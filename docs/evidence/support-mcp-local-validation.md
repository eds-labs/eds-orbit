# Support MCP completion — local validation

Date: 2026-10-19. Worktree: `EDS-Orbit-mcp2`, branch
`codex/orbit-support-mcp`, base `c232ecb` (merged MCP 2.0). Runtime:
Node 24.18.0; package scripts use Corepack pnpm 11.19.0. Tests load local
configuration without printing it and prefer this worktree's isolated test DB
and Redis namespace via `scripts/test-db-for-worktree.ts`. No shared/production
DB reset, production configuration, provider credential or customer action.

## Implemented contracts

- Five new canonical tool names plus the extended `support_update_ticket`.
  Native Support/assistant services and existing ActionRequests, no new table,
  provider or dependency. Canonical reply/note names adapt into the original
  operations, sharing their actor/client/key identity.
- Strict canonical read result schemas; explicit project selection for the
  five new tools. Role/scopes/module/tenant checks are retained.
- Native date/assignee filters, category/label support and keyset cursors;
  complete chronological message/event reading with body chunks and JSON byte
  bounds. Metadata-heavy ticket pages continue after the actual returned row.
- Owner/editor internal-content permission on native and MCP timeline/search,
  filtering before pagination, including current-role checks on native draft
  conversation projections. Native viewer and registry tests explicitly
  changed to verify this intended access restriction.
- Reply approval shows the exact body and destination context. Destination
  and current actor/grant are rechecked before native delivery enqueue.
  Receipts project live native message state without returning body/address.
- Native privacy erasure purges the approval payload/context and history;
  audit contains ids/hashes, not ticket body or recipient.
- Single-pass native placeholder replacement fixes repeated anonymization of
  contact tokens such as "Customer"; unit and Support AI regression coverage.

## Checks and evidence

- Isolated DB migration/least-privilege role verification: passed; no new
  migrations introduced.
- Focused Support SQL, contract/unit and real OAuth/gateway HTTP: 32 tests
  passed across three files before the final private-artifact case was added.
  The subsequent unit + shared main-agent regression passed 24 tests across
  two files. The HTTP boundary test also passed both scenarios after adding
  explicit refusal of a direct REST reply with an MCP bearer token.
  The complete frozen-source suite below is authoritative.
- Lint, typecheck, production build, Compose and bounded secret-pattern scan:
  executed using repository scripts; final results below.
- OpenAPI/client generation: completed; generated artifacts unchanged because
  the new surface uses the registry MCP adapter rather than new REST routes.
- Framework full schema/YAML validation and relative-link validation:
  final result below. The initial link check correctly caught this evidence
  file before creation; rerun after documentation completion is authoritative.
- Source/diff/security review: focused on the plan's tenant isolation, private
  content search, exact recipient/content approval, terminal action lifecycle,
  alias/concurrent dedupe, data erasure, byte limits and content-free logging.

## Final local results before integration with current main

- Complete repository suite: **2776/2776 tests, 260/260 files passed**
  (461.23 s, Node 24.18.0, isolated SQL/Redis). The native id aliases in the
  reply/update receipts were then retained for compatibility with main-agent
  artifact projections; that additional assertion passed all 16 native MCP
  workflow tests and is included in the post-integration focused regression.
- Lint/source/import-boundary checks: passed, **zero boundary violations**.
- Root and web typecheck, production build, Coolify Compose validation and
  bounded secret-pattern scan: passed. Full framework schema/YAML/link checks:
  **zero errors and zero warnings**.
- Generated OpenAPI/client artifacts: no diff.
- The initial complete run caught stale intermediate modules while the new
  edge cases were being added. The clean complete rerun above is authoritative.

Temporary logs remain in ignored `.runtime/support-mcp-*.log`; no credentials or test
account passwords are committed.

## Integration with current main and delivery

Rebased onto `6dac139`, retaining Knowledge freshness fix `f1827f5` and the
owner-approved direct-main workflow. Only the concurrent implementation-status
entries conflicted; both checkpoints were preserved. Code merged cleanly.
Post-integration validation of the final production code:

- **145/145 tests across 12 files passed** (40.66 s): new Support SQL/unit,
  real OAuth/gateway HTTP, native main-agent workflows (including reply
  artifact ids), native Support workspace/AI, RLS/access matrices, real worker
  dispatch and all three changed Knowledge freshness/overview/attention suites.
- Lint/import boundaries, root/web typecheck, production build, Compose and
  secret-pattern checks passed again. Framework full schema/YAML/link checks:
  zero errors/warnings. OpenAPI/client generation remained unchanged.
- Code-only direct push to main follows Mario's existing delivery instruction;
  Coolify's webhook performs deployment. No flag/secret/customer/provider
  mutation is part of the push. The exact pushed commit and independent
  deployment/readiness observations are recorded in the delivery handoff.

## Coverage and limitations

The Support integration tests cover filter combinations and pagination,
metadata/placeholder handling, same-time message/event ordering, complete long
Unicode body reconstruction, byte-limited ticket-list continuation, attachments
and deleted-file availability, viewer/private-note isolation across native and
MCP paths (including search), missing consent/write scope, module grant/flags,
foreign project/workspace ids, concurrent proposals/decisions and old aliases,
exact owner approval, rejection/expiry, changed recipient/channel, old unbound
approvals, role/grant revocation, internal notes, partial changes/configured
categories/tags/assignee validation, widget delivery, injected customer
instructions, content-free audit and erasure of approval/history copies.

The real HTTP/OAuth test discovers schemas/annotations/scopes, lists/reads a
synthetic ticket, submits a reply with no immediate send, reviews exact content
and destination via the native approval endpoint, approves and polls its
receipt, retries idempotently, rejects unknown/implicit-project arguments and
checks an old-scope connection cannot list content tools. The native main-agent
workflow also proposes the canonical reply and waits for its separate exact
send approval. All model/SMTP/provider activity is synthetic or mocked.

No live ChatGPT/Dots reconnect, real email delivery or production acceptance is
claimed. Browser UI layout is unchanged; the existing exact-operation JSON
review displays the added destination snapshot, verified through the native
approval HTTP response and existing component regression tests. Operator steps
and rollback are in `docs/SUPPORT_MCP.md`.
