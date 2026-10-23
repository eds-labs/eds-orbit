-- Project-wide content languages and profile links (plans/project-configuration-i18n.md).
-- "language" stays the default content language, so every existing reader keeps
-- working. The list starts with it plus the Marketing profile's content language
-- when that differs, so no current campaign loses its language. Existing official
-- links of the Marketing profile are copied as profile links with a type derived
-- from their label; the profile itself (and its version) is not touched.
-- Both tables force row-level security for every role, the owner too; the
-- copy lifts that for the owner inside this transaction only, so it reaches
-- every project whether or not the migrator bypasses RLS.
-- Additive; down path: drop both columns.

BEGIN;

ALTER TABLE "Project"
  ADD COLUMN "contentLanguages" TEXT[] NOT NULL DEFAULT ARRAY['en']::TEXT[],
  ADD COLUMN "links" JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE "Project" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProjectMarketingProfile" NO FORCE ROW LEVEL SECURITY;

UPDATE "Project" p SET "contentLanguages" = ARRAY[p."language"]::TEXT[];

UPDATE "Project" p
SET "contentLanguages" = p."contentLanguages" || (m."data"->>'contentLanguage')
FROM "ProjectMarketingProfile" m
WHERE m."projectId" = p."id"
  AND m."data"->>'contentLanguage' IS NOT NULL
  AND NOT (m."data"->>'contentLanguage' = ANY (p."contentLanguages"));

UPDATE "Project" p
SET "links" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'type', CASE
      WHEN lower(l->>'label') = 'website' THEN 'website'
      WHEN lower(l->>'label') = 'web app' THEN 'web_app'
      WHEN lower(l->>'label') IN ('getting started', 'documentation', 'docs') THEN 'documentation'
      WHEN lower(l->>'label') = 'x' AND (l->>'url') ~* '^https://([a-z0-9-]+\.)*(x|twitter)\.com(/|$)' THEN 'x'
      WHEN lower(l->>'label') = 'linkedin' AND (l->>'url') ~* '^https://([a-z0-9-]+\.)*linkedin\.com(/|$)' THEN 'linkedin'
      WHEN lower(l->>'label') LIKE 'telegram%' AND (l->>'url') ~* '^https://([a-z0-9-]+\.)*(t|telegram)\.me(/|$)' THEN 'telegram'
      ELSE 'custom'
    END,
    'label', left(l->>'label', 80),
    'url', l->>'url') ORDER BY ord)
  FROM jsonb_array_elements(m."data"->'officialLinks') WITH ORDINALITY AS t(l, ord)
  WHERE (l->>'url') LIKE 'https://%'
), '[]'::JSONB)
FROM "ProjectMarketingProfile" m
WHERE m."projectId" = p."id"
  AND jsonb_typeof(m."data"->'officialLinks') = 'array';

ALTER TABLE "ProjectMarketingProfile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;

COMMIT;
