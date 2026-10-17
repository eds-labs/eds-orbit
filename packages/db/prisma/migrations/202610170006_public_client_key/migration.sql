-- Public client keys (Orbit Platform, WP4.2b): a module's public API for one
-- project, used by browsers on the key's allowed origins (a support widget).
-- The key identifies the project, it is no secret; sessions carry a bearer
-- token. Additive. A tenancy table: orbit_auth reads it without a project
-- scope to resolve the key, orbit_app has no grant.
CREATE TABLE "PublicClientKey" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "moduleId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "allowedOrigins" TEXT[] NOT NULL DEFAULT '{}',
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "PublicClientKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicClientKey_publicKey_key" UNIQUE ("publicKey"),
  CONSTRAINT "PublicClientKey_publicKey_check" CHECK ("publicKey" ~ '^pk_[A-Za-z0-9_-]{32,64}$'),
  CONSTRAINT "PublicClientKey_moduleId_check" CHECK ("moduleId" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "PublicClientKey_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PublicClientKey_workspaceId_projectId_idx" ON "PublicClientKey"("workspaceId", "projectId");

ALTER TABLE "PublicClientKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicClientKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "PublicClientKey"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
CREATE POLICY auth_control ON "PublicClientKey" TO orbit_auth USING(true) WITH CHECK(true);
