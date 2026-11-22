# Released-Post Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn the owner as soon as a released Marketing post would be refused at its slot, give an all-clear when it recovers, and warn before a knowledge action blocks released posts.

**Architecture:** A marketing `PeriodicTask` runs the existing publish `preflight` ahead of time for live publications waiting for a future slot, keeps its own per-publication state in a new entity kind, and notifies owners (bell + e-mail via `notifyMembers`, Telegram via `notify`). A new optional module contribution lets the knowledge module ask, without importing marketing, which released posts depend on the live index evaluation; a knowledge read route and a web guard use it before corpus-changing actions.

**Tech Stack:** TypeScript, Fastify, Prisma (generic `entity` table), Vitest integration tests against the worktree test DB, Next.js web.

**Spec:** `docs/superpowers/specs/2026-11-18-released-post-watch-design.md`

## Global Constraints

- Flag `ORBIT_RELEASED_POST_WATCH`, `z.enum(["false","true"]).default("false")`, covers B and C. Off: no watcher work, no entity writes, route answers `{ enabled: false, gateValid: true, count: 0, dependents: [] }`, no dialog, no MCP `releaseImpact`.
- No schema change, no migration. New entity kind only in `apps/api/src/modules/marketing/manifest.ts`.
- The watcher never writes `publications`, makes no paid or external calls, and writes no audit for checks without a change.
- Watch horizon 48 h, cap 20 publications per pass, nearest slot first, fallback interval 15 min.
- Ignored codes: `VETOED`, `PROJECT_PAUSED` (the existing `OWNER_CAUSED` list in `agents/notifications.ts`).
- Member kinds: `marketing_post_at_risk` (label de "Ein freigegebener Post wird nicht veröffentlicht", en "A released post will not be published", `emailDefault: true`), `marketing_post_at_risk_cleared` (de "Ein gefährdeter Post kann wieder veröffentlicht werden", en "An at-risk post can be published again", `emailDefault: false`). Neither `proactive`.
- Bot kinds `at_risk`, `at_risk_cleared` appended to `NOTIFY_KINDS`.
- Audit action `publication.at_risk`, content-free: `{ codes, assignmentId, assignmentRunId }`.
- Recipients: project owners only. No post body in notices beyond the title.
- Module boundaries: nothing under `apps/api/src/modules/knowledge/`, `apps/api/src/platform/` or `packages/` imports marketing (`node scripts/boundaries.mjs` stays clean, no new baseline exception).
- Dependents details only for callers whose effective Marketing role is not `none` and Marketing is enabled; everyone else gets `count` only.

## Review Focus

- A slot already passed or within the hand-off grace: the watcher ignores it (the slot path owns it) — test in Task 1.
- FB + IG of one run blocked together: one notice per watcher pass listing both posts, not one e-mail per post — test in Task 2.
- One publication whose check throws (content removed, asset unreadable) must not stop the others; it is skipped and retried next pass — test in Task 2.
- Gate already invalid when the dialog asks: no dialog, no MCP warning (posts are already blocked, the watcher has warned) — test in Task 3.
- Another project's released posts never appear in `release-impact` — test in Task 3.

---

### Task 1: Flag and risk evaluation

**Files:**
- Modify: `packages/config/src/index.ts` (flag next to `ORBIT_AI_IMAGE_LABELS`, line ~110)
- Modify: `docker-compose.yml`, `docker-compose.pve.yml` (`ORBIT_RELEASED_POST_WATCH: ${ORBIT_RELEASED_POST_WATCH:-false}` next to `ORBIT_AI_IMAGE_LABELS`), `.env.example`
- Create: `apps/api/src/modules/marketing/publishing/released-post-watch.ts`
- Test: `apps/api/tests/daily-social-automation.integration.test.ts` (new `describe` inside "from the owner's release to the Social calendar", reusing `released()`, `atMinutes()`, `provider.liveIndex`)

**Interfaces:**
- Produces:
  - `releasedPostWatchEnabled(): boolean` — `loadConfig().ORBIT_RELEASED_POST_WATCH === "true"`.
  - `WATCH_HORIZON_MS = 48 * 3600000`, `WATCH_CAP = 20`.
  - `type WatchCandidate = { id: string; slotAt: Date; data: Record<string, any> }`.
  - `watchCandidates(tx: DbTx, scope: Scope, now: Date, opts?: { horizonMs?: number | null; cap?: number | null }): Promise<WatchCandidate[]>` — publications with `test !== true`, status `intent_created` or (`blocked_dependency` and not `vetoedAt`), `scheduledAt > now`, within horizon (null = unlimited), sorted by slot, capped (null = no cap).
  - `postRisk(tx: DbTx, scope: Scope, c: WatchCandidate): Promise<string[]>` — sorted unique codes, empty = publishable.

Approach for `postRisk`: `intent_created` → `preflight(tx, scope, data.contentId, { test: false, at: slotAt, ignoreApproval: true, approvalPublicationId: c.id, ...(vetoDeadline && assignmentRunId ? { veto: { deadline, vetoedAt: null, assignmentRunId, handoff: false } } : {}) })` (`handoff: false` evaluates the post as it stands once the window ends), add `"PACKAGE_CHANGED"` when `checked.packageHash !== data.packageHash` (the claim refuses that too, `publisher.ts:171`); `blocked_dependency` → `[data.reason, ...data.blockers]` filtered to strings; drop `OWNER_CAUSED` codes.

- [ ] **Step 1: Write the failing tests**

```ts
describe("released-post watch: risk", () => {
  it("a released post with a valid live index has no risk", async () => {
    const { pubs } = await released();
    const risks = await daily.h.run(async (tx) => {
      const cs = await watchCandidates(tx, daily.project.owner, new Date());
      return Promise.all(cs.map((c) => postRisk(tx, daily.project.owner, c)));
    });
    expect(risks).toEqual([[], []]);
    expect(pubs).toHaveLength(2);
  });
  it("an invalid live index puts both released posts at risk with LIVE_RAG_EVAL_REQUIRED", async () => {
    await released();
    provider.liveIndex = false;
    const risks = /* same as above */;
    for (const r of risks) expect(r).toContain("LIVE_RAG_EVAL_REQUIRED");
  });
  it("a content invalidation before the slot is a risk carrying CONTENT_CHANGED", async () => {
    // invalidateContent(tx, owner, pub.contentId) on one released post
    // → that candidate is blocked_dependency, risk contains "CONTENT_CHANGED"
  });
  it("ignores test publications, past slots and slots beyond 48 hours", async () => {
    // test: true row, slot = now - 1 min, slot = now + 49 h → none are candidates
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/test-db-for-worktree.ts && pnpm exec vitest run apps/api/tests/daily-social-automation.integration.test.ts -t "released-post watch: risk"`
Expected: FAIL, `watchCandidates` not exported.

- [ ] **Step 3: Add the flag (config, both compose files, `.env.example`) and implement `released-post-watch.ts` with the interfaces above**

- [ ] **Step 4: Run to verify they pass**

Same command. Expected: 4 passed. Also `pnpm test:coolify-compose` passes.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/index.ts docker-compose.yml docker-compose.pve.yml .env.example apps/api/src/modules/marketing/publishing/released-post-watch.ts apps/api/tests/daily-social-automation.integration.test.ts
git commit -m "feat(marketing): evaluate released posts ahead of their slot"
```

### Task 2: Watch state, notices and the periodic task

**Files:**
- Modify: `apps/api/src/modules/marketing/manifest.ts` (entity kind `{ kind: "publication_watch", description: "Ahead-of-slot check state of released posts; no publishing authority" }`)
- Modify: `apps/api/src/modules/marketing/publishing/released-post-watch.ts`
- Modify: `apps/api/src/modules/marketing/signals.ts` (`marketingSignalNotifications`: the two member kinds)
- Modify: `apps/api/src/modules/marketing/agents/notifications.ts` (`NOTIFY_KINDS`: `at_risk`, `at_risk_cleared`)
- Modify: `apps/api/src/modules/marketing/agents/notification-messages.ts` (renderers + `render` switch)
- Modify: `apps/api/src/modules/marketing/periodic.ts` (task after `social-hold-sync`)
- Test: `apps/api/tests/daily-social-automation.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `type WatchState = { publicationId: string; slotAt: string; codes: string[]; notifiedCodes: string[]; firstSeenAt: string | null; clearedAt: string | null }` stored as `publication_watch` data, one row per publication (look up by `data.publicationId`).
  - `runReleasedPostWatch(scope: Scope): Promise<{ status?: string; wakeAt?: Date } | void>` — no-op with the flag off or when `publishingBackend` is not `social` and Postiz is unused (mirror `syncSocialHolds`' guards).
  - `nextReleasedPostWatchAt(tx: DbTx, scope: Scope): Promise<Date | null>` — `min(now + 15 min, next candidate slot)` while a candidate exists in the horizon, else `null`.
  - `atRiskReason(code: string, language: "de" | "en"): string` — German/English for `LIVE_RAG_EVAL_REQUIRED`, `CONTENT_CHANGED`, `PACKAGE_CHANGED`, `fact_changed`, `SLOT_EXPIRED`, `AI_LABEL_MISSING`; otherwise `READINESS_BLOCKERS[code]` cause + fix (English) or the bare code.

One pass: for each candidate (try/catch per candidate; a throw skips it, state untouched), compute codes; `changed` = codes non-empty and `codes ≠ notifiedCodes`; `cleared` = codes empty, `notifiedCodes` non-empty and `clearedAt` null. Write state only when something changed. Then, in the same project transaction: one `notifyMembers` per pass for all `changed` (kind `marketing_post_at_risk`, owners from `resolveRecipients(scope, { roles: ["owner"] }, "marketing")`, title per kind label, body = one line per post `"<title> · <local slot> · <channel>: <reasons>"`, link `/marketing/approvals`), one for all `cleared`; one `notify(tx, scope, "at_risk", ref)` / `"at_risk_cleared"` with `ref = <first publicationId>:<hash of the changed set>`; one `audit(..., "publication.at_risk", publicationId, { codes, assignmentId, assignmentRunId })` per changed post. Renderers read the watch rows named by the notice and return `{ skip: "STALE" }` when none is still at risk / cleared.

- [ ] **Step 1: Write the failing tests**

```ts
describe("released-post watch: notices", () => {
  beforeEach(() => vi.stubEnv("ORBIT_RELEASED_POST_WATCH", "true"));
  it("warns the owners once when both posts become at risk, with one notice for both", async () => {
    await released(); provider.liveIndex = false;
    await runReleasedPostWatch(daily.h.worker());
    await runReleasedPostWatch(daily.h.worker());
    const notices = await daily.h.run((tx) => tx.notification.findMany({ where: { kind: "marketing_post_at_risk" } }));
    expect(notices).toHaveLength(1);              // one owner, one pass, both posts
    expect(notices[0]!.body.split("\n")).toHaveLength(2);
    expect((await daily.h.rows("audit_events")).filter((a) => a.action === "publication.at_risk")).toHaveLength(2);
  });
  it("sends an all-clear once the index is valid again", async () => {
    // after the warning: provider.liveIndex = true; two passes → one marketing_post_at_risk_cleared notice
  });
  it("a new code on an already warned post warns again", async () => {
    // LIVE_RAG_EVAL_REQUIRED warned; then invalidateContent → codes change → second warning
  });
  it("one post whose check throws does not stop the other", async () => {
    // remove one post's content row → the other post is still warned; no state row for the broken one
  });
  it("does nothing with the flag off", async () => {
    vi.stubEnv("ORBIT_RELEASED_POST_WATCH", "false");
    // liveIndex false, run → no notification, no publication_watch rows
  });
  it("never changes the publications it checks", async () => {
    // versions of both publications are equal before and after two passes
  });
});
```

Notifications in this file need `vi.stubEnv("ORBIT_NOTIFICATIONS", "true")`; read the real table/field names from `model Notification` (`packages/db/prisma/schema.prisma:358`) and the audit helper's kind, and adjust the two lookups above to them.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/api/tests/daily-social-automation.integration.test.ts -t "released-post watch: notices"`
Expected: FAIL, `runReleasedPostWatch` not exported.

- [ ] **Step 3: Implement state, `atRiskReason`, the two member kinds, the two bot kinds with renderers, `runReleasedPostWatch`, `nextReleasedPostWatchAt`, and register `{ name: "released-post-watch", nextDueAt: nextReleasedPostWatchAt, run: runReleasedPostWatch }` in `marketingPeriodicTasks`**

- [ ] **Step 4: Run to verify they pass**

Same command, then the whole file. Expected: all pass, existing hand-off tests unchanged. Also `pnpm exec vitest run apps/worker/tests/queue-dispatch.integration.test.ts` still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/marketing apps/api/tests/daily-social-automation.integration.test.ts
git commit -m "feat(marketing): warn owners before a released post is lost"
```

### Task 3: Release-gate dependents, knowledge route and MCP warning

**Files:**
- Modify: `apps/api/src/platform/modules/contributions.ts` (contribution type + aggregator)
- Create: `apps/api/src/platform/knowledge/release-impact.ts` (aggregation and visibility rule)
- Modify: `apps/api/src/modules/marketing/contributions.ts` (implementation via Task 1's `watchCandidates(tx, scope, now, { horizonMs: null, cap: null })`, `intent_created` only)
- Modify: `apps/api/src/modules/knowledge/routes.ts` (read route)
- Modify: `apps/api/src/modules/knowledge/mcp-tools.ts` (`knowledge_add_document`, `knowledge_import_url`)
- Test: `apps/api/tests/released-post-impact.integration.test.ts` (new), `apps/api/tests/access-matrix.integration.test.ts` (route row)

**Interfaces:**
- Consumes: `watchCandidates`, `releasedPostWatchEnabled` (Task 1).
- Produces:
  - In `ModuleContributions`: `releaseGateDependents?: (tx: DbTx, scope: Scope) => Promise<ReleaseGateDependent[]>` with `type ReleaseGateDependent = { id: string; title: string; slotAt: string; timeZone: string; channels: string[] }`; aggregator `registeredReleaseGateDependents(): ReadonlyArray<{ moduleId: string; list: NonNullable<ModuleContributions["releaseGateDependents"]> }>`.
  - `releaseImpact(tx: DbTx, scope: Scope): Promise<{ enabled: boolean; gateValid: boolean; count: number; dependents: ReleaseGateDependent[] }>` — flag off → `{ enabled: false, gateValid: true, count: 0, dependents: [] }`; `validateActiveIndexEvaluation` invalid → `gateValid: false`, empty; otherwise sums every enabled module's list into `count`, includes `dependents` only from modules where `effectiveRole(scope, moduleId) !== "none"`.
  - Route `GET /api/projects/:projectId/knowledge/release-impact` → `releaseImpact`, scope `PROJECT_OWN` (the corpus-changing actions are owner actions; `import` is writer — use `PROJECT_WRITE` if the builder confirms `import` changes the manifest, and keep the visibility rule).
  - MCP: `knowledge_add_document` and `knowledge_import_url` compute `releaseImpact` **before** ingest/enqueue and add `releaseImpact` to their result when `count > 0`.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists a released future post when the live gate is valid", /* count 1, dependents[0].title */);
it("returns count only to a member whose Marketing role is none", /* dependents [] , count 1 */);
it("is empty when the live gate is already invalid", /* gateValid false, count 0 */);
it("never lists another project's posts", /* second project with a released post → first project's count unchanged */);
it("answers enabled false with the flag off", /* ... */);
it("knowledge_add_document returns releaseImpact computed before the ingest", /* count 1 in result */);
```

Access matrix: add the route with expected status per role exactly as for `GET /api/projects/:projectId/indexes` (owner 200, others per `PROJECT_OWN`), reviewed as a security change.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/api/tests/released-post-impact.integration.test.ts apps/api/tests/access-matrix.integration.test.ts`
Expected: FAIL (404 / not exported).

- [ ] **Step 3: Implement the contribution type and aggregator, `release-impact.ts`, Marketing's implementation, the route and the MCP result field**

- [ ] **Step 4: Run to verify they pass**

Same command; then `node scripts/boundaries.mjs` (no new violation) and `apps/api/tests/rls-matrix.integration.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/platform apps/api/src/modules/marketing/contributions.ts apps/api/src/modules/knowledge apps/api/tests/released-post-impact.integration.test.ts apps/api/tests/access-matrix.integration.test.ts
git commit -m "feat(knowledge): report released posts a corpus change would block"
```

### Task 4: Web confirmation before corpus-changing actions

**Files:**
- Create: `apps/web/src/modules/knowledge/release-impact.ts`
- Modify: `apps/web/src/modules/knowledge/workspace-text.ts` (de/en copy)
- Modify the call sites: `knowledge.tsx` (`import` ×2, `knowledge-import-commit`, `source-pause`, `source-audiences`, `revoke-source`), `add-flow.tsx` (`knowledge-content-accept`, `knowledge-site-start`), `source-list.tsx` (`knowledge-site-refresh`, `source-pause`, `revoke-source`), `index-status.tsx` (`source-reindex`, `source-settings`)
- Test: `apps/web/src/modules/knowledge/release-impact.test.ts`

**Interfaces:**
- Consumes: the route from Task 3.
- Produces: `confirmReleaseImpact(projectId: string, locale: "de" | "en", ask?: (text: string) => boolean): Promise<boolean>` — fetches the route; returns `true` without asking when `!enabled || !gateValid || count === 0`; otherwise returns `ask(text)` (default `window.confirm`, the pattern of `components/public-keys.tsx:150`). Exported `releaseImpactText(impact, locale): string`.

Copy (de): with details `"Das sperrt {n} freigegebene Posts ({Liste: 'heute 18:30 · FamilyPlan Facebook'}), bis ein neuer Index bewertet und aktiviert ist. Trotzdem fortfahren?"`; count only `"Das sperrt {n} freigegebene Marketing-Posts, bis ein neuer Index bewertet und aktiviert ist. Trotzdem fortfahren?"`. English equivalents. A failed fetch returns `true` (never block the action on the warning).

- [ ] **Step 1: Write the failing tests**

```ts
it("does not ask when nothing depends on the gate", async () => { /* count 0 → true, ask not called */ });
it("does not ask when the gate is already invalid", async () => { /* gateValid false → true */ });
it("asks with the posts named and returns the answer", async () => { /* ask → false → false; text contains "18:30" */ });
it("asks with a count when details are withheld", async () => { /* dependents [] count 2 → "2 freigegebene Marketing-Posts" */ });
it("does not block the action when the check fails", async () => { /* fetch rejects → true */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/src/modules/knowledge/release-impact.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `release-impact.ts` and the copy; at each listed call site run `if (!(await confirmReleaseImpact(project.id, locale))) return;` before `action(...)`**

The builder checks each listed action against `manifest()` in `packages/knowledge/src/indexes.ts` and drops any that cannot change it (note the decision in the commit message).

- [ ] **Step 4: Run to verify they pass**

Same command; then `pnpm typecheck` and the Playwright spec that covers the knowledge read-in (`pnpm test:e2e -- <spec>`; find it under the config's `testDir`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/modules/knowledge
git commit -m "feat(knowledge): confirm before a change blocks released posts"
```

### Task 5: Docs, generated client and full checks

**Files:**
- Modify: `docs/OPERATIONS.md` (flag paragraph: what it does, switch-on needs restart only, rollback = flag off), `docs/MODULE_ACTIVATION.md` (installation row), `docs/EMAIL_AND_NOTIFICATIONS.md` (two member kinds, two bot kinds), `docs/IMPLEMENTATION_STATUS.md` (local, flag off, not deployed)
- Regenerate: OpenAPI/client via `pnpm api:generate`

- [ ] **Step 1: Write the docs entries above (English)**
- [ ] **Step 2: Run `pnpm api:generate` and review the diff (one new GET route, no other change)**
- [ ] **Step 3: Run the full checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check`
Expected: all green; `apps/api/tests/rls-matrix.integration.test.ts`, `apps/api/tests/access-matrix.integration.test.ts`, `apps/worker/tests/queue-dispatch.integration.test.ts` pass.

- [ ] **Step 4: Commit**

```bash
git add docs apps/web/src/lib packages
git commit -m "docs: released-post watch flag, notices and rollout"
```

Delivery to `main` (deploys production) is a separate step that needs Mario's go-ahead; switching `ORBIT_RELEASED_POST_WATCH=true` in Coolify is Mario's decision. No schema hash is needed.
