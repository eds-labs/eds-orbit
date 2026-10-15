-- K-1 read-only check (WP3.2, plans/orbit-modularization/05 §5).
--
-- Lists, per fact key of one project, which Verified Fact marketing may use
-- today (content-packages.ts `usableFact`) and which it could use once
-- `usableFacts` applies the knowledge engine's full rules (retrieve(): source
-- active with a valid policy, not generated, public, not embargoed, model use
-- allowed, fact from the source's current generation, content language and
-- the global market). Rows with change = 'lost' are facts the uLiquid
-- assignment would no longer get.
--
-- Read-only by construction: one READ ONLY transaction that ends in
-- ROLLBACK; it creates nothing (no temp tables, no functions). Run it as the
-- application role, so row-level security limits it to the given project:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v workspace_id=<workspace uuid> -v project_id=<project uuid> \
--     -f scripts/rollout/k1-usable-facts-diff.sql
--
-- Assumptions, matching how the API reads the same data:
-- - "now" is the transaction start; dates without an offset are read as UTC
--   (the API containers run in UTC).
-- - The content language is the marketing profile's `contentLanguage`
--   (packages are written in it), else the project language, else 'en'; the
--   market is 'global', because marketing passes no market today.
-- - Facts reach a model, so model use is required, as in the chat's
--   knowledge_search (forModel: true, purpose: public).
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SELECT
  set_config('app.workspace_id', :'workspace_id', true) AS workspace_id,
  set_config('app.project_id', :'project_id', true) AS project_id;

WITH params AS (
  SELECT
    now() AS at,
    coalesce(
      (SELECT data->>'contentLanguage' FROM "ProjectMarketingProfile" LIMIT 1),
      (SELECT language FROM "Project" LIMIT 1),
      'en'
    ) AS language,
    'global'::text AS market
),
facts AS (
  SELECT
    f.id,
    f."createdAt",
    f.data AS d,
    f.data->>'key' AS key,
    -- usableFact's statement: copies with the same statement are no conflict.
    jsonb_build_array(
      f.data->'value', f.data->'valueType', f.data->'unit',
      f.data->'currency', f.data->'language'
    ) AS statement,
    CASE WHEN f.data->>'validFrom' ~ '^\d{4}-\d{2}-\d{2}'
      THEN (f.data->>'validFrom')::timestamptz END AS valid_from,
    nullif(f.data->>'validUntil', '') IS NOT NULL AS has_until,
    CASE WHEN nullif(f.data->>'validUntil', '') ~ '^\d{4}-\d{2}-\d{2}'
      THEN (f.data->>'validUntil')::timestamptz END AS valid_until
  FROM "Entity" f
  WHERE f.kind = 'facts' AND f.data ? 'key'
),
rated AS (
  SELECT
    fa.*,
    s.data AS src,
    -- Today's rule (content-packages.ts usableFact).
    coalesce(
      fa.d->>'status' = 'verified'
      AND fa.d->'publicUse' = 'true'::jsonb
      AND fa.d->'modelUse' = 'true'::jsonb
      AND fa.valid_from <= p.at
      AND (NOT fa.has_until OR fa.valid_until > p.at),
      false
    ) AS today_ok,
    -- What the full rules add (packages/knowledge retrieve()).
    array_remove(ARRAY[
      CASE WHEN s.id IS NULL THEN 'source_missing' END,
      CASE WHEN s.id IS NOT NULL AND s.data->>'status' IS DISTINCT FROM 'active'
        THEN 'source_status:' || coalesce(s.data->>'status', 'none') END,
      CASE
        WHEN s.id IS NULL THEN NULL
        WHEN jsonb_typeof(s.data->'generation') IS DISTINCT FROM 'number'
          OR jsonb_typeof(s.data->'maxAgeHours') IS DISTINCT FROM 'number'
          THEN 'source_policy_invalid'
        WHEN (s.data->>'generation')::numeric < 1
          OR (s.data->>'generation')::numeric <> trunc((s.data->>'generation')::numeric)
          OR (s.data->>'maxAgeHours')::numeric <= 0
          OR coalesce(s.data->>'authority', '') NOT IN ('official', 'website', 'research', 'generated')
          THEN 'source_policy_invalid'
      END,
      CASE WHEN s.data->>'authority' = 'generated' THEN 'source_generated' END,
      CASE WHEN s.id IS NOT NULL AND s.data->'publicUse' IS DISTINCT FROM 'true'::jsonb
        THEN 'source_not_public' END,
      CASE WHEN s.data->>'embargoUntil' ~ '^\d{4}-\d{2}-\d{2}'
        AND (s.data->>'embargoUntil')::timestamptz > p.at
        THEN 'source_embargoed' END,
      CASE WHEN s.id IS NOT NULL AND s.data->'modelUse' IS DISTINCT FROM 'true'::jsonb
        THEN 'source_no_model_use' END,
      CASE WHEN s.id IS NOT NULL
        AND fa.d->'sourceGeneration' IS DISTINCT FROM s.data->'generation'
        THEN 'fact_source_generation_stale' END,
      CASE WHEN fa.d->>'language' IS DISTINCT FROM p.language
        THEN 'language_mismatch:' || coalesce(fa.d->>'language', 'none') END,
      CASE WHEN coalesce(fa.d->>'market', 'global') <> p.market
        THEN 'market_mismatch:' || (fa.d->>'market') END
    ], NULL) AS k1_reasons
  FROM facts fa
  CROSS JOIN params p
  LEFT JOIN "Entity" s ON s.kind = 'sources' AND s.id::text = fa.d->>'sourceId'
),
judged AS (
  SELECT r.*, r.today_ok AND cardinality(r.k1_reasons) = 0 AS k1_ok FROM rated r
),
per_key AS (
  SELECT
    key,
    count(*) FILTER (WHERE today_ok) AS today_copies,
    count(DISTINCT statement) FILTER (WHERE today_ok) AS today_statements,
    (array_agg(id ORDER BY "createdAt" DESC, id::text COLLATE "C" DESC)
      FILTER (WHERE today_ok))[1] AS today_id,
    count(*) FILTER (WHERE k1_ok) AS k1_copies,
    count(DISTINCT statement) FILTER (WHERE k1_ok) AS k1_statements,
    (array_agg(id ORDER BY "createdAt" DESC, id::text COLLATE "C" DESC)
      FILTER (WHERE k1_ok))[1] AS k1_id,
    jsonb_agg(
      jsonb_build_object('factId', id, 'value', d->>'value', 'reasons', to_jsonb(k1_reasons))
      ORDER BY "createdAt" DESC
    ) FILTER (WHERE today_ok AND NOT k1_ok) AS excluded_copies
  FROM judged
  GROUP BY key
),
states AS (
  SELECT
    k.*,
    CASE WHEN today_copies = 0 THEN 'none'
      WHEN today_statements > 1 THEN 'conflict' ELSE 'usable' END AS today_state,
    CASE WHEN k1_copies = 0 THEN 'none'
      WHEN k1_statements > 1 THEN 'conflict' ELSE 'usable' END AS k1_state
  FROM per_key k
),
diff AS (
  SELECT
    CASE
      WHEN today_state = 'usable' AND k1_state = 'usable' AND today_id = k1_id THEN 'unchanged'
      WHEN today_state = 'usable' AND k1_state = 'usable' THEN 'other_copy'
      WHEN today_state = 'usable' THEN 'lost'
      WHEN k1_state = 'usable' THEN 'gained'
      ELSE 'unusable_both'
    END AS change,
    s.*
  FROM states s
)
SELECT
  d.change,
  d.key,
  d.today_state,
  t.data->>'value' AS today_value,
  d.k1_state,
  k.data->>'value' AS k1_value,
  d.excluded_copies
FROM diff d
LEFT JOIN "Entity" t ON t.id = d.today_id
LEFT JOIN "Entity" k ON k.id = d.k1_id
ORDER BY
  array_position(ARRAY['lost', 'gained', 'other_copy', 'unusable_both', 'unchanged'], d.change),
  d.key COLLATE "C";

ROLLBACK;
