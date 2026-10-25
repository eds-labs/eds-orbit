# Central AI management: prices, models and budgets in one place

Status: **plan, not implemented** (2026-10-25). Requested by Mario after the phase 3 rollout: *"Prices should be maintained once per organization instead of as JSON per project. AI is still confusing for new users; billing and budgets must be simpler and centrally managed."* Builds on ADR 0014 (central connections, AI profiles) and ADR 0015 (AI spending authority). Every decision marked **D-n** below is open.

## 1. Where we are (production, 2026-10-25)

A project owner who wants AI in a new project today has to understand:
- **4 places for keys**
- **5 places for prices**
- **3 levels of routing**
- **7 budget layers with 3 different periods**

### Keys

| Where | Field | Who |
|---|---|---|
| Project | `openai_configuration.encryptedApiKey`, `encryptedImageApiKey`, `encryptedAnthropicApiKey` | project owner (Settings → KI & Budget) |
| Organization / system | `Connection` + `ConnectionGrant` with purposes `text`/`image` (ADR 0014) | org owner, administrator |
| Environment | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | operator; since key rule v2 only for projects without saved settings |

### Prices (rate cards, USD micros per million tokens)

| Where | How it is edited |
|---|---|
| Project `openai_configuration.rateCard` | JSON textarea ("Modelle & Preise") |
| System AI profile `rateCard` | JSON textarea (Administration → KI & Wissen) |
| Organization AI profile `rateCard` | JSON textarea (organization settings) |
| Environment `OPENAI_RATE_CARD_JSON` | operator |
| Code `anthropicCatalog` (`packages/ai/src/provider.ts`) | suggestion only, copied into the project by "Configure Claude" |

There is no OpenAI catalog.

Image prices are a separate "maximum per image" plus a "price checked" date per project (`imageGeneration`).

### Models and routing

- `verifiedModels`: an allowlist per project or profile, entered as comma-separated text.
- OpenAI tiers `fast`/`standard`/`quality`/`escalation` and Claude tiers `fast`/`standard`/`quality`.
- `defaultProvider`.
- 10 task routes (model, effort, max tokens).
- A model registry (provider, display name, capabilities).

All of these exist per project and per profile.

### Budgets: 7 layers

| # | Layer | Scope | Period | Where |
|---|---|---|---|---|
| 1 | Spending authority: per day / month / run, window, "paid use allowed" | project | UTC day, calendar month | KI & Budget |
| 2 | Module caps: Support per day, Finance per day | project × module | UTC day | Support / Finance settings |
| 3 | Assignment budget | assignment (Marketing) | calendar month | Marketing → Aufträge |
| 4 | Maximum per image | project | per call | OpenAI dialog |
| 5 | Provider budget: credit, 2 warnings, stop, anchor day, manual credit | project (inherited from profile) × provider | provider billing period | KI & Budget, one panel per provider |
| 6 | Grant budget | project grant, organization grant | calendar month | organization → connections |
| 7 | Connection budget | connection | calendar month | administration → connections |

`reserve` checks all of these in turn. The other views:
- The project page shows spend per project only.
- There is no organization-wide spend overview; only per-connection usage exists.

### Concrete problems found

- **JSON as the editing surface for prices.** One typo blocks every save ("VALIDATION FAILED" until 2026-10-25).
- **Hidden coupling.** Saving the image model failed because unused OpenAI tiers were unverified (fixed in `9f3512fe`). Each project carries a full copy of models, tiers and prices that can drift.
- **No price source for OpenAI.** Owners must look up prices themselves. Image generation needs a separately typed maximum and a "checked" tick.
- **Budgets are not explained as one system.** An owner cannot tell which of the 7 layers stopped a call. Provider budgets (layer 5) and grant budgets (layer 6) overlap in purpose.
- **New users see everything at once.** Keys, routes, prices, provider credits and spend all appear on one page, with no guided first setup.

## 2. Target picture

Principle: **the organization decides what AI exists and what it costs; a project only decides how much it may spend and, optionally, which model a task uses.**

### 2.1 Organization → "KI" (one area, org owners and administrators)

1. **Anbieter.** OpenAI and Anthropic keys as connections, as today (ADR 0014). Each gets a status and a "check" button.
2. **Modelle & Preise** (catalog). A table: model, provider, purpose (text / image / embedding), price input / output (or per image), price checked on, active yes/no.
   - Orbit ships a **dated price catalog for OpenAI and Anthropic**, image and embedding models included. It extends today's `anthropicCatalog` with an `openaiCatalog`.
   - Administrators confirm or override prices in a form, field by field. No JSON.
   - Organizations inherit the system catalog and may switch models off or override a price.
   - Prices older than N days are flagged ("bitte prüfen") but do not stop calls (**D-3**).
3. **Standard-Modelle.** One choice per purpose:
   - Text: a preset "Günstig / Ausgewogen / Beste Qualität" that maps to concrete models, or a custom choice.
   - Image model.
   - Advanced, collapsed: one model per task.

   This replaces tiers, default provider and task routes for every project that does not override them.
4. **Budget.**
   - **One monthly organization budget** (USD) with warnings at 75 % and 90 % and a hard stop.
   - An optional cap per provider ("max. USD x on Anthropic"), replacing per-project provider budgets.
   - The manually entered provider credit balance moves here (it is the organization's account, not the project's).
5. **Verbrauch.** Spend per project, provider, model and task for the current month. Reservations with unclear outcomes appear here with "settle".

### 2.2 Project → "KI & Budget" (project owners)

1. **Status.** Text / Knowledge search / Images, each with one sentence on what is missing and a button that leads there.
2. **Budget.** A monthly amount the project may spend, as one number with presets (Aus / 10 / 50 / Eigener Betrag). It is drawn from the organization budget.
   - Daily limit and per-run limit are derived automatically, for example day = month / 10 and run = min(day, USD 2).
   - Both can be overridden under "Erweitert" (**D-4**).
   - Module caps (Support, Finance) and assignment budgets stay where they are, shown read-only with links.
3. **Modelle** (optional). "Use organization defaults" (default), or deviations per task chosen from the organization catalog.
4. **Images.** On/off, using the catalog's image price. No separate maximum, no "checked" tick.
5. **No keys, no prices, no JSON** on the project page. Project-owned keys (today: uLiquid) stay readable and usable until migrated (**D-1**).

### 2.3 Budget layers after the change

| Today | Target |
|---|---|
| 1 spending authority (day/month/run/window) | **project monthly budget**; day and run derived; the window becomes optional |
| 2 module caps | unchanged (module settings) |
| 3 assignment budget | unchanged (Marketing) |
| 4 maximum per image | from the catalog's image price; no manual entry |
| 5 provider budget per project | **organization provider cap** |
| 6 grant budgets | **project share of the organization budget** (the project monthly budget *is* the allocation) |
| 7 connection budget | kept for administrators (system connections across organizations) |

The `reserve` order stays the same: authority → module → provider → grant/organization → connection. The UI explains a refusal by naming the layer: "Projektbudget für Oktober erreicht (USD 10 von 10)".

## 3. Data model and compatibility

- **Catalog.**
  - New `AiModelPrice`, either as a table or as an extension of `AiProfile.rateCard` with metadata (**D-2**).
  - The system scope is seeded from the code catalog; the organization scope holds overrides and on/off.
  - The rate card a call uses resolves in this order:
    1. the project's own `rateCard` (legacy, kept read-only);
    2. the organization's overrides;
    3. the system catalog.
- **Defaults.** Organization-level `AiProfile` already holds routes and tiers (ADR 0014). It gets the purpose presets. Projects keep `taskRoutes` as overrides only.
- **Budgets.**
  - Organization monthly budget and provider caps go on the organization `AiProfile`, or on a new `OrganizationAiBudget` (**D-2**), enforced through the existing `SpendCounter` rows.
  - The project monthly budget is the existing `ai_spend_policies` record; day and run become derived unless set.
  - Per-project `providerBudgets` are migrated to the organization cap. When several projects differ: the sum, or the smallest stop (**D-5**).
- **Migration (scripted, dry run first, like the spend-authority backfill).**
  1. Collect every project's rate card. Prices that agree go into the organization overrides; conflicts are listed for the owner.
  2. Project task routes equal to the new organization defaults are dropped; differing ones stay as overrides.
  3. Project provider budgets become the organization provider cap.
  4. Project keys are reported. Moving them to an organization connection is a separate step with the owner (**D-1**).
- **Rollback.** Every phase sits behind a flag. The project's own fields are never deleted until a later, separately approved clean-up.

## 4. Phases

| Phase | Content | Effect for users |
|---|---|---|
| **A: price catalog** (quick win) | OpenAI and Anthropic catalog in code, image and embedding models included; admin and org "Modelle & Preise" table with forms; projects fall back to the catalog when their rate card lacks a model; the image price comes from the catalog | No more JSON; images work by switching them on; the current FamilyPlan blocker disappears |
| **B: organization defaults** | Org-level "Standard-Modelle" with presets; project page "use defaults / deviate per task"; one guided first-setup flow (key → model preset → budget) | New projects need two clicks, not ten fields |
| **C: central budget** | Org monthly budget and provider caps; project monthly budget with derived day and run limits; one explanation of every refusal; org "Verbrauch" overview with unclear outcomes | One budget to understand per level; spend visible across projects |
| **D: project page rebuild** | Status, budget, models, images; keys and prices removed from the project page (read-only notice for legacy project keys) | The project page fits on one screen |
| **E: clean-up** (separate approval) | Remove project rate cards, provider budgets and tier fields after migration and evidence | Less code, one source of truth |

Each phase:
- is its own commit series with tests (catalog resolution, budget derivation, migration dry run, access matrix);
- keeps production behaviour until its flag is set;
- gets its own deploy approval.

## 5. Tests and acceptance

- **New project with a Claude key only.** Set up text, budget and images through the guided flow without seeing JSON. A save error always names the field and the reason.
- **Prices.**
  - A project without its own rate card prices calls from the catalog.
  - A price override in the organization applies to all its projects.
  - An unpriced model still fails closed.
- **Budgets.** Refusals name the layer that stopped them, for each of: org monthly budget, provider cap, project monthly budget, derived daily limit, module cap.
- **Migration.**
  - The dry run lists merges and conflicts.
  - After `--apply`, every project resolves the same model and price for each task as before (equivalence test).
  - Rollback restores the old behaviour.
- **Production check after each phase.** uLiquid's 04:00 assignment run, FamilyPlan Support drafts and EDS-Labs Finance extraction run unchanged.

## 6. Open decisions

- **D-1 Project keys.** Allow them in future, or only organization connections (with project keys migrated by the owner)? *Recommendation:* organization connections only; existing project keys stay usable until migrated.
- **D-2 Storage.** Catalog and organization budget as fields on `AiProfile`, or as their own tables? *Recommendation:* own tables (`AiModelPrice`, `OrganizationAiBudget`). They need per-row history and per-model audit, and JSON blobs are what made editing hard.
- **D-3 Price maintenance.** Who keeps prices current, and what happens when they are old? *Recommendation:* Orbit ships dated catalog prices; administrators may override; prices older than 90 days are flagged, not blocked.
- **D-4 Day and run limits.** Derived automatically with an advanced override, or kept as visible fields? *Recommendation:* derived (day = month / 10, run = min(day, USD 2)), override under "Erweitert".
- **D-5 Provider budgets.** One organization cap per provider replacing the per-project ones? How should differing project values migrate? *Recommendation:* yes; the migration proposes the sum and the owner confirms.
- **D-6 Who manages the organization AI area.** Organization owners, administrators, or both? *Recommendation:* organization owners for their organization; administrators for the system catalog and system connections.
- **D-7 Order.** *Recommendation:* phase A first (it removes today's blocker and the JSON), then B, C, D, E.
