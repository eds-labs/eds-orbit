-- Handoffs of tasks to other modules' work (ADR 0017 P-3). Additive. One
-- row per handoff: the brief, the approval and the target's progress; the
-- task links to the target object with `delegated_to`.
CREATE TABLE "WorkHandoff" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "targetKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting_approval',
  "input" JSONB NOT NULL,
  "inputHash" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" UUID,
  "actionRequestId" UUID,
  "ceilingMicros" BIGINT NOT NULL DEFAULT 0,
  "costMicros" BIGINT NOT NULL DEFAULT 0,
  "result" JSONB NOT NULL DEFAULT '{}',
  "errorCode" TEXT,
  "createdBy" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkHandoff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkHandoff_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkHandoff_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WorkHandoff_task_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "WorkTask"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WorkHandoff_targetKey_check" CHECK ("targetKey" ~ '^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "WorkHandoff_status_check" CHECK ("status" IN ('awaiting_approval','running','finished','failed','canceled')),
  CONSTRAINT "WorkHandoff_input_check" CHECK (pg_column_size("input") <= 16384),
  CONSTRAINT "WorkHandoff_result_check" CHECK (pg_column_size("result") <= 4096),
  CONSTRAINT "WorkHandoff_costs_check" CHECK ("ceilingMicros" >= 0 AND "costMicros" >= 0)
);
CREATE UNIQUE INDEX "WorkHandoff_projectId_taskId_targetKey_active_key" ON "WorkHandoff"("projectId", "taskId", "targetKey") WHERE "status" IN ('awaiting_approval','running');
CREATE INDEX "WorkHandoff_projectId_targetType_targetId_idx" ON "WorkHandoff"("projectId", "targetType", "targetId");
CREATE INDEX "WorkHandoff_projectId_taskId_idx" ON "WorkHandoff"("projectId", "taskId");

ALTER TABLE "WorkHandoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkHandoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "WorkHandoff"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
