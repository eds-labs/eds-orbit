# Inbox-specific MCP reply authorization

Risk: high; existing backend authorization and Support web settings. Follow-up to
MCP_SUPPORT_DIRECT_SEND.md, same stack/main delivery workflow. No DDL, provider,
secret, paid model call or real message delivery.

## Plan

1. Add an optional default-deny flag to SupportInbox.rules. Only an explicit true
   on the current ticket inbox permits a new owner's direct MCP reply. Ignore
   the deprecated project flag; retain its schema key for stored JSON compatibility.
2. Reuse owner/grant/destination revalidation, exact request hashes, transactions,
   deduplication and native delivery. Audit inbox id/version as decision provenance.
   Pending retries and delegated/editor/non-reply operations retain approval.
3. Move the control into owner-only inbox create/edit forms, preserve other inbox
   rules, show each inbox's effective MCP mode, remove the project-wide control.
4. Test Support opt-in vs Admin off/missing, legacy project true ignored,
   same-ticket inbox changes, opt-out/replays, owner permissions/version conflicts,
   settings UI and native scope matrix. Run focused/full checks and browser tests
   using synthetic fixtures without a worker; verify exact deployment and read-only
   production UI. Never activate production inboxes implicitly.

## Rollback

Disable direct sends with a compatibility rollback retaining recognition of both
JSON fields. A full old binary rollback can reactivate a stored legacy project
flag and reject the new inbox rules key. It requires separately authorized JSON
normalization first (legacy project flag false, remove the new inbox key). No
schema/data rewrite is included in this change; no backup or migration is needed.
Disabling only affects future proposals, not already queued delivery.

## Local verification

- Focused SQL/HTTP/schema/UI/catalog regression: 59 tests in six files passed.
- The final Support regression includes opt-in/opt-out/retry, missing/off Admin
  rules, ignored legacy global opt-in, current-inbox moves, archived inbox opt-in,
  stale owner/revoked grant and existing tenant/destination cases (29 tests).
- Browser: a synthetic Support inbox was opted in through Edit; Admin stayed off.
  After reload both badges persisted. The new direct reply consumed once; a retry
  reused it. Admin stayed pending with zero outgoing messages and an older pending
  Support request stayed pending. Other automation rules survived the form save.
  No worker, real SMTP send or paid provider was started. Evidence is in ignored
  `.runtime/mcp-inbox-browser-probe.log` and screenshots.
- Lint, root/web typecheck, production build, API generation (no contract artifact
  diff), Compose, secrets and framework checks passed. Full suite: 2,815 passed /
  1 failed in 264 files (513.27 s). The sole failure is the previously reproduced
  baseline agent-resume I7b case; all inbox regressions pass.

Production inbox settings remain unchanged. Verify the exact main deployment,
read-only inbox UI and updated client descriptions before reporting delivery.
