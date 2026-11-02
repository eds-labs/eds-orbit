-- Social media library (ADR 0020, S3): one row per uploaded image. The
-- bytes are platform Files of the module (the normalized original and a
-- JPEG rendition); a purged file takes its library entry with it.

CREATE TABLE "SocialMediaAsset" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "jpegFileId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "size" INTEGER NOT NULL,
  "jpegWidth" INTEGER NOT NULL,
  "jpegHeight" INTEGER NOT NULL,
  "jpegSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "altText" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SocialMediaAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialMediaAsset_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialMediaAsset_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialMediaAsset_jpegFile_fkey" FOREIGN KEY ("projectId", "jpegFileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SocialMediaAsset_mime_check" CHECK ("mime" IN ('image/png','image/jpeg')),
  CONSTRAINT "SocialMediaAsset_size_check" CHECK ("width" > 0 AND "height" > 0 AND "size" > 0 AND "jpegWidth" > 0 AND "jpegHeight" > 0 AND "jpegSize" > 0),
  CONSTRAINT "SocialMediaAsset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SocialMediaAsset_name_check" CHECK (length("name") BETWEEN 1 AND 200),
  CONSTRAINT "SocialMediaAsset_altText_check" CHECK ("altText" IS NULL OR length("altText") <= 1000),
  CONSTRAINT "SocialMediaAsset_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "SocialMediaAsset_projectId_id_key" ON "SocialMediaAsset"("projectId", "id");
CREATE UNIQUE INDEX "SocialMediaAsset_projectId_fileId_key" ON "SocialMediaAsset"("projectId", "fileId");
CREATE INDEX "SocialMediaAsset_projectId_archivedAt_createdAt_idx" ON "SocialMediaAsset"("projectId", "archivedAt", "createdAt");

ALTER TABLE "SocialMediaAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SocialMediaAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SocialMediaAsset"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
