-- Project management module (ADR 0016, plan §3.4): initiatives, milestones,
-- tasks with subtasks, checklists, dependencies, comments, attachments,
-- watchers and history. Every table is project-scoped with forced
-- row-level security. References between module rows (and to "File") are
-- composite ("projectId", id) keys, because foreign key checks bypass RLS:
-- a row can only point at rows of its own project.

CREATE TABLE "WorkInitiative" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "health" TEXT NOT NULL DEFAULT 'unknown',
  "ownerUserId" TEXT,
  "startDate" DATE,
  "targetDate" DATE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "WorkInitiative_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkInitiative_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkInitiative_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkInitiative_projectId_key_key" UNIQUE ("projectId", "key"),
  CONSTRAINT "WorkInitiative_key_check" CHECK ("key" ~ '^[A-Z][A-Z0-9]{1,9}$'),
  CONSTRAINT "WorkInitiative_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "WorkInitiative_description_check" CHECK ("description" IS NULL OR char_length("description") <= 50000),
  CONSTRAINT "WorkInitiative_status_check" CHECK ("status" IN ('planned','active','on_hold','completed','canceled')),
  CONSTRAINT "WorkInitiative_health_check" CHECK ("health" IN ('unknown','on_track','at_risk','off_track')),
  CONSTRAINT "WorkInitiative_dates_check" CHECK ("targetDate" IS NULL OR "startDate" IS NULL OR "targetDate" >= "startDate")
);
CREATE INDEX "WorkInitiative_projectId_status_idx" ON "WorkInitiative"("projectId", "status") WHERE "archivedAt" IS NULL;

CREATE TABLE "WorkMilestone" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "initiativeId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "dueDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'open',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "WorkMilestone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkMilestone_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkMilestone_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkMilestone_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkMilestone_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "WorkMilestone_description_check" CHECK ("description" IS NULL OR char_length("description") <= 20000),
  CONSTRAINT "WorkMilestone_status_check" CHECK ("status" IN ('open','reached','missed','canceled'))
);
CREATE INDEX "WorkMilestone_projectId_initiativeId_dueDate_idx" ON "WorkMilestone"("projectId", "initiativeId", "dueDate");

-- The last task number per project; numbers are never reused.
CREATE TABLE "WorkTaskCounter" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "WorkTaskCounter_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "WorkTaskCounter_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkTaskCounter_lastNumber_check" CHECK ("lastNumber" >= 0)
);

CREATE TABLE "WorkTask" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "initiativeId" UUID,
  "milestoneId" UUID,
  "parentTaskId" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL,
  "statusCategory" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'none',
  "category" TEXT,
  "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "assigneeUserId" TEXT,
  "assigneeAgentKey" TEXT,
  "teamKey" TEXT,
  "startDate" DATE,
  "dueDate" DATE,
  "completedAt" TIMESTAMPTZ(3),
  "estimate" INTEGER,
  "rank" TEXT COLLATE "C" NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "searchVector" tsvector,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "WorkTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkTask_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkTask_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkTask_projectId_number_key" UNIQUE ("projectId", "number"),
  -- An initiative or milestone with tasks cannot be deleted; the service
  -- detaches its tasks first.
  CONSTRAINT "WorkTask_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id"),
  CONSTRAINT "WorkTask_milestone_fkey" FOREIGN KEY ("projectId", "milestoneId") REFERENCES "WorkMilestone"("projectId", "id"),
  CONSTRAINT "WorkTask_parent_fkey" FOREIGN KEY ("projectId", "parentTaskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkTask_not_own_parent" CHECK ("parentTaskId" IS NULL OR "parentTaskId" <> "id"),
  CONSTRAINT "WorkTask_number_check" CHECK ("number" > 0),
  CONSTRAINT "WorkTask_title_check" CHECK (char_length("title") BETWEEN 1 AND 300),
  CONSTRAINT "WorkTask_description_check" CHECK ("description" IS NULL OR char_length("description") <= 50000),
  CONSTRAINT "WorkTask_statusCategory_check" CHECK ("statusCategory" IN ('backlog','todo','in_progress','blocked','in_review','done','canceled')),
  CONSTRAINT "WorkTask_priority_check" CHECK ("priority" IN ('urgent','high','medium','low','none')),
  CONSTRAINT "WorkTask_labels_check" CHECK (cardinality("labels") <= 20),
  CONSTRAINT "WorkTask_assignee_check" CHECK ("assigneeUserId" IS NULL OR "assigneeAgentKey" IS NULL),
  CONSTRAINT "WorkTask_dates_check" CHECK ("dueDate" IS NULL OR "startDate" IS NULL OR "dueDate" >= "startDate"),
  CONSTRAINT "WorkTask_estimate_check" CHECK ("estimate" IS NULL OR "estimate" BETWEEN 0 AND 1000),
  CONSTRAINT "WorkTask_source_check" CHECK ("source" IN ('manual','assistant','mcp','pm_agent','issue','import'))
);
CREATE INDEX "WorkTask_projectId_statusCategory_assigneeUserId_idx" ON "WorkTask"("projectId", "statusCategory", "assigneeUserId") WHERE "archivedAt" IS NULL;
CREATE INDEX "WorkTask_projectId_initiativeId_status_rank_idx" ON "WorkTask"("projectId", "initiativeId", "status", "rank") WHERE "archivedAt" IS NULL;
CREATE INDEX "WorkTask_projectId_milestoneId_idx" ON "WorkTask"("projectId", "milestoneId");
CREATE INDEX "WorkTask_projectId_parentTaskId_idx" ON "WorkTask"("projectId", "parentTaskId");
CREATE INDEX "WorkTask_open_due_idx" ON "WorkTask"("projectId", "dueDate") WHERE "archivedAt" IS NULL AND "statusCategory" NOT IN ('done','canceled');
CREATE INDEX "WorkTask_searchVector_idx" ON "WorkTask" USING GIN ("searchVector");

-- Full-text search over titles (weight A) and descriptions (B) in any
-- language: the 'simple' configuration, as for support messages.
CREATE FUNCTION work_task_search_vector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple'::regconfig, coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(NEW."description", '')), 'B');
  RETURN NEW;
END $$;
CREATE TRIGGER work_task_search_vector BEFORE INSERT OR UPDATE OF "title", "description" ON "WorkTask"
  FOR EACH ROW EXECUTE FUNCTION work_task_search_vector();

-- A task's milestone belongs to the task's initiative, and subtasks are one
-- level deep: a parent has no parent, and a task with subtasks gets none.
CREATE FUNCTION work_task_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."milestoneId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkMilestone" m
    WHERE m."projectId" = NEW."projectId" AND m."id" = NEW."milestoneId"
      AND m."initiativeId" IS NOT DISTINCT FROM NEW."initiativeId"
  ) THEN
    RAISE EXCEPTION 'WORK_MILESTONE_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parentTaskId" IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM "WorkTask" p
      WHERE p."projectId" = NEW."projectId" AND p."id" = NEW."parentTaskId"
        AND p."parentTaskId" IS NOT NULL
    ) OR EXISTS (
      SELECT 1 FROM "WorkTask" c
      WHERE c."projectId" = NEW."projectId" AND c."parentTaskId" = NEW."id"
    )
  ) THEN
    RAISE EXCEPTION 'WORK_PARENT_DEPTH' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_task_structure BEFORE INSERT OR UPDATE OF "milestoneId", "initiativeId", "parentTaskId" ON "WorkTask"
  FOR EACH ROW EXECUTE FUNCTION work_task_structure();

CREATE TABLE "WorkChecklistItem" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "doneBy" TEXT,
  "doneAt" TIMESTAMPTZ(3),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkChecklistItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkChecklistItem_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkChecklistItem_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkChecklistItem_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkChecklistItem_text_check" CHECK (char_length("text") BETWEEN 1 AND 500)
);
CREATE INDEX "WorkChecklistItem_projectId_taskId_sortOrder_idx" ON "WorkChecklistItem"("projectId", "taskId", "sortOrder");

-- "taskId" waits for "dependsOnTaskId" (finish to start). Cycles are refused
-- by the service under the project lock.
CREATE TABLE "WorkTaskDependency" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "dependsOnTaskId" UUID NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'finish_to_start',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkTaskDependency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkTaskDependency_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkTaskDependency_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkTaskDependency_pair_key" UNIQUE ("projectId", "taskId", "dependsOnTaskId"),
  CONSTRAINT "WorkTaskDependency_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkTaskDependency_dependsOn_fkey" FOREIGN KEY ("projectId", "dependsOnTaskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkTaskDependency_not_self" CHECK ("taskId" <> "dependsOnTaskId"),
  CONSTRAINT "WorkTaskDependency_kind_check" CHECK ("kind" IN ('finish_to_start'))
);
CREATE INDEX "WorkTaskDependency_projectId_dependsOnTaskId_idx" ON "WorkTaskDependency"("projectId", "dependsOnTaskId");

CREATE TABLE "WorkComment" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "authorKind" TEXT NOT NULL,
  "authorUserId" TEXT,
  "agentRunId" UUID,
  "bodyText" TEXT NOT NULL,
  "mentions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "editedAt" TIMESTAMPTZ(3),
  "deletedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkComment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkComment_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkComment_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkComment_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkComment_authorKind_check" CHECK ("authorKind" IN ('user','agent','system')),
  -- A deleted comment keeps its place in the thread with an empty body.
  CONSTRAINT "WorkComment_body_check" CHECK (char_length("bodyText") <= 20000 AND ("deletedAt" IS NOT NULL OR char_length("bodyText") >= 1)),
  CONSTRAINT "WorkComment_mentions_check" CHECK (cardinality("mentions") <= 50)
);
CREATE INDEX "WorkComment_projectId_taskId_createdAt_idx" ON "WorkComment"("projectId", "taskId", "createdAt");

CREATE TABLE "WorkAttachment" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "addedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkAttachment_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkAttachment_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkAttachment_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkAttachment_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkAttachment_task_file_key" UNIQUE ("projectId", "taskId", "fileId"),
  CONSTRAINT "WorkAttachment_size_check" CHECK ("size" >= 0)
);
CREATE INDEX "WorkAttachment_projectId_taskId_idx" ON "WorkAttachment"("projectId", "taskId");

CREATE TABLE "WorkTaskWatcher" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkTaskWatcher_pkey" PRIMARY KEY ("projectId", "taskId", "userId"),
  CONSTRAINT "WorkTaskWatcher_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkTaskWatcher_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE
);

-- History of tasks, initiatives and milestones: one row per change, ids and
-- field names only (text changes are recorded as {"changed": true}).
CREATE TABLE "WorkEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID,
  "initiativeId" UUID,
  "milestoneId" UUID,
  "type" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorId" TEXT,
  "before" JSONB NOT NULL DEFAULT '{}',
  "after" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkEvent_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkEvent_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkEvent_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkEvent_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkEvent_milestone_fkey" FOREIGN KEY ("projectId", "milestoneId") REFERENCES "WorkMilestone"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkEvent_subject_check" CHECK (num_nonnulls("taskId", "initiativeId", "milestoneId") = 1),
  CONSTRAINT "WorkEvent_actorKind_check" CHECK ("actorKind" IN ('user','agent','system','mcp')),
  CONSTRAINT "WorkEvent_type_check" CHECK ("type" ~ '^[a-z][a-z_]{1,40}$')
);
CREATE INDEX "WorkEvent_projectId_taskId_createdAt_idx" ON "WorkEvent"("projectId", "taskId", "createdAt");
CREATE INDEX "WorkEvent_projectId_initiativeId_createdAt_idx" ON "WorkEvent"("projectId", "initiativeId", "createdAt");
CREATE INDEX "WorkEvent_projectId_milestoneId_createdAt_idx" ON "WorkEvent"("projectId", "milestoneId", "createdAt");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['WorkInitiative','WorkMilestone','WorkTaskCounter','WorkTask','WorkChecklistItem','WorkTaskDependency','WorkComment','WorkAttachment','WorkTaskWatcher','WorkEvent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
