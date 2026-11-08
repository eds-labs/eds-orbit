-- Ads module (ADR 0025): ad accounts, OAuth state, sync state and provider
-- throttle. Every table is project-scoped with forced row-level security.

CREATE TABLE "AdAccount" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "connectionId" UUID NOT NULL,
  "businessId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "capability" TEXT NOT NULL DEFAULT 'read_verified',
  "writesEnabled" BOOLEAN NOT NULL DEFAULT false,
  "providerStatus" TEXT,
  "spendCapMicros" BIGINT,
  "amountSpentMicros" BIGINT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "lastSyncedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdAccount_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdAccount_version_check" CHECK ("version" >= 1),
  CONSTRAINT "AdAccount_provider_check" CHECK ("provider" IN ('meta','openai','google')),
  CONSTRAINT "AdAccount_status_check" CHECK ("status" IN ('active','reconnect_required','disabled','unlinked')),
  CONSTRAINT "AdAccount_capability_check" CHECK ("capability" IN ('read_verified','write_ready','write_verified')),
  CONSTRAINT "AdAccount_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "AdAccount_spend_cap_check" CHECK ("spendCapMicros" >= 0),
  CONSTRAINT "AdAccount_amount_spent_check" CHECK ("amountSpentMicros" >= 0)
);
CREATE UNIQUE INDEX "AdAccount_projectId_id_key" ON "AdAccount"("projectId", "id");
CREATE UNIQUE INDEX "AdAccount_external_key" ON "AdAccount"("projectId", "provider", "externalId");
CREATE INDEX "AdAccount_projectId_status_idx" ON "AdAccount"("projectId", "status");

CREATE TABLE "AdOAuthState" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "appConnectionId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "verifierCiphertext" TEXT,
  "redirectAfter" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdOAuthState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdOAuthState_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdOAuthState_state_hash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AdOAuthState_provider_check" CHECK ("provider" IN ('meta','openai','google')),
  CONSTRAINT "AdOAuthState_expiry_check" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "AdOAuthState_stateHash_key" ON "AdOAuthState"("stateHash");
CREATE UNIQUE INDEX "AdOAuthState_projectId_id_key" ON "AdOAuthState"("projectId", "id");

CREATE TABLE "AdSyncState" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "stream" TEXT NOT NULL,
  "cursor" JSONB NOT NULL DEFAULT '{}',
  "watermark" TIMESTAMPTZ(3),
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSuccessAt" TIMESTAMPTZ(3),
  "lastErrorCode" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdSyncState_pkey" PRIMARY KEY ("projectId", "accountId", "stream"),
  CONSTRAINT "AdSyncState_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdSyncState_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "AdAccount"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "AdSyncState_stream_check" CHECK ("stream" IN ('structure','status','insights_recent','insights_backfill','spend_today','health')),
  CONSTRAINT "AdSyncState_failures_check" CHECK ("consecutiveFailures" >= 0),
  CONSTRAINT "AdSyncState_lease_check" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
);
CREATE INDEX "AdSyncState_projectId_nextRunAt_idx" ON "AdSyncState"("projectId", "nextRunAt");

CREATE TABLE "AdProviderThrottle" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "usagePct" DECIMAL(6,2),
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "blockedUntil" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdProviderThrottle_pkey" PRIMARY KEY ("projectId", "scope", "bucket"),
  CONSTRAINT "AdProviderThrottle_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdProviderThrottle_bucket_check" CHECK ("bucket" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "AdProviderThrottle_usage_check" CHECK ("usagePct" >= 0)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['AdAccount','AdOAuthState','AdSyncState','AdProviderThrottle'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
