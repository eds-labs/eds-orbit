-- Agent/model-call telemetry and budget attribution. Additive only.
ALTER TABLE "BudgetReservation"
  ADD COLUMN "agentRunId" UUID,
  ADD COLUMN "taskClass" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "missionId" UUID;
CREATE INDEX "BudgetReservation_workspaceId_projectId_agentRunId_idx" ON "BudgetReservation"("workspaceId", "projectId", "agentRunId");

CREATE TABLE "AgentRun" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "taskClass" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "missionId" UUID,
  "status" TEXT NOT NULL DEFAULT 'running',
  "errorCode" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMPTZ(3),
  "durationMs" INTEGER,
  CONSTRAINT "AgentRun_workspaceId_projectId_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "AgentRun_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image')),
  CONSTRAINT "AgentRun_status_check" CHECK ("status" IN ('running','succeeded','failed','blocked','canceled','unknown')),
  CONSTRAINT "AgentRun_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0)
);
CREATE INDEX "AgentRun_workspaceId_projectId_startedAt_idx" ON "AgentRun"("workspaceId", "projectId", "startedAt" DESC);
CREATE INDEX "AgentRun_workspaceId_projectId_subject_idx" ON "AgentRun"("workspaceId", "projectId", "subjectType", "subjectId");

CREATE TABLE "AgentSpan" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "parentSpanId" UUID,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "model" TEXT,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "cachedTokens" INTEGER,
  "cacheWriteTokens" INTEGER,
  "outputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "costMicros" BIGINT,
  "budgetReservationId" UUID,
  "providerResponseId" TEXT,
  "inputHash" TEXT,
  "outputHash" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSpan_run_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "AgentRun"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentSpan_type_check" CHECK ("type" IN ('model_call','tool_call','embedding','image')),
  CONSTRAINT "AgentSpan_status_check" CHECK ("status" IN ('succeeded','failed','unknown','blocked')),
  CONSTRAINT "AgentSpan_nonnegative" CHECK ("durationMs" >= 0 AND ("costMicros" IS NULL OR "costMicros" >= 0))
);
CREATE INDEX "AgentSpan_workspaceId_projectId_runId_idx" ON "AgentSpan"("workspaceId", "projectId", "runId");

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['AgentRun','AgentSpan'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY project_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid)', table_name);
  END LOOP;
END $$;
