# MCP 2.0 local validation and handoff

Date: 2026-10-19. Branch: `codex/orbit-mcp-2`. Base: `6028312` (includes merged Anthropic provider PR #179).
Risk: high. Environment: isolated local worktree and worktree-specific test database.
Implementation: `docs/MCP_2_0.md`. Threat/reuse plan: `docs/plans/MCP_2_0.md`.

## Delivered behavior

- 30 additional MCP tools: 6 task/action-result, 8 Support, 8 Marketing and 8 Knowledge.
- Persistent, client/user-private work orders use native conversations/runs, the
  existing chat worker and job/outbox, module contributions and ActionRequests.
- Read/Draft/Execute intersects explicit module selection, token scopes, active
  grant and current membership/module roles. The model cannot decide approvals.
- Exact start/operation approvals, duplicate retry handling, native spend mandates,
  route checks, approved chat ceilings, source rights and publication locks remain
  server controls. Revocation stops subsequent delegated main-agent calls.
- Standard MCP resource invalidations complement durable status polling. Native
  Orbit Chat shows work orders; existing approval UI displays exact contents.
- Support redaction, shared export exclusions, contact erasure of operation
  payload/history copies and terminal task retention have negative tests.
- AGENTS.md now describes the modular platform, working-state checks, current
  architecture/ownership, verification and the new delegated work-order contract.

## Automated evidence

| Check | Local result |
| --- | --- |
| Full Vitest suite | 2739 passed across 256 files; 489.05 seconds |
| Final targeted regression after the ceiling guard | 89 passed across 8 files, including the delegated Claude adapter and native provider budgets |
| Native Playwright desktop/mobile acceptance | 1 passed; exact approval, responsive view, API cancellation and persisted status |
| `pnpm lint` | Passed; no new import-boundary violations |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed |
| `pnpm test:coolify-compose` | Passed |
| Secret pattern scan | Passed; bounded pattern scan, not an exhaustive security proof |
| Framework validation | Passed; 0 errors, 0 warnings |
| `git diff --check` | Passed |

The targeted regression includes `mcp-2-workflows.integration.test.ts`,
`mcp-2-gateway.integration.test.ts`, `chat-runner.integration.test.ts`,
`anthropic-chat.integration.test.ts`, `ai-provider.integration.test.ts`,
`action-requests.integration.test.ts`, `module-contributions.test.ts` and the
optional-scope consent test. A–G cover
native main-agent dispatch/results, support draft without sending, marketing
package/approval/artifact references, approved searchable ingestion/update,
foreign-project/client/module/scope refusal, rejection/expiry/revocation,
parallel idempotent create, repeated worker dispatch and gateway restart.
Gateway tests exercise real OAuth/JWKS, JSON-RPC, resource reads and streaming
acknowledgement. The ceiling regression proves no model transmission occurs
when the saved chat ceiling is insufficient. Disabling the new feature leaves
pending operations inert while still allowing owner rejection. A delegated task
also passes through the native Anthropic adapter, reservation/settlement and
telemetry (only the SDK is mocked); the approved maximum includes any configured
OpenAI fallback, and the runner keeps the native provider budget/call plan.

All fixtures are synthetic and model/provider calls are mocked. No customer
message, social publication, paid model request or production configuration
change was made. Temporary native browser servers and their test accounts were
stopped/cleaned after the browser test. Private fixture credentials and local
logs are ignored under `.runtime/` and are not deliverables.

## Reproduce the native browser acceptance

Use the pinned Node/pnpm runtime and an existing configured local environment.
Create the worktree-specific test database with
`node scripts/test-db-for-worktree.ts` first. From the repository root, run the
fixture in one terminal (replace the environment path with your configured local
file; do not copy or print secrets):

```sh
node --env-file=/absolute/path/to/local.env --import tsx scripts/mcp-task-browser-fixture.ts
```

The script refuses to start without a validated local worktree test database,
forces test mode and disables external writes. It creates a synthetic account,
project and pending approval and stores credentials only in ignored `.runtime/`.
It starts the API on 127.0.0.1:44311 and never starts a worker.

In a second terminal, build and serve the web app against that API:

```sh
pnpm --dir apps/web build
APP_ORIGIN=http://localhost:44310 ORBIT_API_ORIGIN=http://127.0.0.1:44311 pnpm --dir apps/web exec next start --hostname 127.0.0.1 --port 44310
```

Then run:

```sh
E2E_MCP_TASKS=1 pnpm exec playwright test --config scripts/mcp-task-browser.config.ts
```

Stop both servers afterwards. Ctrl+C on the fixture removes its synthetic project
and account. Restart the fixture before repeating the test: the test deliberately
cancels the pending work order. Screenshots/traces stay under `.runtime/`.

## Configuration and operator acceptance

No schema migration or dependency is added. `ORBIT_MCP_TASKS` defaults to false;
keep it off for deployment until a rollout is separately authorized. Existing
OAuth/gateway/proposal prerequisites still apply. Configure the new flag
consistently on API, MCP gateway and worker; reconnect clients to explicitly
consent to `orbit:write` and/or `orbit:support` when needed. Confirm native module
activation/roles, model spend mandates/budgets, channel verification and readiness
before enabling writes. Examples and rollback are in `docs/MCP_2_0.md`.

Actual ChatGPT/dots/Claude connections, real paid generation, sustained load and
multi-replica subscription quotas have not been accepted by these local tests.
Subscription quotas are per process. Canceling a work order cannot retract an
already approved native child job or transmitted external action; use its native
cancellation/reconciliation path. Disable the new flag before rollback and keep
new approval types inert if returning to an older image. No push, merge or
production deployment is included in this handoff.

## Main delivery authorization (2026-10-19)

After the local handoff, Mario explicitly authorized committing/pushing the
complete change to `main`, with Coolify deploying automatically. The release
adds no migration or dependency and does not change live feature flags. Existing
2739-test, browser, build and quality evidence applies to the unchanged code;
this delivery follow-up adds the changelog and this authorization record only.
Remote CI and Coolify deployment/health are checked separately from local tests.

While the first required CI run was executing, PR #180 advanced `main` to
`6a5d438`. That main revision was merged into the delivery branch; the only
merge conflict was the additive implementation-status documentation. MCP
production code was unchanged. Required CI is rerun for the combined revision
before the final fast-forward to main.

After integrating PR #180, 75 focused tests across 10 files, lint, typecheck
and build passed locally. OpenAPI/client artifacts were regenerated before
publishing the combined delivery branch for its required checks.
