# Social S1 — Module Skeleton, Data Model and Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in module `social` that is registered, gated by `ORBIT_SOCIAL` and the project's module row, owns its ten tables with forced row-level security, appears as empty web views, and changes nothing for existing modules.

**Architecture:** Mirrors the issues module (ADR 0018), which is the latest module built on the modular platform: `manifest.ts` + `permissions.ts` + `gate.ts` + `settings.ts` + `contributions.ts` + `routes.ts` under `apps/api/src/modules/social/`, a hand-written SQL migration with the `project_scope` policy loop, grants in `scripts/db-deploy.ts`, zones in `scripts/boundaries.json`, and a `WebModule` in `apps/web/src/modules/social/`. No platform call, no SDK dependency, no job yet.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7, PostgreSQL 17, Vitest, Next.js 16, lucide-react.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§5 data model, §6.1 files, §6.2 module settings, §10 S1) and [ADR 0020](../../adr/0020-social-module.md).

## Global Constraints

- Branch from current `origin/main` in an isolated worktree; never commit to `main`; push only with Mario's approval.
- The migration is a production schema change: it ships only with Mario's approval of the new `ORBIT_APPROVED_SCHEMA_SHA256` (`scripts/check-pve-schema.sh --print-hash`).
- `ORBIT_SOCIAL` defaults to `"false"` everywhere (config, both compose files, `.env.example`).
- Module id `social`, version `0.1.0`, `defaultEnabled: false`, `dependsOn: []`.
- No new npm dependency in S1 (the SDK arrives in S2 after approval).
- English in code, comments and docs; UI strings `en` + `de`.
- Read `apps/web/node_modules/next/dist/docs/` before Task 6 (`apps/web/AGENTS.md`).
- Integration tests need the local test databases (`TEST_DATABASE_URL`, `TEST_AUTH_DATABASE_URL`; `pnpm local:setup`); without them they are skipped, which does not count as passing for this plan.

## Review Focus

1. **Cross-project read of a social row** (an editor of project A asks for a post id of project B). Expect: not found. Pinned in Task 3 (`rls-matrix` classification plus `social-schema.integration.test.ts` cross-scope read).
2. **Module enabled while `ORBIT_SOCIAL=false`.** Expect: every social route 404 `SOCIAL_DISABLED`. Pinned in Task 5.
3. **`ORBIT_MODULES=false` (production default before enforcement) and no project row.** Expect: social still off, because it is opt-in (`defaultEnabled: false`). Pinned in Task 5.
4. **A viewer opening the module.** Expect: views visible read-only; `social.compose`/`social.approve`/`social.accounts.manage` denied. Pinned in Task 2 (permission table) and Task 5 (route check).
5. **A future import of a managed provider** (`@opencoredev/social-sdk/cloud/postiz`). Expect: `pnpm lint` fails. Pinned in Task 4.

---

### Task 1: Installation switch `ORBIT_SOCIAL`

**Files:**
- Modify: `packages/config/src/index.ts` (next to `ORBIT_ISSUES`, ~line 200)
- Modify: `docker-compose.yml` (~line 72), `.env.example` (~line 77), `scripts/check-coolify-compose.mjs` (the four lists at ~57, ~176, ~221, ~247), `docker-compose.pve.yml` via `node scripts/render-pve-compose.mjs`
- Test: `packages/config/src/index.test.ts` (or the existing config test file; find it with `rg -l "ORBIT_ISSUES" packages/config`)

**Interfaces:**
- Produces: `loadConfig().ORBIT_SOCIAL: "false" | "true"`

- [ ] **Step 1: Write the failing test**

```ts
it("ORBIT_SOCIAL defaults to false and accepts true", () => {
  expect(loadConfig({ ...baseEnv }).ORBIT_SOCIAL).toBe("false");
  expect(loadConfig({ ...baseEnv, ORBIT_SOCIAL: "true" }).ORBIT_SOCIAL).toBe("true");
  expect(() => loadConfig({ ...baseEnv, ORBIT_SOCIAL: "yes" })).toThrow();
});
```
(Use the existing config test's environment fixture and call style.)

- [ ] **Step 2: Run it and see it fail** — `pnpm exec vitest run packages/config` → FAIL (`ORBIT_SOCIAL` undefined).
- [ ] **Step 3: Add** `ORBIT_SOCIAL: z.enum(["false", "true"]).default("false")` with a one-line comment ("Social module installation switch, ADR 0020"); add `ORBIT_SOCIAL: ${ORBIT_SOCIAL:-false}` to both compose files, `ORBIT_SOCIAL=false` to `.env.example`, and the name to every list in `check-coolify-compose.mjs` where `ORBIT_ISSUES` appears.
- [ ] **Step 4: Verify** — `pnpm exec vitest run packages/config` PASS; `pnpm test:coolify-compose` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(social): installation switch ORBIT_SOCIAL (off)"`

### Task 2: Manifest, permissions, gate, settings, registration

**Files:**
- Create: `apps/api/src/modules/social/{manifest.ts, permissions.ts, gate.ts, settings.ts, contributions.ts, routes.ts}`
- Modify: `apps/api/src/modules/registry.ts` (import + `modules[]` after `issuesModule` + contributions map)
- Modify: `apps/api/tests/module-registry.test.ts` (module list and order)
- Test: `apps/api/tests/social-module.test.ts`

**Interfaces:**
- Produces:
  - `socialModule: ServerModule` (`id "social"`, `version "0.1.0"`, `displayName {en: "Social", de: "Social Media"}`, `dependsOn: []`, `defaultEnabled: false`, `entityKinds: []`, `tables` = the ten names in Task 3, `permissions: socialPermissions`)
  - Permissions (key, default roles, sensitive): `social.read` [owner, editor, viewer] no; `social.compose` [owner, editor] no; `social.publish` [owner, editor] no; `social.approve` [owner] no; `social.accounts.manage` [owner] **yes**; `social.analytics.read` [owner, editor, viewer] no; `social.settings` [owner] no — exported as `SOCIAL_READ`, `SOCIAL_COMPOSE`, `SOCIAL_PUBLISH`, `SOCIAL_APPROVE`, `SOCIAL_ACCOUNTS_MANAGE`, `SOCIAL_ANALYTICS_READ`, `SOCIAL_SETTINGS` and `socialPermissions` in that order.
  - `socialSwitchedOn(): boolean`, `socialActive(tx, scope): Promise<boolean>`, `requireSocial(tx, scope): Promise<void>` (throws `DomainError("SOCIAL_DISABLED", 404)`), same shape as `issues/gate.ts`.
  - `socialSettingsSchema` (strict zod): `{ approval: "owner_each" | "editor_each", mcpOwnerPublishWithoutApproval: boolean }`; `defaultSocialSettings = { approval: "owner_each", mcpOwnerPublishWithoutApproval: false }`; `readSocialSettings(tx, scope)` / `writeSocialSettings(tx, scope, settings, expectedVersion)` over `platform/modules/settings.ts`.
  - `socialContributions: ModuleContributions = { available: socialSwitchedOn, unavailableCode: "SOCIAL_DISABLED", routes: socialRoutes, files: { privateToModule: true } }`.

- [ ] **Step 1: Write the failing tests** in `social-module.test.ts`:

```ts
it("registers social as an opt-in module with its permissions", () => {
  expect(modules).toContain(socialModule);
  expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
  expect(socialModule).toMatchObject({ id: "social", dependsOn: [], defaultEnabled: false, entityKinds: [] });
  expect(socialModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true])).toEqual([
    ["social.read", ["owner", "editor", "viewer"], false],
    ["social.compose", ["owner", "editor"], false],
    ["social.publish", ["owner", "editor"], false],
    ["social.approve", ["owner"], false],
    ["social.accounts.manage", ["owner"], true],
    ["social.analytics.read", ["owner", "editor", "viewer"], false],
    ["social.settings", ["owner"], false],
  ]);
});
it("is switched off unless ORBIT_SOCIAL=true", () => {
  expect(socialSwitchedOn()).toBe(false);
  process.env.ORBIT_SOCIAL = "true";
  expect(socialSwitchedOn()).toBe(true);
  expect(socialContributions.unavailableCode).toBe("SOCIAL_DISABLED");
});
it("defaults to owner approval and refuses unknown settings", () => {
  expect(socialSettingsSchema.parse({})).toEqual(defaultSocialSettings); // if the schema uses defaults; otherwise parse(defaultSocialSettings)
  expect(() => socialSettingsSchema.parse({ ...defaultSocialSettings, approval: "nobody" })).toThrow();
  expect(() => socialSettingsSchema.parse({ ...defaultSocialSettings, extra: 1 })).toThrow();
});
it("lists every social table in the manifest and nowhere else", () => {
  const schema = readFileSync(join(root, "packages/db/prisma/schema.prisma"), "utf8");
  const models = [...schema.matchAll(/^model (Social\w+) \{/gm)].map((m) => m[1]).sort();
  expect([...socialModule.tables].sort()).toEqual(models);
});
```

Update `module-registry.test.ts`: `modules` ids end with `"issues", "social"`; `registry.order` becomes `["finance", "issues", "knowledge", "social", "support", "work", "marketing"]`.

- [ ] **Step 2: Run them and see them fail** — `pnpm exec vitest run apps/api/tests/social-module.test.ts apps/api/tests/module-registry.test.ts` → FAIL (module missing). The table test stays red until Task 3.
- [ ] **Step 3: Implement** the six files and the registration. `routes.ts` exports `socialRoutes: RoutesContribution` with `BASE = "/api/projects/:projectId/social"` and the helper `inSocial(auth, req, required, work)` copied in shape from `issues/routes.ts:40-55` (`scopeFor` → `scoped` → `requireSocial`), plus one route `GET ${BASE}/status` (permission `SOCIAL_READ`) returning `{ module: "social", version: "0.1.0", settings }`.
- [ ] **Step 4: Verify** — both test files pass except the table test; `pnpm exec vitest run apps/api/tests/module-contributions.test.ts` still PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(social): opt-in module manifest, permissions, gate and settings"`

### Task 3: Data model and migration `social_core`

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (ten models after the `Issue*` block; back-relations on `Project` only if the existing modules do so — they do not for `Issue*`, so none)
- Create: `packages/db/prisma/migrations/<YYYYMMDD>0001_social_core/migration.sql` (date of implementation; must sort after the newest folder)
- Modify: `scripts/db-deploy.ts` (business-table list ~180-238 and the restricted grants after ~284)
- Modify: `apps/api/tests/rls-matrix.integration.test.ts` (`PROJECT_TABLES` and `RESTRICTED_GRANTS`)
- Create: `apps/api/tests/support/social-project.ts` (synthetic owner/editor/viewer project with `social` enabled; copy of `support/issues-project.ts` with `modules: ["social"]`)
- Test: `apps/api/tests/social-schema.integration.test.ts`

**Interfaces:**
- Produces Prisma delegates `tx.socialAccount`, `tx.socialPost`, `tx.socialPostVariant`, `tx.socialPostMedia`, `tx.socialPublication`, `tx.socialDeliveryAttempt`, `tx.socialAccountThrottle`, `tx.socialOAuthState`, `tx.socialMetricSnapshot`, `tx.socialProviderState`; `createSocialProject(options?)` test fixture returning `{ owner, editor, viewer, run, cleanup }` like `createIssuesProject`.

Columns are those of the programme plan §5; every table has `workspaceId UUID NOT NULL`, `projectId UUID NOT NULL`, the composite FK to `Project("workspaceId","id") ON DELETE CASCADE`, and module-internal references as composite `("projectId", "<x>Id") → "<Table>"("projectId","id")` keys (FK checks bypass RLS). Pinned SQL rules:

| Table | Checks and keys |
| --- | --- |
| `SocialAccount` | `platform IN ('instagram','facebook','x','telegram','linkedin','tiktok')`; `status IN ('active','reconnect_required','disabled')`; `capability IN ('configured','read_verified','write_verified')`; unique `(projectId, platform, externalId)`; partial unique `(projectId, legacyPostizIntegrationId) WHERE legacyPostizIntegrationId IS NOT NULL`; `connectionId UUID NOT NULL` (no FK: `Connection` is under its own RLS, resolved by the service) |
| `SocialPost` | `status IN ('draft','needs_approval','approved','scheduled','publishing','published','partially_published','failed','canceled','archived')`; `origin IN ('manual','marketing','mcp','assistant','legacy_postiz')`; `scheduleMode IN ('none','at','now')`; `scheduleFold IS NULL OR scheduleFold IN ('earlier','later')`; `scheduleMode <> 'at' OR scheduledAt IS NOT NULL`; `readOnly = (origin = 'legacy_postiz')`; indexes `(projectId, scheduledAt)`, `(projectId, status)`, `(projectId, origin)` |
| `SocialPostVariant` | unique `(postId, accountId)`; FKs to post (cascade) and account (restrict) |
| `SocialPostMedia` | `kind IN ('image','video')`; unique `(variantId, position)`; `position BETWEEN 0 AND 34`; `sha256 ~ '^[0-9a-f]{64}$'`; `fileId` composite FK to `"File"("projectId","id")` if `File` has that unique, else unchecked uuid resolved by the service (check `schema.prisma:315-334` first) |
| `SocialPublication` | `status IN ('pending','claimed','sending','accepted','processing','published','failed','outcome_unknown','cancel_requested','canceled','blocked')`; `resolution IS NULL OR resolution IN ('published_confirmed','not_published')`; **unique `idempotencyKey`**; partial unique `(projectId, legacyEntityId) WHERE legacyEntityId IS NOT NULL`; index `(projectId, status, nextAttemptAt)` |
| `SocialDeliveryAttempt` | `step IN ('upload','container','publish','status','cancel','delete')`; `outcome IN ('not_sent','rejected','unknown','ok')`; `requestHash ~ '^[0-9a-f]{64}$'` |
| `SocialAccountThrottle` | PK `(accountId, "window", windowStart)`; `"window" IN ('minute','hour','day')`; `count >= 0` |
| `SocialOAuthState` | unique `stateHash`; `expiresAt > createdAt` |
| `SocialMetricSnapshot` | unique `(publicationId, metric, period, observedAt)` |
| `SocialProviderState` | PK `(projectId, namespace, recordKey)`; `revision >= 0` |

Then the `DO $$ … FOREACH t IN ARRAY [...] LOOP` block from `202610260001_issues_core/migration.sql:283-293` for all ten tables. Grants: full business grants for all except `SocialPublication` `[select, insert, update]` (deleted only with its project; final review: its variant key is `(projectId, variantId, accountId)` with `ON DELETE NO ACTION`, so a post or variant with publications cannot be deleted) and `SocialDeliveryAttempt`, `SocialMetricSnapshot` `[select, insert, delete]` (append-only; delete only for retention), mirrored in `RESTRICTED_GRANTS`.

- [ ] **Step 1: Write the failing tests** in `social-schema.integration.test.ts` (style of `issues-schema.integration.test.ts`):
  - `refuses two publications with the same idempotency key` → second insert fails with a unique violation.
  - `refuses a second mirror of the same legacy publication` → unique violation on `(projectId, legacyEntityId)`.
  - `refuses a scheduled post without a time` → check violation (`scheduleMode='at'`, `scheduledAt` null).
  - `refuses a writable legacy mirror` → check violation (`origin='legacy_postiz'`, `readOnly=false`).
  - `refuses a variant pointing to another project's account` → FK violation.
  - `hides another project's posts` → a post created in project A is not returned by `findMany` in project B's `scoped` transaction.
  - `keeps publications when the business role tries to delete one` → permission denied.
  Add the ten names to `PROJECT_TABLES` and the three restricted grants to `RESTRICTED_GRANTS` in `rls-matrix.integration.test.ts`.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run apps/api/tests/social-schema.integration.test.ts apps/api/tests/rls-matrix.integration.test.ts` → FAIL (tables missing).
- [ ] **Step 3: Implement** the models, the migration and the grants; `pnpm db:generate`; apply locally with `pnpm db:deploy` against the local test database only.
- [ ] **Step 4: Verify** — both files PASS; the Task 2 table test PASS; `scripts/check-pve-schema.sh --print-hash` prints a new hash (record it in the PR description for Mario's approval; do not set it anywhere).
- [ ] **Step 5: Commit** — `git commit -m "feat(social): social_core tables with forced row-level security"`

### Task 4: Boundaries and the no-managed-provider rule

**Files:**
- Modify: `scripts/boundaries.json` (zones `"module:social": ["apps/api/src/modules/social/"]`, `"web-module:social": ["apps/web/src/modules/social/"]`; `forbiddenLiterals` entry `"@opencoredev/social-sdk/cloud"` for every zone key)
- Modify: `scripts/boundaries.mjs` only if `forbiddenLiterals` matches exact literals; then add prefix matching for this one entry with a comment
- Test: the existing boundary check test (find with `rg -l "forbiddenLiterals" scripts apps/api/tests`), add a case

**Interfaces:**
- Produces: `pnpm lint` fails on any source string starting with `@opencoredev/social-sdk/cloud`.

- [ ] **Step 1: Write the failing test** — a fixture file in the `module:social` zone containing `import "@opencoredev/social-sdk/cloud/postiz"` makes the boundary checker report `forbidden-literal` for zone `module:social`; the same import of `"@opencoredev/social-sdk/x"` reports nothing.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** the zones and the rule.
- [ ] **Step 4: Verify** — the test passes; `node scripts/source-check.mjs` PASS on the tree (baseline unchanged).
- [ ] **Step 5: Commit** — `git commit -m "chore(social): module zones and a ban on managed providers"`

### Task 5: Gate and route behaviour

**Files:**
- Modify: `apps/api/tests/module-enforcement.integration.test.ts`, `apps/api/tests/access-matrix.integration.test.ts` (add the status route), `apps/api/tests/module-contributions.test.ts` (if it lists unavailable codes)
- Test: `apps/api/tests/social-routes.integration.test.ts`

**Interfaces:**
- Consumes: `GET /api/projects/:projectId/social/status` (Task 2), `createSocialProject` (Task 3).

- [ ] **Step 1: Write the failing tests** in `social-routes.integration.test.ts`:
  - `ORBIT_SOCIAL=false`, module row enabled → `404 {code: "SOCIAL_DISABLED"}`.
  - `ORBIT_SOCIAL=true`, no module row, `ORBIT_MODULES=false` → `404 SOCIAL_DISABLED` (opt-in).
  - `ORBIT_SOCIAL=true`, row enabled → owner, editor and viewer get `200` with `settings.approval === "owner_each"`.
  - Member of another project → `404 NOT_FOUND`.
  - With `ORBIT_MODULE_ROLES=true` and module role `none` for the editor → `404 MODULE_NOT_AVAILABLE`.
  - Disabling the module keeps its `ProjectModule` row and returns `404 SOCIAL_DISABLED` afterwards.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** whatever is missing (normally nothing beyond Task 2; fix the access-matrix entry).
- [ ] **Step 4: Verify** — `pnpm exec vitest run apps/api/tests/social-routes.integration.test.ts apps/api/tests/module-enforcement.integration.test.ts apps/api/tests/access-matrix.integration.test.ts` PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(social): gate, roles and opt-in behaviour of the module routes"`

### Task 6: Web module skeleton

**Files:**
- Create: `apps/web/src/modules/social/{manifest.tsx, labels.ts, api.ts, overview.tsx, placeholder.tsx}`
- Modify: `apps/web/src/modules/registry.ts` (import `socialWeb`, add after `issuesWeb`)
- Test: `apps/web/src/modules/social/social.test.tsx`

**Interfaces:**
- Produces: `socialWeb: WebModule` with `id "social"`, `optIn: true`, `minAccess` unset (viewers allowed), `displayName {en: "Social", de: "Social Media"}`, `groupOrder: 15` (next to Marketing; confirm against the current order in `apps/web/src/modules/*/manifest.tsx`), views (key, path, lucide icon): `social` `""` `LayoutDashboard`; `social.calendar` `calendar` `CalendarDays`; `social.posts` `posts` `PenSquare`; `social.media` `media` `Images`; `social.accounts` `accounts` `AtSign`; `social.analytics` `analytics` `BarChart3`. Every view except the overview renders `placeholder.tsx` ("Coming in a later phase" / "Folgt in einer späteren Phase").
- `api.ts`: `socialStatus(projectId): Promise<{module: "social"; version: string; settings: SocialSettings}>` over the existing web API helper.

- [ ] **Step 1: Write the failing tests** — the manifest exposes exactly the six view keys above in order; labels exist in `en` and `de` for each; the overview renders the approval policy returned by a mocked `socialStatus` ("Owner approves each post" / "Owner gibt jeden Beitrag frei"); every interactive element has an accessible name.
- [ ] **Step 2: Run and see them fail** — `pnpm --dir apps/web exec vitest run src/modules/social` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — tests PASS; `pnpm --dir apps/web typecheck` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(social): opt-in web module with placeholder views"`

### Task 7: Documentation and full check

**Files:**
- Create: `docs/SOCIAL.md` (purpose, status "S1: skeleton, flag off", tables, permissions, settings, flag, link to ADR 0020 and the plans)
- Modify: `docs/MODULE_ACTIVATION.md` (social as opt-in module), `docs/IMPLEMENTATION_STATUS.md` (S1 entry at the top: what exists, flag off, no migration applied in production), `docs/REQUIREMENTS_TRACEABILITY.md` (R1–R7 rows pointing at the plan phases), `docs/adr/0020-social-module.md` (status line unchanged unless Mario accepted it)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full required checks** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; expected: all green, integration suites executed (not skipped).
- [ ] **Step 3: Review the diff** against `.agentic/quality-gates/definition-of-done.md`, `review-checklist.md`, `security-checklist.md`, `data-safety` (migration) and record the new schema hash.
- [ ] **Step 4: Commit** — `git commit -m "docs(social): S1 module skeleton status and activation"`

## Done when

- `ORBIT_SOCIAL=false` → no route, view, tool or job of social is reachable; all existing suites unchanged.
- `ORBIT_SOCIAL=true` + enabled row → the status route and six views work for owner/editor/viewer; another project's members get 404.
- Ten tables with FORCE RLS, the pinned constraints and grants; `rls-matrix` and `access-matrix` green.
- `pnpm lint` refuses managed-provider imports.
- Rollback: revert the branch before deployment; after a deployment the tables are empty and inert while the flag is off (dropping them needs a separate approved migration).
