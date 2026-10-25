-- Model price overrides of the central AI catalog (plans/ai-central-management.md,
-- phase A, decisions D-2 and D-3). Orbit's dated catalog lives in code; a row
-- here overrides one model's price or switches it off, for the whole system
-- (administrators) or for one organization (its owners). Control plane like
-- "AiProfile": orbit_auth writes, orbit_app reads inside a project
-- transaction. Additive; down path: drop the table.

CREATE TABLE "AiModelPrice" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "workspaceId" UUID,
    "modelId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rate" JSONB,
    "perImageMicros" INTEGER,
    "verifiedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiModelPrice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiModelPrice_scope_check" CHECK (
      ("scope" = 'system' AND "workspaceId" IS NULL) OR ("scope" = 'workspace' AND "workspaceId" IS NOT NULL)),
    CONSTRAINT "AiModelPrice_model_check" CHECK (char_length("modelId") BETWEEN 1 AND 120),
    CONSTRAINT "AiModelPrice_image_check" CHECK ("perImageMicros" IS NULL OR "perImageMicros" BETWEEN 0 AND 10000000)
);

CREATE UNIQUE INDEX "AiModelPrice_system_model" ON "AiModelPrice"("modelId") WHERE "scope" = 'system';
CREATE UNIQUE INDEX "AiModelPrice_workspace_model" ON "AiModelPrice"("workspaceId", "modelId") WHERE "scope" = 'workspace';
ALTER TABLE "AiModelPrice" ADD CONSTRAINT "AiModelPrice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiModelPrice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiModelPrice" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_control ON "AiModelPrice" TO orbit_auth USING (true) WITH CHECK (true);
-- Inside a project transaction only, like the AI profiles.
CREATE POLICY price_read ON "AiModelPrice" FOR SELECT TO orbit_app USING (
  nullif(current_setting('app.project_id', true), '') IS NOT NULL
  AND ("scope" = 'system' OR "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid));
