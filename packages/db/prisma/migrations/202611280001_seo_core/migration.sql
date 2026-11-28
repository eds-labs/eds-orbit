CREATE TABLE "SeoWebsite" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SeoWebsite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeoWebsite_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "SeoWebsite_project_fkey" FOREIGN KEY ("workspaceId", "projectId")
    REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SeoWebsite_active_url_key"
  ON "SeoWebsite" ("workspaceId", "projectId", "url") WHERE "archivedAt" IS NULL;

CREATE TABLE "SeoWebsiteProperty" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "websiteId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "connectionId" UUID NOT NULL,
  "propertyId" TEXT NOT NULL,
  CONSTRAINT "SeoWebsiteProperty_pkey" PRIMARY KEY ("workspaceId", "projectId", "websiteId", "provider"),
  CONSTRAINT "SeoWebsiteProperty_website_fkey" FOREIGN KEY ("workspaceId", "projectId", "websiteId")
    REFERENCES "SeoWebsite"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SeoOAuthState" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "appConnectionId" UUID NOT NULL,
  "accountConnectionId" UUID,
  "userId" TEXT NOT NULL,
  "verifierCiphertext" TEXT NOT NULL,
  "verifierKeyId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SeoOAuthState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeoOAuthState_project_fkey" FOREIGN KEY ("workspaceId", "projectId")
    REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SeoOAuthState_stateHash_key" ON "SeoOAuthState" ("stateHash");
CREATE INDEX "SeoOAuthState_workspaceId_projectId_expiresAt_idx"
  ON "SeoOAuthState" ("workspaceId", "projectId", "expiresAt");

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['SeoWebsite','SeoWebsiteProperty','SeoOAuthState'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$
      CREATE POLICY project_scope ON %I USING (
        "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND "projectId" = nullif(current_setting('app.project_id', true), '')::uuid
      ) WITH CHECK (
        "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
        AND "projectId" = nullif(current_setting('app.project_id', true), '')::uuid
      )
    $policy$, table_name);
  END LOOP;
END $$;
