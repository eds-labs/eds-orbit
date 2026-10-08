# Orbit Agents — design

Status: draft for Mario's review (2026-10-09). Supersedes the autopilot (`autopilot.ts`) once released. Builds on the Orbit Core stack (#51–#71), the [Jarvis plan](../../plans/ORBIT_CORE_JARVIS_PLAN.md) section 3 and ADR 0005/0007/0008.

## 1. Goal

Mario talks to one agent, **Orbit Core**, in the Orbit chat. He plans and discusses with it, and it runs **assignments** on his behalf: one-off jobs and standing jobs such as "two posts a day for X and Telegram with an image at 10:00 and 17:00", "a LinkedIn post every day" or "a blog article every Monday". For each run Orbit Core makes a work plan and hands its steps to **specialist agents** (strategy, research, analytics, copywriter, visual, review) that work in the background. Posts are published automatically after a **veto window**: Mario gets a preview with a **Stop** button from a private **Orbit Telegram bot** and only acts if he wants to stop a post.

Success means the daily job Mario runs in ChatGPT today (two posts a day with text and image, handed to Postiz and posted at fixed times without his involvement) runs in Orbit instead, with Orbit's facts, budgets, history and checks, and that other assignments can run beside it.

## 2. Decisions (Mario, 2026-10-09)

| #   | Question                     | Decision                                                                                                                                                    |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which specialist roles       | Strategy, research, analytics, copywriter, visual, review. Specialists are Orbit's staff and not part of the normal UI.                                     |
| D2  | Approval before agents act   | Orbit works autonomously within a budget; it asks only for publishing (handled by D3) or when the budget is exceeded.                                       |
| D3  | Publishing safety net        | Automatic with a veto window: posts are scheduled, Mario sees a preview ahead of the slot and can stop each one; no action means the post is published.     |
| D4  | Channel for preview and stop | A private Orbit Telegram bot (new external provider, Telegram Bot API; approved with this choice).                                                          |
| D5  | Existing autopilot           | Replaced by standing assignments; one planner only.                                                                                                         |
| D6  | Research                     | Allowed to search the web (OpenAI web search). Findings are always unverified and never facts.                                                              |
| D7  | Budget                       | 50 USD per month for uLiquid, editable in the settings.                                                                                                     |
| D8  | Runtime                      | Approach C: Orbit's own agent layer on the existing `AgentRuntime` port (#65); single specialists can move to the OpenAI Agents SDK later if it adds value. |
| D9  | Several assignments          | Any number of assignments per project, each with its own channels, rhythm, content type and budget.                                                         |
| D10 | Awareness of past posts      | Orbit reads what was already posted on the channels (also posts not made by Orbit) to avoid repetition.                                                     |
| D11 | Banner style                 | Generated images follow the look of existing banners.                                                                                                       |

Voice (J4), chatting with Orbit Core through Telegram, direct blog publishing and the X API are out of scope (section 12).

## 3. Terms

- **Orbit Core**: the only conversational agent (today's chat operator, `chat_operator` route). It plans, discusses, creates and changes assignments, starts runs and reports.
- **Assignment** (`Entity(kind="assignments")`): what Orbit pursues for Mario. Fields: name, `kind` (`one_off` | `standing`), schedule (rhythm, days, local times, preparation lead), content type (`social` | `blog` | `newsletter` | `report`), channels, topic frame, tone, image yes/no, style references (asset IDs), veto window (minutes), monthly budget, status (`draft` | `active` | `paused` | `budget_exhausted` | `ended`), version, owner confirmation (user, time, assignment hash, image-rights consent).
- **Run** (`Entity(kind="assignment_runs")`): one due execution of an assignment for a date, with its work plan, state, cost and result. Idempotency key `assignment:<id>:<date>`.
- **Work plan**: ordered steps of a run. Each step names a specialist, its input references, a cost ceiling and its state.
- **Agent task** (`Entity(kind="agent_tasks")`): one specialist step, executed by the worker as one `AgentRun` with spans (visible under Operations → AI runs).

Content packages (#51 onward) stay as they are for quick chat requests. A one-off assignment (`rhythm: once`) runs through the same run pipeline as standing assignments, so strategy, review and the veto window apply to it too.

## 4. Architecture

```text
Mario ── Orbit chat (text, later voice)        Orbit Telegram bot (preview, Stop, reports, /pause)
              │                                              │  webhook (secret)
        Orbit Core (chat turn, AgentRuntime port)            │
              │ tools: assignment_* , run_*, status, history │
              ▼                                              ▼
   assignments ── scheduler (worker sweep) ── assignment_runs ── veto/publication service
                                 │ work plan
                                 ▼
          agent_tasks ── worker queue "agent" ── specialist runner (AgentRuntime port)
            strategy · research(web search) · analytics · copywriter · visual · review
                                 │
   existing services: knowledge/retrieval, facts, generation (claims ledger, placeholders),
   image generation, claim/policy/preflight checks, budget journal, telemetry, publishIntent,
   Postiz client (create/list/analytics), reconciliation
```

- One queue topic `agent` runs agent tasks; one task is one specialist invocation with a bounded loop (max model calls, max tool calls, cost ceiling, timeout).
- The specialist runner reuses the `AgentRuntime` port and the legacy Responses adapter (`agents/runtime`), the budgeted model (reserve → transmit → settle, `outcome_unknown` on crash, no replay) and the tool registry with per-role tool sets.
- Orbit Core never waits inside a chat turn for specialists. It starts runs and reads their state; results reach the chat as cards and messages when they finish (same pattern as package cards today).

## 5. Specialists

Every specialist has its own instructions, a role-specific tool set, a structured output schema (strict JSON) and limits. Model routes per role are owner-editable in the OpenAI configuration (new task classes `agent_strategy`, `agent_research`, `agent_analytics`, `agent_review`; copy keeps `draft_social`/`draft_blog`, visual keeps the image route).

| Specialist | Input                                                                                  | Tools                                                                                                                                           | Output                                                                                             |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Analytics  | assignment, period                                                                     | Matomo metrics, Postiz analytics per post and channel (`getPostAnalytics`, `getIntegrationAnalytics`), post history, deterministic calculations | findings with numbers and freshness; explicit `no_data` when nothing is measured (JC19)            |
| Research   | topic frame, assignment                                                                | OpenAI hosted `web_search` (Responses API), knowledge search                                                                                    | findings `{claim, sourceUrl, sourceTitle, observedAt}` marked `unverified`; never written to facts |
| Strategy   | assignment, analytics and research output, channel history (section 7), verified facts | read-only: history, facts, knowledge                                                                                                            | one brief per deliverable: topic, angle, fact keys, CTA, image idea, why it is not a repeat        |
| Copywriter | brief, channel rules, evidence                                                         | existing `generate` with claims ledger and fact placeholders; sees the other channels' drafts (#64) and recent channel posts (#60)              | draft per channel                                                                                  |
| Visual     | image idea, style references (section 8), brand profile                                | existing image generation; reference images                                                                                                     | one image per run, reusable across channels                                                        |
| Review     | drafts, image, facts, brand profile, deterministic check results                       | deterministic checks (`checkClaims`, preflight, duplicate and channel checks) + its own critique                                                | `approve` \| `revise` (one round, with instructions to the copywriter) \| `reject` (reason)        |

Limits per task (defaults, configurable per route): 4 model calls, 6 tool calls, 3 web searches, cost ceiling from the work plan, 120 s wall time. A task that exceeds a limit fails with a named code; the run continues without that deliverable.

## 6. Review authority

- Deterministic blockers stay absolute: wrong or stale facts, unsupported claims, forbidden statements (profit or return promises, investment advice), disallowed links, channel limits, duplicates, quota and spacing, calendar blocks, policy window. The review agent cannot clear them.
- Today free marketing text needs `humanReviewedBodyHash` (owner review). New: inside a **confirmed, active assignment** the review agent's `approve` records `agentReviewedBodyHash` with the review task ID, the assignment version and the deterministic check result. Preflight accepts it in place of the owner review only if all of these hold: the assignment is active and its confirmation covers the content type and channel; the project has a connected Telegram bot; the publication carries a veto deadline that has passed without a stop; the body hash still matches.
- Without a connected bot, assignment posts wait for owner approval on the approvals page as today.
- A review `reject` or a second failed round drops the deliverable and notifies Mario.
- Image rights: confirming an assignment with images includes one consent that generated images for this assignment may be used (no logos, no real persons, no text in the image). Generated assets of the assignment are marked approved with that consent reference.

A review evaluation set (good drafts and deliberately bad ones: wrong number, profit promise, off-brand tone, disallowed link) must pass before the review agent may approve live (section 11).

## 7. Channel history ("what was already posted")

- Source: the Postiz post list (`listPosts`) for the assigned channels, which includes posts not made by Orbit (for example Mario's ChatGPT job). The client's `remoteSchema` is extended to read the post text and media (field names verified against the Postiz API during implementation).
- A sync job stores normalized `channel_posts` (channel, remote ID, published at, text, media URLs, source `orbit` | `external`) for the last 60 days, refreshed before each run and at most hourly.
- Strategy, copywriter (`recentChannelPosts`) and the duplicate check use it, so repetition is avoided across Orbit and external posts.
- X itself is not scraped and the X API is not used (cost and terms); Postiz is the source of truth for what was posted through it.

Verified (2026-10-09): Postiz `GET /posts` (public API docs and the open-source `getPosts` select) returns per post `id`, `content` (string, may contain HTML and must be stripped to plain text), `settings`, `publishDate`, `releaseURL`, `releaseId`, `state` (`QUEUE`, `PUBLISHED`, `ERROR`, `DRAFT`), `error` and `integration` (`id`, `providerIdentifier`, `name`, `picture`), but no media field: the `image` column is not selected. Orbit's `remoteSchema` therefore only needs an added `content` field (plus optional `settings`), and `channel_posts` stores text only; `media URLs` are filled solely for posts Orbit itself created (from Orbit's own records), and external posts have none. Postiz applies a public API limit of 30 requests per hour, so the sync must use one date-range call per run, cached for at least the hourly interval above. The field names are re-checked against the live API in plan task 6.

## 8. Banner style

- Each assignment can name **style references**: approved assets (uploaded banners or images from past posts, imported from `channel_posts` media with Mario's confirmation).
- The visual specialist writes a structured image brief that cites the references, and image generation is called with the reference images as input (image edit/reference mode of the configured image model), plus fixed constraints: no text, no logos, no identifiable persons; the logo and any text are composed afterwards by the existing raster template when the assignment asks for it.
- Whether the configured image model accepts reference images through Orbit's current API path is verified first (plan task 1 spike); if not, the fallback is a written style description derived once from the references by a model and stored on the assignment.

Verified (2026-10-09): the pinned `openai` 7.25.0 types document `images.edit` for `gpt-image-2.5-flare` with `image: Uploadable | Uploadable[]` (up to 16 `png`, `webp` or `jpg` files, each under 50 MB), `prompt` (up to 32000 characters), and the same `size`, `quality`, `background`, `output_format` and `n` parameters as `images.generate`. `input_fidelity` is ignored only for `gpt-image-2` and `gpt-image-2-2026-04-21`, not for the flare model. Mechanism chosen: a new `generateImageWithReferences` next to `generateImage` in `packages/ai/src/index.ts` calls `api.images.edit` with the references wrapped by the SDK's own `toFile` helper, reusing the same reservation, price limit, verified-model check and PNG output validation, with no new dependency. This is verified from the types only, because no paid call was made; the first live call happens in the paid, budgeted eval, and if the API rejects references for the model the fallback in the bullet above applies. Because Postiz returns no media (section 7), style references are uploaded banners or Orbit-generated assets, not images imported from `channel_posts`.

## 9. Scheduling, veto window and publication

- Runs start at the assignment's preparation time (default 6 h before the first slot of the day; weekly assignments the day before).
- Slots follow the existing posting times, daily quota and spacing across all assignments; a taken slot moves to the next free slot that day or the deliverable is dropped with a notice — never two posts for one slot.
- After review approval the deliverable gets a publication (`intent_created`) with `vetoDeadline = slot − vetoWindow` (default 180 min), and the Telegram bot sends the preview right away. If a run finishes later than `slot − vetoWindow`, the slot moves to the next free one so Mario always has the full window.
- Stop (Telegram or Orbit) before handoff withdraws the publication (`canceled`, reason `VETOED`) using the existing withdraw path; after handoff the bot says the post can only be removed in Postiz.
- Handoff, preflight, reconciliation and error handling stay the existing publisher path.

## 10. Telegram bot

- Setup: Mario creates a bot with @BotFather and enters its token in Settings → Connections → Telegram; it is stored encrypted with `CREDENTIAL_KEY` and never shown again. Orbit shows a one-time link code (10 min); `/start <code>` binds the Telegram chat to Mario's owner account and project.
- Orbit registers a webhook `POST /api/telegram/<connectionId>` with Telegram's `secret_token`; every update is checked against the secret and the bound chat ID; other chats are ignored and audited.
- Messages: preview per post (channel, slot, text, image, buttons Stop / Open in Orbit), notices (rejected, budget paused, Postiz error, project paused), daily report (published, stopped, rejected, cost today and this month, hints such as facts that expire soon). `/pause` pauses the project after an inline confirmation; resuming only in Orbit.
- Callback data carries a signed short token bound to the publication and version; repeated clicks are idempotent.
- Fallback: the approvals page lists upcoming assignment posts with Stop; the veto deadline applies regardless of Telegram delivery. A delivery failure is shown in Orbit and retried with backoff; it never extends publishing rights.

## 11. Guardrails, errors and tests

Hard rules: only verified facts in content; deterministic blockers absolute; no automatic publishing without a confirmed assignment, active policy, passed veto deadline and connected bot; budgets per call, task, run, assignment and project (50 USD/month for uLiquid, editable) are hard and an exhausted assignment pauses itself; no blind retry of a paid call; quota, spacing and calendar blocks across assignments; project pause stops everything; every automatic approval is audited with assignment version, review task, check result and veto deadline.

Errors: a failed task retries once only when no paid request was transmitted; an unclear paid call is `outcome_unknown`; a dropped deliverable never blocks the others; budget exhaustion, review rejection, missing facts, Postiz errors and Telegram delivery failures are reported in Orbit and through the bot.

Tests (offline, recorded model outputs, no paid calls): per specialist (tools, schema, limits); run flow (plan → tasks → review → schedule) including crash and restart mid-run, budget end, review reject, slot conflicts across assignments and stop within the window; Telegram webhook (wrong secret, foreign chat, double click, stop after handoff); preflight with agent review (all conditions, each missing one blocks); channel history sync; migration from autopilot settings. Review evaluation set run once against the live model with Mario's cost approval before live approval is enabled.

## 12. Out of scope

Voice (J4) and Realtime; chatting with Orbit Core through Telegram; direct blog or newsletter publishing (drafts go to Drive until a blog target exists); the X API or scraping X; moving specialists to the OpenAI Agents SDK (possible later per specialist through the port).

## 13. Rollout

New flag `ORBIT_AGENTS` (off by default; passed through `docker-compose.yml`). Delivery in small PRs, flag off: (1) assignments, runs and Orbit Core tools, Assignments page; (2) agent task runner and strategy, analytics, research with web search, channel history; (3) copywriter and visual in the run, style references, review agent with evaluation set; (4) veto window and Telegram bot; (5) autopilot replacement with migration of its settings, daily report, docs. Then one joint test round: a test assignment without publishing, then Mario's two daily posts with the veto window. Mario provides the bot token, connects LinkedIn in Postiz if wanted, and switches the flag in Coolify.

## 14. Risks and open points

- Review agent quality: mitigated by deterministic blockers, the evaluation set, the veto window and Telegram previews; Mario can lengthen the window.
- Image references may not be supported by the current image path (section 8 fallback).
- Postiz post text fields must be confirmed against the live API before channel history can be relied on.
- Cost estimates (0.30–1.50 USD per day for two posts) are estimates; actual spend is reported daily and capped.
