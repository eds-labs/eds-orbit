-- Social module (ADR 0020, plan §5): connected social accounts, posts with
-- one variant per account, their media, publications (the only delivery
-- state machine), provider call records, outbound throttles, OAuth states,
-- metric snapshots and durable SDK store records. Every table is
-- project-scoped with forced row-level security; references between module
-- rows are composite ("projectId", id) keys, because foreign key checks
-- bypass RLS. Tokens never live here: they are sealed ConnectionSecrets.

CREATE TABLE "SocialAccount" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "handle" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarFileId" UUID,
  "status" TEXT NOT NULL DEFAULT 'active',
  "capability" TEXT NOT NULL DEFAULT 'configured',
  "writeVerifiedAt" TIMESTAMPTZ(3),
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "legacyPostizIntegrationId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt" TIMESTAMPTZ(3),
  CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialAccount_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialAccount_avatar_fkey" FOREIGN KEY ("projectId", "avatarFileId") REFERENCES "File"("projectId", "id") ON DELETE SET NULL ("avatarFileId"),
  CONSTRAINT "SocialAccount_platform_check" CHECK ("platform" IN ('instagram','facebook','x','telegram','linkedin','tiktok')),
  CONSTRAINT "SocialAccount_status_check" CHECK ("status" IN ('active','reconnect_required','disabled')),
  CONSTRAINT "SocialAccount_capability_check" CHECK ("capability" IN ('configured','read_verified','write_verified')),
  CONSTRAINT "SocialAccount_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "SocialAccount_projectId_id_key" ON "SocialAccount"("projectId", "id");
CREATE UNIQUE INDEX "SocialAccount_external_key" ON "SocialAccount"("projectId", "platform", "externalId");
CREATE UNIQUE INDEX "SocialAccount_legacy_key" ON "SocialAccount"("projectId", "legacyPostizIntegrationId") WHERE "legacyPostizIntegrationId" IS NOT NULL;
CREATE INDEX "SocialAccount_projectId_status_idx" ON "SocialAccount"("projectId", "status");

CREATE TABLE "SocialPost" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "title" TEXT,
  "scheduleMode" TEXT NOT NULL DEFAULT 'none',
  "scheduledAt" TIMESTAMPTZ(3),
  "scheduleTimezone" TEXT NOT NULL,
  "scheduleLocal" TEXT,
  "scheduleFold" TEXT,
  "packageHash" TEXT,
  "approvalRequestId" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "approvedBy" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'manual',
  "originModule" TEXT,
  "originType" TEXT,
  "originId" UUID,
  "originVersion" INTEGER,
  "readOnly" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPost_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPost_status_check" CHECK ("status" IN ('draft','needs_approval','approved','scheduled','publishing','published','partially_published','failed','canceled','archived')),
  CONSTRAINT "SocialPost_origin_check" CHECK ("origin" IN ('manual','marketing','mcp','assistant','legacy_postiz')),
  CONSTRAINT "SocialPost_scheduleMode_check" CHECK ("scheduleMode" IN ('none','at','now')),
  CONSTRAINT "SocialPost_scheduleFold_check" CHECK ("scheduleFold" IS NULL OR "scheduleFold" IN ('earlier','later')),
  -- A post scheduled for a time has that time.
  CONSTRAINT "SocialPost_schedule_check" CHECK ("scheduleMode" <> 'at' OR "scheduledAt" IS NOT NULL),
  CONSTRAINT "SocialPost_scheduleLocal_check" CHECK ("scheduleLocal" IS NULL OR "scheduleLocal" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  -- Mirrored Postiz history is read-only, and only it is.
  CONSTRAINT "SocialPost_readonly_check" CHECK ("readOnly" = ("origin" = 'legacy_postiz')),
  CONSTRAINT "SocialPost_packageHash_check" CHECK ("packageHash" IS NULL OR "packageHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SocialPost_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "SocialPost_projectId_id_key" ON "SocialPost"("projectId", "id");
CREATE INDEX "SocialPost_projectId_scheduledAt_idx" ON "SocialPost"("projectId", "scheduledAt");
CREATE INDEX "SocialPost_projectId_status_idx" ON "SocialPost"("projectId", "status");
CREATE INDEX "SocialPost_projectId_origin_idx" ON "SocialPost"("projectId", "origin");

CREATE TABLE "SocialPostVariant" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "postId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "platformOptions" JSONB NOT NULL DEFAULT '{}',
  "contentHash" TEXT NOT NULL,
  "validation" JSONB NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPostVariant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostVariant_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPostVariant_post_fkey" FOREIGN KEY ("projectId", "postId") REFERENCES "SocialPost"("projectId", "id") ON DELETE CASCADE,
  -- An account with variants is disabled, never deleted.
  CONSTRAINT "SocialPostVariant_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "SocialAccount"("projectId", "id") ON DELETE RESTRICT,
  CONSTRAINT "SocialPostVariant_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SocialPostVariant_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "SocialPostVariant_projectId_id_key" ON "SocialPostVariant"("projectId", "id");
CREATE UNIQUE INDEX "SocialPostVariant_postId_accountId_key" ON "SocialPostVariant"("postId", "accountId");
CREATE INDEX "SocialPostVariant_projectId_accountId_idx" ON "SocialPostVariant"("projectId", "accountId");

CREATE TABLE "SocialPostMedia" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "altText" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPostMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostMedia_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPostMedia_variant_fkey" FOREIGN KEY ("projectId", "variantId") REFERENCES "SocialPostVariant"("projectId", "id") ON DELETE CASCADE,
  -- A purged platform file takes its media references with it, as for the
  -- other modules' attachments; a post whose medium vanished no longer
  -- matches its package hash, so its approval is stale.
  CONSTRAINT "SocialPostMedia_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialPostMedia_kind_check" CHECK ("kind" IN ('image','video')),
  CONSTRAINT "SocialPostMedia_position_check" CHECK ("position" BETWEEN 0 AND 34),
  CONSTRAINT "SocialPostMedia_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SocialPostMedia_size_check" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0) AND ("durationMs" IS NULL OR "durationMs" > 0))
);
CREATE UNIQUE INDEX "SocialPostMedia_projectId_id_key" ON "SocialPostMedia"("projectId", "id");
CREATE UNIQUE INDEX "SocialPostMedia_variantId_position_key" ON "SocialPostMedia"("variantId", "position");

CREATE TABLE "SocialPublication" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "blockedCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "fence" UUID,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3),
  "externalPostId" TEXT,
  "permalink" TEXT,
  "providerState" JSONB NOT NULL DEFAULT '{}',
  "lastErrorCode" TEXT,
  "retryDisposition" TEXT,
  "claimedAt" TIMESTAMPTZ(3),
  "publishedAt" TIMESTAMPTZ(3),
  "resolution" TEXT,
  "resolvedBy" TEXT,
  "legacyEntityId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPublication_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPublication_variant_fkey" FOREIGN KEY ("projectId", "variantId") REFERENCES "SocialPostVariant"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialPublication_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "SocialAccount"("projectId", "id") ON DELETE RESTRICT,
  CONSTRAINT "SocialPublication_status_check" CHECK ("status" IN ('pending','claimed','sending','accepted','processing','published','failed','outcome_unknown','cancel_requested','canceled','blocked')),
  CONSTRAINT "SocialPublication_blocked_check" CHECK ("status" <> 'blocked' OR "blockedCode" IS NOT NULL),
  CONSTRAINT "SocialPublication_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('published_confirmed','not_published')),
  CONSTRAINT "SocialPublication_retry_check" CHECK ("retryDisposition" IS NULL OR "retryDisposition" IN ('never','after-delay','after-reconnect','reconcile-first')),
  CONSTRAINT "SocialPublication_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "SocialPublication_idempotencyKey_check" CHECK (length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "SocialPublication_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "SocialPublication_idempotencyKey_key" ON "SocialPublication"("idempotencyKey");
CREATE UNIQUE INDEX "SocialPublication_projectId_id_key" ON "SocialPublication"("projectId", "id");
CREATE UNIQUE INDEX "SocialPublication_legacy_key" ON "SocialPublication"("projectId", "legacyEntityId") WHERE "legacyEntityId" IS NOT NULL;
CREATE INDEX "SocialPublication_projectId_status_nextAttemptAt_idx" ON "SocialPublication"("projectId", "status", "nextAttemptAt");
CREATE INDEX "SocialPublication_projectId_variantId_idx" ON "SocialPublication"("projectId", "variantId");
CREATE INDEX "SocialPublication_projectId_accountId_publishedAt_idx" ON "SocialPublication"("projectId", "accountId", "publishedAt");

CREATE TABLE "SocialDeliveryAttempt" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "publicationId" UUID NOT NULL,
  "step" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "providerCode" TEXT,
  "retryAfterMs" INTEGER,
  "requestHash" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SocialDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialDeliveryAttempt_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialDeliveryAttempt_publication_fkey" FOREIGN KEY ("projectId", "publicationId") REFERENCES "SocialPublication"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialDeliveryAttempt_step_check" CHECK ("step" IN ('upload','container','publish','status','cancel','delete')),
  CONSTRAINT "SocialDeliveryAttempt_outcome_check" CHECK ("outcome" IN ('not_sent','rejected','unknown','ok')),
  CONSTRAINT "SocialDeliveryAttempt_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SocialDeliveryAttempt_retryAfter_check" CHECK ("retryAfterMs" IS NULL OR "retryAfterMs" >= 0)
);
CREATE UNIQUE INDEX "SocialDeliveryAttempt_projectId_id_key" ON "SocialDeliveryAttempt"("projectId", "id");
CREATE INDEX "SocialDeliveryAttempt_projectId_publicationId_startedAt_idx" ON "SocialDeliveryAttempt"("projectId", "publicationId", "startedAt");

CREATE TABLE "SocialAccountThrottle" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "window" TEXT NOT NULL,
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "blockedUntil" TIMESTAMPTZ(3),
  CONSTRAINT "SocialAccountThrottle_pkey" PRIMARY KEY ("accountId", "window", "windowStart"),
  CONSTRAINT "SocialAccountThrottle_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialAccountThrottle_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "SocialAccount"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialAccountThrottle_window_check" CHECK ("window" IN ('minute','hour','day')),
  CONSTRAINT "SocialAccountThrottle_count_check" CHECK ("count" >= 0)
);
CREATE INDEX "SocialAccountThrottle_projectId_accountId_idx" ON "SocialAccountThrottle"("projectId", "accountId");

CREATE TABLE "SocialOAuthState" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "appConnectionId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "codeVerifierCiphertext" TEXT NOT NULL,
  "redirectAfter" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialOAuthState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialOAuthState_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialOAuthState_platform_check" CHECK ("platform" IN ('instagram','facebook','x','telegram','linkedin','tiktok')),
  CONSTRAINT "SocialOAuthState_expiry_check" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "SocialOAuthState_stateHash_key" ON "SocialOAuthState"("stateHash");
CREATE UNIQUE INDEX "SocialOAuthState_projectId_id_key" ON "SocialOAuthState"("projectId", "id");

CREATE TABLE "SocialMetricSnapshot" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "publicationId" UUID NOT NULL,
  "metric" TEXT NOT NULL,
  "value" DECIMAL(24,6) NOT NULL,
  "unit" TEXT,
  "period" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SocialMetricSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialMetricSnapshot_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialMetricSnapshot_publication_fkey" FOREIGN KEY ("projectId", "publicationId") REFERENCES "SocialPublication"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialMetricSnapshot_metric_check" CHECK ("metric" ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE UNIQUE INDEX "SocialMetricSnapshot_projectId_id_key" ON "SocialMetricSnapshot"("projectId", "id");
CREATE UNIQUE INDEX "SocialMetricSnapshot_publicationId_metric_period_observedAt_key" ON "SocialMetricSnapshot"("publicationId", "metric", "period", "observedAt");

CREATE TABLE "SocialProviderState" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "namespace" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "body" JSONB NOT NULL,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialProviderState_pkey" PRIMARY KEY ("projectId", "namespace", "recordKey"),
  CONSTRAINT "SocialProviderState_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialProviderState_revision_check" CHECK ("revision" >= 0)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['SocialAccount','SocialPost','SocialPostVariant','SocialPostMedia','SocialPublication','SocialDeliveryAttempt','SocialAccountThrottle','SocialOAuthState','SocialMetricSnapshot','SocialProviderState'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
