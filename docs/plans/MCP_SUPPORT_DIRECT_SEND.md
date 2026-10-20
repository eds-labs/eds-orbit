# Owner MCP Support send setting and independent decisions inbox

The project-wide policy below is superseded by the inbox-specific policy in
`MCP_SUPPORT_INBOX_POLICY.md`; the independent decisions inbox remains current.

Risk: high; backend/authz + existing Next.js web UI. Feature/bugfix in the existing stack; authorized main/Coolify workflow. No schema migration, new provider/dependency, paid call or real customer send.

## Plan and acceptance

1. Add default-off owner-managed Support setting `mcpOwnerRepliesWithoutApproval`. It applies only to new exact customer-reply proposals made directly through MCP by a user who may already decide those requests as owner. Editors, in-app/delegated agents, notes, status changes and paid AI retain individual decisions. Existing pending proposals are not retroactively sent when enabling it.
2. Reuse the same ActionRequest hash, active-grant/module/role checks, destination snapshot/revalidation, native reply outbox, idempotency and audit. The owner's standing setting permits the existing owner decision in the same transaction, labelled as an MCP-setting decision. Return the durable queued/executed state so a client cannot mistake pending approval or queued delivery for delivered mail. Replays never send twice, including old aliases. This is server-side standing authorization of a proposal, not token scope widening.
3. Move the generic ActionRequest inbox out of the Marketing page into a project-wide Decisions view and nav entry. MCP approval/status links and platform attention route there. Marketing's own content decisions keep their existing page/deep links.
4. Add behavior tests: default-off, owner opt-in exactly once, editor/no-channel refusal to auto-send, opt-out, stale/revoked grant, foreign ticket, unchanged recipient/queue checks, audit source, and disabled Marketing navigation/approval. Test the settings control and UI states, run focused/full tests, typecheck/lint/build, API generation, Compose and security/framework checks. Verify deployed version and the default-off UI; no real reply is a smoke test.

## Security and operations

The setting route already requires the sensitive owner permission and versioned module settings. Only the code-owned Support reply operation opts into this behavior. Client arguments cannot set approval mode or decision source. Project transactions serialize settings, exact proposal and native queue changes. The same owner authority and active MCP scopes remain necessary; no background/draft task is promoted to sending. No extra OAuth scope is added to an existing token/grant. Other actions retain their original approval floor. Keep requested-by actor/client/grant, setting decision source and execution receipt; never log message bodies or credentials.

No schema/data migration or backup modification. For rollback, disable the option and deploy a compatibility rollback that keeps the new settings schema field but removes standing execution. Older binaries use a strict settings schema: a full binary rollback therefore requires separately authorized removal of the stored JSON field before deployment. Owners can disable the option through normal settings; disabling does not undo already queued mail. No setting is enabled in production as part of implementation. The new Decisions route is additive and existing Marketing URLs remain valid. Paid/model/provider actions are not verification. Browser checks use a local fixture or existing read-only/default-off UI.

## Verification (2026-10-20)

- Full isolated local suite: 2,810 passed / 1 failed in 264 files (507.98 s).
  The sole failure is the previously reproduced baseline agent-resume I7b
  regression (`agent-runner.integration.test.ts:819`), outside this change.
- Final authorization regression after adding the stale-owner guard: 79 tests
  in five files passed, including current owner demotion, revoked grants,
  default-off/opt-in/opt-out, old pending requests, aliases and Marketing off.
- Final settings/catalog regression: 12 tests in three files passed. The real
  HTTP catalog advertises potential external effects on direct reply tools.
- Lint, root/web typecheck, production build, API/client generation (no artifact
  diff), Compose, secrets and framework checks passed. No import boundary violations.
- Local browser acceptance used an isolated synthetic project, synthetic mailbox
  and no worker. With Marketing disabled, the exact Support reply was visible
  in App approvals and its decision consumed once. The setting persisted across
  a reload. A new MCP reply after browser opt-in consumed without another
  decision; its repeated call reused the receipt and created no extra message.
  Browser opt-out saved successfully. The local fixture queued two synthetic
  messages in total (one manual decision, one direct); no SMTP call or actual
  delivery occurred. Both default-off and nonowner UI states have rendering tests.
- Screenshots and probe/log artifacts are under ignored `.runtime/`. The existing
  navigation/work-order E2E route expectations were updated; the entire Playwright
  suite was not run. Acceptance for the changed UI was through the browser above.

Deployment, production default-off UI and exact commit will be independently
verified after the authorized main push. Do not enable a production project
setting or send a real customer message as a smoke test.
