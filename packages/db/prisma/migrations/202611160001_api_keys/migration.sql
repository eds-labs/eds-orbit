-- Project API keys and request idempotency for the versioned /api/v1 routes
-- (ADR 0029, CH1.1/CH1.2). Additive.
--
-- ApiKey is a tenancy table like PublicClientKey: orbit_auth resolves a key
-- without a project scope, orbit_app has no grant. Only the SHA-256 of the
-- 256-bit secret is stored; the full token is shown once at creation. Keys
-- are revoked, never edited: scopes, filter and expiry are fixed.
CREATE TABLE "ApiKey" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "resourceFilter" JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3),
  "lastUsedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "revokedBy" TEXT,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApiKey_prefix_key" UNIQUE ("prefix"),
  CONSTRAINT "ApiKey_workspace_project_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "ApiKey_prefix_check" CHECK ("prefix" ~ '^ok_[a-z2-7]{12}$'),
  CONSTRAINT "ApiKey_secretHash_check" CHECK ("secretHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ApiKey_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "ApiKey_scopes_check" CHECK (
    cardinality("scopes") BETWEEN 1 AND 20
    AND array_to_string("scopes", ' ') ~ '^[a-z][a-z0-9_]{1,30}:[a-z][a-z0-9_.]{1,40}( [a-z][a-z0-9_]{1,30}:[a-z][a-z0-9_.]{1,40})*$'
  ),
  CONSTRAINT "ApiKey_resourceFilter_check" CHECK (jsonb_typeof("resourceFilter") = 'object'),
  CONSTRAINT "ApiKey_expiry_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
  CONSTRAINT "ApiKey_revoked_check" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL)),
  CONSTRAINT "ApiKey_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ApiKey_workspaceId_projectId_idx" ON "ApiKey"("workspaceId", "projectId");

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ApiKey"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
CREATE POLICY auth_control ON "ApiKey" TO orbit_auth USING(true) WITH CHECK(true);

-- A key's identity, scopes and filter never change after creation.
CREATE FUNCTION "ApiKey_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."prefix" IS DISTINCT FROM OLD."prefix"
     OR NEW."secretHash" IS DISTINCT FROM OLD."secretHash"
     OR NEW."scopes" IS DISTINCT FROM OLD."scopes"
     OR NEW."resourceFilter" IS DISTINCT FROM OLD."resourceFilter"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'API_KEY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ApiKey_immutable" BEFORE UPDATE ON "ApiKey"
  FOR EACH ROW EXECUTE FUNCTION "ApiKey_immutable"();

-- Stored answers to v1 writes with an Idempotency-Key header, for 24 hours.
-- Business table: written in the key's project scope.
CREATE TABLE "ApiIdempotencyKey" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "apiKeyId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ApiIdempotencyKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApiIdempotencyKey_apiKeyId_key_key" UNIQUE ("apiKeyId", "key"),
  CONSTRAINT "ApiIdempotencyKey_key_check" CHECK ("key" ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  CONSTRAINT "ApiIdempotencyKey_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ApiIdempotencyKey_status_check" CHECK ("responseStatus" BETWEEN 200 AND 599),
  CONSTRAINT "ApiIdempotencyKey_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "ApiIdempotencyKey_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ApiIdempotencyKey_apiKey_fkey" FOREIGN KEY ("workspaceId", "projectId", "apiKeyId") REFERENCES "ApiKey"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ApiIdempotencyKey_expiresAt_idx" ON "ApiIdempotencyKey"("expiresAt");
CREATE INDEX "ApiIdempotencyKey_workspaceId_projectId_idx" ON "ApiIdempotencyKey"("workspaceId", "projectId");

ALTER TABLE "ApiIdempotencyKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiIdempotencyKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ApiIdempotencyKey"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
