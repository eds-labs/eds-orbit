-- Orbit Core rollout, Phase 0, Approval B (read-only).
-- Which channel-days will the weekly autopilot skip once J3.2 (#44) is deployed?
-- Mirrors planAutopilot in apps/api/src/modules/autopilot.ts: a day the autopilot
-- has not planned yet is skipped when active publications on that channel already
-- use the policy's daily quota, or one sits within the policy spacing of the slot.
-- Covers the next 14 local days (a superset of the autopilot planning horizon).
-- Run inside a read-only transaction; see docs/plans/ORBIT_CORE_ROLLOUT_PLAN.md,
-- appendix "Phase 0 runbook". psql variable: project_id.
WITH project AS (
  SELECT p.id, p.timezone FROM "Project" p WHERE p.id = :'project_id'::uuid
),
settings AS (
  SELECT e.data FROM "Entity" e JOIN project p ON e."projectId" = p.id
  WHERE e.kind = 'autopilot_settings'
  ORDER BY e."createdAt" DESC LIMIT 1
),
connector AS (
  SELECT e.data FROM "Entity" e JOIN project p ON e."projectId" = p.id
  WHERE e.kind = 'connectors'
    AND e.data ->> 'provider' = 'postiz'
    AND e.data ->> 'status' IN ('read_verified', 'write_verified')
  ORDER BY e."createdAt" DESC LIMIT 1
),
policy AS (
  SELECT
    coalesce((e.data ->> 'maxPerDay')::int, 1) AS max_per_day,
    coalesce((e.data ->> 'minIntervalMinutes')::int, 0) AS min_interval_minutes
  FROM "Entity" e JOIN project p ON e."projectId" = p.id
  WHERE e.kind = 'policies' AND e.data ->> 'active' = 'true'
  ORDER BY e."createdAt" DESC LIMIT 1
),
channel_days AS (
  SELECT
    ch.channel,
    ((now() AT TIME ZONE p.timezone)::date + d.offset_days) AS day,
    (((now() AT TIME ZONE p.timezone)::date + d.offset_days)
      + ((c.data -> 'postingTimes' ->> ch.channel)::time)) AT TIME ZONE p.timezone AS slot_at,
    p.timezone
  FROM project p
  CROSS JOIN settings s
  CROSS JOIN connector c
  CROSS JOIN LATERAL jsonb_array_elements_text(s.data -> 'channels') AS ch(channel)
  CROSS JOIN generate_series(0, 13) AS d(offset_days)
  WHERE (s.data ->> 'enabled') = 'true'
    AND c.data -> 'postingTimes' ->> ch.channel ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    -- Only channels assigned to this project and not disabled in Postiz.
    AND c.data -> 'assignedIntegrationIds' @> jsonb_build_array(ch.channel)
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(c.data -> 'channels') AS x(item)
      WHERE x.item ->> 'id' = ch.channel
        AND coalesce((x.item ->> 'disabled')::boolean, false) = false
    )
),
active_publications AS (
  SELECT e.id, e.data ->> 'channel' AS channel, (e.data ->> 'scheduledAt')::timestamptz AS scheduled_at
  FROM "Entity" e JOIN project p ON e."projectId" = p.id
  WHERE e.kind = 'publications'
    AND e.data ->> 'status' NOT IN ('canceled', 'failed', 'blocked_dependency')
),
evaluated AS (
  SELECT
    cd.channel,
    cd.day,
    cd.slot_at,
    EXISTS (
      SELECT 1 FROM "Entity" m JOIN project p ON m."projectId" = p.id
      WHERE m.kind = 'missions'
        AND m.data ->> 'autopilotSlot' = cd.channel || '|' || to_char(cd.day, 'YYYY-MM-DD')
    ) AS already_planned,
    cd.slot_at - now() < interval '2 hours' AS too_soon,
    coalesce((SELECT s.data ->> 'startDate' FROM settings s), '0000-00-00') > to_char(cd.day, 'YYYY-MM-DD') AS before_start_date,
    array(
      SELECT ap.id FROM active_publications ap
      WHERE ap.channel = cd.channel
        AND (ap.scheduled_at AT TIME ZONE cd.timezone)::date = cd.day
      ORDER BY ap.scheduled_at
    ) AS same_day_publications,
    array(
      SELECT ap.id FROM active_publications ap, policy pol
      WHERE ap.channel = cd.channel
        AND abs(extract(epoch FROM ap.scheduled_at - cd.slot_at)) < pol.min_interval_minutes * 60
      ORDER BY ap.scheduled_at
    ) AS too_close_publications
  FROM channel_days cd
)
SELECT
  e.channel,
  to_char(e.day, 'YYYY-MM-DD') AS day,
  e.slot_at,
  e.already_planned,
  cardinality(e.same_day_publications) AS same_day_count,
  e.same_day_publications,
  e.too_close_publications,
  (NOT e.already_planned AND NOT e.too_soon AND NOT e.before_start_date
    AND (cardinality(e.same_day_publications) >= pol.max_per_day
      OR cardinality(e.too_close_publications) > 0)) AS will_skip
FROM evaluated e CROSS JOIN policy pol
WHERE cardinality(e.same_day_publications) > 0
   OR cardinality(e.too_close_publications) > 0
ORDER BY e.day, e.channel;
