-- Central connections, AI profiles and organization knowledge (ADR 0013).
-- Additive only. A connection and the permission to use it are separate:
-- `Connection` (+ versioned `ConnectionSecret`) and `ConnectionGrant`.
-- The business role reads a connection or secret only inside a project
-- transaction that holds an active project grant for it (row-level
-- security below); administration writes through orbit_auth.
-- Down path before first use: drop the six tables and the added columns.

ALTER TABLE "Project" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'project';
ALTER TABLE "Project" ADD CONSTRAINT "Project_kind_check" CHECK ("kind" IN ('project','library'));
ALTER TABLE "BudgetReservation" ADD COLUMN "connectionId" UUID;
ALTER TABLE "BudgetReservation" ADD COLUMN "grantId" UUID;
ALTER TABLE "BudgetReservation" ADD COLUMN "parentGrantId" UUID;
ALTER TABLE "AgentRun" ADD COLUMN "routeVersionKey" TEXT;

CREATE TABLE "Connection" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "workspaceId" UUID,
    "projectId" UUID,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'configured',
    "health" JSONB NOT NULL DEFAULT '{}',
    "monthlyBudgetMicros" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "legacyRef" JSONB,
    "disabledAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Connection_scope_check" CHECK (
      ("scope" = 'system' AND "workspaceId" IS NULL AND "projectId" IS NULL) OR
      ("scope" = 'workspace' AND "workspaceId" IS NOT NULL AND "projectId" IS NULL) OR
      ("scope" = 'project' AND "workspaceId" IS NOT NULL AND "projectId" IS NOT NULL)),
    CONSTRAINT "Connection_budget_check" CHECK ("monthlyBudgetMicros" IS NULL OR "monthlyBudgetMicros" >= 0)
);

CREATE TABLE "ConnectionSecret" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "keyId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),
    CONSTRAINT "ConnectionSecret_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConnectionSecret_state_check" CHECK ("state" IN ('pending','active','retired'))
);

CREATE TABLE "ConnectionGrant" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "userId" TEXT,
    "parentGrantId" UUID,
    "purposes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "modules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "monthlyBudgetMicros" BIGINT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedBy" TEXT,
    CONSTRAINT "ConnectionGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConnectionGrant_budget_check" CHECK ("monthlyBudgetMicros" IS NULL OR "monthlyBudgetMicros" >= 0)
);

CREATE TABLE "SpendCounter" (
    "scopeKey" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "connectionId" UUID NOT NULL,
    "workspaceId" UUID,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "settledMicros" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "SpendCounter_pkey" PRIMARY KEY ("scopeKey", "periodStart"),
    CONSTRAINT "SpendCounter_nonnegative" CHECK ("reservedMicros" >= 0 AND "settledMicros" >= 0)
);

CREATE TABLE "AiProfile" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "workspaceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiProfile_scope_check" CHECK (
      ("scope" = 'system' AND "workspaceId" IS NULL) OR ("scope" = 'workspace' AND "workspaceId" IS NOT NULL))
);

CREATE TABLE "KnowledgeShare" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "libraryProjectId" UUID NOT NULL,
    "consumerProjectId" UUID NOT NULL,
    "sourceIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "modules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "generation" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "KnowledgeShare_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeShare_distinct" CHECK ("libraryProjectId" <> "consumerProjectId")
);

CREATE INDEX "Connection_workspaceId_idx" ON "Connection"("workspaceId");
CREATE INDEX "Connection_projectId_idx" ON "Connection"("projectId");
CREATE UNIQUE INDEX "ConnectionSecret_connectionId_version_key" ON "ConnectionSecret"("connectionId", "version");
CREATE UNIQUE INDEX "ConnectionSecret_one_active" ON "ConnectionSecret"("connectionId") WHERE "state" = 'active';
CREATE INDEX "ConnectionGrant_connectionId_idx" ON "ConnectionGrant"("connectionId");
CREATE INDEX "ConnectionGrant_workspaceId_projectId_idx" ON "ConnectionGrant"("workspaceId", "projectId");
CREATE INDEX "ConnectionGrant_parentGrantId_idx" ON "ConnectionGrant"("parentGrantId");
-- One active grant per connection and consumer (organization or project).
CREATE UNIQUE INDEX "ConnectionGrant_one_active" ON "ConnectionGrant"("connectionId", "workspaceId", COALESCE("projectId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "revokedAt" IS NULL AND "userId" IS NULL;
CREATE UNIQUE INDEX "AiProfile_one_system" ON "AiProfile"("scope") WHERE "scope" = 'system';
CREATE UNIQUE INDEX "AiProfile_workspaceId_key" ON "AiProfile"("workspaceId");
CREATE INDEX "KnowledgeShare_consumer_idx" ON "KnowledgeShare"("workspaceId", "consumerProjectId");
CREATE INDEX "KnowledgeShare_library_idx" ON "KnowledgeShare"("workspaceId", "libraryProjectId");
CREATE UNIQUE INDEX "KnowledgeShare_one_active" ON "KnowledgeShare"("libraryProjectId", "consumerProjectId") WHERE "revokedAt" IS NULL;
CREATE INDEX "BudgetReservation_grantId_idx" ON "BudgetReservation"("grantId");

ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionSecret" ADD CONSTRAINT "ConnectionSecret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_parentGrantId_fkey" FOREIGN KEY ("parentGrantId") REFERENCES "ConnectionGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpendCounter" ADD CONSTRAINT "SpendCounter_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiProfile" ADD CONSTRAINT "AiProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeShare" ADD CONSTRAINT "KnowledgeShare_library_fkey" FOREIGN KEY ("workspaceId", "libraryProjectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeShare" ADD CONSTRAINT "KnowledgeShare_consumer_fkey" FOREIGN KEY ("workspaceId", "consumerProjectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security. orbit_auth administers everything; orbit_app reads
-- (and for spend counters writes) only what the current project may use.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Connection','ConnectionSecret','ConnectionGrant','SpendCounter','AiProfile','KnowledgeShare'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY auth_control ON %I TO orbit_auth USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

CREATE POLICY grant_use ON "ConnectionGrant" FOR SELECT TO orbit_app USING (
  "revokedAt" IS NULL
  AND "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND ("projectId" = nullif(current_setting('app.project_id', true), '')::uuid OR "projectId" IS NULL));

CREATE POLICY connection_use ON "Connection" FOR SELECT TO orbit_app USING (
  "disabledAt" IS NULL AND "revokedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "ConnectionGrant" g
              WHERE g."connectionId" = "Connection"."id"
                AND g."revokedAt" IS NULL
                AND g."workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
                AND g."projectId" = nullif(current_setting('app.project_id', true), '')::uuid));

CREATE POLICY secret_use ON "ConnectionSecret" FOR SELECT TO orbit_app USING (
  "state" = 'active'
  AND EXISTS (SELECT 1 FROM "Connection" c WHERE c."id" = "ConnectionSecret"."connectionId"));

-- Inside a project transaction only, like every other business read.
CREATE POLICY profile_read ON "AiProfile" FOR SELECT TO orbit_app USING (
  nullif(current_setting('app.project_id', true), '') IS NOT NULL
  AND ("scope" = 'system' OR "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid));

CREATE POLICY counter_use ON "SpendCounter" TO orbit_app USING (
  "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR ("workspaceId" IS NULL AND EXISTS (SELECT 1 FROM "Connection" c WHERE c."id" = "SpendCounter"."connectionId")))
  WITH CHECK (
  "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR ("workspaceId" IS NULL AND EXISTS (SELECT 1 FROM "Connection" c WHERE c."id" = "SpendCounter"."connectionId")));

CREATE POLICY share_read ON "KnowledgeShare" FOR SELECT TO orbit_app USING (
  "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND ("consumerProjectId" = nullif(current_setting('app.project_id', true), '')::uuid
       OR "libraryProjectId" = nullif(current_setting('app.project_id', true), '')::uuid));
