-- Platform files (Orbit Platform, WP4.6): binary content lives encrypted in
-- object storage; this table holds what Orbit knows about each object. A
-- project table like Entity: the business role reads and writes it within
-- the project scope. Deleting sets "deletedAt" first (the file is gone for
-- every reader), then removes the object and the row; a cleanup retries
-- what failed, so no object outlives its row. Additive.
CREATE TABLE "File" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "moduleId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "encryption" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "File_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "File_key_key" UNIQUE ("key"),
  CONSTRAINT "File_moduleId_check" CHECK ("moduleId" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "File_size_check" CHECK ("size" >= 0),
  CONSTRAINT "File_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "File_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "File_workspaceId_projectId_moduleId_idx" ON "File"("workspaceId", "projectId", "moduleId");

ALTER TABLE "File" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "File" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "File"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
