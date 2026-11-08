# Ads A1 — Module Skeleton, `ads_core` Tables and Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in module `ads` that is registered, gated by `ORBIT_ADS` and the project's module row, owns the four `ads_core` tables with forced row-level security, shows empty web views to owners and editors, and changes nothing for existing modules.

**Architecture:** Mirrors the Social skeleton (plan [`2026-11-02-social-s1-module-skeleton.md`](2026-11-02-social-s1-module-skeleton.md), commits `198bca16` … `207a986a`) in its current shape: `manifest.ts`, `permissions.ts`, `gate.ts`, `settings.ts`, `http-scope.ts`, `contributions.ts`, `routes.ts` under `apps/api/src/modules/ads/`, a hand-written SQL migration with the `project_scope` policy loop, grants in `scripts/db-deploy.ts`, zones in `scripts/boundaries.json`, and a `WebModule` in `apps/web/src/modules/ads/`. Permissions are sensitive like Finance's, and the web module is editor-only like Finance's. No provider call, no job, no connection provider, no dependency.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7, PostgreSQL 17, zod 4, Vitest, Next.js 16, lucide-react.

**Spec:** programme plan [`2026-11-07-ads-module.md`](2026-11-07-ads-module.md) (§5 `ads_core` rows and settings, §6.1–§6.3, §7, §11, §12.1 row A1) and [ADR 0025](../../adr/0025-ads-module.md). Baseline: `origin/main` at `c2bafb41` (2026-11-08); re-read the touched files at the start, line numbers below are from that revision.

## Global Constraints

- **Task 0 gates the rest:** A-D1 (module id `ads` or `advertising`) is settled by the ad-blocker test before Task 1 starts. If the result is `advertising`, apply "Rename if A-D1 says `advertising`" below to every task first.
- Risk **high** (migration, row-level security, grants), environment local only; while `ORBIT_ADS` is off nothing is reachable at runtime. Workflows: `.agentic/workflows/feature.md` and `migration.md`.
- Branch from current `origin/main` in an isolated worktree. Delivery follows `AGENTS.md` ("Main delivery workflow"): integrate `origin/main`, then push to `main` **only after Mario's go**. The migration changes the production schema hash, so Mario approves the new hash in Coolify before that push (`docs/deployment/COOLIFY.md`, "Current production").
- `ORBIT_ADS` defaults to `"false"` everywhere (config, both compose files, `.env.example`). No production flag changes in A1.
- Module id `ads`, version `0.1.0`, display name `{ en: "Ads", de: "Werbung" }`, `defaultEnabled: false`, `dependsOn: []`, `entityKinds: []`, unavailable code `ADS_DISABLED` (404).
- No new npm dependency; no network in tests; no Meta, Google or OpenAI call.
- Viewers see nothing of Ads: read permissions are `owner` + `editor`; web `minAccess: "editor"`.
- Ad-blocker hygiene (A-D1): no `ad`, `ads`, `advert`, `banner` or `sponsor` token in DOM ids, CSS class names or asset paths written by the module.
- English in code, comments and docs; UI strings `en` + `de`.
- Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before Task 6 (`apps/web/AGENTS.md`).
- Integration tests run against this worktree's own test database: `node scripts/test-db-for-worktree.ts` first (README, "Parallel worktrees"). Skipped integration suites do not count as passing.

## Review Focus

1. **Module enabled while `ORBIT_ADS=false`.** Expect: every ads route answers 404 `ADS_DISABLED`. Pinned in Task 5.
2. **`ORBIT_MODULES=false` and no project row.** Expect: ads stays off, because it is opt-in. Pinned in Task 5.
3. **A viewer opens the module or calls its route.** Expect: no ads navigation for viewers; the status route answers 403 `FORBIDDEN`. Pinned in Task 2 (permission table), Task 5 (route) and Task 6 (`minAccess`).
4. **Cross-project read of an ad account** (an editor of project A asks for project B's rows). Expect: nothing returned. Pinned in Task 3 (`rls-matrix` plus `ads-schema.integration.test.ts`).
5. **A future import of a Meta or Google SDK or an intermediary** (`facebook-nodejs-business-sdk`, `google-ads-api`, n8n packages). Expect: `pnpm lint` fails. Pinned in Task 4.

## Rename if A-D1 says `advertising`

| Place | `ads` | `advertising` |
| --- | --- | --- |
| Module id (`ADS_MODULE_ID`), folders `apps/api/src/modules/<id>/`, `apps/web/src/modules/<id>/`, zones `module:<id>`, `web-module:<id>`, registry keys | `ads` | `advertising` |
| Permission key prefix (Task 2 table) | `ads.` | `advertising.` |
| API base (`ADS_BASE`), web path helper (`adsPath`), web route `/p/:id/<id>` | `/ads` | `/advertising` |

Unchanged either way: the flag `ORBIT_ADS`, the code `ADS_DISABLED`, the `Ad*` table names, the display name, TypeScript identifiers (`adsModule`, `inAds`, …) and the view paths of Task 6.

---

### Task 0: Settle A-D1 with the ad-blocker test

**Files:**
- Create (outside the repository): `~/orbit-ads-spike/adblock/` (static test site, A0 spike plan §4.6)
- Modify: `docs/superpowers/plans/2026-11-07-ads-a0-spike.md` (§7 row Q18), `docs/superpowers/plans/2026-11-07-ads-module.md` (§3 row A-D1: add "Settled 2026-MM-DD: `ads`" or "`advertising`")

- [ ] **Step 1:** Build the site of A0 §4.6: the paths `/p/test/ads/`, `/p/test/ads/units/`, `/p/test/ads/creatives/`, `/p/test/advertising/`, `/p/test/campaigns/`; fetches of `/api/projects/test/{ads,advertising,paid-media}/status.json`; elements with the classes `ads-summary`, `ad-card`, `campaign-card` and the ids `nav-group-ads`, `settings-group-ads`. Each row turns green when it loaded or is visible and red when it was blocked or hidden. Serve it with `python3 -m http.server 4399`.
- [ ] **Step 2:** Mario opens it in Chrome with uBlock Origin, Chrome or Firefox with AdGuard (default lists) and Brave with Shields on, and reports the red rows.
- [ ] **Step 3: Decide.** Every `ads` path and fetch green → `ads`. Any `ads` path or fetch red while the `advertising` row is green → `advertising`. One of the shell ids red → stop and report to Mario: the shell derives `nav-group-<id>` (`apps/web/src/platform/shell/sidebar-nav.tsx:107`) and `settings-group-<id>` (`settings-nav.tsx:192`) from the module id, and changing that is a platform change outside A1.
- [ ] **Step 4:** Record the result in both documents and commit: `git commit -m "docs(ads): settle A-D1 module id after the ad-blocker test"`.

### Task 1: Installation switch `ORBIT_ADS`

**Files:**
- Modify: `packages/config/src/index.ts` (after the `ORBIT_SOCIAL_PLATFORMS` block, before `ORBIT_CUSTOMER_CONTEXT`, ~line 234)
- Modify: `docker-compose.yml` (after `ORBIT_SOCIAL_PLATFORMS`, ~line 85), `.env.example` (after `ORBIT_SOCIAL_PLATFORMS=`, ~line 93), `scripts/check-coolify-compose.mjs` (next to `ORBIT_SOCIAL` in the four lists at ~66, ~193, ~245 with value `"true"`, ~278)
- Regenerate: `docker-compose.pve.yml` and `docker-compose.pve.source.sha256` with `node scripts/render-pve-compose.mjs`
- Test: `apps/api/tests/ads-module.test.ts` (new; `packages/config` has no test file, Social tests its flag the same way in `social-module.test.ts:22-28`)

**Interfaces:**
- Produces: `loadConfig().ORBIT_ADS: "false" | "true"`

- [ ] **Step 1: Write the failing test** (clear `process.env.ORBIT_ADS` in `beforeEach` and `afterEach`):

```ts
it("ORBIT_ADS defaults to false and accepts only false or true", () => {
  expect(loadConfig().ORBIT_ADS).toBe("false");
  process.env.ORBIT_ADS = "true";
  expect(loadConfig().ORBIT_ADS).toBe("true");
  process.env.ORBIT_ADS = "yes";
  expect(() => loadConfig()).toThrow();
});
```

- [ ] **Step 2: Run it and see it fail** — `pnpm exec vitest run apps/api/tests/ads-module.test.ts` → FAIL (`ORBIT_ADS` undefined).
- [ ] **Step 3: Add** `ORBIT_ADS: z.enum(["false", "true"]).default("false")` with the comment `// Ads module (ADR 0025): off until its rollout is approved. Even when "true", it works only in projects whose owner enabled the module.`; `ORBIT_ADS: ${ORBIT_ADS:-false}` with `# Ads module (ADR 0025): off until its rollout is approved.` in `docker-compose.yml`; `ORBIT_ADS=false` with `# Ads module (ADR 0025): off until its rollout; owners still enable it per project.` in `.env.example`; the key in the four lists; then render the PVE files.
- [ ] **Step 4: Verify** — the test PASS; `pnpm test:coolify-compose` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): installation switch ORBIT_ADS (off)"`

### Task 2: Manifest, permissions, gate, settings, status route, registration

**Files:**
- Create: `apps/api/src/modules/ads/{manifest.ts, permissions.ts, gate.ts, settings.ts, http-scope.ts, contributions.ts, routes.ts}`
- Modify: `apps/api/src/modules/registry.ts` (imports after `socialContributions` ~line 18; append `adsModule` to `modules` ~line 38; `ads: adsContributions` in `registerContributions` ~line 82)
- Modify: `apps/api/tests/module-registry.test.ts:72-91`, `apps/api/tests/extensibility.integration.test.ts:55-66` and `:84-92` (orders and the ordering comment)
- Test: `apps/api/tests/ads-module.test.ts`

**Interfaces:**
- Produces:
  - `ADS_MODULE_ID = "ads"` (`manifest.ts`; `gate.ts` and `http-scope.ts` use it, so a rename touches one constant per app).
  - `adsModule: ServerModule` (`id: ADS_MODULE_ID`, `version: "0.1.0"`, `displayName: { en: "Ads", de: "Werbung" }`, `dependsOn: []`, `defaultEnabled: false`, `entityKinds: []`, `tables: ["AdAccount", "AdOAuthState", "AdProviderThrottle", "AdSyncState"]`, `permissions: adsPermissions`).
  - Permissions (key, default roles, sensitive), built with `permission()` from `platform/tenancy/permissions.ts` and Finance's `sensitive()` wrapper (`finance/permissions.ts:5-8`): `ads.read` [owner, editor] **yes**; `ads.analytics.read` [owner, editor] **yes**; `ads.compose` [owner, editor] no; `ads.manage` [owner, editor] no; `ads.approve` [owner] **yes**; `ads.accounts.manage` [owner] **yes**; `ads.budget.manage` [owner] **yes**; `ads.settings` [owner] no. Exported as `ADS_READ`, `ADS_ANALYTICS_READ`, `ADS_COMPOSE`, `ADS_MANAGE`, `ADS_APPROVE`, `ADS_ACCOUNTS_MANAGE`, `ADS_BUDGET_MANAGE`, `ADS_SETTINGS` and `adsPermissions` in that order.
  - `adsSwitchedOn(): boolean`, `adsActive(tx: DbTx, scope: Scope): Promise<boolean>`, `requireAds(tx: DbTx, scope: Scope): Promise<void>` (throws `DomainError("ADS_DISABLED", 404)`); same shape as `social/gate.ts`.
  - `adsSettingsSchema` (strict zod object): `decider: z.literal("owner")`, `autoPauseAtLimit: z.boolean()`, `utmTemplate: z.string().min(1).max(500).nullable()`, `reportDay: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])`, `backfillDays: z.int().min(1).max(1125)`, `insightsRetentionMonths: z.int().min(13).max(60)`; `type AdsSettings`; `defaultAdsSettings(): AdsSettings` returns `{ decider: "owner", autoPauseAtLimit: false, utmTemplate: null, reportDay: "monday", backfillDays: 90, insightsRetentionMonths: 25 }`; `readAdsSettings(tx, scope)` over `readModuleSettings` (`platform/modules/settings.ts`), same return shape as `readSocialSettings`. The spec's `conversionDefaults` arrives in A5 as a field with `.default({})`, so settings stored by A1 still parse.
  - ``ADS_BASE = `/api/projects/:projectId/${ADS_MODULE_ID}` `` and `inAds(auth, req, required, work)` in `http-scope.ts`, a copy in shape of `social/http-scope.ts:12-29` (`scopeFor` → `scoped` → `requireAds`).
  - `adsRoutes: RoutesContribution` with one route `GET ${ADS_BASE}/status` (permission `ADS_READ`) returning `{ module: "ads", version: adsModule.version, settings, settingsVersion }` (as `social/routes.ts:58-67`).
  - `adsContributions: ModuleContributions = { available: adsSwitchedOn, unavailableCode: "ADS_DISABLED", routes: adsRoutes }`.

- [ ] **Step 1: Write the failing tests** in `ads-module.test.ts`:

```ts
it("registers ads as an opt-in module with sensitive read permissions", () => {
  expect(modules).toContain(adsModule);
  expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
  expect(adsModule).toMatchObject({ id: "ads", version: "0.1.0", dependsOn: [], defaultEnabled: false, entityKinds: [] });
  expect(adsModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true])).toEqual([
    ["ads.read", ["owner", "editor"], true],
    ["ads.analytics.read", ["owner", "editor"], true],
    ["ads.compose", ["owner", "editor"], false],
    ["ads.manage", ["owner", "editor"], false],
    ["ads.approve", ["owner"], true],
    ["ads.accounts.manage", ["owner"], true],
    ["ads.budget.manage", ["owner"], true],
    ["ads.settings", ["owner"], false],
  ]);
});
it("is switched off unless ORBIT_ADS=true", () => {
  expect(adsSwitchedOn()).toBe(false);
  process.env.ORBIT_ADS = "true";
  expect(adsSwitchedOn()).toBe(true);
  expect(adsContributions.unavailableCode).toBe("ADS_DISABLED");
});
it("defaults to owner decisions and refuses unknown or out-of-range settings", () => {
  expect(adsSettingsSchema.parse(defaultAdsSettings())).toEqual(defaultAdsSettings());
  expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), decider: "editor" })).toThrow();
  expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), backfillDays: 0 })).toThrow();
  expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), insightsRetentionMonths: 12 })).toThrow();
  expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), extra: 1 })).toThrow();
});
it("lists every Ad* table in the manifest", () => {
  const schema = readFileSync(join(root, "packages/db/prisma/schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model (Ad[A-Z]\w*) \{/gm)].map((m) => m[1]).sort();
  expect([...adsModule.tables].sort()).toEqual(models);
});
```

Orders: `module-registry.test.ts` ids end with `"social", "ads"` and `registry.order` becomes `["ads", "finance", "issues", "knowledge", "social", "support", "work", "marketing"]`; `extensibility.integration.test.ts` order becomes `["ads", "finance", "issues", "knowledge", "social", "support", "tasks", "work", "marketing"]` and its id list ends with `"social", "ads"`.

- [ ] **Step 2: Run them and see them fail** — `pnpm exec vitest run apps/api/tests/ads-module.test.ts apps/api/tests/module-registry.test.ts` → FAIL (module missing). The table test stays red until Task 3.
- [ ] **Step 3: Implement** the seven files and the registration.
- [ ] **Step 4: Verify** — both files pass except the table test; `pnpm exec vitest run apps/api/tests/module-contributions.test.ts` still PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): opt-in module manifest, permissions, gate and settings"`

### Task 3: Data model and migration `ads_core`

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (four models after the `Social*` block; no back-relations on `Project`, like `Social*`)
- Create: `packages/db/prisma/migrations/<YYYYMMDD>0001_ads_core/migration.sql` (implementation date; must sort after the newest folder, `202611050003_support_message_translations` at baseline)
- Modify: `scripts/db-deploy.ts` (`business` array after the Social names ~line 249: `AdOAuthState`, `AdProviderThrottle`, `AdSyncState`; restricted grant `GRANT SELECT,INSERT,UPDATE ON "AdAccount" TO orbit_app` next to the Social grants ~301-308)
- Modify: `apps/api/tests/rls-matrix.integration.test.ts` (`PROJECT_TABLES` under `// Ads module (ADR 0025).`; `RESTRICTED_GRANTS` `AdAccount: [true, true, true, false]`; a `seedAds(tx, s)` called from `seed()` next to `seedSocial`, one row per table; the project-delete cascade filter also covers `/^Ad[A-Z]/`)
- Create: `apps/api/tests/support/ads-project.ts` (`createAdsProject(options?)`, a copy of `support/social-project.ts` with `modules: ["ads"]`)
- Test: `apps/api/tests/ads-schema.integration.test.ts`

**Interfaces:**
- Produces Prisma delegates `tx.adAccount`, `tx.adOAuthState`, `tx.adProviderThrottle`, `tx.adSyncState`; `createAdsProject(options?: { name?: string; modules?: string[] })` returning what `createSocialProject` returns.

Every table has `workspaceId UUID NOT NULL`, `projectId UUID NOT NULL`, the composite FK `("workspaceId","projectId") REFERENCES "Project"("workspaceId","id") ON DELETE CASCADE`, `Timestamptz(3)` times. Tables with an `id` also get `@@unique([projectId, id])`. Pinned columns and SQL rules (programme plan §5):

| Table | Columns | Checks and keys |
| --- | --- | --- |
| `AdAccount` | `id`, `provider`, `externalId`, `name`, `currency`, `timezone`, `connectionId UUID` (no FK: `Connection` has its own RLS; resolved by the service), `businessId?`, `status` default `'active'`, `capability` default `'read_verified'`, `writesEnabled` default `false`, `providerStatus?`, `spendCapMicros BigInt?`, `amountSpentMicros BigInt?`, `settings Json` default `{}`, `lastSyncedAt?`, `version` default 1, `createdBy`, `createdAt`, `updatedAt` | `provider IN ('meta','openai','google')`; `status IN ('active','reconnect_required','disabled','unlinked')`; `capability IN ('read_verified','write_ready','write_verified')`; `currency ~ '^[A-Z]{3}$'`; `spendCapMicros >= 0`; `amountSpentMicros >= 0`; unique `(projectId, provider, externalId)` named `AdAccount_external_key`; index `(projectId, status)` |
| `AdOAuthState` | `id`, `stateHash`, `provider`, `appConnectionId UUID`, `userId`, `verifierCiphertext?`, `redirectAfter?`, `expiresAt`, `usedAt?`, `createdAt` | unique `stateHash`; `stateHash ~ '^[0-9a-f]{64}$'`; `provider IN ('meta','openai','google')`; `expiresAt > createdAt` |
| `AdSyncState` | `accountId UUID`, `stream`, `cursor Json` default `{}`, `watermark?`, `nextRunAt`, `lastSuccessAt?`, `lastErrorCode?`, `consecutiveFailures` default 0, `leaseToken UUID?`, `leaseExpiresAt?`, `updatedAt` | PK `(projectId, accountId, stream)`; FK `("projectId","accountId") → "AdAccount"("projectId","id") ON DELETE CASCADE`; `stream IN ('structure','status','insights_recent','insights_backfill','spend_today','health')`; `consecutiveFailures >= 0`; `(leaseToken IS NULL) = (leaseExpiresAt IS NULL)`; index `(projectId, nextRunAt)` |
| `AdProviderThrottle` | `scope`, `bucket`, `usagePct Decimal(6,2)?`, `windowStart`, `blockedUntil?`, `updatedAt` | PK `(projectId, scope, bucket)`; `bucket ~ '^[a-z][a-z0-9_]{1,63}$'`; `usagePct >= 0` |

Then the `DO $$ … FOREACH t IN ARRAY [...] LOOP` block from `202611020001_social_core/migration.sql:286-296` for the four tables. Grants: full business grants for `AdOAuthState`, `AdProviderThrottle`, `AdSyncState`; `AdAccount` `[select, insert, update]` (an account is unlinked by status and deleted only with its project, so later spend history keeps its account), mirrored in `RESTRICTED_GRANTS`.

- [ ] **Step 1: Write the failing tests** in `ads-schema.integration.test.ts` (style of `social-schema.integration.test.ts`):
  - `refuses the same ad account twice in one project` → unique violation on `(projectId, provider, externalId)`.
  - `refuses an unknown provider, status or capability` → check violations.
  - `refuses a negative spend cap` → check violation.
  - `refuses a currency that is not three capital letters` → check violation (`"eur"`).
  - `refuses a sync state for another project's account` → FK violation.
  - `refuses a lease token without an expiry` → check violation.
  - `hides another project's ad accounts` → a row created in project A is not returned by `findMany` in project B's `scoped` transaction.
  - `keeps ad accounts when the business role tries to delete one` → permission denied.
  Add the names and grants to `rls-matrix.integration.test.ts` as listed above.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run apps/api/tests/ads-schema.integration.test.ts apps/api/tests/rls-matrix.integration.test.ts` → FAIL (tables missing).
- [ ] **Step 3: Implement** the models, the migration and the grants; `pnpm db:generate`; apply to this worktree's test database only (`node scripts/test-db-for-worktree.ts`).
- [ ] **Step 4: Verify** — both files PASS; the Task 2 table test PASS; `sh scripts/check-pve-schema.sh --print-hash` prints a new hash. Record it in `docs/IMPLEMENTATION_STATUS.md` (Task 7) for Mario's approval; do not set it anywhere.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): ads_core tables with forced row-level security"`

### Task 4: Boundary zones and the no-SDK rule

**Files:**
- Modify: `scripts/boundaries.json` (zones `"module:ads": ["apps/api/src/modules/ads/"]` and `"web-module:ads": ["apps/web/src/modules/ads/"]` next to Social's; append `"facebook-nodejs-business-sdk"`, `"google-ads-api"`, `"google-ads-node"`, `"n8n-"`, `"@n8n/"` to `forbiddenImportPrefixes`; extend the `$comment` line for both)
- Test: `scripts/boundaries.test.mjs`

**Interfaces:**
- Produces: `pnpm lint` fails on any import specifier starting with one of the five prefixes, in any zone.

- [ ] **Step 1: Write the failing tests** — `classify("apps/api/src/modules/ads/gate.ts", zones)` is `"module:ads"`, `classify("apps/web/src/modules/ads/overview.tsx", zones)` is `"web-module:ads"`, and `classify("apps/api/src/modules/workflow.ts", zones)` stays `"module:marketing"`; in `describe("checkForbiddenImportPrefixes")` an `import "facebook-nodejs-business-sdk"` and a dynamic `import("google-ads-api/build")` in a `module:ads` file are both reported, while `import "@orbit/connectors"` is not.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run scripts/boundaries.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the zones and prefixes. Before committing, `rg -n "from ['\"](facebook-nodejs-business-sdk|google-ads-|n8n-|@n8n/)" apps packages scripts` returns nothing.
- [ ] **Step 4: Verify** — the test passes; `node scripts/source-check.mjs` (part of `pnpm lint`) passes with an unchanged empty `baseline`.
- [ ] **Step 5: Commit** — `git commit -m "chore(ads): module zones and a ban on ads SDKs and intermediaries"`

### Task 5: Gate, roles and route behaviour

**Files:**
- Modify: `apps/api/tests/access-matrix.integration.test.ts` (env block ~25-50: `// Ads module (ADR 0025): routes exist; the project never enables it.` and `ORBIT_ADS: "true"`); regenerate `apps/api/tests/fixtures/access-matrix.json` with `UPDATE_ACCESS_MATRIX=1` and review the diff as a security change
- Regenerate: OpenAPI and client artifacts with `pnpm api:generate`; review the diff (one new route)
- Test: `apps/api/tests/ads-routes.integration.test.ts`

**Interfaces:**
- Consumes: `GET /api/projects/:projectId/ads/status` (Task 2), `createAdsProject` (Task 3).

- [ ] **Step 1: Write the failing tests** in `ads-routes.integration.test.ts`:
  - `ORBIT_ADS=false`, module row enabled → `404 {code: "ADS_DISABLED"}`.
  - `ORBIT_ADS=true`, no module row, `ORBIT_MODULES=false` → `404 ADS_DISABLED` (opt-in).
  - `ORBIT_ADS=true`, row enabled → owner and editor get `200` with `module === "ads"` and `settings.decider === "owner"`; the viewer gets `403 FORBIDDEN`.
  - Member of another project → `404 NOT_FOUND`.
  - `ORBIT_MODULE_ROLES=true` and module role `none` for the editor → `404 MODULE_NOT_AVAILABLE`.
  - Disabling the module keeps its `ProjectModule` row and returns `404 ADS_DISABLED` afterwards.
  The regenerated access-matrix entry `GET /api/projects/{projectId}/ads/status` has the shape of the Social status entry (`fixtures/access-matrix.json:1850-1857`): anonymous `unauthenticated`, outsider and sysadmin `not_found`, viewer, editor and owner `not_found:MODULE_DISABLED`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** whatever is missing (normally nothing beyond Task 2).
- [ ] **Step 4: Verify** — `pnpm exec vitest run apps/api/tests/ads-routes.integration.test.ts apps/api/tests/module-enforcement.integration.test.ts apps/api/tests/access-matrix.integration.test.ts` PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(ads): gate, roles and opt-in behaviour of the module route"`

### Task 6: Web module skeleton

**Files:**
- Create: `apps/web/src/modules/ads/{manifest.tsx, labels.ts, api.ts, overview.tsx, placeholder.tsx}`
- Modify: `apps/web/src/modules/registry.ts` (import `adsWeb` after `socialWeb` ~line 46; append to `modules` ~line 345)
- Modify: `apps/web/src/platform/shell/nav-groups.test.tsx:17-28` (`"ads"` after `"social"`), `settings-nav.test.tsx:263-273` (append `["ads", undefined]`)
- Test: `apps/web/src/modules/ads/ads.test.tsx`

**Interfaces:**
- Produces: `adsWeb: WebModule` (`apps/web/src/platform/shell/types.ts:177`) with `id: "ads"`, `optIn: true`, `minAccess: "editor"`, `displayName: { en: "Ads", de: "Werbung" }`, a `description`, `groupOrder: 13` (comment: right after Social 12, before Work 15), no `home`, `settings`, `attention` or `actionRequests` yet. Views (key, path, lucide icon, label en / de):

| Key | Path | Icon | Label |
| --- | --- | --- | --- |
| `ads` | `""` | `LayoutDashboard` | Overview / Übersicht |
| `ads.campaigns` | `campaigns` | `Megaphone` | Campaigns / Kampagnen |
| `ads.units` | `units` | `LayoutGrid` | Ads / Anzeigen |
| `ads.creatives` | `creatives` | `Images` | Creatives / Werbemittel |
| `ads.performance` | `performance` | `BarChart3` | Performance / Performance & Analytics |
| `ads.accounts` | `accounts` | `Link2` | Accounts / Konten & Verbindungen |

  Every view except the overview renders `placeholder.tsx` (Social's skeleton placeholder: `Empty` with "Coming in a later phase" / "Folgt in einer späteren Phase").
- `api.ts`: `type AdsStatus = { module: "ads"; version: string; settings: AdsSettings; settingsVersion: number }` (settings typed like the server schema) and `adsPath(projectId: string, rest = ""): string` → `/projects/${encodeURIComponent(projectId)}/ads${rest}`.
- `labels.ts`: `adsText(locale: "en" | "de"): AdsText` with `type AdsText = typeof en`, Social's `labels.ts` pattern.

- [ ] **Step 1: Write the failing tests:**
  - the manifest exposes exactly the six view keys above, in that order, with `minAccess: "editor"` and `optIn: true`;
  - `adsText("en")` and `adsText("de")` have the same keys and a nav label for every view;
  - the overview, given a mocked status, shows "Spend decisions: owner only" / "Ausgaben entscheidet nur der Owner" and the empty state "No ad account connected yet" / "Noch kein Werbekonto verbunden";
  - **hygiene:** rendering each view, no element's `id` or `class` token matches `/(^|[-_])(ad|ads|advert|banner|sponsor)([-_]|$)/i`;
  - every interactive element has an accessible name.
- [ ] **Step 2: Run and see them fail** — `pnpm --dir apps/web exec vitest run src/modules/ads` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — tests PASS; the two shell tests PASS; `pnpm --dir apps/web typecheck` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): opt-in web module with placeholder views"`

### Task 7: Documentation and full check

**Files:**
- Create: `docs/ADS.md` (purpose, status "A1: skeleton, flag off", tables, permissions, settings, flag, the two kinds of limits in one paragraph, links to ADR 0025 and the plans)
- Modify: `docs/MODULE_ACTIVATION.md` (new section `## Ads module (opt-in, <date>, branch only; flag off)` after the Social section ~line 170, with its Layer/Rule table), `docs/IMPLEMENTATION_STATUS.md` (top entry: what exists, flag off, migration not applied in production, new schema hash for Mario's approval), `docs/REQUIREMENTS_TRACEABILITY.md` (an Ads section like the Social one at line 70: R1 and R1-DB rows with files and tests, the other requirements pointing at their steps), `docs/superpowers/plans/2026-11-07-ads-module.md` (§12.1 row A1: "Done <date>" with the commit)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full required checks** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and `pnpm test:coolify-compose`; expected: all green, integration suites executed (not skipped).
- [ ] **Step 3: Review the diff** against `.agentic/quality-gates/definition-of-done.md`, `review-checklist.md`, `security-checklist.md` and the data-safety gate (migration); confirm the hash recorded in Task 3.
- [ ] **Step 4: Commit** — `git commit -m "docs(ads): A1 module skeleton status and activation"`

## Done when

- `ORBIT_ADS=false` → no ads route or view is reachable; all existing suites unchanged.
- `ORBIT_ADS=true` + enabled row → the status route and six views work for owners and editors; viewers get nothing; another project's members get 404.
- Four tables with forced RLS, the pinned constraints and grants; `rls-matrix` and `access-matrix` green; the new schema hash is recorded for Mario.
- `pnpm lint` refuses Meta and Google SDK and n8n imports.
- **Rollback:** before deployment, revert the branch. After deployment the tables are empty and inert while the flag is off; dropping them needs a separate approved migration.
