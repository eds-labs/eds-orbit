-- Central AI budget (plans/ai-central-management.md, phase C, decisions D-2,
-- D-5 and D-6). One monthly budget and one cap per provider per
-- organization, set by its owners; spend counters per organization, month
-- and scope ('total' or a provider) that every project of the organization
-- adds to while ORBIT_AI_ORG_BUDGET is on, locked in a fixed order like the
-- grant counters of ADR 0014. A reservation records which provider counter
-- it was added to, so its settlement moves the same amount. Additive; down
-- path: drop the column and both tables.

CREATE TABLE "OrganizationAiBudget" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "monthlyMicros" BIGINT,
    "providerCaps" JSONB NOT NULL DEFAULT '{}',
    "credits" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationAiBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationAiBudget_monthly_check" CHECK ("monthlyMicros" IS NULL OR "monthlyMicros" BETWEEN 0 AND 100000000000)
);
CREATE UNIQUE INDEX "OrganizationAiBudget_workspaceId_key" ON "OrganizationAiBudget"("workspaceId");
ALTER TABLE "OrganizationAiBudget" ADD CONSTRAINT "OrganizationAiBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganizationSpendCounter" (
    "workspaceId" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "settledMicros" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "OrganizationSpendCounter_pkey" PRIMARY KEY ("workspaceId", "scopeKey", "periodStart"),
    CONSTRAINT "OrganizationSpendCounter_scope_check" CHECK ("scopeKey" IN ('total', 'openai', 'anthropic')),
    CONSTRAINT "OrganizationSpendCounter_nonnegative" CHECK ("reservedMicros" >= 0 AND "settledMicros" >= 0)
);
ALTER TABLE "OrganizationSpendCounter" ADD CONSTRAINT "OrganizationSpendCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The provider counter a reservation was added to; 'none' for a reservation
-- without a model (only the total counter); null when it was not counted.
ALTER TABLE "BudgetReservation" ADD COLUMN "orgProvider" TEXT;
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_orgProvider_check" CHECK ("orgProvider" IS NULL OR "orgProvider" IN ('openai', 'anthropic', 'none'));

ALTER TABLE "OrganizationAiBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationAiBudget" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_control ON "OrganizationAiBudget" TO orbit_auth USING (true) WITH CHECK (true);
-- Inside a project transaction only, like the AI profiles.
CREATE POLICY budget_read ON "OrganizationAiBudget" FOR SELECT TO orbit_app USING (
  nullif(current_setting('app.project_id', true), '') IS NOT NULL
  AND "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE "OrganizationSpendCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationSpendCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_control ON "OrganizationSpendCounter" TO orbit_auth USING (true) WITH CHECK (true);
CREATE POLICY counter_use ON "OrganizationSpendCounter" TO orbit_app USING (
  nullif(current_setting('app.project_id', true), '') IS NOT NULL
  AND "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (
  nullif(current_setting('app.project_id', true), '') IS NOT NULL
  AND "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid);
