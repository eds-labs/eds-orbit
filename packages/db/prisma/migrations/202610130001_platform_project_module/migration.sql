-- Module activation per project (Orbit Platform, ADR 0009 AD-06, WP1.4).
-- Additive: existing tables and rows are untouched. A missing row means the
-- module's registry default applies; a row records an explicit choice.
CREATE TABLE "ProjectModule" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "moduleId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "settingsVersion" INTEGER NOT NULL DEFAULT 1,
  "moduleVersion" TEXT NOT NULL,
  "changedBy" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectModule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectModule_workspaceId_projectId_moduleId_key" UNIQUE ("workspaceId", "projectId", "moduleId"),
  CONSTRAINT "ProjectModule_moduleId_check" CHECK ("moduleId" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "ProjectModule_settingsVersion_positive" CHECK ("settingsVersion" > 0),
  CONSTRAINT "ProjectModule_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Today every project uses knowledge and marketing; record that explicitly so
-- a later change of a registry default never switches an existing project.
INSERT INTO "ProjectModule" ("id", "workspaceId", "projectId", "moduleId", "enabled", "moduleVersion", "changedBy")
SELECT gen_random_uuid(), p."workspaceId", p."id", m."moduleId", true, '1.0.0', 'migration'
FROM "Project" p CROSS JOIN (VALUES ('knowledge'), ('marketing')) AS m("moduleId");

ALTER TABLE "ProjectModule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectModule" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ProjectModule"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
