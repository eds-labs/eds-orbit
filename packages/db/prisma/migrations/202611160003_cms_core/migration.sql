-- Content module core (ADR 0029, CH1.6): entries with one working draft and
-- immutable revisions, taxonomies, authors, image assets, websites,
-- publications with their attempt log, and redirects. Additive; all tables
-- are business tables in the project scope with composite tenant keys and
-- FORCE RLS. Published history is kept: revisions and attempts are
-- insert-only, an entry that was ever published cannot be deleted (archive
-- it), publications are never deleted. Project deletion still cascades.

CREATE TABLE "CmsAuthor" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "bio" JSONB NOT NULL DEFAULT '{}',
  "avatarAssetId" UUID,
  "sameAs" TEXT[] NOT NULL DEFAULT '{}',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsAuthor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsAuthor_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsAuthor_slug_key" UNIQUE ("projectId", "slug"),
  CONSTRAINT "CmsAuthor_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "CmsAuthor_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80),
  CONSTRAINT "CmsAuthor_bio_check" CHECK (jsonb_typeof("bio") = 'object'),
  CONSTRAINT "CmsAuthor_sameAs_check" CHECK (cardinality("sameAs") <= 10),
  CONSTRAINT "CmsAuthor_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CmsAsset" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "mime" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "alt" JSONB NOT NULL DEFAULT '{}',
  "caption" JSONB NOT NULL DEFAULT '{}',
  "credit" TEXT,
  "license" TEXT,
  "provenanceId" UUID,
  "focalPoint" JSONB,
  "variants" JSONB NOT NULL DEFAULT '[]',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsAsset_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsAsset_mime_check" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  CONSTRAINT "CmsAsset_size_check" CHECK ("width" BETWEEN 1 AND 20000 AND "height" BETWEEN 1 AND 20000 AND "bytes" > 0),
  CONSTRAINT "CmsAsset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CmsAsset_text_check" CHECK (jsonb_typeof("alt") = 'object' AND jsonb_typeof("caption") = 'object' AND jsonb_typeof("variants") = 'array'),
  CONSTRAINT "CmsAsset_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A referenced file cannot disappear under content (checked at the end of
  -- the statement, so deleting the whole project still cascades).
  CONSTRAINT "CmsAsset_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id")
);
CREATE INDEX "CmsAsset_projectId_sha256_idx" ON "CmsAsset"("projectId", "sha256");

ALTER TABLE "CmsAuthor" ADD CONSTRAINT "CmsAuthor_avatar_fkey" FOREIGN KEY ("workspaceId", "projectId", "avatarAssetId") REFERENCES "CmsAsset"("workspaceId", "projectId", "id");

CREATE TABLE "CmsTaxonomyTerm" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "translationGroupId" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "parentId" UUID,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsTaxonomyTerm_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsTaxonomyTerm_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsTaxonomyTerm_slug_key" UNIQUE ("projectId", "kind", "locale", "slug"),
  CONSTRAINT "CmsTaxonomyTerm_translation_key" UNIQUE ("projectId", "translationGroupId", "locale"),
  CONSTRAINT "CmsTaxonomyTerm_kind_check" CHECK ("kind" IN ('category', 'tag')),
  CONSTRAINT "CmsTaxonomyTerm_locale_check" CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "CmsTaxonomyTerm_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80),
  CONSTRAINT "CmsTaxonomyTerm_name_check" CHECK (char_length("name") BETWEEN 1 AND 120 AND char_length(coalesce("description", '')) <= 1000),
  CONSTRAINT "CmsTaxonomyTerm_parent_check" CHECK ("parentId" IS NULL OR ("kind" = 'category' AND "parentId" <> "id")),
  CONSTRAINT "CmsTaxonomyTerm_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CmsTaxonomyTerm_parent_fkey" FOREIGN KEY ("workspaceId", "projectId", "parentId") REFERENCES "CmsTaxonomyTerm"("workspaceId", "projectId", "id")
);

CREATE TABLE "CmsSite" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "locales" TEXT[] NOT NULL,
  "defaultLocale" TEXT NOT NULL,
  "routes" JSONB NOT NULL DEFAULT '{}',
  "trailingSlash" BOOLEAN NOT NULL DEFAULT true,
  "adapter" TEXT NOT NULL DEFAULT 'orbit_pull',
  "adapterConfig" JSONB NOT NULL DEFAULT '{}',
  "notifiers" JSONB NOT NULL DEFAULT '[]',
  "contentRules" JSONB NOT NULL DEFAULT '{}',
  "verification" TEXT NOT NULL DEFAULT 'configured',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsSite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsSite_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsSite_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "CmsSite_baseUrl_check" CHECK ("baseUrl" ~ '^https://[^\s@/?#]+$' AND char_length("baseUrl") <= 255),
  CONSTRAINT "CmsSite_locales_check" CHECK (cardinality("locales") BETWEEN 1 AND 20 AND "defaultLocale" = ANY ("locales")),
  CONSTRAINT "CmsSite_adapter_check" CHECK ("adapter" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "CmsSite_json_check" CHECK (jsonb_typeof("routes") = 'object' AND jsonb_typeof("adapterConfig") = 'object' AND jsonb_typeof("notifiers") = 'array' AND jsonb_typeof("contentRules") = 'object'),
  CONSTRAINT "CmsSite_verification_check" CHECK ("verification" IN ('configured', 'read_verified', 'live_verified')),
  CONSTRAINT "CmsSite_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CmsEntry" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "translationGroupId" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "publishedRevisionId" UUID,
  "scheduledRevisionId" UUID,
  "scheduledAt" TIMESTAMPTZ(3),
  "firstPublishedAt" TIMESTAMPTZ(3),
  "lastPublishedAt" TIMESTAMPTZ(3),
  "archivedAt" TIMESTAMPTZ(3),
  "origin" TEXT NOT NULL DEFAULT 'manual',
  "originRef" JSONB,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsEntry_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsEntry_slug_key" UNIQUE ("projectId", "type", "locale", "slug"),
  CONSTRAINT "CmsEntry_translation_key" UNIQUE ("projectId", "translationGroupId", "locale"),
  CONSTRAINT "CmsEntry_type_check" CHECK ("type" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "CmsEntry_locale_check" CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "CmsEntry_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 120),
  CONSTRAINT "CmsEntry_origin_check" CHECK ("origin" IN ('manual', 'assistant', 'marketing', 'api', 'mcp', 'import')),
  CONSTRAINT "CmsEntry_status_check" CHECK (
    ("status" = 'draft' AND "publishedRevisionId" IS NULL AND "archivedAt" IS NULL)
    OR ("status" = 'in_review' AND "archivedAt" IS NULL)
    OR ("status" = 'scheduled' AND "scheduledRevisionId" IS NOT NULL AND "scheduledAt" IS NOT NULL AND "archivedAt" IS NULL)
    OR ("status" = 'published' AND "publishedRevisionId" IS NOT NULL AND "archivedAt" IS NULL)
    OR ("status" = 'archived' AND "archivedAt" IS NOT NULL AND "publishedRevisionId" IS NULL AND "scheduledRevisionId" IS NULL)
  ),
  CONSTRAINT "CmsEntry_schedule_check" CHECK (("scheduledRevisionId" IS NULL) = ("scheduledAt" IS NULL)),
  CONSTRAINT "CmsEntry_published_check" CHECK ("publishedRevisionId" IS NULL OR ("firstPublishedAt" IS NOT NULL AND "lastPublishedAt" IS NOT NULL)),
  CONSTRAINT "CmsEntry_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CmsEntry_projectId_type_status_idx" ON "CmsEntry"("projectId", "type", "status");
CREATE INDEX "CmsEntry_projectId_updatedAt_idx" ON "CmsEntry"("projectId", "updatedAt");

CREATE TABLE "CmsDraft" (
  "entryId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "excerpt" TEXT NOT NULL DEFAULT '',
  "body" JSONB NOT NULL,
  "fields" JSONB NOT NULL DEFAULT '{}',
  "seo" JSONB NOT NULL DEFAULT '{}',
  "heroAssetId" UUID,
  "authorIds" UUID[] NOT NULL DEFAULT '{}',
  "termIds" UUID[] NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsDraft_pkey" PRIMARY KEY ("entryId"),
  CONSTRAINT "CmsDraft_text_check" CHECK (char_length("title") <= 200 AND char_length("excerpt") <= 500),
  CONSTRAINT "CmsDraft_body_check" CHECK (jsonb_typeof("body") = 'object' AND coalesce("body"->>'schema', '') = 'orbit-doc' AND octet_length("body"::text) <= 1048576),
  CONSTRAINT "CmsDraft_json_check" CHECK (jsonb_typeof("fields") = 'object' AND jsonb_typeof("seo") = 'object' AND octet_length("fields"::text) <= 262144),
  CONSTRAINT "CmsDraft_refs_check" CHECK (cardinality("authorIds") <= 10 AND cardinality("termIds") <= 50),
  CONSTRAINT "CmsDraft_entry_fkey" FOREIGN KEY ("workspaceId", "projectId", "entryId") REFERENCES "CmsEntry"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsDraft_hero_fkey" FOREIGN KEY ("workspaceId", "projectId", "heroAssetId") REFERENCES "CmsAsset"("workspaceId", "projectId", "id")
);

CREATE TABLE "CmsRevision" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "entryId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "body" JSONB NOT NULL,
  "fields" JSONB NOT NULL,
  "seo" JSONB NOT NULL,
  "heroAssetId" UUID,
  "authorIds" UUID[] NOT NULL,
  "termIds" UUID[] NOT NULL,
  "contentHash" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "wordCount" INTEGER NOT NULL,
  "changeNote" TEXT,
  "basedOnRevisionId" UUID,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsRevision_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsRevision_number_key" UNIQUE ("entryId", "number"),
  CONSTRAINT "CmsRevision_entry_tenant_key" UNIQUE ("workspaceId", "projectId", "entryId", "id"),
  CONSTRAINT "CmsRevision_number_check" CHECK ("number" >= 1 AND "wordCount" >= 0),
  CONSTRAINT "CmsRevision_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$' AND "bodyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CmsRevision_body_check" CHECK (jsonb_typeof("body") = 'object' AND coalesce("body"->>'schema', '') = 'orbit-doc'),
  CONSTRAINT "CmsRevision_note_check" CHECK (char_length(coalesce("changeNote", '')) <= 500),
  CONSTRAINT "CmsRevision_entry_fkey" FOREIGN KEY ("workspaceId", "projectId", "entryId") REFERENCES "CmsEntry"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsRevision_hero_fkey" FOREIGN KEY ("workspaceId", "projectId", "heroAssetId") REFERENCES "CmsAsset"("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsRevision_basedOn_fkey" FOREIGN KEY ("workspaceId", "projectId", "basedOnRevisionId") REFERENCES "CmsRevision"("workspaceId", "projectId", "id") ON DELETE SET NULL ("basedOnRevisionId")
);

-- An entry's live and scheduled revisions must be its own.
ALTER TABLE "CmsEntry" ADD CONSTRAINT "CmsEntry_published_fkey" FOREIGN KEY ("workspaceId", "projectId", "id", "publishedRevisionId") REFERENCES "CmsRevision"("workspaceId", "projectId", "entryId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "CmsEntry" ADD CONSTRAINT "CmsEntry_scheduled_fkey" FOREIGN KEY ("workspaceId", "projectId", "id", "scheduledRevisionId") REFERENCES "CmsRevision"("workspaceId", "projectId", "entryId", "id") DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "CmsEntrySite" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "entryId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsEntrySite_pkey" PRIMARY KEY ("entryId", "siteId"),
  CONSTRAINT "CmsEntrySite_entry_fkey" FOREIGN KEY ("workspaceId", "projectId", "entryId") REFERENCES "CmsEntry"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsEntrySite_site_fkey" FOREIGN KEY ("workspaceId", "projectId", "siteId") REFERENCES "CmsSite"("workspaceId", "projectId", "id") ON DELETE CASCADE
);
CREATE INDEX "CmsEntrySite_siteId_idx" ON "CmsEntrySite"("siteId");

CREATE TABLE "CmsPublication" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "entryId" UUID NOT NULL,
  "revisionId" UUID,
  "siteId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "idempotencyKey" TEXT NOT NULL,
  "fence" UUID,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "approvalRequestId" UUID,
  "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
  "claimedAt" TIMESTAMPTZ(3),
  "visibleAt" TIMESTAMPTZ(3),
  "notifiedAt" TIMESTAMPTZ(3),
  "liveVerifiedAt" TIMESTAMPTZ(3),
  "errorCode" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CmsPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsPublication_tenant_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "CmsPublication_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "CmsPublication_action_check" CHECK ("action" IN ('publish', 'update', 'unpublish')),
  CONSTRAINT "CmsPublication_revision_check" CHECK (("action" = 'unpublish') = ("revisionId" IS NULL)),
  CONSTRAINT "CmsPublication_status_check" CHECK ("status" IN ('queued', 'claimed', 'sending', 'outcome_unknown', 'visible', 'notified', 'live_verified', 'needs_attention', 'cancelled', 'failed')),
  CONSTRAINT "CmsPublication_key_check" CHECK ("idempotencyKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CmsPublication_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "CmsPublication_entry_fkey" FOREIGN KEY ("workspaceId", "projectId", "entryId") REFERENCES "CmsEntry"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsPublication_revision_fkey" FOREIGN KEY ("workspaceId", "projectId", "entryId", "revisionId") REFERENCES "CmsRevision"("workspaceId", "projectId", "entryId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsPublication_site_fkey" FOREIGN KEY ("workspaceId", "projectId", "siteId") REFERENCES "CmsSite"("workspaceId", "projectId", "id") ON DELETE CASCADE
);
CREATE INDEX "CmsPublication_entryId_createdAt_idx" ON "CmsPublication"("entryId", "createdAt");
CREATE INDEX "CmsPublication_projectId_status_scheduledAt_idx" ON "CmsPublication"("projectId", "status", "scheduledAt");

CREATE TABLE "CmsPublicationAttempt" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "publicationId" UUID NOT NULL,
  "step" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "durationMs" INTEGER,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsPublicationAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsPublicationAttempt_step_check" CHECK ("step" ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "CmsPublicationAttempt_outcome_check" CHECK ("outcome" IN ('ok', 'failed', 'unknown', 'skipped')),
  CONSTRAINT "CmsPublicationAttempt_detail_check" CHECK (jsonb_typeof("detail") = 'object' AND octet_length("detail"::text) <= 4096),
  CONSTRAINT "CmsPublicationAttempt_publication_fkey" FOREIGN KEY ("workspaceId", "projectId", "publicationId") REFERENCES "CmsPublication"("workspaceId", "projectId", "id") ON DELETE CASCADE
);
CREATE INDEX "CmsPublicationAttempt_publicationId_createdAt_idx" ON "CmsPublicationAttempt"("publicationId", "createdAt");

CREATE TABLE "CmsRedirect" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "fromPath" TEXT NOT NULL,
  "toEntryId" UUID,
  "toPath" TEXT,
  "code" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMPTZ(3),
  CONSTRAINT "CmsRedirect_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CmsRedirect_path_check" CHECK ("fromPath" ~ '^/[^\s?#]*$' AND char_length("fromPath") <= 500 AND ("toPath" IS NULL OR ("toPath" ~ '^/[^\s?#]*$' AND char_length("toPath") <= 500))),
  CONSTRAINT "CmsRedirect_target_check" CHECK (
    ("code" = 410 AND "toEntryId" IS NULL AND "toPath" IS NULL)
    OR ("code" = 301 AND (("toEntryId" IS NULL) <> ("toPath" IS NULL)))
  ),
  CONSTRAINT "CmsRedirect_reason_check" CHECK ("reason" IN ('slug_changed', 'archived', 'manual')),
  CONSTRAINT "CmsRedirect_site_fkey" FOREIGN KEY ("workspaceId", "projectId", "siteId") REFERENCES "CmsSite"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "CmsRedirect_toEntry_fkey" FOREIGN KEY ("workspaceId", "projectId", "toEntryId") REFERENCES "CmsEntry"("workspaceId", "projectId", "id") ON DELETE SET NULL ("toEntryId")
);
CREATE UNIQUE INDEX "CmsRedirect_active_from_key" ON "CmsRedirect"("siteId", "fromPath") WHERE "removedAt" IS NULL;

-- Revisions and attempts are the record of what was published: never changed.
CREATE FUNCTION "cms_insert_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CMS_RECORD_IMMUTABLE';
END $$;
CREATE TRIGGER "CmsRevision_insert_only" BEFORE UPDATE ON "CmsRevision"
  FOR EACH ROW EXECUTE FUNCTION "cms_insert_only"();
CREATE TRIGGER "CmsPublicationAttempt_insert_only" BEFORE UPDATE ON "CmsPublicationAttempt"
  FOR EACH ROW EXECUTE FUNCTION "cms_insert_only"();

-- An entry that was ever published is archived, never deleted; its project
-- may still go (the project row is deleted first in that transaction).
CREATE FUNCTION "cms_entry_keep_published"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."firstPublishedAt" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId") THEN
    RAISE EXCEPTION 'CMS_ENTRY_WAS_PUBLISHED';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "CmsEntry_keep_published" BEFORE DELETE ON "CmsEntry"
  FOR EACH ROW EXECUTE FUNCTION "cms_entry_keep_published"();

ALTER TABLE "CmsAuthor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsAuthor" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsAuthor"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsAsset"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsTaxonomyTerm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsTaxonomyTerm" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsTaxonomyTerm"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsSite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsSite" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsSite"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsEntry"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsDraft" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsDraft"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsRevision"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsEntrySite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsEntrySite" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsEntrySite"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsPublication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsPublication" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsPublication"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsPublicationAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsPublicationAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsPublicationAttempt"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "CmsRedirect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CmsRedirect" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "CmsRedirect"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
