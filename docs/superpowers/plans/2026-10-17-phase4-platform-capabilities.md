# Phase 4: Platform Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a third module plugs in through the contracts alone (WP4.1), then add the platform capabilities the Support module needs: public ingress, real-time, module roles, files, e-mail and notifications (WP4.2–WP4.7).

**Architecture:** Every capability lives in `apps/api/src/platform/*` and is used by modules through registries and contracts (ADR 0009). A test-only fixture module `tasks` exercises the contracts first and serves as the consumer of later capabilities.

**Tech Stack:** TypeScript (Node 24), Fastify, Prisma/Postgres with RLS, Redis, Vitest, Next.js.

**Spec:** `plans/orbit-modularization/07-roadmap.md` §Phase 4, `06-support-readiness.md` (S-R4–S-R8), `03-module-contracts.md`, ADR `docs/adr/0009-modular-platform.md`.

## Global Constraints

- Production stays unchanged in every work package: no customer-facing feature uses the new capabilities until Phase 5.
- Every production deployment and every production migration needs Mario's explicit approval for that step.
- Approval gates before implementation, not only before deploy:
  - **WP4.2 public ingress** and **WP4.5 module roles**: risk class high, with a security review.
  - **WP4.6 files**: a new bucket and new credentials (a secrets change, Q-19).
  - **WP4.7 e-mail**: a new external provider (Q-16) and a DNS change for SPF, DKIM and DMARC.
- The boundary baseline stays 0. The fixture module lives under `apps/api/tests/` and is never registered in production.
- Code comments and docs are in English.

## Review Focus

1. **The fixture module leaks into production registration.** `registerTestModules` must be the only way in, and API and worker startup must never call it. Pinned in Task 1: the default `moduleRegistry()` has exactly knowledge and marketing.
2. **A disabled third module still contributes something.** Its route, collection, tool, scheduler or action type must not reach a project that has the module off. Pinned in Task 2.
3. **A viewer reaches a module write.** Covered for the tool offer, the route permission and the ActionRequest decision. Pinned in Tasks 2 and 3.
4. **Approving one ActionRequest executes the other.** Each request carries its own payload hash. Pinned in Task 3.
5. **Platform types close the door on modules.** `ToolNamespace` was a closed union; a module tool needs an own namespace. Found in Task 1 and opened there.

---

## WP4.1 Extensibility test suite (detailed)

Risk: low (tests plus one test-only hook and one type widening). Rollback: revert.

### Task 1: Fixture module `tasks` and the registry test hook

**Files:**
- Create: `apps/api/tests/fixtures/modules/tasks/manifest.ts`, `apps/api/tests/fixtures/modules/tasks/contributions.ts`
- Modify: `apps/api/src/modules/registry.ts` (`registerTestModules`)
- Modify: `apps/api/src/modules/agents/tools/registry.ts` (`ToolNamespace` is open to module namespaces)
- Test: `apps/api/tests/extensibility.integration.test.ts`

**Interfaces:**
- `registerTestModules(extra: ReadonlyArray<{ module: ServerModule; contributions: ModuleContributions }>)`: test only. It resets the memoized registry, so the next `moduleRegistry()` or `registerModules()` includes the extra modules.
- The fixture `tasks` module:
  - id `tasks`, `dependsOn: []`, kind `fixture_tasks`;
  - permissions `tasks.read` (owner, editor, viewer) and `tasks.manage` (owner, editor);
  - route `GET /api/projects/:projectId/fixture-tasks` (`tasks.read`);
  - tool `propose_tasks` (namespace `tasks`, risk `P_proposal`, permission `tasks.manage`): it creates one ActionRequest `tasks.create` per task;
  - action type `tasks.create` (decider editor, payload `{ title }`, on approval it creates a `fixture_tasks` row);
  - a scheduler contribution that counts its sweeps.

- [ ] Failing test: "registers a third module through the contracts alone". It covers the validated order (knowledge, marketing, tasks), the kind owner, the tool owner, the action type, the scheduler set and the route, and that the default registry, without the hook, has exactly knowledge and marketing.
- [ ] Implement the hook and the fixture; widen `ToolNamespace`.

### Task 2: Activation and permissions over HTTP

- [ ] Failing scenarios in `extensibility.integration.test.ts`, with `ORBIT_MODULES=true`. Owner, editor and viewer sign in (three sign-ins at most per file).
  - Owner, editor and viewer read `/fixture-tasks` (200). A member of another project gets 404.
  - Switching `tasks` off: the route and `GET /fixture_tasks` answer 404 `MODULE_DISABLED`, `registeredTools(enabled)` has no `propose_tasks` and `registeredSchedulers(enabled)` has no tasks scheduler. Switching it on restores everything.
  - `availableTools` offers `propose_tasks` to owner and editor, not to the viewer.

### Task 3: Assistant run across three modules

**Files:** `apps/api/tests/extensibility-assistant.integration.test.ts`, using `apps/api/tests/support/package-project.ts` and a scripted `streamChat` as in `chat-runner.integration.test.ts`.

- [ ] Failing test: the editor's chat run calls `knowledge_search`, then `recent_content`, then `propose_tasks` with two tasks, then answers. The result is two pending `tasks.create` ActionRequests with different payload hashes.
  - The viewer cannot decide them (`EDITOR_REQUIRED`).
  - The editor approves one; exactly one `fixture_tasks` row exists and the other request stays pending.
  - No marketing or knowledge record changes.

### Task 4: Docs and checks

- [ ] `docs/IMPLEMENTATION_STATUS.md`, `docs/MODULE_ACTIVATION.md` (how a module plugs in; the test hook).
- [ ] Full suite, `tsc`, source check (the tests are excluded from the boundary zones), OpenAPI unchanged.

---


## WP4.4 Cross-module operator eval (detailed)

Risk: none (offline eval). It builds on WP4.1's fixture module.

- **Dataset.** `evals/operator/cases-v3.json`, a new dataset, so the v1 and v2 hashes stay comparable:
  - JC30: cross-module tool choice, ending in two ActionRequests.
  - JC31: a viewer gets no module write, and a forged call is refused.
  - JC32: a switched-off module offers nothing.
  - JC33: with every module off, only the platform's `knowledge_search` is offered.
- **Harness.** `disabledModules` (switched off in order, with `ORBIT_MODULES` on) and the check `actionRequests` (by action type). Dataset version 3.
- **Runner.** `evals/operator/cross-module.test.ts` registers the fixture module and replays the steps through the real chat runner. After every case, no fixture task exists, because proposals wait for a decision.
- **Done.** All 14 operator cases (v1, v2, v3) are green offline.

## WP4.3 Lock measurement and real-time fan-out (detailed)

Risk class high: invariants may rely on the per-project advisory lock in `scoped()` (`packages/db/src/index.ts`). This WP therefore runs in two gated parts. Part A changes nothing in behaviour. Part B starts only after Mario has seen the measurement report.

**Part A: measurement (this PR).**
- **Hook.** `lockObserver.observe` in `packages/db` receives `{ waitMs, holdMs }` for every `scoped()` transaction. It is unset in production, where it costs one property read. The measurement labels each sample with its call site from the stack.
- **Load.** `scripts/measure/lock-load.measure.ts` runs with `vitest.measure.config.ts`, outside `pnpm test`, against the local test database, for 30 s on one project:
  - five chat-stream pollers (`getRun` every 700 ms, as the SSE route does);
  - two writers;
  - the scheduler sweep every 2 s;
  - a chat run whose scripted model takes 1.5 s per call;
  - knowledge searches with a 1 s embedding.
- **Report.** `docs/evidence/lock-measurement-2026-10-17.md` gives per call site the count, wait p50/p95/max and hold p50/p95/max. It also names the transactions that hold the lock across a network call and says whether the lock limits concurrent use.

**Part B: after the report (separate PRs, each with its own approval).**
- `scopedRead()` without the advisory lock, RLS still set, for read paths the report proves read-only, starting with the chat-stream poll.
- Redis pub/sub per project and stream:
  - writers publish after commit;
  - SSE subscribes and replays from the DB with `Last-Event-ID`;
  - if Redis is down, it falls back to slow polling.
- Chat SSE onto pub/sub (optional, if the report shows the poll matters).

## WP4.2–WP4.7 (outline; each gets a detailed plan before it starts)

| WP | Content | Gate before starting |
|---|---|---|
| 4.2 Public ingress | `/api/hooks/:provider/:connectionId` (signature, store, enqueue, idempotent) and `/api/public/<module>/:publicKey/...` (CORS per key, session token, no cookies); per-client rate limits | Security review plan; F-02 fix is live |
| 4.5 Module roles | `ProjectMemberModuleRole`, `can()` resolves module role first, `none` hides the module; members UI matrix | Security review; auth change |
| 4.6 Files | `File` table with FORCE RLS, S3-compatible adapter (own bucket and credentials), streaming upload, authorized download, retention | Mario approves the bucket and credentials (Q-19) |
| 4.7 E-mail and notifications | Provider adapter (send, inbound via 4.2, bounces), `Notification` and preferences, in-app bell, e-mail channel | Mario chooses the provider (Q-16); DNS change |

Suggested order: 4.1 → 4.4 (cheap, reuses the fixture) → 4.3 measurement → 4.5 → 4.2 → 4.6 → 4.7. The last three need decisions or credentials from Mario.
