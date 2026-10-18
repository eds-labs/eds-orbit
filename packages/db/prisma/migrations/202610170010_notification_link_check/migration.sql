-- Member notifications (WP4.7 security review): a link must stay on Orbit.
-- The first check ('^/[^/]') let "/\x" and "/<tab>/x" through, which a
-- browser reads as "//x", another site. Now no backslash, no whitespace and
-- no control character anywhere, the API's ORBIT_PATH rule. NOT VALID: rows
-- written before are left as they are (the flag was off, so there are none);
-- every new or changed row is checked.
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_link_check";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_link_check" CHECK (
  "link" IS NULL OR (
    "link" ~ '^/'
    AND "link" !~ '^/[/\\]'
    AND "link" !~ '[[:space:][:cntrl:]\\]'
  )
) NOT VALID;
