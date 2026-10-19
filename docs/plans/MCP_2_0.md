# MCP 2.0 implementation

Status: implemented and locally validated; production activation pending. Analysis base: 10c2b0b. Delivery base: 6028312 (Anthropic PR #179). User request: 2026-10-19.

## Risk, reuse and boundaries

High risk: delegated agent execution, customer data and approval-bound writes.
Environment: isolated local worktree/database; no production writes or paid calls.
Primary profile: AI agent app; backend API and existing web shell supplement it.
Stack stays unchanged. Workflow: feature. No new provider/dependency required.

The gateway currently exposes profile, projects, search/fetch, action status,
marketing status, support counts and assignment proposals. It is stateless and
refuses subscriptions. The platform already has user-private ChatConversation /
ChatRun, bounded model/tool execution, the chat queue, durable jobs/outbox,
ActionRequests, project locking, live module roles and Redis realtime fanout.
Marketing contributes campaign/package/assignment tools and specialist jobs;
Support owns ticket services and draft jobs; Knowledge owns import/actions over
the platform retrieval/ingestion engine. Those services remain authoritative.

## Implementation sequence

1. Add durable delegated task records over conversations/runs, hash-bound owner
   start approvals, idempotency and cancellation. Do not introduce a second runner.
2. Contribute typed module operations through the existing registry. Reads reuse
   native services; mutations create ActionRequests, then execute through those
   same services only after approval. External customer text requires explicit
   OAuth consent in addition to normal module permissions.
3. Bind the chat runner to the originating grant and module restriction. Recheck
   before model transmissions, tool calls, results and decisions. No model can
   approve an action. Paid attempts keep existing unknown-outcome recovery.
4. Return bounded, versioned task/progress/result/approval projections. Keep all
   original tools compatible. Expose new tasks in the native UI and reuse
   existing realtime notifications; evaluate standard MCP subscriptions against
   the installed SDK, with status tools always available as fallback.
5. Test A–G with synthetic fixtures and mocked providers, regenerate API
   artifacts where needed, run lint/typecheck/tests/build, document examples,
   configuration, limitations and rollout.

## Threats and tests

- Confused deputy: a read-only or module-restricted grant cannot obtain writes or
  another module's data through the assistant. Verify revocation mid-run.
- Cross-project/user/client probes: return uniform NOT_FOUND, including result,
  cancellation, pagination and approval lookup.
- Duplicate retries: serialize by project, bind idempotency keys to input hashes;
  create task, conversation, approval and queued run transactionally.
- Prompt injection: inputs remain untrusted; server capability filtering and
  approval definitions establish authority, never source text.
- Customer privacy: separate explicit content consent, bounded sanitized output,
  no message text or prompts in audit logs.
- Restart and delivery ambiguity: reuse leases/outbox and ChatRun transmission
  markers; never retry a transmitted paid call or uncertain external write.
- Approvals: exact payload/hash/version, role, expiry, rejection, module state
  and current grant must all be checked. Cancellation cannot revoke work already
  transmitted; report that limitation honestly.

## Rollback and deployment

No production activation in this task. Revert the code change and disable new
MCP capabilities before rollback. Existing gateway tools remain supported.
Any additive migration must remain compatible with the previous image and be
applied only under separate production approval. Saved tasks/results follow
project deletion/retention; no external payload is sent during tests.

## Acceptance evidence

Local acceptance is exercised by the integration and browser tests below. No
live-client or production acceptance is implied by mocked provider results.

## Implemented architecture and local checks

- Tasks reuse private conversations/runs, the `chat` queue/outbox, native
  telemetry and hash-bound ActionRequests. No schema migration or provider
  dependency was added; `orbit_tasks` is an unexported platform entity kind.
- Operations are contributed through the existing tool/action registries and
  reuse native module services. Campaign changes use an owner ActionRequest
  rather than creating an untrackable private chat proposal for an external task.
- The task runner intersects mode, original token scopes, the current grant,
  module activation and current member/module permissions at execution time.
  AsyncLocalStorage carries server-created task attribution to native requests;
  untrusted inputs cannot create this context.
- Ticket text uses native placeholders; sensitive support access and internal
  execute permissions are optional, initially unchecked OAuth consent scopes.
  Shared exports strip operation bodies. Contact erasure/retention purge MCP
  ticket-payload copies and their EntityVersion history.
- Standard resources/read and 2026-07-28 resource invalidation subscriptions use
  current SQL snapshots and the existing Redis fanout. Limits: 2 streams per
  user/client/workspace/process, 5 resources per stream, 60 s lifetime. Legacy
  clients use tools. No MCP Tasks extension or proprietary webhook was added.
- Native UI: private work orders in Orbit Chat, exact task/operation contents in
  the approval inbox, result-conversation deep links and mobile cancellation.
- Test A–G: `apps/api/tests/mcp-2-workflows.integration.test.ts`, real SQL and
  mocked models, including idempotency, duplicate worker dispatch, package
  approval/artifacts, lexical ingestion/update, denied scope/module/project/
  client access, mid-run consent loss, injection, rejection/expiry/cancellation,
  export/erasure/retention, subscription revocation, approved chat ceilings and
  pending-operation shutdown.
- `apps/api/tests/mcp-2-gateway.integration.test.ts`: real OAuth/JWKS, actual
  gateway HTTP dispatch and streaming acknowledgement, optional module inputs,
  resource read, native UI APIs, persistence across gateway restart.
- `apps/web/tests/mcp-work-orders.spec.ts`: isolated native desktop/mobile
  acceptance. `E2E_MCP_TASKS=1` and a generated ignored
  `.runtime/mcp2-browser.json` account/task fixture are required. Run against an
  isolated test stack; no worker is needed, and the test cancels the pending task.
- Existing gateway process/discovery and the reviewed access matrix were updated
  only for intentional new scopes/routes. Import boundaries remain clean.

Final check results are recorded in `docs/evidence/mcp2-local-validation.md`.
A true paid-provider/client acceptance, multi-replica stream quotas and sustained
load testing are not claimed by these local tests. Already approved child work
uses its own native lifecycle, not retroactive task cancellation.

## Concurrent upstream integration

PR #179 merged while this work was being validated. The branch was rebased onto
`6028312`. The chat runner preserves the new native provider call plan, budget
stop/fallback, settlement, telemetry and refusal/unsupported error handling.
Task start ceilings cover the largest allowed primary/fallback route; each
selected call remains bounded by the approved share before reservation. The
existing Anthropic chat integration now also exercises an approved MCP work
order through the real adapter with only the SDK mocked. Frozen dependencies
are inherited from the new base; MCP itself adds none. OpenAPI/client artifacts
were regenerated and match the combined contract.
