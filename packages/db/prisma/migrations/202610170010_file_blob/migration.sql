-- Platform file content in the database (Orbit Platform, WP4.6 backend B,
-- Mario 2026-10-17): the encrypted object of a file when FILES_BACKEND is
-- "database". Same object key and encryption as the S3 backend; the rows
-- go with the database backup and with their project. A project table:
-- the business role reads and writes it within the project scope. Additive.
CREATE TABLE "FileBlob" (
  "key" TEXT NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileBlob_pkey" PRIMARY KEY ("key"),
  -- The key names the project; a blob is stored under its own project only.
  CONSTRAINT "FileBlob_key_check" CHECK ("key" LIKE 'projects/' || "projectId"::text || '/%'),
  CONSTRAINT "FileBlob_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FileBlob_workspaceId_projectId_idx" ON "FileBlob"("workspaceId", "projectId");

ALTER TABLE "FileBlob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FileBlob" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FileBlob"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
