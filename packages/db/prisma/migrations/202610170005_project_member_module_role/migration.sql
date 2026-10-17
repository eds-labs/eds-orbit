-- Module-level roles (Orbit Platform, WP4.5): a member's role in one module
-- overrides the project role there; 'none' hides the module for that member.
-- Additive: no existing row changes, and without rows every check is as before.
-- A tenancy table like ProjectMember: managed by orbit_auth, invisible to orbit_app.
CREATE TABLE "ProjectMemberModuleRole" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "changedBy" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMemberModuleRole_pkey" PRIMARY KEY ("projectId", "userId", "moduleId"),
  CONSTRAINT "ProjectMemberModuleRole_role_check" CHECK ("role" IN ('editor', 'viewer', 'none')),
  CONSTRAINT "ProjectMemberModuleRole_moduleId_check" CHECK ("moduleId" ~ '^[a-z][a-z0-9_]{1,30}$'),
  -- Overrides disappear with the project membership.
  CONSTRAINT "ProjectMemberModuleRole_member_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "ProjectMember"("projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectMemberModuleRole_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectMemberModuleRole_workspaceId_userId_idx" ON "ProjectMemberModuleRole"("workspaceId", "userId");

ALTER TABLE "ProjectMemberModuleRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMemberModuleRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ProjectMemberModuleRole"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
CREATE POLICY auth_control ON "ProjectMemberModuleRole" TO orbit_auth USING(true) WITH CHECK(true);
