-- AI project manager (ADR 0017, plan §3). Additive: five new tables of the
-- work module with composite same-project keys and FORCE RLS; no existing
-- row is changed. Texts the PM generates are drafts for people to review.

-- PM state per initiative: on/off, schedule and the last scan and report.
CREATE TABLE "WorkPmState" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "initiativeId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "lastScanAt" TIMESTAMPTZ(3),
  "lastScanHash" TEXT,
  "lastReportAt" TIMESTAMPTZ(3),
  "lastReportHash" TEXT,
  "lastAnalysisAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkPmState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkPmState_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkPmState_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkPmState_projectId_initiativeId_key" UNIQUE ("projectId", "initiativeId"),
  CONSTRAINT "WorkPmState_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkPmState_settings_check" CHECK (pg_column_size("settings") <= 4096)
);

-- A plan or adjustment the PM (or a client) proposed. Each edit is a new
-- row that supersedes the previous revision; applied plans stay as the
-- record of what was created.
CREATE TABLE "WorkPlanProposal" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "initiativeId" UUID,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requestText" TEXT,
  "requestedBy" TEXT NOT NULL,
  "requestedVia" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "supersedesId" UUID,
  "plan" JSONB,
  "validation" JSONB NOT NULL DEFAULT '{}',
  "planHash" TEXT,
  "agentRunId" UUID,
  "actionRequestId" UUID,
  "appliedAt" TIMESTAMPTZ(3),
  "appliedTaskIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "costMicros" BIGINT NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkPlanProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkPlanProposal_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkPlanProposal_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkPlanProposal_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE SET NULL ("initiativeId"),
  CONSTRAINT "WorkPlanProposal_supersedes_fkey" FOREIGN KEY ("projectId", "supersedesId") REFERENCES "WorkPlanProposal"("projectId", "id") ON DELETE SET NULL ("supersedesId"),
  CONSTRAINT "WorkPlanProposal_kind_check" CHECK ("kind" IN ('new_plan','extension','adjustment')),
  CONSTRAINT "WorkPlanProposal_status_check" CHECK ("status" IN ('queued','running','draft','proposed','applied','rejected','invalid','failed','expired','superseded')),
  CONSTRAINT "WorkPlanProposal_requestedVia_check" CHECK ("requestedVia" IN ('ui','assistant','mcp','monitor')),
  CONSTRAINT "WorkPlanProposal_requestText_check" CHECK ("requestText" IS NULL OR char_length("requestText") <= 4000),
  CONSTRAINT "WorkPlanProposal_plan_check" CHECK ("plan" IS NULL OR pg_column_size("plan") <= 262144),
  CONSTRAINT "WorkPlanProposal_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "WorkPlanProposal_costMicros_check" CHECK ("costMicros" >= 0)
);
CREATE UNIQUE INDEX "WorkPlanProposal_projectId_idempotencyKey_key" ON "WorkPlanProposal"("projectId", "idempotencyKey");
CREATE INDEX "WorkPlanProposal_projectId_initiativeId_status_idx" ON "WorkPlanProposal"("projectId", "initiativeId", "status");
CREATE INDEX "WorkPlanProposal_projectId_requestedBy_createdAt_idx" ON "WorkPlanProposal"("projectId", "requestedBy", "createdAt");

-- A rule finding of the monitor; a stable fingerprint keeps one open (or
-- dismissed) finding per condition.
CREATE TABLE "WorkPmFinding" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "initiativeId" UUID NOT NULL,
  "rule" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "taskIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "milestoneId" UUID,
  "status" TEXT NOT NULL DEFAULT 'open',
  "dismissedBy" TEXT,
  "dismissedUntil" TIMESTAMPTZ(3),
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  "data" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "WorkPmFinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkPmFinding_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkPmFinding_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkPmFinding_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkPmFinding_milestone_fkey" FOREIGN KEY ("projectId", "milestoneId") REFERENCES "WorkMilestone"("projectId", "id") ON DELETE SET NULL ("milestoneId"),
  CONSTRAINT "WorkPmFinding_rule_check" CHECK ("rule" ~ '^[a-z][a-z_]{1,40}$'),
  CONSTRAINT "WorkPmFinding_severity_check" CHECK ("severity" IN ('info','warning','critical')),
  CONSTRAINT "WorkPmFinding_status_check" CHECK ("status" IN ('open','resolved','dismissed')),
  CONSTRAINT "WorkPmFinding_data_check" CHECK (pg_column_size("data") <= 4096)
);
CREATE UNIQUE INDEX "WorkPmFinding_projectId_fingerprint_active_key" ON "WorkPmFinding"("projectId", "fingerprint") WHERE "status" IN ('open','dismissed');
CREATE INDEX "WorkPmFinding_projectId_initiativeId_status_severity_idx" ON "WorkPmFinding"("projectId", "initiativeId", "status", "severity");

-- An AI-generated report or analysis (a draft for people, labelled as such).
CREATE TABLE "WorkPmReport" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "initiativeId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "findingIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "agentRunId" UUID,
  "costMicros" BIGINT NOT NULL DEFAULT 0,
  "requestedBy" TEXT,
  "publishedTo" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkPmReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkPmReport_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkPmReport_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkPmReport_initiative_fkey" FOREIGN KEY ("projectId", "initiativeId") REFERENCES "WorkInitiative"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkPmReport_kind_check" CHECK ("kind" IN ('status_report','next_steps','analysis')),
  CONSTRAINT "WorkPmReport_body_check" CHECK (char_length("body") <= 20000),
  CONSTRAINT "WorkPmReport_data_check" CHECK (pg_column_size("data") <= 65536),
  CONSTRAINT "WorkPmReport_costMicros_check" CHECK ("costMicros" >= 0)
);
CREATE INDEX "WorkPmReport_projectId_initiativeId_createdAt_idx" ON "WorkPmReport"("projectId", "initiativeId", "createdAt");

-- A coding work order: a sanitized brief, the owner's approval, the
-- dispatch and what the external system reported back. A task with runs is
-- archived, not deleted.
CREATE TABLE "WorkCodingRun" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "repositoryKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "briefRevision" INTEGER NOT NULL DEFAULT 1,
  "brief" JSONB NOT NULL,
  "briefHash" TEXT NOT NULL,
  "sanitization" JSONB NOT NULL DEFAULT '{}',
  "personalDataReviewed" BOOLEAN NOT NULL DEFAULT false,
  "ceilingMicros" BIGINT NOT NULL DEFAULT 0,
  "reportedCostMicros" BIGINT,
  "actionRequestId" UUID,
  "automationRunId" UUID,
  "externalRef" TEXT,
  "branch" TEXT,
  "prUrl" TEXT,
  "prNumber" INTEGER,
  "commitSha" TEXT,
  "tests" JSONB,
  "summary" TEXT,
  "errorCode" TEXT,
  "dispatchedAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3),
  "timeoutAt" TIMESTAMPTZ(3),
  "createdBy" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkCodingRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkCodingRun_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkCodingRun_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkCodingRun_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id"),
  CONSTRAINT "WorkCodingRun_repositoryKey_check" CHECK ("repositoryKey" ~ '^[a-z][a-z0-9_-]{1,40}$'),
  CONSTRAINT "WorkCodingRun_provider_check" CHECK ("provider" IN ('manual','automation')),
  CONSTRAINT "WorkCodingRun_status_check" CHECK ("status" IN ('draft','awaiting_approval','canceled','dispatching','dispatched','outcome_unknown','running','succeeded','failed')),
  CONSTRAINT "WorkCodingRun_brief_check" CHECK (pg_column_size("brief") <= 32768),
  CONSTRAINT "WorkCodingRun_ceilingMicros_check" CHECK ("ceilingMicros" >= 0),
  CONSTRAINT "WorkCodingRun_prUrl_check" CHECK ("prUrl" IS NULL OR "prUrl" ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$'),
  CONSTRAINT "WorkCodingRun_commitSha_check" CHECK ("commitSha" IS NULL OR "commitSha" ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT "WorkCodingRun_summary_check" CHECK ("summary" IS NULL OR char_length("summary") <= 2000),
  CONSTRAINT "WorkCodingRun_tests_check" CHECK ("tests" IS NULL OR pg_column_size("tests") <= 2048)
);
CREATE UNIQUE INDEX "WorkCodingRun_projectId_taskId_active_key" ON "WorkCodingRun"("projectId", "taskId") WHERE "status" IN ('awaiting_approval','dispatching','dispatched','running');
CREATE INDEX "WorkCodingRun_projectId_status_timeoutAt_idx" ON "WorkCodingRun"("projectId", "status", "timeoutAt");
CREATE INDEX "WorkCodingRun_projectId_taskId_idx" ON "WorkCodingRun"("projectId", "taskId");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['WorkPmState','WorkPlanProposal','WorkPmFinding','WorkPmReport','WorkCodingRun'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
