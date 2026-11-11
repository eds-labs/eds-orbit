# Settings Center Phase 4 (Central AI Configuration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `ORBIT_SETTINGS_CENTER=preview`, every AI setting of the system, an organization and a project is reachable section by section in `/manage`, each value shows where it comes from, and no AI form changes stored configuration the member did not touch.

**Architecture:** First the existing AI forms are made safe (they save only what they show, built from the stored value; nothing writes by preselection; the profile `PUT` takes an expected version), each fix pinned by a regression test written first. Then a shared AI configuration service, extracted from the MCP tool `readAiModels`, backs two read-only endpoints below `/api/management/`: a project's effective AI configuration with the origin of every value and a readiness per provider, and an organization's projects with what they follow or override. Last, the settings center replaces the three AI link panels with the existing panels mounted one per section, plus an effective view, origin badges, an "affected projects" notice and a read-only list of module AI ceilings.

**Tech Stack:** TypeScript, Next.js App Router (client shell), Fastify, Prisma (`scoped` project transactions, `authDb`), zod, Vitest (`renderToStaticMarkup` and pure functions in the web; integration tests over `app.inject` and direct service calls in the API), Playwright.

**Spec:** [docs/plans/SYSTEM_MANAGEMENT_V2.md](../../plans/SYSTEM_MANAGEMENT_V2.md) (sections 3.1–3.4 rows S4, O5–O9, J7, J11–J14; 4.1 F-6 to F-8; 4.3; 5.1; 5.6; 5.9; 9; 11 D-7; 14; 15), [docs/adr/0027-settings-center.md](../../adr/0027-settings-center.md), [docs/plans/ai-central-management.md](../../plans/ai-central-management.md), ADRs 0010, 0015, 0019, [docs/MODEL_ROUTING.md](../../MODEL_ROUTING.md). The phase 2 plan [2026-11-11-settings-center-phase-2.md](2026-11-11-settings-center-phase-2.md) describes the frame this plan builds on.

## Global Constraints

- Work in the worktree `.claude/worktrees/system-management-v2` on the branch the controller names. Phase 3 (integrations center) is executed before this plan on the same settings-center files (`sections/*.tsx`, `scope-view.tsx`, `texts.ts`, `types.ts`, `registry.ts`); this plan relies on nothing phase 3 adds. Before Task 1: integrate the branch's current head, `pnpm install --frozen-lockfile`, `pnpm db:generate`, `node scripts/test-db-for-worktree.ts`.
- No database migration, no schema change, no new dependency, no change to roles or permissions. The one changed write path is additive: `PUT …/ai/profile` accepts an optional `expectedVersion` query parameter (spec 5.6); without it the route behaves exactly as today.
- No change to budget enforcement, routing semantics, key rules or the route version. Not in this plan: removing project keys or prices (phase E of the AI plan), an organization-level spending authority or agent mandates, verifying project-stored keys against the provider.
- Opening, moving or mounting a form never changes stored configuration. Every form saves only the fields it shows, built from the stored value; where the API replaces a whole object, the form resends the stored remainder unchanged; no control is preselected in a way that writes on save without the member touching it.
- The safe-save tasks (1 to 4) come before any AI form is mounted in the center (Tasks 10 and 11; spec 14 "4.3 before 4.4").
- Old pages `/p/:id/settings?section=ai`, `/o/:id/settings`, `/admin/ai` keep the same markup in every flag state. A change to a component they share is an export, a pure helper or an optional prop whose default keeps today's behaviour; the safe-save fixes reach them on purpose.
- Everything new is behind `ORBIT_SETTINGS_CENTER` (`off` default). New API routes live below `/api/management/`, so `isManagementRoute` in the `onRequest` hook gates them; each gets zod-checked parameters, an explicit field list (never a key, never a whole profile, no free-form `config`), a row in `apps/api/tests/fixtures/access-matrix.json` (reviewed as a security change), regenerated OpenAPI (`pnpm api:generate`) and an entry in `docs/API_CONTRACT.md`.
- `apps/api/src/platform/administration/` uses only `authDb` (`administration-boundary.test.ts`); project data is read in `apps/api/src/platform/management/` only inside each project's own `scoped` transaction, as the member who asked. The platform never imports `apps/api/src/modules/<id>/` or `apps/web/src/modules/<id>/`; modules reach the platform through `WebModule` contributions.
- Texts: English and German for every string. New wording of the AI area lives in `apps/web/src/platform/settings-center/ai/texts.ts` (German typed against the English keys, as in `settings-center/texts.ts`); no inline `de ? … : …` in new files. Section labels and descriptions are `Label` literals next to the section.
- Tests never reach a provider: no key check, no paid call. Integration tests use this worktree's own database.
- Documentation and code comments are English. Commit messages end with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`; no model names anywhere.
- Do not push, deploy or change a production flag; each needs Mario's approval.
- Local commands (Node 24: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`): tests `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`; types `./node_modules/.bin/tsc --noEmit` (root and `apps/web`); boundaries `node scripts/source-check.mjs`. The whole suite and the browser runs are the controller's (Task 12).

## Review Focus

1. **A project without saved AI settings.** Saving any model or provider dialog creates the project's configuration, copies the environment's models, prices and tiers into it, ends the environment key fallback and masks the organization's profile. Expected: the form says so and refuses to save until the member ticks the first-save confirmation; opening any section writes nothing. Pinned in Task 2 (`firstSaveFields`, payload tests) and Task 12 (stored entities byte-identical before and after opening every AI section).
2. **A project that follows the organization standard or a preset saves a provider budget, a Claude key or the fallback.** Expected: the stored `defaultProvider`, tiers and routes are resent as stored, never the effective values the view shows. Pinned in Task 1 (`stored` in the view) and Task 2 (`providerPayload`, `anthropicPayload`).
3. **A stored route of a task the form does not show** (`creative_review` while Creative Studio is off). Expected: it survives every save of the task-route dialog, the model choice and the organization or system standard. Pinned in Task 2 (`taskRoutesPayload`) and Task 3 (`taskRoutesFrom`).
4. **Two editors of the same AI profile, or a profile editor opened before the standard changed.** Expected: the stale save answers 409 `AI_PROFILE_VERSION_CONFLICT` and stores nothing; a half-filled route or tier set is an error, not a silent removal. Pinned in Task 4.
5. **A project owner who is not an organization owner, and an outsider.** Expected: the effective read returns only the values that apply to the project with their origin label (no profile, no other project, no key); the organization projects read answers 404 to everyone but that organization's owners, and lists no personal space. Pinned in Task 6 and Task 7 (role and cross-organization tests, access matrix).

---

## File Structure

**New (API)**

| File | Responsibility |
| --- | --- |
| `apps/api/src/platform/ai/effective-configuration.ts` | `aiConfigurationState(tx, scope)`: the one read of a project's AI layers (shared by MCP and management); `routingModeOf`, `projectAiExceptions` |
| `apps/api/src/platform/management/ai-effective.ts` | `projectAiEffective(tx, scope)`: values with origin, readiness per provider |
| `apps/api/src/platform/management/ai-projects.ts` | `organizationAiProjects(workspaceId, actorId, now)` |
| `apps/api/tests/ai-models-read.integration.test.ts` | Characterization of `ai_models_get` before and after the extraction |
| `apps/api/tests/ai-safe-save.integration.test.ts` | `stored` in the project view; profile version check |
| `apps/api/tests/management-ai.integration.test.ts` | Both endpoints: fixtures, roles, flag |

**New (web), under `apps/web/src/platform/settings-center/ai/`**

| File | Responsibility |
| --- | --- |
| `texts.ts` | Wording of the AI area |
| `paths.ts` | `aiPaths(scope)`: every request path of the AI sections |
| `origin-badge.tsx` | `OriginBadge`, `originLabel` |
| `effective-view.tsx` | `EffectiveAiView` (presentational) and `EffectiveAiSection` (container); web copy of the response type |
| `organization-projects.tsx` | `OrganizationAiProjectsView` and its container; `affectedCounts` |
| `affected-projects.tsx` | `AffectedProjectsNotice` and the organization and system containers |
| `module-ceilings.tsx` | `ModuleCeilingsView` and `ModuleCeilings` (calls the modules' hooks) |
| `*.test.tsx` next to each | Unit tests |
| `apps/web/tests/settings-center-ai.spec.ts` | Playwright |

**Modified**

| File | Change |
| --- | --- |
| `apps/api/src/platform/ai/openai-configuration.ts` | `storedAiFields`, `ownAiKeys`, `stored` in `projectAiConfigurationView`, export `TEXT_TASKS` |
| `apps/api/src/platform/ai/central-ai.ts` | Export `centralLayers` |
| `apps/api/src/platform/ai/mcp-tools.ts` | `readAiModels` and `proposedAi` read through the shared service |
| `apps/api/src/platform/administration/ai-profiles.ts`, `connection-routes.ts` | Expected version on the profile `PUT` |
| `apps/api/src/platform/management/routes.ts`, `capabilities.ts` | Two routes; additive `flags` |
| `apps/api/tests/fixtures/access-matrix.json`, `apps/api/tests/management-capabilities.integration.test.ts` | Two rows; `flags` assertions |
| `apps/web/src/components/ai-settings.tsx` | Safe payload builders and field builders (Task 2); sub-panel exports (Task 8) |
| `apps/web/src/components/ai-settings.test.tsx` | Regression and sub-panel tests |
| `apps/web/src/lib/ai-presets.ts`, `ai-presets.test.tsx` | `taskRoutesFrom` keeps routes of tasks without a field |
| `apps/web/src/components/ai-model-choice.tsx` (+ new `ai-model-choice.test.tsx`) | Overrides, wizard steps, budget step |
| `apps/web/src/components/spend-policy.tsx` (+ new `spend-policy.test.tsx`) | `choiceOf`, `spendPolicyPayload`, notice |
| `apps/web/src/platform/administration/ai-defaults-ui.tsx`, `ai-knowledge-ui.tsx`, `ai-budget-ui.tsx`, `texts.ts` (+ new `ai-defaults-ui.test.tsx`, `ai-knowledge-ui.test.tsx`; `ai-budget-ui.test.tsx`) | Defaults payload, profile payload and version, budget payload |
| `apps/web/src/platform/shell/types.ts`, `shell-context.tsx`, `apps/web/src/components/orbit.tsx` | `WebModule.aiCeilings`, `ShellContextValue.aiCeilings` |
| `apps/web/src/modules/{finance,work,issues,support}/manifest.tsx` (and a small `ai-ceiling.ts` in each) | Ceiling contributions |
| `apps/web/src/platform/settings-center/types.ts`, `settings-center.tsx` | `ManagementFlags`, `SectionProps.flags` |
| `apps/web/src/platform/settings-center/sections/{project,organization,system}.tsx` and tests; `texts.ts` | AI sections; link panel and its keys removed |
| `apps/web/src/platform/settings-center/sections/ai-link.tsx` | Deleted |
| `docs/API_CONTRACT.md`, `docs/MODEL_ROUTING.md`, `docs/plans/ai-central-management.md`, `docs/plans/SYSTEM_MANAGEMENT_V2.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` | Documentation |

---

### Task 1: The stored configuration next to the effective one

The project view (`GET /api/projects/:id/openai-configuration`, `projectAiConfigurationView`, `openai-configuration.ts:378`) shows environment values for an unsaved project (`publicOpenAiConfiguration(null)`, `:461-496`) and, for a project on a preset or the standard, replaces `defaultProvider` and `effectiveRoutes` with effective values (`:410-417`). The forms build their payloads from this view (risks 1 and 2). This task adds what they need: the stored fields, unchanged by any layer.

**Files:**
- Modify: `apps/api/src/platform/ai/openai-configuration.ts`
- Create: `apps/api/tests/ai-safe-save.integration.test.ts`

**Interfaces:**
- Consumes: `stored(row)` (`openai-configuration.ts:189`), `ProjectRouting`, `ProviderId`
- Produces (all in `openai-configuration.ts`):

```ts
export type StoredAiFields = {
  version: number;
  verifiedModels: string[];
  rateCard: Record<string, Rate>;
  modelRoutes: { fast: string; standard: string; quality: string; escalation: string };
  taskRoutes: Partial<Record<TaskClass, ModelRoute>>;
  imageGeneration: { model: string; maxCostMicrosPerImage: number; pricingVerifiedAt?: string };
  defaultProvider: ProviderId;
  anthropicTierRoutes: { fast: string; standard: string; quality: string } | null;
  models: ModelRegistry;
  providerBudgets: ProviderBudgets;
  fallback: { onProviderBudgetStop: "none" | "openai" };
  routing: ProjectRouting | null;
};
/** The project's own saved AI fields, never a key; null while it saved none. */
export function storedAiFields(row: { data: unknown; version: number } | null): StoredAiFields | null;
/** Whether the project saved its own key, per key; no key is read. */
export function ownAiKeys(row: { data: unknown } | null): { openai: boolean; image: boolean; anthropic: boolean };
/** Task classes whose route decides whether chat and text drafting can run (now exported). */
export const TEXT_TASKS: readonly ["chat_operator", "draft_social"];
```

- `projectAiConfigurationView` returns an additional field `stored: StoredAiFields | null` in both of its return branches (`:405` and `:410`). Nothing else in the response changes.

- [ ] **Step 1: Write the failing test** (`ai-safe-save.integration.test.ts`, first `describe`)

Fixtures as in `apps/api/tests/key-rule-v2.integration.test.ts` (direct service calls inside `scoped`, synthetic owner, `process.env` restored in `afterAll`). Environment: `ORBIT_CONNECTIONS`, `ORBIT_AI_CATALOG`, `ORBIT_AI_DEFAULTS` `"true"`; `OPENAI_API_KEY` a synthetic string; `OPENAI_VERIFIED_MODELS="gpt-5.6-luna,gpt-5.6-terra"`.

```ts
it("reports no stored configuration for an unsaved project", async () => {
  const view = await run(unsaved, (tx) => projectAiConfigurationView(tx, unsaved));
  expect(view.stored).toBeNull();
  expect(view.verifiedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]); // environment, as today
});
it("reports the stored default provider of a project on a preset, not the effective one", async () => {
  // saveOpenAiConfiguration with its own key and models; saveAiProviderConfiguration with defaultProvider "openai";
  // saveAiRouting({ source: "preset", provider: "anthropic", level: "balanced", overrides: {} })
  const view = await run(preset, (tx) => projectAiConfigurationView(tx, preset));
  expect(view.defaultProvider).toBe("anthropic");          // effective, as today
  expect(view.stored).toMatchObject({ defaultProvider: "openai", routing: { source: "preset", provider: "anthropic" } });
  expect(JSON.stringify(view.stored)).not.toMatch(/encrypted|sk-/);
});
```

- [ ] **Step 2: Run it; expected FAIL** (`view.stored` is `undefined`).
- [ ] **Step 3: Implement** `storedAiFields` from `stored(row)` without `encrypted*`, `updatedBy`, `updatedAt` (with `version: row.version`, `anthropicTierRoutes ?? null`, `routing ?? null`); `ownAiKeys` from the three `encrypted*` fields; add `stored: storedAiFields(row)` to both return branches; `export` on `TEXT_TASKS`.
- [ ] **Step 4: Run** the new test, `openai-configuration.integration.test.ts`, `key-rule-v2.integration.test.ts`; expected PASS. Run `pnpm api:generate` if the view has an OpenAPI schema and review the diff (additive only).
- [ ] **Step 5: Commit** `feat(ai): stored configuration next to the effective one in the project view`

---

### Task 2: Safe saves in the project AI settings (risks 1 to 4)

Risks as found in `apps/web/src/components/ai-settings.tsx` today:

| Risk | Where | Fix |
| --- | --- | --- |
| 1 First save freezes environment values | every dialog builds from the view (`modelsPayload` `:1176`, `providerPayload` `:232`), and the view of an unsaved project holds environment values | Not fixable without changing what a first save is (it must create a whole configuration). Guard: while `view.stored === null`, every form that writes the `models` or `providers` section shows a required, unticked first-save checkbox with the consequence, and does not submit without it |
| 2 Effective `defaultProvider` saved as stored | `providerPayload(view)` `:234`; Claude dialog field value `view.defaultProvider` `:330` | Both read `view.stored` |
| 3 Hidden task routes deleted | task-route dialog rebuilds `taskRoutes` from the shown tasks (`:1502-1520`) | Start from the stored routes of tasks not shown |
| 4 Writing preselections | `applyCatalog` true without Claude models (`:295-297`); "price checked today" true without a date (`:1336`); Claude tiers prefilled and always sent (`:259`, `:404-408`); provider budget prefilled 100/75/90/95 (`:456-471`); four hard-coded image models (`:1292-1297`) | Unticked; unticked; empty and sent only when all three are filled (half-filled is an error); empty and required for a provider without a stored budget; the stored model joins the options |

**Files:**
- Modify: `apps/web/src/components/ai-settings.tsx`, `apps/web/src/components/ai-settings.test.tsx`

**Interfaces:**
- Consumes: `StoredAiFields` (Task 1), mirrored as a web type
- Produces (exports of `ai-settings.tsx`; the components keep their names and props):

```ts
export type StoredAiView = { /* field-for-field copy of StoredAiFields */ };
export type AiConfigurationData = OpenAiConfigurationView & ProviderFields; // OpenAiConfigurationView gains `stored: StoredAiView | null`
/** The model section as stored (or, before a first save, as shown), so a dialog resends what it does not show. */
export function modelsPayload(view: OpenAiConfigurationView): ModelsSection;
/** The provider section as stored (or as shown before a first save): a full replace. */
export function providerPayload(view: AiConfigurationData): ProviderSection;
/** The first-save confirmation, only while the project saved no AI settings of its own. */
export function firstSaveFields(view: Pick<OpenAiConfigurationView, "stored">, locale: Locale): FormField[];
/** Whether a submitted form may save: true when no confirmation was needed or it was ticked. */
export function firstSaveConfirmed(view: Pick<OpenAiConfigurationView, "stored">, values: FormValues): boolean;
export function taskRoutesPayload(
  values: FormValues,
  shown: ReadonlyArray<{ id: TaskClass; defaultTokens: number }>,
  stored: Partial<Record<TaskClass, StoredTaskRoute>>,
): Partial<Record<TaskClass, StoredTaskRoute>>;
export function anthropicFields(view: AiConfigurationData, locale: Locale, options?: { followsStandard?: boolean }): FormField[];
export function anthropicPayload(view: AiConfigurationData, values: FormValues, options?: { followsStandard?: boolean }):
  | { providers: ProviderSection & { applyAnthropicCatalog: boolean; anthropicApiKey?: string; clearAnthropicApiKey?: true } }
  | { error: "CLAUDE_TIERS_INCOMPLETE" };
export function openAiFields(current: OpenAiConfigurationView, locale: Locale, options?: { followsStandard?: boolean }): FormField[];
export function imageModelOptions(stored: string | undefined, locale: Locale): Array<{ value: string; label: string }>;
export function providerBudgetFields(provider: ProviderId, view: AiConfigurationData, locale: Locale): FormField[];
```

`ModelsSection` and `ProviderSection` are the existing return shapes of `modelsPayload` and `providerPayload`, named. `followsStandard` is consumed in Task 8; in this task it only omits fields (rule below).

**Rules**

- `modelsPayload(view)`: from `view.stored` when it is not null (verifiedModels, rateCard, modelRoutes, taskRoutes, imageGeneration exactly as stored); else today's body over the view.
- `providerPayload(view)`: from `view.stored` when not null (`defaultProvider`, `anthropicTierRoutes` only when not null, `models`, `providerBudgets`, `fallback`); else today's body.
- `firstSaveFields`: `[]` when `view.stored !== null`; else one checkbox `{ name: "firstSave", type: "checkbox", required: true, value: false, label, hint }` (copy below). `firstSaveConfirmed`: `view.stored !== null || values.firstSave === true`. The OpenAI, Claude, task-route, models-and-prices and provider-budget forms append `firstSaveFields(view, locale)` as their last field and return without a request when `firstSaveConfirmed` is false. `saveKey` of the setup wizard is covered in Task 3.
- `taskRoutesPayload`: every entry of `stored` whose task is not in `shown` is kept as stored; every shown task with a chosen model gets `{ model, reasoningEffort? , maxOutputTokens }` exactly as today; a shown task without a model has no route.
- `anthropicFields`: `applyCatalog` value `false`; tiers `value` = the stored tiers, else `""`, `required: false`, `placeholder` = the suggested tier model; `defaultProvider` value = `view.stored?.defaultProvider ?? view.defaultProvider`. With `followsStandard`, the fields `applyCatalog`, the three tiers and `defaultProvider` are left out (key, forget-key and fallback stay).
- `anthropicPayload`: `providerPayload(view)` plus the key fields as today; `defaultProvider` and `anthropicTierRoutes` from the form only when their fields exist; tiers: all three filled → sent; all three empty → the stored value is kept (left out when null); otherwise `{ error: "CLAUDE_TIERS_INCOMPLETE" }` (the dialog shows the error and sends nothing).
- `openAiFields`: today's fields, except `imagePriceChecked` value `false` and the image model options from `imageModelOptions(current.stored?.imageGeneration.model ?? current.imageGeneration.model, locale)`; with `followsStandard` the three tier fields are left out (the payload keeps the stored tiers through `modelsPayload`).
- `imageModelOptions(stored)`: the four existing options in today's order; when `stored` is set and not among them, it is appended as `{ value: stored, label: stored }`.
- `providerBudgetFields(provider, view)`: with a stored budget for `provider` the values are as today; without one, `monthly`, `warn`, `warn2`, `stop` and `anchorDay` start empty (`value: ""`) and stay `required`; the old defaults become `placeholder` (`"100"`, `"75"`, `"90"`, `"95"`, `"1"`).

**Exact copy**

| Key | English | German |
| --- | --- | --- |
| first-save label | Save as this project's own AI settings | Als eigene KI-Einstellungen dieses Projekts speichern |
| first-save hint | This project has no AI settings of its own yet. Saving copies the models, prices and tiers shown here into the project. From then on the environment's key no longer serves it, and the organization's and system's model settings no longer apply to the fields saved here. | Dieses Projekt hat noch keine eigenen KI-Einstellungen. Beim Speichern werden die hier gezeigten Modelle, Preise und Stufen in das Projekt übernommen. Danach gilt der Schlüssel aus der Umgebung nicht mehr, und die Modelleinstellungen von Organisation und System gelten für die hier gespeicherten Felder nicht mehr. |
| `CLAUDE_TIERS_INCOMPLETE` | Fill in all three Claude tiers or leave all three empty. | Fülle alle drei Claude-Stufen aus oder lass alle drei leer. |

These strings stay in `ai-settings.tsx` in its existing `de ? … : …` style (an existing file; the rule against inline language switches is for new files).

- [ ] **Step 1: Export the current helpers unchanged** so the tests fail on their assertions, not on imports: `modelsPayload`, `providerPayload`; and move today's inline field arrays and the task-route payload into `anthropicFields(view, locale)`, `openAiFields(current, locale)`, `providerBudgetFields(provider, view, locale)` and `taskRoutesPayload(values, shown)` without changing their output. Run `ai-settings.test.tsx`; expected PASS (no behaviour change yet).

- [ ] **Step 2: Write the failing tests** (`ai-settings.test.tsx`; a fixture `view(over)` builds an `AiConfigurationData` with `stored` set; `field(fields, name)` finds a field)

```ts
it("saves the stored default provider of a project on a preset (risk 2)", () => {
  const v = view({ defaultProvider: "anthropic", stored: storedFixture({ defaultProvider: "openai", routing: preset }) });
  expect(providerPayload(v).defaultProvider).toBe("openai");
  expect(field(anthropicFields(v, "en"), "defaultProvider").value).toBe("openai");
});
it("saves the stored model section, not the view's (risk 1 and 2)", () => {
  const v = view({ verifiedModels: ["env-model"], stored: storedFixture({ verifiedModels: ["own-model"] }) });
  expect(modelsPayload(v).verifiedModels).toEqual(["own-model"]);
});
it("asks before a first save and only then (risk 1)", () => {
  expect(firstSaveFields(view({ stored: null }), "en")).toEqual([
    expect.objectContaining({ name: "firstSave", type: "checkbox", required: true, value: false }),
  ]);
  expect(firstSaveFields(view({ stored: storedFixture() }), "en")).toEqual([]);
  expect(firstSaveConfirmed(view({ stored: null }), {})).toBe(false);
  expect(firstSaveConfirmed(view({ stored: null }), { firstSave: true })).toBe(true);
});
it("keeps the route of a task the dialog does not show (risk 3)", () => {
  const stored = { creative_review: { model: "gpt-5.6-terra", maxOutputTokens: 1500 } };
  const routes = taskRoutesPayload({ "route-chat_operator-model": "gpt-5.6-luna" }, routeTaskClasses(false), stored);
  expect(routes.creative_review).toEqual(stored.creative_review);
  expect(routes.chat_operator).toMatchObject({ model: "gpt-5.6-luna", maxOutputTokens: 3000 });
});
it("writes nothing by preselection (risk 4)", () => {
  const v = view({ verifiedModels: [], stored: storedFixture({ anthropicTierRoutes: null, providerBudgets: {} }) });
  expect(field(anthropicFields(v, "en"), "applyCatalog").value).toBe(false);
  expect(field(anthropicFields(v, "en"), "tier-fast").value).toBe("");
  expect(field(openAiFields(v, "en"), "imagePriceChecked").value).toBe(false);
  expect(field(providerBudgetFields("openai", v, "en"), "monthly").value).toBe("");
  expect(anthropicPayload(v, { defaultProvider: "openai", fallback: "none" })).not.toHaveProperty("providers.anthropicTierRoutes");
  expect(anthropicPayload(v, { "tier-fast": "claude-x", fallback: "none" })).toEqual({ error: "CLAUDE_TIERS_INCOMPLETE" });
});
it("keeps a stored image model that is not in the list (risk 4)", () => {
  expect(imageModelOptions("gpt-image-legacy", "en").map((o) => o.value)).toContain("gpt-image-legacy");
  expect(imageModelOptions("gpt-image-2.5-flare", "en")).toHaveLength(4);
});
it("leaves model fields out while the project follows the standard", () => {
  const names = anthropicFields(view({}), "en", { followsStandard: true }).map((f) => f.name);
  expect(names).not.toContain("tier-fast");
  expect(names).not.toContain("defaultProvider");
  expect(names).not.toContain("applyCatalog");
  expect(openAiFields(view({}), "en", { followsStandard: true }).map((f) => f.name)).not.toContain("model-fast");
});
```

- [ ] **Step 3: Run them; expected FAIL** on the assertions (the helpers return today's values; `firstSaveFields`, `firstSaveConfirmed`, `anthropicPayload`, `imageModelOptions` do not exist yet).
- [ ] **Step 4: Implement** the rules; wire the dialogs to the helpers (`AnthropicConfiguration` submits `anthropicPayload`, `TaskRoutesConfiguration` passes `current.stored?.taskRoutes ?? current.taskRoutes ?? {}`, every dialog appends `firstSaveFields` and checks `firstSaveConfirmed`). `AiSettings` renders exactly as before.
- [ ] **Step 5: Run** `apps/web/src/components/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 6: Commit** `fix(web): project AI dialogs save only what they show (F-8 risks 1-4)`

---

### Task 3: Safe saves in model choice, standard models, wizard and spending authority (risks 3, 5, 6)

| Risk | Where | Fix |
| --- | --- | --- |
| 3 (helpers) | `taskRoutesFrom` (`lib/ai-presets.ts:97`) iterates all `aiTasks`, so `creative_review` (no field while the studio is off) is dropped; `routingFrom` (`ai-model-choice.tsx:321-324`) and `DefaultsForm` (`ai-defaults-ui.tsx:275-278`) send `{}` when "advanced" is "no" | `taskRoutesFrom` keeps `current[task]` for every task whose field `task-<id>` is absent from `values`; both callers always call it (fields hidden by "advanced: no" are not rendered, so they arrive as `""` and drop exactly the shown tasks' routes) |
| 5 Wizard budget | `SetupWizard` budget step preselects `"10"` (`ai-model-choice.tsx:518`) and "Finish" always sends `ai-spend-policy`, also on a project that has an authority | The wizard reads the authority; the budget step exists only when the project has none; its select starts empty and required |
| 5 Wizard key step | `saveKey` (`ai-settings.tsx:754-762`) is a first save on an unsaved project | The key step appends `firstSaveFields(view, locale)` when the view has `stored: null` and does not submit without it |
| 6 Spending authority re-save | `SpendPolicyForm` (`spend-policy.tsx:394-413`) sends only `monthlyBudgetMicros` for monthly choices; the server derives day and run and restarts the year (`spend-policy.ts:88-98`); `choiceOf` preselects `monthly-10` without a record (`:282`) | Unchanged monthly choice and amount → no request; a changed amount → the request as today plus a visible notice in the dialog that day and run are derived anew and a new year starts; no record → empty required select |

**Files:**
- Modify: `apps/web/src/lib/ai-presets.ts`, `ai-presets.test.tsx`, `apps/web/src/components/ai-model-choice.tsx`, `apps/web/src/components/spend-policy.tsx`, `apps/web/src/platform/administration/ai-defaults-ui.tsx`, `apps/web/src/components/ai-settings.tsx` (wizard `saveKey` call site only)
- Create: `apps/web/src/components/ai-model-choice.test.tsx`, `apps/web/src/components/spend-policy.test.tsx`, `apps/web/src/platform/administration/ai-defaults-ui.test.tsx`

**Interfaces:**
- Consumes: `firstSaveFields`, `firstSaveConfirmed` (Task 2)
- Produces:

```ts
// lib/ai-presets.ts — same signature, new rule
export function taskRoutesFrom(values: Record<string, unknown>, current?: Partial<Record<string, TaskRoute>>): Record<string, TaskRoute>;
// ai-model-choice.tsx
export function routingFrom(values: FormValues, view: ModelChoiceView): Record<string, unknown>; // now exported
export type WizardStep = "key" | "models" | "budget";
/** The wizard's steps: "budget" only once the authority has loaded and the project has none. */
export function wizardSteps(input: { keyReady: boolean; policy: { record: unknown | null; source: string } | null }): WizardStep[];
export function budgetStepFields(t: { budget: string; budgets: Record<"off" | "10" | "50", string> }): FormField[];
// ai-defaults-ui.tsx
export function defaultsPayload(values: FormValues, current: AiDefaults | null): AiDefaults;
// spend-policy.tsx
export function choiceOf(view: Pick<SpendPolicyView, "record">): Choice | ""; // now exported
/** The action input, or null when the form changed nothing. */
export function spendPolicyPayload(values: FormValues, record: SpendPolicyView["record"]): Record<string, unknown> | null;
```

**Rules**

- `wizardSteps`: `key` first unless `keyReady`; then `models`; then `budget` only when `policy !== null && policy.record === null && policy.source === "none"`. `SetupWizard` loads `collectionPath(project.id, "ai-spend-policy")`; with no budget step, the models step's submit label is `finish` and it closes the wizard after saving.
- `budgetStepFields`: one select `profile`, `value: ""`, `required: true`, options `off`, `10`, `50` as today.
- `spendPolicyPayload`: `null` when the chosen profile and amount equal the record (`profile: "monthly"` with the same `monthlyBudgetMicros`, or the same non-monthly profile and `profile !== "custom"`); otherwise today's payload. On `null` the dialog closes without a request.
- `choiceOf`: `""` without a record; otherwise as today. The profile select is `required`.
- The notice shows in the dialog while `record?.profile === "monthly"`.

**Exact copy** (in `spend-policy.tsx`'s `text` object)

| Key | English | German |
| --- | --- | --- |
| `monthlyResave` | Saving a new monthly amount derives the day and run limits from it again and starts a new year from today. Limits set elsewhere (for example through MCP) are replaced. | Ein neuer Monatsbetrag leitet die Tages- und Lauflimits wieder daraus ab und beginnt ein neues Jahr ab heute. Anderswo gesetzte Limits (zum Beispiel über MCP) werden ersetzt. |

- [ ] **Step 1: Export the current helpers unchanged** (`routingFrom`, `choiceOf`; move the budget field array into `budgetStepFields(t)`, the spend payload into `spendPolicyPayload(values, record)` ignoring `record`, the defaults payload into `defaultsPayload(values, current)`). Run the existing tests; expected PASS.

- [ ] **Step 2: Write the failing tests**

```ts
// ai-presets.test.tsx
it("keeps the route of a task the form shows no field for", () => {
  const current = { creative_review: { model: "m1", maxOutputTokens: 1500 } };
  expect(taskRoutesFrom({ "task-chat_operator": "m2" }, current)).toEqual({
    creative_review: current.creative_review,
    chat_operator: { model: "m2", maxOutputTokens: 3000 },
  });
  expect(taskRoutesFrom({ "task-creative_review": "" }, current)).toEqual({}); // shown and cleared
});
// ai-model-choice.test.tsx
it("keeps hidden overrides when per-task models are switched off", () => {
  const view = { routing: { source: "organization", overrides: { creative_review: { model: "m1", maxOutputTokens: 1500 } } } } as ModelChoiceView;
  expect(routingFrom({ source: "organization", advanced: "no", "task-chat_operator": "" }, view))
    .toEqual({ source: "organization", overrides: { creative_review: { model: "m1", maxOutputTokens: 1500 } } });
});
it("offers the budget step only to a project without an authority (risk 5)", () => {
  expect(wizardSteps({ keyReady: true, policy: { record: { id: "r" }, source: "platform" } })).toEqual(["models"]);
  expect(wizardSteps({ keyReady: false, policy: { record: null, source: "none" } })).toEqual(["key", "models", "budget"]);
  expect(wizardSteps({ keyReady: true, policy: null })).toEqual(["models"]);
  expect(wizardSteps({ keyReady: true, policy: { record: null, source: "marketing_policy" } })).toEqual(["models"]);
});
it("preselects no budget (risk 5)", () => {
  expect(budgetStepFields(t)[0]).toMatchObject({ name: "profile", value: "", required: true });
});
// spend-policy.test.tsx
it("sends nothing when a monthly authority is saved unchanged (risk 6)", () => {
  const record = { id: "r", version: 1, profile: "monthly", monthlyBudgetMicros: 25_000_000, dailyBudgetMicros: 4_000_000, perRunBudgetMicros: 1_000_000 };
  expect(spendPolicyPayload({ profile: "monthly", amount: "25" }, record)).toBeNull();
  expect(spendPolicyPayload({ profile: "monthly", amount: "30" }, record)).toEqual({ profile: "monthly", monthlyBudgetMicros: 30_000_000 });
});
it("preselects no profile without a record", () => {
  expect(choiceOf({ record: null })).toBe("");
});
// ai-defaults-ui.test.tsx
it("keeps a hidden task route of the standard", () => {
  const current = { provider: "anthropic", level: "balanced", taskRoutes: { creative_review: { model: "m1", maxOutputTokens: 1500 } } };
  expect(defaultsPayload({ provider: "anthropic", level: "balanced", imageModel: "", advanced: "no" }, current).taskRoutes)
    .toEqual(current.taskRoutes);
});
```

- [ ] **Step 3: Run them; expected FAIL** on the assertions.
- [ ] **Step 4: Implement** the rules; wire `SetupWizard` (steps, budget fields, `firstSaveFields` on the key step), `SpendPolicyForm` (payload, notice, required select) and `DefaultsForm` (`defaultsPayload`).
- [ ] **Step 5: Run** the four test files, `apps/web/src/components/*.test.tsx`, `apps/web/src/platform/administration/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 6: Commit** `fix(web): model choice, standard, setup and spending authority keep what they do not show (F-8 risks 3, 5, 6)`

---

### Task 4: AI profile version check and the organization budget payload (risks 7 and 8)

Risk 7: `AiProfileEditor` (`ai-knowledge-ui.tsx:146-186`) sends the whole profile from the copy it loaded, `defaults` included, so a save after the standard changed writes the old standard back; `saveAiProfile` (`ai-profiles.ts:27`) has no version check. A half-filled route or tier set silently removes `modelRoutes` or `anthropicTierRoutes` (`:165`, `:176`). Risk 8: `PUT …/ai/budget` replaces `monthlyMicros`, `providerCaps` and `credits` (`ai-budget.ts:192`); today one form shows all of them (`ai-budget-ui.tsx:579-596`) and this plan mounts that form whole (Task 11), so nothing is lost today. Not fixed, pinned: a characterization test of the payload so a later split cannot drop a part unseen.

**Files:**
- Modify: `apps/api/src/platform/administration/ai-profiles.ts`, `connection-routes.ts` (the two profile `PUT`s, `:221-234`), `apps/web/src/platform/administration/ai-knowledge-ui.tsx`, `ai-budget-ui.tsx`, `texts.ts`, `ai-budget-ui.test.tsx`
- Create: `apps/web/src/platform/administration/ai-knowledge-ui.test.tsx`
- Test: `apps/api/tests/ai-safe-save.integration.test.ts` (second `describe`)

**Interfaces:**
- Produces:

```ts
// ai-profiles.ts
export async function saveAiProfile(actorId: string, target: Target, raw: unknown, expectedVersion?: number): Promise<{ scope; version; data; updatedAt }>;
// throws DomainError("AI_PROFILE_VERSION_CONFLICT", 409) when expectedVersion is given and differs from the stored version (0 without a row)
// connection-routes.ts: both PUT …/ai/profile parse req.query with
//   z.object({ expectedVersion: z.coerce.number().int().min(0).optional() }).strict()
// ai-knowledge-ui.tsx
export function profilePayload(stored: Profile["data"], values: FormValues):
  | { payload: Record<string, unknown> }
  | { error: "PROFILE_JSON_INVALID" | "PROFILE_ROUTES_INCOMPLETE" | "PROFILE_TIERS_INCOMPLETE" };
// ai-budget-ui.tsx
export function budgetPayload(values: FormValues, credits: Partial<Record<Provider, Credit>>, now: string): {
  monthlyMicros: number | null; assistantPerUserMonthlyMicros: number | null;
  providerCaps: Partial<Record<Provider, number>>; credits: Partial<Record<Provider, Credit>>;
};
```

**Rules**

- The version comparison and the write are one conditional update: `updateMany({ where: { id: current.id, version: expectedVersion } })`; a count of 0 throws the conflict. Without a row, `expectedVersion` other than 0 throws. Without `expectedVersion`, today's code path. `saveProfileDefaults` (`ai-defaults.ts:73`) passes none (it reads the stored profile itself).
- `AiProfileEditor` sends `put(\`${path}?expectedVersion=${profile.data.version}\`, payload)`.
- `profilePayload`: all four route fields empty → `modelRoutes` left out (the member cleared them); all four filled → sent; otherwise `PROFILE_ROUTES_INCOMPLETE`. Same for the three Claude tiers with `PROFILE_TIERS_INCOMPLETE`. Every field the form does not show (including `defaults`, `taskRoutes`, `models`, `fallback`, `imageGeneration`) is copied from `stored` unchanged. JSON errors → `PROFILE_JSON_INVALID`.

**Exact copy** (`administration/texts.ts` `errors`, and the editor's local errors)

| Code | English | German |
| --- | --- | --- |
| `AI_PROFILE_VERSION_CONFLICT` | This profile changed since you opened it (for example its standard models). Reload the page and apply your change again. | Dieses Profil hat sich geändert, seit du es geöffnet hast (zum Beispiel seine Standard-Modelle). Lade die Seite neu und übernimm deine Änderung noch einmal. |
| `PROFILE_ROUTES_INCOMPLETE` | Fill in all four routes or leave all four empty. | Fülle alle vier Routen aus oder lass alle vier leer. |
| `PROFILE_TIERS_INCOMPLETE` | Fill in all three Claude tiers or leave all three empty. | Fülle alle drei Claude-Stufen aus oder lass alle drei leer. |
| `PROFILE_JSON_INVALID` | The rate card or the budgets are not valid JSON. | Preise oder Budgets sind kein gültiges JSON. |

- [ ] **Step 1: Write the failing API test**

```ts
it("refuses a stale profile save and keeps the stored profile (risk 7)", async () => {
  // as organization owner: PUT /api/organizations/:id/ai/profile { verifiedModels: ["m1"] } → version 1
  // PUT /api/organizations/:id/ai/defaults (a valid standard) → version 2
  const stale = await call("PUT", `/api/organizations/${w}/ai/profile?expectedVersion=1`, { verifiedModels: ["m2"] });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe("AI_PROFILE_VERSION_CONFLICT");
  const now = (await call("GET", `/api/organizations/${w}/ai/profile`)).json();
  expect(now.version).toBe(2);
  expect(now.data.defaults).toBeDefined();
  expect(now.data.verifiedModels).toEqual(["m1"]);
});
it("saves with the current version and without one, as before", async () => {
  expect((await call("PUT", `/api/organizations/${w}/ai/profile?expectedVersion=2`, body)).statusCode).toBe(200);
  expect((await call("PUT", `/api/organizations/${w}/ai/profile`, body)).statusCode).toBe(200);
});
it("refuses an unknown query parameter", async () => {
  expect((await call("PUT", `/api/admin/ai/profile?version=1`, body)).statusCode).toBe(400);
});
```

Environment `ORBIT_CONNECTIONS`, `ORBIT_AI_CATALOG`, `ORBIT_AI_DEFAULTS` `"true"`; fixtures and helpers as in `apps/api/tests/ai-defaults.integration.test.ts`.

- [ ] **Step 2: Export the editor's and the budget form's payload code unchanged** as `profilePayload(stored, values)` and `budgetPayload(values, credits, now)`; existing tests still pass.

- [ ] **Step 3: Write the failing web tests**

```ts
// ai-knowledge-ui.test.tsx
it("refuses a half-filled route set instead of removing the routes (risk 7)", () => {
  expect(profilePayload(stored, { ...untouched, fast: "" })).toEqual({ error: "PROFILE_ROUTES_INCOMPLETE" });
});
it("removes the routes only when all four are cleared", () => {
  const r = profilePayload(stored, { ...untouched, fast: "", standard: "", quality: "", escalation: "" });
  expect(r).toMatchObject({ payload: expect.not.objectContaining({ modelRoutes: expect.anything() }) });
});
it("resends what the form does not show, the standard included", () => {
  const r = profilePayload({ ...stored, defaults: STANDARD, fallback: { onProviderBudgetStop: "openai" } }, untouched);
  expect(r).toEqual({ payload: { ...stored, defaults: STANDARD, fallback: { onProviderBudgetStop: "openai" } } });
});
// ai-budget-ui.test.tsx (characterization of risk 8: passes today, pins the full replace)
it("sends every part the budget PUT replaces", () => {
  expect(Object.keys(budgetPayload(values, {}, NOW)).sort())
    .toEqual(["assistantPerUserMonthlyMicros", "credits", "monthlyMicros", "providerCaps"]);
});
```

- [ ] **Step 4: Run them; expected FAIL** for the API test (409 expected, 200 received) and the first two web tests; the budget test passes (characterization).
- [ ] **Step 5: Implement** the rules and the error texts.
- [ ] **Step 6: Run** both test files, `ai-defaults.integration.test.ts`, `access-matrix.integration.test.ts` (no row may change; the query parameter is optional), `administration-boundary.test.ts`, `pnpm api:generate` (review: one optional query parameter on two routes), `tsc --noEmit`; expected PASS.
- [ ] **Step 7: Commit** `fix(ai): AI profile saves check the version; profile editor keeps what it does not show (F-8 risks 7, 8)`

---

### Task 5: Shared AI configuration service

`readAiModels` (`mcp-tools.ts:129-235`) holds the only code that puts a project's own configuration, its effective status, the profiles and the granted keys side by side. It moves into a service both the MCP tool and the management view read; the MCP output stays byte-identical.

**Files:**
- Create: `apps/api/src/platform/ai/effective-configuration.ts`, `apps/api/tests/ai-models-read.integration.test.ts`
- Modify: `apps/api/src/platform/ai/mcp-tools.ts`, `apps/api/src/platform/ai/central-ai.ts`

**Interfaces:**
- Consumes: `storedAiFields`, `ownAiKeys` (Task 1); `effectiveAiStatus`; `grantedConnections`; `layer`, `profileFields` (private in `central-ai.ts`)
- Produces:

```ts
// central-ai.ts
export type CentralLayers = {
  system: Partial<OpenAiRuntimeConfig> | null;        // profileFields(system profile)
  organization: Partial<OpenAiRuntimeConfig> | null;  // profileFields(workspace profile)
  standardImageModel: string | undefined;             // defaultImageModel(layer)
};
/** The central layers a project's runtime merges, without keys; null while none applies. */
export async function centralLayers(tx: DbTx, scope: Scope): Promise<CentralLayers | null>;

// effective-configuration.ts
export type RoutingMode = "unsaved" | "custom" | "preset" | "organization";
export type AiConfigurationState = {
  version: number;                                    // 0 without a row
  stored: StoredAiFields | null;
  ownKeys: { openai: boolean; image: boolean; anthropic: boolean };
  effective: Awaited<ReturnType<typeof effectiveAiStatus>>;
  profiles: { system: AiProfileRow | null; organization: AiProfileRow | null }; // rows as read by readAiModels today
  layers: CentralLayers | null;
  grants: { openaiText?: GrantedConnection; openaiImage?: GrantedConnection; anthropic?: GrantedConnection };
  global: { verified: Set<string>; rates: Record<string, unknown> };              // today's globalModels
  /** Status of the connections that serve the effective keys, by connection id. */
  keyConnections: Record<string, { status: string; disabled: boolean; scope: "system" | "workspace"; label: string }>;
  routingApplied: boolean;                            // aiDefaultsEnabled()
};
export async function aiConfigurationState(tx: DbTx, scope: Scope): Promise<AiConfigurationState>;
export async function globalModels(tx: DbTx, scope: Scope): Promise<{ verified: Set<string>; rates: Record<string, unknown> }>; // moved from mcp-tools.ts
export function routingModeOf(stored: StoredAiFields | null): RoutingMode;
export function projectAiExceptions(stored: StoredAiFields | null, ownKeys: AiConfigurationState["ownKeys"]): {
  models: boolean; routes: boolean; prices: boolean; providerBudgets: boolean;
  keys: Array<"openai" | "image" | "anthropic">;
};
```

**Rules**

- `routingModeOf`: `null` → `"unsaved"`; `stored.routing?.source` when set; else `"custom"`. (The stored mode; `routingApplied` says whether the runtime applies it — `configuredRuntime` ignores routing while `ORBIT_AI_DEFAULTS` is off, `openai-configuration.ts:583`.)
- `projectAiExceptions`: `models` = stored and `verifiedModels.length > 0`; `prices` = stored and the rate card has an entry; `routes` = mode `custom`, or `routing.overrides` has an entry; `providerBudgets` = stored and `providerBudgets` has a provider; `keys` = the keys in `ownKeys` that are true, in the order openai, image, anthropic.
- `keyConnections` reads `tx.connection.findMany({ where: { id: { in: <ids in effective.keyConnections> } }, select: { id, status, disabledAt, scope, label } })` (the project transaction already reads `connection`, `central.ts:58`).
- `readAiModels(tx, scope)` becomes a mapping of `aiConfigurationState(tx, scope)` to exactly today's output; `proposedAi` uses the moved `globalModels`.

- [ ] **Step 1: Write the characterization test** (passes on today's code)

Fixture modeled on `apps/api/tests/project-administration-mcp.integration.test.ts:153-200`: one organization with an organization OpenAI connection granted to the project (`purposes: ["text", "image"]`, `monthlyBudgetMicros: 5_000_000`) and an organization profile (verified models, rate card, `defaultProvider: "anthropic"`); a second project with its own saved configuration. Call `readAiModels` inside `scoped` for both projects and assert the complete objects with `toEqual` (dates and versions taken from the fixture rows, `anthropicCatalogVerifiedAt` from `anthropicCatalog`), including `global.profiles.organization`, `global.grantedKeys`, `checks` and `candidates`.

- [ ] **Step 2: Run it; expected PASS** on today's code (it pins the output).
- [ ] **Step 3: Implement** `centralLayers`, the service and the helpers; rewrite `readAiModels` on top of them.
- [ ] **Step 4: Run** the characterization test (expected PASS, unchanged), `project-administration-mcp.integration.test.ts`, `module-enforcement.integration.test.ts`, `key-rule-v2.integration.test.ts`; plus unit tests for `routingModeOf` and `projectAiExceptions` (one `it` per rule, in the same file). `node scripts/source-check.mjs`: 0 violations.
- [ ] **Step 5: Commit** `refactor(ai): one read of a project's AI layers for MCP and the settings center`

---

### Task 6: `GET /api/management/projects/:projectId/ai/effective`

**Files:**
- Create: `apps/api/src/platform/management/ai-effective.ts`, `apps/api/tests/management-ai.integration.test.ts`
- Modify: `apps/api/src/platform/management/routes.ts`, `apps/api/tests/fixtures/access-matrix.json`, `docs/API_CONTRACT.md`, OpenAPI artifacts

**Interfaces:**
- Consumes: `aiConfigurationState`, `routingModeOf`, `projectAiExceptions` (Task 5); `textModelReady`, `TEXT_TASKS`; `scopeFor(auth, req, projectId, PROJECT_OWN)` (the guard of `GET /api/projects/:id/openai-configuration`, `server.ts:1047-1054`); `scoped`
- Produces:

```ts
export type AiOrigin = "environment" | "system" | "organization" | "preset" | "project";
export type Traced<T> = { stored: T | null; effective: T | null; origin: AiOrigin | null };
export type TracedRoute = {
  stored: { model: string; reasoningEffort?: string; maxOutputTokens: number } | null;
  effective:
    | { model: string; reasoningEffort?: string; maxOutputTokens: number; provider: "openai" | "anthropic"; price: "current" | "missing" }
    | { error: "MODEL_CAPABILITY_NOT_VERIFIED" | "ROUTE_EFFORT_UNSUPPORTED" };
  explicit: boolean;
  origin: AiOrigin | null;
};
export type KeyTrace = {
  stored: boolean;                 // the project saved its own key
  effective: boolean;              // a call would have a key
  origin: Exclude<AiOrigin, "preset"> | null;
  connection: { label: string; status: string; disabled: boolean } | null;
};
export type ReadinessReason =
  | "no_key" | "project_key_unverifiable" | "environment_key_unverifiable"
  | "connection_not_checked" | "connection_failed" | "connection_disabled"
  | "no_text_route" | "text_not_ready";
export type ProviderReadiness = { stored: boolean; verified: boolean; ready: boolean; reasons: ReadinessReason[] };
export type ProviderBudgetValue = { monthlyMicros: number; warnMicros: number; warn2Micros: number; stopMicros: number; anchorDay: number; credit?: { amountMicros: number; verifiedAt: string; note?: string } };
export type ProjectAiEffective = {
  projectId: string;
  routingMode: RoutingMode;
  routingApplied: boolean;
  standardSource: "organization" | "system" | null;     // only with routingMode "organization"
  exceptions: ReturnType<typeof projectAiExceptions>;
  defaultProvider: Traced<"openai" | "anthropic">;
  tiers: {
    openai: Record<"fast" | "standard" | "quality" | "escalation", Traced<string>>;
    anthropic: Record<"fast" | "standard" | "quality", Traced<string>>;
  };
  taskRoutes: Record<TaskClass, TracedRoute>;
  fallback: Traced<"none" | "openai">;
  imageModel: Traced<string>;
  keys: Record<"openai" | "image" | "anthropic", KeyTrace>;
  providerBudgets: Record<"openai" | "anthropic", Traced<ProviderBudgetValue>>;
  readiness: Record<"openai" | "anthropic", ProviderReadiness>;
};
export async function projectAiEffective(tx: DbTx, scope: Scope): Promise<ProjectAiEffective>;
// route: GET /api/management/projects/:projectId/ai/effective (params: z.object({ projectId: z.uuid() }).strict())
```

**Origin rules** (the runtime's merge, `central-ai.ts:239-304`, `openai-configuration.ts:574-656`; nothing else decides an origin)

| Field | Origin |
| --- | --- |
| `defaultProvider`, `tiers.*` with mode `preset` and `routingApplied` | `preset` |
| the same with mode `organization` and `routingApplied` | the last of `organization`, `system` layer that defines the field, else `environment` |
| any field with a stored row (mode `custom`, or a field the routing does not replace) | `project` (a saved row always defines `defaultProvider`, `modelRoutes`, `fallback`, `imageGeneration`; `anthropicTierRoutes` only when stored) |
| any field without a row | the last of `organization`, `system` layer that defines it, else `environment` |
| `imageModel` with mode `organization`, `routingApplied` and `layers.standardImageModel` | that standard's layer (`organization` if the organization's `defaults.imageModel` is set, else `system`) |
| task route `T`, mode `custom` | `project` when stored defines `T`; else not explicit |
| task route `T`, mode `preset` | `project` when `routing.overrides[T]`; else not explicit |
| task route `T`, mode `organization` | `project` when `routing.overrides[T]`; else the last layer defining `T`; else not explicit |
| task route `T`, mode `unsaved` | the last of `organization`, `system`, `environment` defining `T`; else not explicit |
| not explicit | `explicit: false`, `origin` = origin of `defaultProvider` (the default provider's tier applies) |
| `providerBudgets[P]` | `project` when stored defines `P`; else `organization`, else `system` (`runtimeProviderBudgets`, `:853`); else `null` |
| `keys[K]` | `keySources[K]`: `project` → `project`; `connection` → `system` or `organization` by the connection's scope; `environment` → `environment`; `none` → `null` |

With connections off (`layers === null`) only `project` and `environment` occur. `stored` of every `Traced` comes from `StoredAiFields` (null without a row); `effective` from `effective` of the state.

**Readiness rules** (per provider `P`; `K` = `openai` for OpenAI, `anthropic` for Claude)

- `stored` = a key for `P` exists in the chain (`effective.textKeyConfigured` for OpenAI, `effective.anthropicKeyConfigured` for Claude). Else reason `no_key`.
- `verified` = `keySources[K] === "connection"` and that connection's `status` is `read_verified` or `write_verified` and it is not disabled. Otherwise, while `stored`: reason `project_key_unverifiable` (source project), `environment_key_unverifiable` (source environment), `connection_not_checked` (status `configured`), `connection_failed` (status `failed`), `connection_disabled` (disabled). A project or environment key is never more than `stored`.
- `ready` = `stored` and `textModelReady(effective)` and at least one task of `TEXT_TASKS` has an effective route without error whose `provider === P` and `price === "current"`. Otherwise, while `stored`: `text_not_ready` when `textModelReady` is false, else `no_text_route`.
- Nothing of the organization's or system's profile goes into the response beyond the values above and their origin.

- [ ] **Step 1: Write the failing integration test**

Environment: `ORBIT_CONNECTIONS`, `ORBIT_AI_CATALOG`, `ORBIT_AI_DEFAULTS` `"true"`, `ORBIT_SETTINGS_CENTER: "preview"`, `OPENAI_API_KEY` synthetic, `OPENAI_VERIFIED_MODELS` and `OPENAI_RATE_CARD_JSON` for two synthetic models; restore `process.env` in `afterAll`. People: `owner` (organization owner), `projectOwner` (project role owner, organization role viewer), `editor`, `outsider` (owner of another organization). Sign-ins with distinct `CLIENT_IP_HEADER` values as in `management-capabilities.integration.test.ts`. One project per fixture; connections created with `createConnection`/`grantConnection` (`administration/connections.ts`) and their `status` set through `authDb.connection.update`; profiles through `saveAiProfile`; standards through `saveAiDefaults`; project settings through the `ai-configure` services.

```ts
it("answers 404 before authentication while the settings center is off", …)  // ORBIT_SETTINGS_CENTER="off", no cookie → 404
it("is for project owners only", …)
// projectOwner 200; owner 200; editor 403 FORBIDDEN; outsider 404; no cookie 401
it("environment only", …)       // routingMode "unsaved"; defaultProvider.origin "environment"; keys.openai { origin: "environment", stored: false };
                                // readiness.openai { stored: true, verified: false, reasons: contains "environment_key_unverifiable" }
it("system profile", …)         // system profile verifiedModels + modelRoutes.fast "sys-fast": tiers.openai.fast { effective: "sys-fast", origin: "system" }
it("organization standard", …)  // organization defaults anthropic/balanced, project routing { source: "organization", overrides: {} } with a granted key:
                                // routingMode "organization"; standardSource "organization"; defaultProvider { origin: "organization", effective: "anthropic", stored: "openai" }
it("preset", …)                 // routing preset openai/economy: tiers.openai.fast.origin "preset"; exceptions.routes false
it("own choice", …)             // custom row with taskRoutes.chat_operator: taskRoutes.chat_operator { explicit: true, origin: "project" };
                                // taskRoutes.draft_blog { explicit: false }; exceptions { models: true, routes: true, prices: true }
it("own key", …)                // project OpenAI key: keys.openai { stored: true, origin: "project" }; readiness.openai.verified false, reasons contains "project_key_unverifiable"
it("granted key, checked", …)   // organization connection status "read_verified" granted: keys.openai { origin: "organization", connection: { label, status: "read_verified", disabled: false } };
                                // readiness.openai { verified: true, ready: true }
it("revoked grant", …)          // grant revokedAt set, no project key: keys.openai { effective: false, origin: null }; readiness.openai { stored: false, reasons: ["no_key"] }
it("missing key", …)            // no environment key, nothing granted: readiness.openai and readiness.anthropic { stored: false, verified: false, ready: false }
it("failed check", …)           // connection status "failed": readiness.openai { stored: true, verified: false }, reasons contains "connection_failed"
it("never returns a key, a profile or another project", …)
// for every fixture: JSON.stringify(body) contains none of the synthetic secrets, no "encrypted", no "rateCard",
// no "verifiedModels", no other project's id
```

- [ ] **Step 2: Run it; expected FAIL** (404 for every call: route missing).
- [ ] **Step 3: Implement** `projectAiEffective` (pure mapping of the state; split the origin and readiness rules into two exported pure functions `effectiveOrigins(state)` and `providerReadiness(state)` with their own unit tests in the same file, one `it` per table row) and the route (`scopeFor(..., PROJECT_OWN)`, then `scoped(scope.workspaceId, projectId, (tx) => projectAiEffective(tx, scope))`).
- [ ] **Step 4: Run the test; expected PASS.**
- [ ] **Step 5: Access matrix.** `UPDATE_ACCESS_MATRIX=1 … vitest run apps/api/tests/access-matrix.integration.test.ts`; the diff is exactly one new entry `GET /api/management/projects/{projectId}/ai/effective` with `anonymous: unauthenticated`, `outsider: not_found`, `viewer: forbidden:FORBIDDEN`, `editor: forbidden:FORBIDDEN`, `sysadmin: not_found`, `owner: allowed:200` (the same as `GET /api/projects/{projectId}/openai-configuration`). Any other change is a defect.
- [ ] **Step 6: OpenAPI and documentation.** `pnpm api:generate`, review; `docs/API_CONTRACT.md`: the route, its guard, the response fields and both rule tables.
- [ ] **Step 7: Verify** the test, `access-matrix`, `rls-matrix.integration.test.ts`, `tsc --noEmit`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 8: Commit** `feat(platform): effective AI configuration of a project with origins`

---

### Task 7: `GET /api/management/organizations/:workspaceId/ai/projects`

**Files:**
- Create: `apps/api/src/platform/management/ai-projects.ts`
- Modify: `apps/api/src/platform/management/routes.ts`, `apps/api/tests/management-ai.integration.test.ts`, `apps/api/tests/fixtures/access-matrix.json`, `docs/API_CONTRACT.md`, OpenAPI artifacts

**Interfaces:**
- Consumes: `storedAiFields`, `ownAiKeys` (Task 1); `routingModeOf`, `projectAiExceptions` (Task 5); `projectSpendAuthority` (`org-budget-levels.ts:67`); `workspaceOwnerFor` (`administration/authz.ts:73`); `scoped`; `authDb`
- Produces:

```ts
export type SpendingAuthorityState = "none" | "active" | "expired" | "off" | "invalid";
export type OrganizationAiProjects = {
  routingApplied: boolean;
  projects: Array<{
    projectId: string;
    name: string;
    routingMode: RoutingMode;
    ownKeys: { openai: boolean; image: boolean; anthropic: boolean };
    overrides: { models: boolean; routes: boolean; prices: boolean; providerBudgets: boolean };
    spendingAuthority: SpendingAuthorityState;
  }>;
};
export async function organizationAiProjects(workspaceId: string, actorId: string, now?: Date): Promise<OrganizationAiProjects>;
// route: GET /api/management/organizations/:workspaceId/ai/projects (params z.object({ workspaceId: z.uuid() }).strict())
```

**Rules**

- Projects: `authDb.project.findMany({ where: { workspaceId, kind: { not: "personal" } }, orderBy: { createdAt: "asc" } })`; personal spaces never.
- Per project, one `scoped(workspaceId, project.id, …)` read as the owner (the `ownerScope` pattern of `org-budget-levels.ts:20`): the `openai_configuration` row → `storedAiFields`, `ownAiKeys`; then `projectSpendAuthority(...)`. `overrides` = `projectAiExceptions` without `keys`.
- `spendingAuthority` from `projectSpendAuthority().state`: `not_set` → `none`; `active`, `expired`, `off`, `invalid` as they are.
- Guard: `workspaceOwnerFor(auth, req, workspaceId)` (404 to everyone else, system administrators included, D-4). No connections gate: the list is true with any flag combination.

- [ ] **Step 1: Write the failing tests** (in `management-ai.integration.test.ts`, second `describe`)

```ts
it("is for organization owners only", …)
// owner 200; projectOwner 404; editor 404; outsider 404; system administrator without ownership 404; no cookie 401
it("says per project what it follows and overrides", …)
// fixtures of Task 6: "environment only" → { routingMode: "unsaved", overrides all false, ownKeys all false };
// "organization standard" → "organization"; "preset" → "preset"; "own choice" → { routingMode: "custom", overrides: { models: true, routes: true, prices: true } };
// "own key" → ownKeys.openai true
it("reports the spending authority", …)
// no record → "none"; monthly 25 USD → "active"; custom window in the past → "expired"
it("lists no personal space and nothing of another organization", …)
// a member's personal space of the organization is absent; outsider's organization id → 404
```

- [ ] **Step 2: Run them; expected FAIL** (404: route missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expected PASS.**
- [ ] **Step 5: Access matrix:** exactly one new entry `GET /api/management/organizations/{workspaceId}/ai/projects`: `anonymous: unauthenticated`, `outsider`, `viewer`, `editor`, `sysadmin`: `not_found`, `owner: allowed:200` (as `GET /api/organizations/{workspaceId}/ai/budget`).
- [ ] **Step 6: OpenAPI and `docs/API_CONTRACT.md`.**
- [ ] **Step 7: Verify** as in Task 6.
- [ ] **Step 8: Commit** `feat(platform): which projects follow or override the organization's AI`

---

### Task 8: Sub-panels of the project AI settings

`AiSettings` (`ai-settings.tsx:687-1047`) renders, in this order: setup wizard, providers panel (with the OpenAI and Claude dialogs), model choice, models panel (with the task-route and models-and-prices dialogs), two provider budget panels, usage and costs. The center mounts them one per section, so they become exports that take their data as props; `AiSettings` keeps rendering them in the same order from one data hook.

**Files:**
- Modify: `apps/web/src/components/ai-settings.tsx`, `ai-settings.test.tsx`

**Interfaces:**
- Consumes: Task 2 helpers; `AiSetupPanel`, `ModelChoicePanel` (`ai-model-choice.tsx`, already exported)
- Produces (exports of `ai-settings.tsx`):

```ts
type Resource<T> = ReturnType<typeof useResource<T>>;
/** The two resources AiSettings loads today, and a refresh of both. */
export function useAiSettingsResources(): {
  configuration: Resource<AiConfigurationData>;
  budget: Resource<AiBudgetView>;
  refreshAll(): void;
};
/** "AI providers": capabilities, warnings, one row per provider, and the OpenAI and Claude dialogs. */
export function AiProvidersPanel(props: { configuration: Resource<AiConfigurationData>; refreshAll(): void; followsStandard?: boolean }): JSX.Element;
/** "AI models": the verified models with prices; the task-route and models-and-prices dialogs while `editable`. */
export function AiModelsPanel(props: { configuration: Resource<AiConfigurationData>; editable?: boolean }): JSX.Element;
/** The Claude and OpenAI budget panels, in that order. */
export function AiProviderBudgetPanels(props: { configuration: Resource<AiConfigurationData>; budget: Resource<AiBudgetView> }): JSX.Element;
/** "AI usage & costs": loads its four cost lists itself. */
export function AiProjectUsagePanel(props: { budget: Resource<AiBudgetView> }): JSX.Element;
/** The wizard's key step through the usual sections (moved out of AiSettings). */
export function saveAiKey(projectId: string, view: AiConfigurationData, provider: "openai" | "anthropic", key: string): Promise<void>;
// Newly exported internal components, props unchanged except the optional `followsStandard`:
export { CapabilityRows, ProviderBudgetPanel, CostList, AnthropicConfiguration };
// OpenAiConfiguration and AnthropicConfiguration take `followsStandard?: boolean` (default false), passed to openAiFields/anthropicFields.
export type { AiConfigurationData, AiBudgetView };
```

`AiModelsPanel`'s `editable` defaults to `true`. With `editable: false` the two buttons are not rendered and a note shows (copy below, local `de ? … : …` in this existing file). `AiProvidersPanel` passes `followsStandard` to both dialogs. `AiSettings` = `useAiSettingsResources()`, today's owner check, then `AiSetupPanel` (with `saveKey` calling `saveAiKey`), `AiProvidersPanel`, `ModelChoicePanel`, `AiModelsPanel`, `AiProviderBudgetPanels`, `AiProjectUsagePanel`, with no props beyond today's behaviour. The dialogs render inside their panels (they are `<dialog>` elements in the top layer, so their place in the tree does not change what is shown); the closed markup is unchanged. The cost requests move into `AiProjectUsagePanel`, so a non-owner no longer fires them (they answered 403 before).

| Copy | English | German |
| --- | --- | --- |
| models read-only note | The models come from the organization's standard. To choose others, change the model choice to a level or own settings. | Die Modelle kommen aus dem Standard der Organisation. Um andere zu wählen, stelle die Modellwahl auf eine Stufe oder eigene Einstellungen um. |

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup` inside a `WorkspaceContext.Provider` with a fixture project and `locale: "en"`; resources are fixture objects `{ data, loading: false, error: null, refresh() {} }`)

```ts
it("renders the providers panel from a configuration", …)  // markup contains "AI providers", "Configure" twice, "OpenAI", "Anthropic (Claude)"
it("offers the task routes only while editable", …)
// AiModelsPanel editable (default): "Task routes" and "Models &amp; prices" present; editable false: both absent, the read-only note present
it("renders both budget panels, Claude first", …)          // index of "Anthropic (Claude) budget" < index of "OpenAI budget"
it("renders AiSettings in today's order", …)
// with the resources hook mocked (vi.mock of the hook module is not available for same-file exports: render the panels
// through a small exported `AiSettingsView({ configuration, budget, refreshAll })`, which AiSettings calls with the hook's result):
// headings appear in this order: "AI providers", "Model choice" (when defaults are present), "AI models", "Anthropic (Claude) budget", "OpenAI budget", "AI usage & costs"
```

Add `export function AiSettingsView(props: { configuration; budget; refreshAll(): void }): JSX.Element` for the last test; `AiSettings` = owner check + `AiSettingsView` with the hook's result.

- [ ] **Step 2: Run them; expected FAIL** (exports missing).
- [ ] **Step 3: Implement** by moving code, not rewriting it. Before and after, render `AiSettingsView` with the same fixture and compare `renderToStaticMarkup` output: the strings must be identical (add this as a test against a stored inline snapshot taken from the code before Step 3 — take the snapshot first, then refactor).
- [ ] **Step 4: Run** `apps/web/src/components/*.test.tsx`, `apps/web/src/platform/project-settings/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 5: Commit** `refactor(web): project AI settings as panels the settings center can mount`

---

### Task 9: Module AI ceilings as a contribution

F-6: AI ceilings live in four modules (Finance extraction per day, Work PM per day and coding per month, Issues triage per day, Support AI per day). They stay module settings; the center lists them read-only with a link (spec 5.9). The shell cannot import modules, so modules contribute a small hook.

**Files:**
- Modify: `apps/web/src/platform/shell/types.ts` (`WebModule`), `apps/web/src/platform/shell/shell-context.tsx` (`ShellContextValue`), `apps/web/src/components/orbit.tsx` (one entry next to `settings`, `:436`), `apps/web/src/modules/finance/manifest.tsx`, `work/manifest.tsx`, `issues/manifest.tsx`, `support/manifest.tsx`
- Create: `apps/web/src/modules/finance/ai-ceiling.ts`, `work/ai-ceiling.ts`, `issues/ai-ceiling.ts`, `support/ai-ceiling.ts`, `apps/web/src/platform/shell/ai-ceilings.test.tsx`
- Test: also `apps/web/src/platform/shell/home.test.tsx` and every test that builds a `ShellContextValue` literal (add `aiCeilings: []`)

**Interfaces:**
- Produces:

```ts
// shell/types.ts
export type AiCeiling = {
  /** Unique within the module. */
  key: string;
  label: Label;
  /** The settings-center section that edits it, below the project's modules area ("finance/ai"). */
  section: string;
  /** Called on every render in registry order: the ceiling, or null while hidden or loading. */
  useCeiling(): { micros: number; period: "day" | "month"; on?: boolean } | null;
};
// WebModule gains: aiCeilings?: readonly AiCeiling[];
// shell-context.tsx, ShellContextValue gains:
//   aiCeilings: ReadonlyArray<AiCeiling & { moduleId: string }>;   // enabled modules only, registry order
// orbit.tsx: aiCeilings: active.flatMap((m) => (m.aiCeilings ?? []).map((c) => ({ ...c, moduleId: m.id }))),
```

**Contributions** (each hook reads the module's existing settings request; nothing new on the server)

| Module | key | label (EN / DE) | section | value |
| --- | --- | --- | --- | --- |
| finance | `extraction` | Document extraction / Belege auslesen | `finance/ai` | `GET financePath(id, "/settings")` → `{ micros: settings.aiDailyCeilingMicros, period: "day", on: settings.aiExtraction === "on" }` |
| work | `pm` | AI project manager / KI-Projektleiter | `work/settings` | `GET workPath(id, "/pm/settings")` → `{ micros: settings.dailyCeilingMicros, period: "day" }` |
| work | `coding` | Coding runs / Coding-Läufe | `work/settings` | same request → `{ micros: settings.codingMonthlyCeilingMicros, period: "month" }` |
| issues | `triage` | AI triage / KI-Einordnung | `issues/settings` | `GET issuesPath(id, "/settings")` → `{ micros: settings.triage.aiDailyCeilingMicros, period: "day", on: settings.triage.aiEnabled }` |
| support | `ai` | Support AI / Support-KI | `support/settings` | `GET supportPath(id, "/settings")` → `{ micros: settings.aiDailyBudgetMicros, period: "day" }` (add `aiDailyBudgetMicros: number` to the module's web `Settings` type) |

Each hook returns `null` while loading or on an error (the module section shows the error). The shell's module filtering (enabled modules, `minAccess`) already decides who sees them.

- [ ] **Step 1: Write the failing test** (`shell/ai-ceilings.test.tsx`)

```ts
it("every ceiling names a module section that exists", () => {
  // for each module of webRegistry with aiCeilings: each `section` equals an id produced by
  // projectModuleSections(…) for that module's settings (import from settings-center/sections/project)
  expect(ids).toEqual(expect.arrayContaining(["finance/ai", "work/settings", "issues/settings", "support/settings"]));
});
it("keys are unique within a module and labels have both languages", …)
```

- [ ] **Step 2: Run it; expected FAIL** (no module contributes `aiCeilings`).
- [ ] **Step 3: Implement** the types, the shell line and the four contributions.
- [ ] **Step 4: Run** the new test, `apps/web/src/platform/shell/*.test.tsx`, the four modules' settings tests, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs` (0 violations); expected PASS.
- [ ] **Step 5: Commit** `feat(web): modules contribute their AI ceilings`

---

### Task 10: Project AI area in the settings center

**Files:**
- Create: `settings-center/ai/texts.ts`, `ai/paths.ts`, `ai/origin-badge.tsx`, `ai/effective-view.tsx`, `ai/module-ceilings.tsx` and their tests
- Modify: `apps/api/src/platform/management/capabilities.ts`, `apps/api/tests/management-capabilities.integration.test.ts`, `settings-center/types.ts`, `settings-center/settings-center.tsx`, `settings-center/sections/project.tsx`, `sections/project.test.tsx`, every web test fixture of `ManagementCapabilities` (`grep -l 'stage: "preview"' apps/web/src/platform/settings-center`), `docs/API_CONTRACT.md`

**Interfaces:**
- Consumes: Tasks 6, 8, 9; `SpendPolicySettings`, `AgentMandateSettings`, `ModelChoicePanel`, `AiSetupPanel`; `useWorkspace`; `ShellContext`
- Produces:

```ts
// capabilities.ts (API) and types.ts (web), additive:
export type ManagementFlags = { connections: boolean; aiCatalog: boolean; aiDefaults: boolean; aiOrgBudget: boolean };
// ManagementCapabilities gains `flags: ManagementFlags`
//   = { connections: connectionsEnabled(), aiCatalog: aiCatalogEnabled(), aiDefaults: aiDefaultsEnabled(), aiOrgBudget: aiOrgBudgetEnabled() }
// SectionProps gains `flags: ManagementFlags`; SettingsCenterView passes caps.flags.
// ai/paths.ts
export function aiPaths(scope: ManageScope): {
  effective?: string;   // project: `/management/projects/${id}/ai/effective`
  projects?: string;    // organization: `/management/organizations/${id}/ai/projects`
  defaults?: string; models?: string; profile?: string; base?: string; // organization: `/organizations/${id}/ai/{defaults,models,profile}`, base `/organizations/${id}`; system: `/admin/ai/{defaults,models,profile}`
  overview?: string;    // system: "/admin/overview"
}; // ids encoded with encodeURIComponent
// ai/texts.ts
export type AiTextKey = keyof typeof en;
export function aiText(locale: Locale): (key: AiTextKey) => string;
// ai/origin-badge.tsx
export function originLabel(origin: AiOrigin | null, locale: Locale): string;
export function OriginBadge(props: { origin: AiOrigin | null; exception?: boolean; locale: Locale }): JSX.Element;
// ai/effective-view.tsx
export type ProjectAiEffective = { /* web copy of Task 6's type, same names and shape */ };
export function EffectiveAiView(props: { data: ProjectAiEffective; locale: Locale; hrefOf(area: string, ...rest: string[]): string }): JSX.Element;
export function EffectiveAiSection(props: SectionProps): JSX.Element;
// ai/module-ceilings.tsx
export function ModuleCeilingsView(props: {
  rows: Array<{ key: string; moduleName: string; label: string; micros: number; period: "day" | "month"; on?: boolean; href: string }>;
  locale: Locale;
}): JSX.Element;
export function ModuleCeilings(props: { locale: Locale; hrefOf(area: string, ...rest: string[]): string }): JSX.Element;
```

**Sections** (area `ai`, capability `project.ai`; the link panel `AiSection` and `projectAiSettingsHref` are removed)

| id | order | Content | Address |
| --- | --- | --- | --- |
| `overview` | 0 | `EffectiveAiSection` | `/manage/p/:id/ai` and `/manage/p/:id/ai/overview` |
| `providers` | 10 | `AiSetupPanel` (with `saveAiKey`), `AiProvidersPanel followsStandard={following}` | `/manage/p/:id/ai/providers` |
| `models` | 20 | `ModelChoicePanel`; `flags.aiDefaults` false → notice `defaultsOff`; then `AiModelsPanel editable={!following}` inside `<details>` with summary `modelsAdvanced` | `/manage/p/:id/ai/models` |
| `budget` | 30 | `SpendPolicySettings`, `AiProviderBudgetPanels`, `ModuleCeilings` | `/manage/p/:id/ai/budget` |
| `usage` | 40 | `AiProjectUsagePanel` | `/manage/p/:id/ai/usage` |
| `agents` | 50 | `AgentMandateSettings` (`ownHead` not set) | `/manage/p/:id/ai/agents` |

`following` = `configuration.data.routing?.source === "organization" && Boolean(configuration.data.defaults)` (the standard applies only while `ORBIT_AI_DEFAULTS` is on). Each section that needs the configuration calls `useAiSettingsResources()` itself. Any other address below `/manage/p/:id/ai/…` shows "Not available" (no section has `takesId`).

**Effective view layout:** a panel with the routing mode (`modeUnsaved` / `modeCustom` / `modePreset` / `modeOrganization` plus `standardFromSystem` when `standardSource === "system"`), `routingOff` when `routingApplied` is false and the mode is `preset` or `organization`; the exceptions line (`exceptionsNone` or `exceptionsList` followed by the names of the true parts and keys); a readiness table, one row per provider with three status marks (`readyStored`, `readyVerified`, `readyReady`) and the reasons' texts; a values table, one row per value (label, effective value or `notSet`, `OriginBadge`, `exception` badge when the origin is `project` and the mode is not `custom`): default provider, the four OpenAI and three Claude tiers, the explicit task routes (task names from `aiTasks` in `lib/ai-presets.ts`) and then `otherTasksTier`, fallback, image model, the three keys (with the connection label and status when set), the two provider budgets (amount per month or `notSet`); links `changeModels` → `hrefOf("ai", "models")`, `changeKeys` → `hrefOf("ai", "providers")`, `changeBudgets` → `hrefOf("ai", "budget")`.

**Module ceilings:** `ModuleCeilings` calls `useCeiling()` of every entry of `shell.aiCeilings` on every render, in order (the project scope is remounted when the enabled modules change, phase 2), drops `null`s, and builds `href` = `hrefOf("modules", ...section.split("/"))` and `moduleName` from `shell.modules`. The view: heading `ceilingsTitle`, intro `ceilingsIntro`, one row per ceiling (`"<module>: <label>"`, amount with `perDay`/`perMonth`, `ceilingOff` when `on === false`, a link `openSetting`), or `ceilingsNone`.

**Exact copy** (`ai/texts.ts`)

| Key | English | German |
| --- | --- | --- |
| `originEnvironment` | Environment | Umgebung |
| `originSystem` | System | System |
| `originOrganization` | Organization | Organisation |
| `originPreset` | Own level | Eigene Stufe |
| `originProject` | This project | Dieses Projekt |
| `originNone` | Not set | Nicht festgelegt |
| `exception` | Exception | Ausnahme |
| `modeUnsaved` | No own AI settings: the project uses what the organization, the system and the environment set. | Keine eigenen KI-Einstellungen: Das Projekt nutzt, was Organisation, System und Umgebung festlegen. |
| `modeCustom` | Own settings: the project's own tiers and task routes apply. | Eigene Einstellungen: Es gelten die eigenen Stufen und Aufgaben-Routen des Projekts. |
| `modePreset` | Own level: a preset chosen for this project. | Eigene Stufe: eine für dieses Projekt gewählte Voreinstellung. |
| `modeOrganization` | Follows the organization's standard. | Folgt dem Standard der Organisation. |
| `standardFromSystem` | The organization has set no standard, so Orbit's standard applies. | Die Organisation hat keinen Standard festgelegt, daher gilt der Orbit-Standard. |
| `routingOff` | Standard models and presets are not switched on for this installation, so the project's own settings apply until they are. | Standard-Modelle und Stufen sind für diese Installation nicht eingeschaltet, daher gelten bis dahin die eigenen Einstellungen des Projekts. |
| `exceptionsNone` | No exceptions: every value is inherited. | Keine Ausnahmen: Jeder Wert ist übernommen. |
| `exceptionsList` | Set by this project: | Von diesem Projekt festgelegt: |
| `partModels` | models | Modelle |
| `partRoutes` | routes | Routen |
| `partPrices` | prices | Preise |
| `partBudgets` | provider budgets | Anbieter-Budgets |
| `partKeys` | own keys | eigene Schlüssel |
| `readinessTitle` | Readiness per provider | Bereitschaft je Anbieter |
| `readyStored` | Key available | Schlüssel vorhanden |
| `readyVerified` | Key checked | Schlüssel geprüft |
| `readyReady` | Ready for text | Bereit für Text |
| `reasonNoKey` | No key for this provider. | Kein Schlüssel für diesen Anbieter. |
| `reasonProjectKey` | The project's own key cannot be checked; only central connections are checked. | Der eigene Schlüssel des Projekts kann nicht geprüft werden; geprüft werden nur zentrale Verbindungen. |
| `reasonEnvironmentKey` | The environment's key cannot be checked; only central connections are checked. | Der Schlüssel aus der Umgebung kann nicht geprüft werden; geprüft werden nur zentrale Verbindungen. |
| `reasonNotChecked` | The connection has not been checked yet. | Die Verbindung wurde noch nicht geprüft. |
| `reasonFailed` | The connection's last check failed; it is still used. | Die letzte Prüfung der Verbindung ist fehlgeschlagen; sie wird trotzdem genutzt. |
| `reasonDisabled` | The connection is disabled. | Die Verbindung ist deaktiviert. |
| `reasonNoTextRoute` | No text task uses this provider. | Keine Textaufgabe nutzt diesen Anbieter. |
| `reasonTextNotReady` | Text tasks need a verified model with a current price. | Textaufgaben brauchen ein geprüftes Modell mit aktuellem Preis. |
| `valuesTitle` | Values and where they come from | Werte und ihre Herkunft |
| `defaultProvider` | Default provider | Standardanbieter |
| `tierOpenAi` | OpenAI tier | OpenAI-Stufe |
| `tierClaude` | Claude tier | Claude-Stufe |
| `otherTasksTier` | Other tasks use the default provider's tier. | Andere Aufgaben nutzen die Stufe des Standardanbieters. |
| `fallback` | When the Claude budget is stopped | Wenn das Claude-Budget gestoppt ist |
| `fallbackNone` | Refuse the call | Aufruf ablehnen |
| `fallbackOpenAi` | Fall back to OpenAI | Auf OpenAI ausweichen |
| `imageModel` | Image model | Bildmodell |
| `keyOpenAi` | OpenAI key | OpenAI-Schlüssel |
| `keyImage` | Image key | Bild-Schlüssel |
| `keyClaude` | Claude key | Claude-Schlüssel |
| `budgetOf` | Budget | Budget |
| `perMonth` | per month | pro Monat |
| `perDay` | per day | pro Tag |
| `notSet` | not set | nicht festgelegt |
| `changeModels` | Change models | Modelle ändern |
| `changeKeys` | Keys and providers | Schlüssel und Anbieter |
| `changeBudgets` | Budgets | Budgets |
| `modelsAdvanced` | Models, prices and task routes | Modelle, Preise und Aufgaben-Routen |
| `defaultsOff` | Standard models and presets are not switched on for this installation; the project's own models apply. | Standard-Modelle und Stufen sind für diese Installation nicht eingeschaltet; es gelten die eigenen Modelle des Projekts. |
| `ceilingsTitle` | AI ceilings of the modules | KI-Obergrenzen der Module |
| `ceilingsIntro` | Modules limit their own AI use on top of the spending authority. They are changed in each module's settings. | Module begrenzen ihre KI-Nutzung zusätzlich zur Ausgabenfreigabe. Geändert werden sie in den Einstellungen des jeweiligen Moduls. |
| `ceilingsNone` | No module of this project sets an AI ceiling. | Kein Modul dieses Projekts legt eine KI-Obergrenze fest. |
| `ceilingOff` | switched off | ausgeschaltet |
| `openSetting` | Open setting | Einstellung öffnen |

Section labels and descriptions (literals in `sections/project.tsx`):

| id | Label EN / DE | Description EN / DE |
| --- | --- | --- |
| `overview` | AI overview / KI-Übersicht | Which models, keys and budgets apply and where each comes from. / Welche Modelle, Schlüssel und Budgets gelten und woher sie kommen. |
| `providers` | Providers and keys / Anbieter und Schlüssel | Keys of OpenAI and Claude, where they come from, and what the project can do with them. / Schlüssel für OpenAI und Claude, woher sie kommen und was das Projekt damit kann. |
| `models` | Models / Modelle | Follow the standard, choose a level or set own models and task routes. / Dem Standard folgen, eine Stufe wählen oder eigene Modelle und Aufgaben-Routen festlegen. |
| `budget` | Budget / Budget | Spending authority, provider budgets and the modules' AI ceilings. / Ausgabenfreigabe, Anbieter-Budgets und die KI-Obergrenzen der Module. |
| `usage` | Usage and costs / Nutzung und Kosten | What the project's AI used, calculated by Orbit. / Was die KI des Projekts verbraucht hat, von Orbit berechnet. |
| `agents` | Agent permissions / Agentenrechte | What configured agents may do and spend. / Was eingerichtete Agenten tun und ausgeben dürfen. |

- [ ] **Step 1: Write the failing tests**

```ts
// management-capabilities.integration.test.ts
it("reports the AI flags", …)  // ORBIT_AI_CATALOG "true", ORBIT_AI_DEFAULTS unset → flags { aiCatalog: true, aiDefaults: false }
// ai/texts.test.tsx
it("has German for every English key and no extra key", …)
// ai/paths.test.tsx
it("builds the AI paths of each scope with the id encoded", () => {
  expect(aiPaths({ kind: "project", projectId: "p 1" }).effective).toBe("/management/projects/p%201/ai/effective");
  expect(aiPaths({ kind: "organization", organizationId: "w1" }).projects).toBe("/management/organizations/w1/ai/projects");
  expect(aiPaths({ kind: "system" }).profile).toBe("/admin/ai/profile");
});
// ai/effective-view.test.tsx (fixture: the "organization standard" case of Task 6)
it("shows each value with its origin and marks project exceptions", …)
// markup contains originLabel("organization", "en") next to the default provider; an override route shows "Exception"
it("states the mode, the standard's source and routing that is off", …)
it("shows the three readiness marks and the reasons", …)        // a project key: "Key available" ready, "Key checked" not, reasonProjectKey text
it("links to the sections that change the values", …)           // hrefs from hrefOf("ai","models"), ("ai","providers"), ("ai","budget")
// ai/module-ceilings.test.tsx
it("lists each ceiling with its period and a link to its module section", …)  // href "/manage/p/p1/modules/finance/ai"
it("says when no module sets a ceiling", …)
// sections/project.test.tsx (replace the link panel test)
it("registers the six AI sections for owners only", …)
// visibleSections(projectSections, "project", OWNER) contains ai/overview, ai/providers, ai/models, ai/budget, ai/usage, ai/agents in this order; VIEWER contains none
it("resolves the short address to the overview and nothing else below it", …)
// resolveSection(sections, "ai", []) → overview; resolveSection(sections, "ai", ["nope"]) → null
it("offers model edits only while the project does not follow the standard", …)
// render the models section with a configuration on routing organization + defaults: no "Task routes"; on custom: "Task routes" present
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement**, including the `flags` field (API and web, every fixture), `SectionProps.flags`, and the removal of `projectAiSettingsHref` and the project `AiSection`.
- [ ] **Step 4: Run** the new tests, `apps/web/src/platform/settings-center/**/*.test.tsx`, `management-capabilities.integration.test.ts`, `tsc --noEmit` (root and `apps/web`); expected PASS.
- [ ] **Step 5: Commit** `feat(web): project AI area of the settings center`

---

### Task 11: Organization and system AI areas

**Files:**
- Create: `settings-center/ai/organization-projects.tsx`, `ai/affected-projects.tsx` and their tests
- Modify: `settings-center/sections/organization.tsx`, `sections/organization.test.tsx`, `sections/system.tsx`, `sections/system.test.tsx`, `settings-center/texts.ts` (remove `aiLinkBody`, `aiLinkAction`), `settings-center/ai/texts.ts`
- Delete: `settings-center/sections/ai-link.tsx`

**Interfaces:**
- Consumes: Tasks 4, 7, 10; `AiDefaultsPanel`, `ModelPricesPanel`, `AiBudgetPanel`, `AiUsagePanel`, `AiProfileEditor` (props unchanged)
- Produces:

```ts
// ai/organization-projects.tsx
export type OrganizationAiProjects = { /* web copy of Task 7's type */ };
export function affectedCounts(data: OrganizationAiProjects): { total: number; following: number; unsaved: number; own: number }; // own = preset + custom
export function OrganizationAiProjectsView(props: { data: OrganizationAiProjects; locale: Locale; projectHref(projectId: string): string }): JSX.Element;
export function OrganizationAiProjectsSection(props: SectionProps): JSX.Element;
// ai/affected-projects.tsx
export type AffectedKind = "profile" | "catalog";
export function AffectedProjectsNotice(props:
  | { scope: "organization"; kind: AffectedKind; counts: ReturnType<typeof affectedCounts>; locale: Locale }
  | { scope: "system"; kind: AffectedKind; total: number; locale: Locale }): JSX.Element;
export function OrganizationAffected(props: { organizationId: string; kind: AffectedKind; locale: Locale }): JSX.Element; // loads aiPaths(...).projects
export function SystemAffected(props: { kind: AffectedKind; locale: Locale }): JSX.Element;                               // loads /admin/overview → projects.total
```

`projectHref(id)` = `manageHref({ kind: "project", projectId: id }, "ai")`. The notice renders nothing while loading or on an error (the panel below still works). `kind: "profile"` is for the standard and the advanced profile (a profile save changes the route version, `central-ai.ts:221-237`); `kind: "catalog"` is for models and prices (catalog prices do not take part in the route version, so that notice does not claim it). The budget section has no notice: the organization budget is not part of the route version.

**Sections, organization** (area `ai`, capability `organization.ai`; the link panel `overview` is removed, so `/manage/o/:id/ai/overview` shows "Not available")

| id | order | Content |
| --- | --- | --- |
| `standard` | 0 | `OrganizationAffected kind="profile"`, `AiDefaultsPanel path={base}/ai/defaults modelsPath={base}/ai/models` |
| `models` | 10 | `flags.aiCatalog` false → notice `catalogOff`; `OrganizationAffected kind="catalog"`, `ModelPricesPanel path={base}/ai/models` |
| `budget` | 20 | `AiBudgetPanel base={base}` (renders `#assistant-budget` itself) |
| `usage` | 30 | `AiUsagePanel base={base}` (exists; order changes from 0) |
| `projects` | 40 | `OrganizationAiProjectsSection` |
| `advanced` | 50 | `advanced: true`; `OrganizationAffected kind="profile"`, `AiProfileEditor path={base}/ai/profile scopeLabel={locale === "de" ? "Organisation" : "Organization"}` (the editor now sends the expected version, Task 4) |

Addresses: `/manage/o/:id/ai` (standard), `/manage/o/:id/ai/{standard,models,budget,usage,projects,advanced}`; `/manage/o/:id/ai/budget#assistant-budget` scrolls to the assistant cap.

**Sections, system** (area `ai`, capability `system.ai`; the link panel and `SYSTEM_AI_SETTINGS_HREF` are removed)

| id | order | Content |
| --- | --- | --- |
| `standard` | 0 | `SystemAffected kind="profile"`, `AiDefaultsPanel path="/admin/ai/defaults" modelsPath="/admin/ai/models"` |
| `models` | 10 | `flags.aiCatalog` false → notice `catalogOff`; `SystemAffected kind="catalog"`, `ModelPricesPanel path="/admin/ai/models"` |
| `advanced` | 20 | `advanced: true`; `SystemAffected kind="profile"`, `AiProfileEditor path="/admin/ai/profile" scopeLabel="System"` |

D-7 (risk 10): the organization's guided budget section edits the organization caps (`AiBudgetPanel`); the profile's provider budgets are edited only in `advanced` (`AiProfileEditor`); project budgets only in the project's `budget` section. No mechanism is removed.

Flag states (decision 7): connections off → `organization.ai` and `system.ai` are not granted, so the area is absent; `ORBIT_AI_DEFAULTS` off → `AiDefaultsPanel` shows its own "not switched on" alert (`ai-defaults-ui.tsx:131`); `ORBIT_AI_CATALOG` off → `catalogOff`; `ORBIT_AI_ORG_BUDGET` off → `AiBudgetPanel` shows its own alert (`ai-budget-ui.tsx:392`). Navigation hides nothing because of these flags.

**Exact copy** (added to `ai/texts.ts`)

| Key | English | German |
| --- | --- | --- |
| `affectedOrgProfile` | Applies to {following} projects that follow the standard and {unsaved} without own AI settings; {own} projects with their own choice keep the values they set. Saving changes the route version of all {total} projects of this organization: running AI work there stops before its next paid call. | Gilt für {following} Projekte, die dem Standard folgen, und {unsaved} ohne eigene KI-Einstellungen; {own} Projekte mit eigener Wahl behalten ihre gesetzten Werte. Speichern ändert die Routen-Version aller {total} Projekte dieser Organisation: Laufende KI-Arbeit dort stoppt vor ihrem nächsten bezahlten Aufruf. |
| `affectedOrgCatalog` | Prices and switches here apply to all {total} projects of this organization where the project sets no price of its own. | Preise und Schalter hier gelten für alle {total} Projekte dieser Organisation, sofern ein Projekt keinen eigenen Preis festlegt. |
| `affectedSystemProfile` | Applies to every project whose organization and own settings leave a value open. Saving changes the route version of all {total} projects and of every personal space: running AI work stops before its next paid call. | Gilt für jedes Projekt, dessen Organisation und eigene Einstellungen einen Wert offen lassen. Speichern ändert die Routen-Version aller {total} Projekte und jedes persönlichen Bereichs: Laufende KI-Arbeit stoppt vor ihrem nächsten bezahlten Aufruf. |
| `affectedSystemCatalog` | Prices and switches here apply to every organization and project that sets no price of its own ({total} projects). | Preise und Schalter hier gelten für jede Organisation und jedes Projekt ohne eigenen Preis ({total} Projekte). |
| `catalogOff` | The central price catalog is not switched on for this installation; projects use their own and the profiles' prices. Saved changes apply once it is. | Der zentrale Preiskatalog ist für diese Installation nicht eingeschaltet; Projekte nutzen ihre eigenen Preise und die der Profile. Gespeicherte Änderungen gelten, sobald er eingeschaltet ist. |
| `projectsIntro` | Which projects follow the organization's AI settings and which set their own. | Welche Projekte den KI-Einstellungen der Organisation folgen und welche eigene festlegen. |
| `projectsEmpty` | This organization has no projects yet. | Diese Organisation hat noch keine Projekte. |
| `colProject` | Project | Projekt |
| `colChoice` | Model choice | Modellwahl |
| `colKeys` | Own keys | Eigene Schlüssel |
| `colOverrides` | Set by the project | Vom Projekt festgelegt |
| `colAuthority` | Spending authority | Ausgabenfreigabe |
| `choiceUnsaved` | No own settings | Keine eigenen Einstellungen |
| `choiceCustom` | Own settings | Eigene Einstellungen |
| `choicePreset` | Own level | Eigene Stufe |
| `choiceOrganization` | Organization standard | Organisationsstandard |
| `none` | none | keine |
| `authorityNone` | not set | nicht festgelegt |
| `authorityActive` | active | aktiv |
| `authorityExpired` | expired | abgelaufen |
| `authorityOff` | off | aus |
| `authorityInvalid` | invalid | ungültig |

Placeholders `{following}`, `{unsaved}`, `{own}`, `{total}` are replaced by `affectedText(key, values, locale)` exported from `ai/affected-projects.tsx` (a pure function: every `{name}` replaced by `String(values[name])`).

Section labels and descriptions:

| Scope / id | Label EN / DE | Description EN / DE |
| --- | --- | --- |
| organization `standard`, system `standard` | Standard models / Standard-Modelle | One provider and level for every project that follows the standard. / Ein Anbieter und eine Stufe für jedes Projekt, das dem Standard folgt. |
| organization `models`, system `models` | Models and prices / Modelle und Preise | Which catalog models are on and what they cost. / Welche Katalogmodelle an sind und was sie kosten. |
| organization `budget` | Budget / Budget | The organization's monthly AI budget, provider caps and the assistant's cap per member. / Das monatliche KI-Budget der Organisation, Anbieter-Obergrenzen und die Grenze des Assistenten je Mitglied. |
| organization `usage` | AI usage / KI-Nutzung | What AI used in this organization, read only. / Was die KI in dieser Organisation verbraucht hat, nur lesend. |
| organization `projects` | Projects / Projekte | Which projects follow the standard and which set their own. / Welche Projekte dem Standard folgen und welche eigene Einstellungen haben. |
| organization `advanced`, system `advanced` | AI profile / KI-Profil | The raw profile: verified models, routes, prices and provider budgets. / Das Rohprofil: geprüfte Modelle, Routen, Preise und Anbieter-Budgets. |

- [ ] **Step 1: Write the failing tests**

```ts
// ai/organization-projects.test.tsx
it("counts who follows, who has no settings and who chose their own", () => {
  expect(affectedCounts(fixture)).toEqual({ total: 4, following: 1, unsaved: 1, own: 2 });
});
it("lists each project with its choice, keys, overrides and authority, linked to its AI area", …)  // href "/manage/p/p1/ai"
it("says when the organization has no projects", …)
// ai/affected-projects.test.tsx
it("fills the counts into the organization's profile notice", () => {
  expect(affectedText("affectedOrgProfile", { following: 1, unsaved: 2, own: 3, total: 6 }, "en"))
    .toBe("Applies to 1 projects that follow the standard and 2 without own AI settings; 3 projects with their own choice keep the values they set. Saving changes the route version of all 6 projects of this organization: running AI work there stops before its next paid call.");
});
it("does not claim a route version change for prices", …)    // the catalog notices contain no "route version" / "Routen-Version"
// sections/organization.test.tsx (replace "offers no AI form")
it("registers the AI sections in order and no link panel", …)
// ids in area ai: standard, models, budget, usage, projects, advanced; "advanced" has advanced: true; resolveSection(…, "ai", ["overview"]) → null
it("shows the catalog notice only while the catalog is off", …)   // render models section with flags.aiCatalog false/true
// sections/system.test.tsx
it("registers standard, models and advanced, and no link panel", …)
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement**; delete `ai-link.tsx` and its two text keys.
- [ ] **Step 4: Run** `apps/web/src/platform/settings-center/**/*.test.tsx`, `apps/web/src/platform/administration/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): organization and system AI areas of the settings center`

---

### Task 12: Browser acceptance, documentation, controller verification

**Files:**
- Create: `apps/web/tests/settings-center-ai.spec.ts`
- Modify: `docs/MODEL_ROUTING.md`, `docs/plans/ai-central-management.md`, `docs/plans/SYSTEM_MANAGEMENT_V2.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/API_CONTRACT.md` (rule check)

**Interfaces:**
- Consumes: everything above; the seeded e2e installation; the invitation pattern of `apps/web/tests/administration.spec.ts:30-90` (a link returned without system mail, accepted in a second browser context)

- [ ] **Step 1: Write the Playwright spec.** It skips unless `/api/me` reports `settingsCenter` other than `"off"` and `connections: true`. Stack flags: `ORBIT_ADMINISTRATION=true ORBIT_ACCOUNT=true ORBIT_CONNECTIONS=true ORBIT_AI_CATALOG=true ORBIT_AI_DEFAULTS=true ORBIT_AI_ORG_BUDGET=true ORBIT_SETTINGS_CENTER=preview`. No provider is reached: the seeded stack has no provider keys in its environment and does not enable external writes, the organization connection is created with a synthetic secret and never checked, and nothing in the spec triggers a paid call or a key check.

```ts
test.beforeAll(…)
// as the seeded owner (organization owner and system administrator), through the API:
//   POST /api/organizations/<org>/connections { provider: "openai", label: "Synthetic OpenAI", config: {}, secret: <synthetic> }
//   POST /api/organizations/<org>/connections/<id>/grants { projectId: <project>, purposes: ["text"] }
//   invite a second person with organization role "viewer" and project role "owner" on <project>; accept the returned link
//   in a second context with an own password (administration.spec.ts pattern)
test("stored AI configuration is identical before and after opening every AI section", …)
// snapshot(): GET /api/projects/<p>/openai-configuration → .stored; GET /api/projects/<p>/ai-spend-policy → .record;
//   GET /api/projects/<p>/agent-mandates (whole body minus usage fields); GET /api/organizations/<org>/ai/profile → { version, data };
//   GET /api/organizations/<org>/ai/defaults → { version, defaults }; GET /api/organizations/<org>/ai/budget → .budget;
//   GET /api/organizations/<org>/ai/models → models[].{id, active, overridden, rate}; GET /api/admin/ai/profile → { version, data }
// before = snapshot(); open /manage/p/<p>/ai/{overview,providers,models,budget,usage,agents},
//   /manage/o/<org>/ai/{standard,models,budget,usage,projects,advanced} (open the advanced disclosure),
//   /manage/system/ai/{standard,models,advanced}; wait for each section's heading; after = snapshot();
// expect(JSON.stringify(after)).toBe(JSON.stringify(before))
test("an organization owner sets the standard; a project owner sees it inherited and can only switch", …)
// owner: /manage/o/<org>/ai/standard → notice text contains "projects of this organization"; "Set standard" → Claude, Balanced → Save;
// owner sets the project's model choice to "Organization standard" (POST action ai-configure { routing: { source: "organization", overrides: {} } });
// second person: /manage/p/<p>/ai → "Follows the organization's standard."; the default provider row shows "Organization";
// /manage/p/<p>/ai/models → "Model choice" panel with "Change"; no "Task routes" button; the read-only note is visible;
// /manage/o/<org>/ai/standard → the not-found text (not an organization owner)
test("the organization's projects list shows the project as following", …)  // /manage/o/<org>/ai/projects: row with "Organization standard"
test("old AI pages keep working", …)   // /p/<p>/settings?section=ai, /o/<org>/settings, /admin/ai render their AI headings
test("the assistant budget anchor still works", …)  // /manage/o/<org>/ai/budget#assistant-budget scrolls the cap into view
test("works on a phone", …)             // 390 × 844 on /manage/p/<p>/ai: no horizontal scroll
```

- [ ] **Step 2: Write the documentation.** `docs/MODEL_ROUTING.md`: the effective read (origin rules, readiness rules), the first-save confirmation, the profile version check. `docs/plans/ai-central-management.md`: phase D marked "replaced by System & Administration V2 phase 4", phase E unchanged and open. `docs/plans/SYSTEM_MANAGEMENT_V2.md`: phase 4 implemented locally; the deviations listed in this plan's report. `docs/IMPLEMENTATION_STATUS.md`: a new top entry (state: local, not on `main`; what was built; the ten risks with fix or reasoned non-fix; verification counts filled by the controller). `docs/REQUIREMENTS_TRACEABILITY.md`: rows for WP 4.1 to 4.5 with their tests.

- [ ] **Step 3: Run** `tsc --noEmit` (root and `apps/web`), `node scripts/source-check.mjs`, `git diff --check`; expected PASS.
- [ ] **Step 4: Commit** `test(web): AI area of the settings center in the browser; docs`
- [ ] **Step 5: Controller verification** (not the implementer's): stop any dev stack and remove a worktree `.runtime/local.env` with flags before the suite (phase 2 ledger), reset this worktree's test database, then:
  1. the whole vitest suite; revert `evals/knowledge/last-deterministic-run.json` afterwards;
  2. the whole Playwright suite with `ORBIT_SETTINGS_CENTER` off (CI flags: `ORBIT_ADMINISTRATION=true`), fresh seed;
  3. the whole Playwright suite with `ORBIT_ADMINISTRATION=true ORBIT_ACCOUNT=true ORBIT_SETTINGS_CENTER=preview`, fresh seed;
  4. `settings-center-ai.spec.ts` alone with the AI flags of Step 1, fresh seed;
  5. `next build` (after stopping `next dev`); `pnpm test:coolify-compose`; secret scan;
  6. fill the status entry's counts and commit.
- [ ] **Step 6: Request review** with `superpowers:requesting-code-review` on the whole branch and the Review Focus list; report to Mario and wait for his approval before any push to `main`.
