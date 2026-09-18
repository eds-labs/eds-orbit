-- Versioned project marketing configuration. Existing projects and entities are untouched.
CREATE TABLE "ProjectMarketingProfile" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ProjectMarketingProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMarketingProfile_projectId_key" UNIQUE ("projectId"),
  CONSTRAINT "ProjectMarketingProfile_workspaceId_projectId_key" UNIQUE ("workspaceId", "projectId"),
  CONSTRAINT "ProjectMarketingProfile_workspaceId_projectId_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "ProjectMarketingProfile_version_positive" CHECK ("version" > 0),
  CONSTRAINT "ProjectMarketingProfile_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectMarketingProfile_workspaceId_projectId_idx" ON "ProjectMarketingProfile"("workspaceId", "projectId");

CREATE TABLE "ProjectMarketingProfileVersion" (
  "profileId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMarketingProfileVersion_pkey" PRIMARY KEY ("profileId", "version"),
  CONSTRAINT "ProjectMarketingProfileVersion_profile_fkey" FOREIGN KEY ("workspaceId", "projectId", "profileId") REFERENCES "ProjectMarketingProfile"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectMarketingProfileVersion_workspaceId_projectId_idx" ON "ProjectMarketingProfileVersion"("workspaceId", "projectId");

ALTER TABLE "ProjectMarketingProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMarketingProfile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMarketingProfileVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMarketingProfileVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ProjectMarketingProfile"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
CREATE POLICY project_scope ON "ProjectMarketingProfileVersion"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
