-- Outbound webhooks (ADR 0029, CH1.3): a module's events signed and sent to
-- a project's HTTPS endpoints, with a delivery record per event and
-- endpoint. Additive. Business tables in the project scope.
--
-- The signing secret is stored encrypted (AES-256-GCM with CREDENTIAL_KEY);
-- after a rotation the previous secret also signs for 24 hours. Payloads are
-- content-poor (ids, paths, tags): receivers fetch content through the API.
CREATE TABLE "WebhookEndpoint" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ownerModule" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "eventTypes" TEXT[] NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "secretCipher" TEXT NOT NULL,
  "previousSecretCipher" TEXT,
  "previousSecretUntil" TIMESTAMPTZ(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "disabledReason" TEXT,
  "disabledAt" TIMESTAMPTZ(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookEndpoint_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "WebhookEndpoint_ownerModule_check" CHECK ("ownerModule" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "WebhookEndpoint_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "WebhookEndpoint_url_check" CHECK ("url" ~ '^https://[^\s@/?#]+(/[^\s?#]*)?$' AND char_length("url") <= 2048),
  CONSTRAINT "WebhookEndpoint_eventTypes_check" CHECK (cardinality("eventTypes") BETWEEN 1 AND 50),
  CONSTRAINT "WebhookEndpoint_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "WebhookEndpoint_disabled_check" CHECK (("status" = 'disabled') = ("disabledReason" IS NOT NULL AND "disabledAt" IS NOT NULL)),
  CONSTRAINT "WebhookEndpoint_previous_check" CHECK (("previousSecretCipher" IS NULL) = ("previousSecretUntil" IS NULL)),
  CONSTRAINT "WebhookEndpoint_failures_check" CHECK ("consecutiveFailures" >= 0),
  CONSTRAINT "WebhookEndpoint_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebhookEndpoint_workspaceId_projectId_ownerModule_idx" ON "WebhookEndpoint"("workspaceId", "projectId", "ownerModule");

CREATE TABLE "WebhookDelivery" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "endpointId" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3),
  "lastStatus" INTEGER,
  "lastErrorCode" TEXT,
  "durationMs" INTEGER,
  "deliveredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookDelivery_endpointId_eventId_key" UNIQUE ("endpointId", "eventId"),
  CONSTRAINT "WebhookDelivery_eventId_check" CHECK ("eventId" ~ '^evt_[A-Za-z0-9_-]{8,80}$'),
  CONSTRAINT "WebhookDelivery_eventType_check" CHECK ("eventType" ~ '^[a-z][a-z0-9_]{1,30}(\.[a-z][a-z0-9_]{1,40}){1,3}$'),
  CONSTRAINT "WebhookDelivery_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed', 'dead', 'skipped')),
  CONSTRAINT "WebhookDelivery_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "WebhookDelivery_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 16384),
  CONSTRAINT "WebhookDelivery_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WebhookDelivery_endpoint_fkey" FOREIGN KEY ("workspaceId", "projectId", "endpointId") REFERENCES "WebhookEndpoint"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");
CREATE INDEX "WebhookDelivery_workspaceId_projectId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "projectId", "createdAt");

ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "WebhookEndpoint"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "WebhookDelivery"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
