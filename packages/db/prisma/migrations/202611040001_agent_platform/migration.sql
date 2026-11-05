-- Agent platform, Phase 1 (ADR 0021, docs/plans/agent-platform-phase-1.md
-- §2.4, §2.6, WP1.4). Additive only: a new project-scoped work order table,
-- a widened run kind check and a nullable attribution column on budget
-- reservations. No existing row is changed.

-- One unit of agent work: who asked, under which frozen allowlist and
-- ceiling, its step log (tool names, risk and outcome codes, never
-- arguments or results) and its bounded result. Parent and root are
-- composite self-references inside the same project, as for Work subtasks:
-- foreign key checks bypass RLS, so a work order can only point at work
-- orders of its own project. Deleting a parent deletes its delegated
-- children; retention only deletes a tree whose members have all finished.
CREATE TABLE "AgentWorkOrder" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "target" TEXT NOT NULL,
  "agentId" UUID,
  "agentVersion" INTEGER,
  "configHash" TEXT,
  "origin" TEXT NOT NULL,
  "originRef" TEXT,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestedBy" JSONB NOT NULL,
  "sponsorUserId" TEXT,
  "allow" JSONB NOT NULL,
  "parentId" UUID,
  "rootId" UUID,
  "depth" INTEGER NOT NULL DEFAULT 0,
  "goal" TEXT NOT NULL,
  "input" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "ceilingMicros" BIGINT NOT NULL,
  "spentMicros" BIGINT NOT NULL DEFAULT 0,
  "costUnknown" BOOLEAN NOT NULL DEFAULT false,
  "startRequestId" UUID,
  "jobId" UUID,
  "conversationId" UUID,
  "result" JSONB,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  CONSTRAINT "AgentWorkOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentWorkOrder_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentWorkOrder_workspaceId_projectId_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "AgentWorkOrder_projectId_idempotencyKey_key" UNIQUE ("projectId", "idempotencyKey"),
  CONSTRAINT "AgentWorkOrder_parent_fkey" FOREIGN KEY ("workspaceId", "projectId", "parentId") REFERENCES "AgentWorkOrder"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentWorkOrder_root_fkey" FOREIGN KEY ("workspaceId", "projectId", "rootId") REFERENCES "AgentWorkOrder"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentWorkOrder_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
  CONSTRAINT "AgentWorkOrder_target_check" CHECK ("target" IN ('agent','assistant')),
  CONSTRAINT "AgentWorkOrder_origin_check" CHECK ("origin" IN ('manual','schedule','event','assistant','agent','mcp')),
  CONSTRAINT "AgentWorkOrder_status_check" CHECK ("status" IN ('queued','awaiting_start','running','waiting_approval','succeeded','failed','blocked','canceled','outcome_unknown')),
  CONSTRAINT "AgentWorkOrder_depth_check" CHECK ("depth" BETWEEN 0 AND 2),
  CONSTRAINT "AgentWorkOrder_goal_check" CHECK (char_length("goal") <= 2000),
  CONSTRAINT "AgentWorkOrder_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "AgentWorkOrder_micros_check" CHECK ("ceilingMicros" >= 0 AND "spentMicros" >= 0)
);
CREATE INDEX "AgentWorkOrder_projectId_agentId_createdAt_idx" ON "AgentWorkOrder"("projectId", "agentId", "createdAt");
CREATE INDEX "AgentWorkOrder_projectId_status_createdAt_idx" ON "AgentWorkOrder"("projectId", "status", "createdAt");
CREATE INDEX "AgentWorkOrder_projectId_subjectType_subjectId_idx" ON "AgentWorkOrder"("projectId", "subjectType", "subjectId");
CREATE INDEX "AgentWorkOrder_projectId_rootId_idx" ON "AgentWorkOrder"("projectId", "rootId");
-- The composite parent key needs its own index for the cascade and for
-- retention's "no unfinished child" check.
CREATE INDEX "AgentWorkOrder_projectId_parentId_idx" ON "AgentWorkOrder"("projectId", "parentId");
-- Retention reads finished work orders by age.
CREATE INDEX "AgentWorkOrder_projectId_finishedAt_idx" ON "AgentWorkOrder"("projectId", "finishedAt") WHERE "finishedAt" IS NOT NULL;

ALTER TABLE "AgentWorkOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentWorkOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "AgentWorkOrder"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

-- Telemetry runs of agent work orders. Widens the check only.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_kind_check";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image','agent','support','mcp','finance','work_pm','issues','agent_work'));

-- Agent spend attribution (plan §2.6, option a): the agent a reservation was
-- made for. The partial index covers the month sum of one agent (state and
-- amounts included), so the agent's month ceiling check does not read the
-- project's other reservations.
ALTER TABLE "BudgetReservation" ADD COLUMN "agentId" UUID;
CREATE INDEX "BudgetReservation_agent_month_idx" ON "BudgetReservation"("projectId", "agentId", "createdAt") INCLUDE ("state", "amountMicros", "settledMicros") WHERE "agentId" IS NOT NULL;
