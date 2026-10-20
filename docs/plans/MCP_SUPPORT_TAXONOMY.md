# Support categories and tags through MCP

Risk: high (owner-managed project configuration); existing backend/API, agent
registry and shared approval UI. Feature workflow, existing modular SaaS stack.
Authorized main/Coolify delivery; no provider, dependency, migration, flag flip,
production classification changes or customer delivery.

## Plan

1. Reuse native Support category/tag schemas and versioned module settings. Add
   bounded list tools plus individual create/update/delete operations for each.
   Keys stay stable; updates change labels and tag colours. Delete only unused
   definitions (including active inbox defaults for categories).
2. All mutations require sensitive owner permission, active module/grant/scopes,
   exact ActionRequest approval and idempotency. Inbox direct-reply permission
   never applies. Revalidate the targeted definition snapshot before execution;
   merge into current settings so unrelated changes and batch proposals coexist.
   Same-key edits, new references, capacity/role/revocation changes fail closed.
3. Show human-readable before/after definitions in App approvals, with native
   settings link. Never fabricate a ticket link for project-level actions.
4. Test CRUD, duplicates/input/limits, usage/inbox guards, stale same-key vs
   unrelated edits, batch approvals, reject/retry, current permission/grant,
   disabled module/flag/scopes and foreign projects. Verify real HTTP catalogs
   and synthetic UI approval without workers/providers; run required checks,
   generate API artifacts, refresh client catalog and independently verify deploy.

## Security and rollback

No full-settings write is exposed to models; only categories/tags are merged.
Other Support settings (including legacy/global flags), inbox permissions,
mailboxes, budgets and retention stay unchanged. Native project transactions,
FORCE RLS, module role floors and content-free settings/action audit stay in use.
Labels are plain untrusted data, never instructions or approval authority.

No schema/data migration or backup rewrite. Existing definition data is compatible
with the old schema. For code rollback, keep new action definitions registered
until their pending requests have been rejected/expired; a compatibility rollback
can remove tool exposure while retaining readable/rejectable receipts. Older
binaries may not understand pending new action types. No bulk cancellation or
production data normalization is implicitly authorized.

## Validation

- 18 focused tests in three files passed, including real HTTP/OAuth catalog,
  strict inputs, current-owner demotion, same-list batch merges and zero replies.
- Synthetic local browser: create category `billing_demo` / Abrechnung and tag
  `urgent_demo` / Dringend / red via MCP, approve under App approvals with Marketing
  disabled, then inspect persisted native Support settings. Both requests consumed;
  old reply request pending and public replies zero. No worker or provider.
- Lint, root/web typecheck, production build, API artifact generation, Compose,
  secrets, framework and source formatting passed. No generated API schema diff.
- Detailed run outputs and synthetic screenshot remain in ignored `.runtime/`.
- Full suite: 2,824 passed / one known baseline failure in 265 files (620 seconds).
  The failure is agent-runner I7b at line 819: resumed task remains
  `blocked_dependency` / `PROJECT_PAUSED` instead of queued. Already reproduced
  on unchanged base in the prior checkpoint; unrelated runner is not modified.
  The final 18-test focused run additionally covers owner demotion added during
  the full run.
