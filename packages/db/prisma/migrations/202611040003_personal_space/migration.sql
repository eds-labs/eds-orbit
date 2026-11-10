-- Agent platform Phase 3 (ADR 0022, D-08/D-09): one personal space per user
-- and organization, the per-user assistant cap and the per-member switch.
-- Additive: existing projects keep kind 'project' or 'library' and get no
-- personal user. Down path before first use: delete kind 'personal'
-- projects, drop the added columns, the index and the two checks, restore
-- Project_kind_check to ('project','library').
ALTER TABLE "Project" DROP CONSTRAINT "Project_kind_check";
ALTER TABLE "Project" ADD CONSTRAINT "Project_kind_check" CHECK ("kind" IN ('project','library','personal'));
ALTER TABLE "Project" ADD COLUMN "personalUserId" TEXT;
ALTER TABLE "Project" ADD COLUMN "personalLeftAt" TIMESTAMPTZ(3);
ALTER TABLE "Project" ADD CONSTRAINT "Project_personalUserId_fkey" FOREIGN KEY ("personalUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_personal_user_check" CHECK (("kind" = 'personal') = ("personalUserId" IS NOT NULL));
CREATE UNIQUE INDEX "Project_personal_space_key" ON "Project"("workspaceId", "personalUserId") WHERE "kind" = 'personal';
CREATE INDEX "Project_personalUserId_idx" ON "Project"("personalUserId");

ALTER TABLE "OrganizationAiBudget" ADD COLUMN "assistantPerUserMonthlyMicros" BIGINT;
ALTER TABLE "OrganizationAiBudget" ADD CONSTRAINT "OrganizationAiBudget_assistant_cap_check" CHECK ("assistantPerUserMonthlyMicros" IS NULL OR "assistantPerUserMonthlyMicros" >= 0);

ALTER TABLE "WorkspaceMember" ADD COLUMN "assistantEnabled" BOOLEAN NOT NULL DEFAULT true;
