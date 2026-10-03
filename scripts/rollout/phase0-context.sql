-- Orbit Core rollout, Phase 0 (read-only): the facts needed to pick the
-- deployment window and to read the autopilot skip preview.
-- Run inside a read-only transaction; psql variable: project_id.
SELECT
  p.name AS project,
  p.timezone,
  p.mode AS project_mode,
  p.paused,
  s.data ->> 'enabled' AS autopilot_enabled,
  s.data -> 'channels' AS autopilot_channels,
  s.data ->> 'planWeekday' AS plan_weekday_0_is_sunday,
  s.data ->> 'planTime' AS plan_time,
  s.data ->> 'startDate' AS autopilot_start_date,
  c.data -> 'postingTimes' AS posting_times,
  pol.data ->> 'mode' AS policy_mode,
  pol.data ->> 'maxPerDay' AS max_per_day,
  pol.data ->> 'minIntervalMinutes' AS min_interval_minutes,
  pol.data ->> 'endAt' AS policy_end,
  (
    SELECT count(*) FROM "Entity" e
    WHERE e."projectId" = p.id AND e.kind = 'publications'
      AND e.data ->> 'status' IN ('intent_created', 'sending')
  ) AS open_publications
FROM "Project" p
LEFT JOIN LATERAL (
  SELECT e.data FROM "Entity" e
  WHERE e."projectId" = p.id AND e.kind = 'autopilot_settings'
  ORDER BY e."createdAt" DESC LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT e.data FROM "Entity" e
  WHERE e."projectId" = p.id AND e.kind = 'connectors'
    AND e.data ->> 'provider' = 'postiz'
    AND e.data ->> 'status' IN ('read_verified', 'write_verified')
  ORDER BY e."createdAt" DESC LIMIT 1
) c ON true
LEFT JOIN LATERAL (
  SELECT e.data FROM "Entity" e
  WHERE e."projectId" = p.id AND e.kind = 'policies' AND e.data ->> 'active' = 'true'
  ORDER BY e."createdAt" DESC LIMIT 1
) pol ON true
WHERE p.id = :'project_id'::uuid;
