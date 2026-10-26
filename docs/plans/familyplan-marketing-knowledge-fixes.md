# FamilyPlan: marketing and knowledge errors (analysis and plan)

Status: **analysis 2026-10-26; P0 and P1 code fixes implemented locally on branch `claude/eds-orbit-familyplan-errors-dcacbc`**. Nothing here was deployed, and no production data, configuration or paid call was changed.
Basis: `main` at `699c0e54`. Production data was **not** read by Claude; statements about FamilyPlan come from the MCP findings of 2026-10-25 (task IDs, index counts) and are combined with code analysis. Points marked "inferred" were not checked against the database.

Classification under `AGENTS.md`:
- Risk: **medium**. The fixes change how an output-limited paid model call is settled and continued (budget settlement, chat runtime), and the knowledge-quality status; no schema, auth or tenancy change.
- Environment: local. Deployment and every production step below need their own approval.
- App profile: `ai-agent-app` (primary), `fullstack-saas` for budgets.
- Workflow: `bugfix`.

---

## 1. Summary

| # | Report | Confirmed? | Root cause |
|---|---|---|---|
| P0 | Work orders end with `CHAT_MODEL_OUTPUT_LIMIT` | **Yes** | Each model call of a chat turn may write at most the `chat_operator` route's `maxOutputTokens` (default **3000**). Claude Sonnet 5.5 / Opus 5.5 always think (adaptive thinking, Sonnet's default effort is `high`), and thinking tokens count against `max_tokens`. After several tool results the model thinks long and writes a report: 3000 tokens are used up, the provider stops with `max_tokens`, and the runner aborted the whole run. |
| P0 | "Even the small task" | Yes | Size of the task is not the deciding factor: the limit is **per call**, and thinking over large tool results costs more than the visible answer. A small audit that reads facts and sources still writes one long final answer. |
| P0 | Partial result, no artifact | Yes, plus two side effects | The runner kept only the last ~450 ms snapshot of the text, settled the billed call as **unknown cost** (an "unclear outcome" reservation although the provider reported the usage), and recorded no token counts in the span, so the cause was not visible. |
| P1 | Generation 2 stays `building` | **By design, but badly explained** | `building` is the state from `begin_index` until a *passed* live evaluation; it also covers "embeddings complete, waiting for evaluation". 112/112 embedded means the build is done. No job is stuck and nothing needs re-embedding. The next step is `knowledge_evaluate step=evaluate`. |
| P1 | Generation 1 active with 0 chunks | Expected | The lazily created legacy baseline (`manifestHash: "legacy-baseline"`). It stays active until a passed generation is activated. |
| P2 | Outdated / duplicate knowledge | Data issue | No code defect. Needs a curated knowledge pass (section 4). It must happen **before** the index evaluation, because each document change invalidates the generation's corpus snapshot. |
| P3 | Marketing readiness gaps | Configuration / approvals | Write verification, Matomo, image assets and links are owner steps; the budget display duplication is the central AI plan's phase D/E (`docs/plans/ai-central-management.md`). |

---

## 2. P0: `CHAT_MODEL_OUTPUT_LIMIT`

### 2.1 Where it happens

- `apps/api/src/platform/assistant/chat-runner.ts`, `budgetedModel.call`: `response.incomplete` with reason `max_output_tokens` threw `CHAT_MODEL_OUTPUT_LIMIT`; the catch block then settled the reservation with `null` (state `unknown`) and recorded an `unknown` span without usage.
- `packages/ai/src/routing.ts`: `defaultOutputTokens.chat_operator = 3000`; an explicit task route overrides it (schema range 256–16000).
- `packages/ai/src/providers/anthropic.ts`: `max_tokens: route.maxOutputTokens`; no `thinking` parameter, so Claude 5.5 models run adaptive thinking. Stop reasons `max_tokens` and `model_context_window_exceeded` become `max_output_tokens`.
- `apps/api/src/platform/agents/runtime/legacy-responses.ts`: the tool loop had no notion of a cut-off step.
- `apps/api/src/platform/tasks/tasks.ts`: `orbit_get_task_result` returns `run.partialText` cut to 4000 characters, while a turn may write 8000.

### 2.2 Why delegated work orders hit it first

Work orders run `orbit_operator` with every offered module operation (128 KB input budget, up to 8 model calls and 16 tool calls). An audit reads several tool results, so later calls carry a large context; thinking over it plus a structured German report exceed 3000 output tokens. The in-app chat answers shorter questions and rarely gets there.

Inferred, not checked in the database: FamilyPlan's `chat_operator` route is `claude-sonnet-5-5` with 3000 max tokens and no effort (the Claude suggestion, `docs/plans/ai-central-management.md`). The fixed spans now record input, output and reasoning tokens of a cut-off call, so the next run shows the split.

### 2.3 Fix (implemented)

1. **Continue instead of abort.** A call cut off by the output limit is settled with the usage the provider reported, recorded as a `failed` span with tokens and cost, and returned as a *truncated* step: its visible text plus an Orbit note asking the model to continue where it stopped (and to repeat a cut-off tool call with shorter arguments). The runtime then makes the next call within the existing limits. At most **2** continuations per turn, and only while a model call remains. Other incomplete reasons (content filter) still stop the run, now with settled cost.
2. **Nothing is lost on a real limit.** When the run still ends blocked, `partialText` is written with the full text of the turn (not the last snapshot), and `orbit_get_task_result` returns up to the turn's full output limit.
3. **Visible cause.** The span of a cut-off call carries `outputTokens` and `reasoningTokens`, so "thinking used the budget" and "the answer was too long" can be told apart.

Not changed: the delegated cost ceiling formula, the 8/16 call limits, approvals, or route defaults.

### 2.4 Configuration recommendation (owner decision, not done)

In FamilyPlan → Settings → AI, `chat_operator` route: **max tokens 12000** and **effort `medium`**. Billing stays on actual usage; only the reservation per call and the approved work-order ceiling grow (with Sonnet 5.5 about 0.18 USD per call reservation, about 1.50 USD maximum per work order instead of about 0.75 USD). Existing pending start approvals are then refused with `COST_CEILING_CHANGED` and need a new work order.

### 2.5 Recommendation for large tasks

Keep one work order per deliverable: "audit facts" and "write the knowledge document" as separate orders. The second can propose `knowledge_add_document` with the report text, which persists it as a versioned document after approval.

### 2.6 Tests

- Runtime contract (`apps/api/src/platform/agents/runtime/contract.ts`): a truncated step is fed back and the turn continues; a truncated last step fails with `CHAT_MODEL_OUTPUT_LIMIT`.
- Chat runner integration (`apps/api/tests/chat-runner.integration.test.ts`): a cut-off call followed by a completed call succeeds with the joined text and two settled reservations; repeated cut-offs stop after two continuations with settled cost and the full partial text; the span records tokens.

---

## 3. P1: index generation lifecycle

### 3.1 States (`packages/knowledge/src/indexes.ts`)

`begin_index` → `building` (corpus snapshot in `manifest`, `manifestHash`) → `build_index` jobs embed 32 chunks per job until every manifest chunk has a vector (`apps/api/src/platform/knowledge/reindex.ts`, the job chain stops by itself) → `evaluate` (paid query embeddings, 32 per job) → `evaluated` only if recall@10 ≥ 0.9 with ≥ 48 positive and ≥ 12 negative cases and no forbidden hit, otherwise it stays `building` with the failed record → `activate` (owner) retires the previous active generation.

FamilyPlan generation 2 (112/112 embedded, no evaluation) is between "build complete" and "evaluate". Restart: nothing to restart; a repeated `build_index` finds no missing chunk and makes no paid call.

### 3.2 Fix (implemented)

- `knowledge_evaluation_get` and `GET /indexes` report a derived **phase** per generation: `embedding`, `ready_for_evaluation`, `evaluation_failed`, `evaluated`, `active`, `retired`, `corpus_changed`, plus the next step. `corpus_changed` means the knowledge changed after `begin_index`; the generation can no longer be evaluated and a new one must be begun.
- The evaluate proposal checks before approval that every expected and forbidden chunk id of the dataset is in the generation's corpus and names the missing ids (before, an unknown expected id failed only after approval; an unknown forbidden id made a negative case pass without testing anything).
- Index settings in the web app show embedded/total chunks and the phase instead of the bare state.

### 3.3 Live evaluation (prepared, not run)

Dataset `evals/knowledge/familyplan-knowledge-2026-10-24.v1.json` (70 cases: 56 positive, 14 negative, German corpus, `purpose: internal`) was labeled on 2026-10-24 from the 96 chunks of the curated source `7179fa92-…`. Generation 2 has 112 chunks, so it contains at least one further document. Order:

1. Do the P2 document changes first (each one changes the corpus).
2. `begin_index` (free) → `build_index` (paid embeddings, well under 0.01 USD for ~112 chunks).
3. `knowledge_evaluation_get`; if a dataset id is missing (the proposal now names it), relabel the affected cases as a new dataset version.
4. `knowledge_evaluate step=evaluate` with the dataset (paid query embeddings, well under 0.01 USD), then `activate` only if passed.

Each paid step is its own owner approval.

---

## 4. P2: knowledge clean-up (owner work, no code)

Use the existing tools (`knowledge_facts`, `knowledge_withdraw_fact`, `knowledge_verify_fact`, `knowledge_add_document` with the same `externalId` for a versioned update); no second knowledge store.

1. **Historical documents.** Give "Integration von FamilyPlan in EDS Orbit" (20.10.2026) a new version whose first line marks it historical, and set its validity end (`validUntil`) to 2026-10-25, so retrieval no longer selects it for current questions. The same for the GitHub README with the old Free/Premium matrix.
2. **Current state document.** One versioned document "FamilyPlan in Orbit — Stand 2026-10-25" with: marketing profile v3 (four official links), 18 verified facts, Drive connected (read verified), Facebook/Instagram in Postiz read verified, publishing not write verified, Matomo not configured, plan matrix from the Supabase check (Free: dashboard, today, calendar, tasks, lists, meals, recipes, budget; Family Premium: all Free features plus chat, school, rewards, locations, assistant).
3. **Facts.** List the 18 verified facts; withdraw the exact duplicate product description (version-bound withdrawal invalidates dependent content), merge the similar assistant facts into one, and verify a plan-matrix fact from the Supabase check. No withdrawal without Mario's review of the list.
4. **Planning vs. facts.** Strategy and roadmap content stays in documents (internal, `purpose: internal`), not in verified facts. Marketing and Support agents already prefer verified facts and active, valid, model-usable sources; marking historical documents expired is what makes them prefer the new state.
5. **Coordination.** Do 1–3 in one session, then begin a fresh index generation (section 3.3). Fact changes do not touch the index corpus; document changes do.

---

## 5. P3: marketing readiness

| Item | State | Next step | Who |
|---|---|---|---|
| `PUBLISHER_WRITE_VERIFICATION_REQUIRED` / `CHANNEL_WRITE_VERIFICATION_REQUIRED` | Postiz read verified | Write verification is a real published test post per channel | Mario's explicit approval per channel |
| `MATOMO_READ_VERIFICATION_REQUIRED` | No FamilyPlan site in Matomo | Create the site, enter site id and token in Orbit, read test (`docs/MATOMO_IMPORT.md`) | Mario |
| `LIVE_RAG_EVAL_REQUIRED` | Generation 2 waits for evaluation | Section 3.3 | Mario approves each paid step |
| Approved image assets | Logos/design in Drive only | Import the logo and design files as assets and approve them | Mario (approval) |
| Project `links` empty, profile has 4 | Two separate fields: project links are project-wide (`packages/schemas/src/project-settings.ts`), profile links belong to Marketing | Copy the four links into the project links if Support and other modules should show them | Mario's decision |
| Budget values differ | Marketing policy budget vs. central AI spend policy | Covered by `docs/plans/ai-central-management.md` phases D (project page) and E (one source of truth); no parallel fix here | Planned |

Blog, newsletter and ads are not needed for the first organic social test.

## 6. P4: end-to-end test (after P0 deploy and P1/P2)

1. Retrieval: 10 real FamilyPlan questions over MCP `search`/`fetch`, check sources and that historical documents are not preferred.
2. Seven-day campaign as a work order in `draft` mode, delivery as drafts only.
3. Texts and images with the approved branding; image ceiling approval.
4. Agent review on product facts, Premium features, privacy and brand quality.
5. Drafts only; no Postiz handover without a separate human approval.
6. Postiz handover tested separately, as draft.
7. Record agent runs, spans (tokens, cost) and blockers per step.

Rules: no automatic publishing, no access to real family or child data, no paid marketing without separate approval.

## 7. Open approvals

- Deploying this branch (push to `main` deploys production).
- `chat_operator` route change (section 2.4).
- P2 data changes after Mario's review of the fact list.
- Paid index steps (build, evaluate, activate).
- Write verification posts, Matomo setup, asset approvals.
