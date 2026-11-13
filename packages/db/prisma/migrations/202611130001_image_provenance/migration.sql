-- Central image provenance (ADR 0028): one immutable record per exact byte
-- version of an image in a project, keyed by its SHA-256. It says where the
-- image came from (AI or an original upload), whether it carries the visible
-- "KI erstellt" label and where, and what the bytes declared about
-- themselves (XMP fields, an embedded C2PA manifest). Records are only
-- inserted; the business role has no UPDATE or DELETE (project deletion
-- still cascades).

CREATE TABLE "ImageProvenance" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sha256" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "labelState" TEXT NOT NULL,
  "labelVersion" INTEGER,
  "labelBox" JSONB,
  "labelContrast" DOUBLE PRECISION,
  "digitalSourceType" TEXT,
  "parentSha256" TEXT,
  "componentSha256s" TEXT[] NOT NULL DEFAULT '{}',
  "embedded" JSONB,
  "c2paManifest" BYTEA,
  "subjectModule" TEXT NOT NULL,
  "subjectKind" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageProvenance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImageProvenance_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ImageProvenance_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ImageProvenance_origin_check" CHECK ("origin" IN ('ai_generated','ai_substantially_modified','original_upload')),
  CONSTRAINT "ImageProvenance_labelState_check" CHECK ("labelState" IN ('labeled','not_required','unlabeled_source')),
  CONSTRAINT "ImageProvenance_labeled_check" CHECK ("labelState" <> 'labeled' OR ("labelBox" IS NOT NULL AND "labelVersion" IS NOT NULL)),
  CONSTRAINT "ImageProvenance_original_check" CHECK (("origin" = 'original_upload') = ("labelState" = 'not_required')),
  CONSTRAINT "ImageProvenance_labelVersion_check" CHECK ("labelVersion" IS NULL OR "labelVersion" >= 1),
  CONSTRAINT "ImageProvenance_labelBox_check" CHECK ("labelBox" IS NULL OR jsonb_typeof("labelBox") = 'object'),
  CONSTRAINT "ImageProvenance_labelContrast_check" CHECK ("labelContrast" IS NULL OR "labelContrast" > 0),
  CONSTRAINT "ImageProvenance_digitalSourceType_check" CHECK ("digitalSourceType" IS NULL OR length("digitalSourceType") BETWEEN 1 AND 200),
  CONSTRAINT "ImageProvenance_parentSha256_check" CHECK ("parentSha256" IS NULL OR "parentSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ImageProvenance_componentSha256s_check" CHECK (cardinality("componentSha256s") <= 64 AND array_to_string("componentSha256s", ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  CONSTRAINT "ImageProvenance_embedded_check" CHECK ("embedded" IS NULL OR jsonb_typeof("embedded") = 'object'),
  CONSTRAINT "ImageProvenance_c2paManifest_check" CHECK ("c2paManifest" IS NULL OR octet_length("c2paManifest") BETWEEN 1 AND 1048576),
  CONSTRAINT "ImageProvenance_subject_check" CHECK (length("subjectModule") BETWEEN 1 AND 64 AND length("subjectKind") BETWEEN 1 AND 64 AND length("subjectId") BETWEEN 1 AND 200),
  CONSTRAINT "ImageProvenance_createdBy_check" CHECK (length("createdBy") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "ImageProvenance_projectId_id_key" ON "ImageProvenance"("projectId", "id");
CREATE UNIQUE INDEX "ImageProvenance_projectId_sha256_key" ON "ImageProvenance"("projectId", "sha256");
CREATE INDEX "ImageProvenance_projectId_parentSha256_idx" ON "ImageProvenance"("projectId", "parentSha256");

ALTER TABLE "ImageProvenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImageProvenance" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ImageProvenance"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
