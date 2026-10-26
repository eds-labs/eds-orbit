# FamilyPlan end-to-end test (P4): plan

Status: **plan, 2026-10-26. Nothing has run yet.** Read live (read-only) in Orbit production; project `118371ad-5f28-4397-9cef-877cbb1ffbe1`.

Rules: no automatic publishing (delivery `postiz_draft` only), no access to real family or child data, no paid marketing, every paid step within the project's AI budget and recorded.

## 1. Starting point

| Item | State |
|---|---|
| Knowledge | 18 verified facts, index generation 3 active (check passed 97/100) |
| Marketing profile | Version 4: four official links, brand colours, approved logo `004c5c80` |
| Assets | Logo and app icon approved (PNG) |
| Channels | Postiz Facebook „FamilyPlan" and Instagram „FamilyPlan", read verified; drafts need no write verification |
| Policy | Active, mode `assisted`, both channels |
| AI budget | Spent 1.22 USD this month, 0.45 USD reserved; limits 5 USD per day and 50 USD per month (central spend policy). The older marketing policy shows 10 USD per month (the known budget display duplication) |
| Assignments | None |
| Text routes | Claude: `draft_social` Sonnet 5.5 1,800 tokens, `agent_review` Opus 5.5 1,800, `agent_strategy` Sonnet 3,000, `agent_analytics` Sonnet 1,800, `agent_research` Sonnet 12,000, `chat_operator` Sonnet 3,000; no effort set |
| Images | `gpt-image-2.5-flare`, at most 0.25 USD per image |

## 2. Blockers found before the test

1. **Output limits too small for Claude 5.5.** Claude Sonnet and Opus 5.5 always think, and thinking counts against `max_tokens` (Sonnet's default effort is `high`). With 1,800 tokens a draft, an analysis or a review often ends cut off. The specialists then fail with `AGENT_OUTPUT_INVALID` (cut-off JSON), the same root cause as P0, now in the marketing pipeline.
2. **Specialist calls to Claude do not stream and time out after 60 seconds** (`packages/ai/src/index.ts` `respond` → `anthropicComplete`). A long answer, for example `agent_research` with 12,000 tokens, can exceed that: the call ends with an unclear outcome and its cost stays unknown. A cut-off answer (`stop_reason: max_tokens`) is also not recognised as such; it surfaces only as invalid JSON.

**Proposed fixes before the test**
- a) Configuration (Settings → AI, owner): `draft_social` 5,000 tokens, effort `medium`; `agent_review` 5,000, `medium`; `agent_strategy` 6,000, `medium`; `agent_analytics` 4,000, `low`; `agent_research` 6,000, `medium`; `chat_operator` 12,000, `medium`. Reservations grow (billing stays on actual use).
- b) Code (small, with tests; deploy approval): Claude specialist calls stream internally (`messages.stream` + `finalMessage`), so the timeout no longer limits a long answer; `max_tokens` is reported as `AGENT_OUTPUT_LIMIT` with its cost settled, instead of `AGENT_OUTPUT_INVALID`.

Without a) the test is likely to fail at the first drafts; b) protects against unclear outcomes and makes failures readable.

## 3. Part 1: real knowledge questions

Run through the knowledge search (`retrieve`, Knowledge → search, internal purpose, language `de`). Cost: query embeddings, well under 1 cent. For each question, record the top sources and whether facts or documents answer it.

| # | Question | Expected source |
|---|---|---|
| 1 | Was kostet FamilyPlan Premium? | „Preise, Abonnements und Berechtigungen" (3,99 € / 39,99 €); no verified price fact exists (see 5) |
| 2 | Welche Funktionen sind in FamilyPlan Free enthalten? | Fact `plans.free_features`, document 06 |
| 3 | Was bietet Premium zusätzlich? | Fact `plans.premium_features` |
| 4 | Gibt es einen kostenlosen Testmonat? | Fact `5a60fe5a` |
| 5 | Ist FamilyPlan für Android verfügbar? | Facts `30bc87e4`, `83d45886` (closed test, not released) |
| 6 | Gibt es eine Web-Version? | Fact `93ec8e46` (public beta) |
| 7 | Speichert der KI-Assistent Änderungen automatisch? | Fact `fd32c88d` (no; an adult reviews) |
| 8 | Ist die Standortfreigabe freiwillig? | Fact `6fcf6145`, document 05 |
| 9 | Für wen ist FamilyPlan gedacht? | Fact `956fc1ef`, document 01 |
| 10 | Ist Zero Data Retention mit OpenAI vereinbart? | Documents 04/05: not confirmed; must not be promised |
| 11 | Darf Orbit Daten echter Familienkonten lesen? | Document 10, safety boundary: no |
| 12 | Kostet Premium 4,99 €? | Documents 06/09: historical draft, not valid |
| 13 | Ist das Marketingprofil in Orbit hinterlegt? | Document 10 version 3 (yes); version 2 must not be found |

Pass: every question finds its expected source among the first five results; 12 does not present 4,99 € as current; 13 finds the new version.

## 4. Part 2: seven-day campaign as Postiz drafts

Through the Orbit chat: ask the Orbit Assistant to propose an assignment and confirm its card (the card shows the exact content and budget).

- Name: „FamilyPlan Testwoche"; kind `standing`, schedule daily 18:00 Europe/Berlin, lead time 6 hours.
- Content: `social`, channels Facebook and Instagram, one shared text and image per slot (`sharedAcrossChannels`).
- Topic frame: one feature per day from the verified facts (calendar and tasks, lists and meals, budget, rewards, location sharing with consent, assistant with adult review, platforms: iOS, web beta, Android test). No prices (no verified price fact), no unverified claims, no real family data, no children's faces.
- Format: 400–900 characters, 2–3 hashtags, link to the official website.
- Image: brand banner (16:9) with the approved logo.
- Delivery `postiz_draft`; approval `human_each` (each post waits for your release in Approvals).
- Assignment budget: 6 USD per month.
- Stop after seven runs (pause the assignment on day 8).

Each run: analytics → research → strategy → copy → visual → agent review (product facts, Premium features, privacy, brand quality) → your release → draft in Postiz. Publishing stays with you in Postiz.

**Test separately:** one release and one rejection in Approvals; the Postiz draft lands on both channels with text and image; nothing is published.

## 5. Findings to note

- No verified price fact exists: Marketing cannot state prices (K-1). If prices should appear in posts, verify `pricing.premium_monthly` = „3,99 €" and `pricing.premium_yearly` = „39,99 €" from the website first.
- 0.45 USD are reserved without settlement (probably the unclear outcomes of the two work orders from 25.10). Settle them under Settings → AI → "settle unclear reservations" after a look at the provider's usage.

## 6. Recording

Per day: agent run id, spans per specialist (model, input/output/reasoning tokens, cost, status, error code), review verdict and reasons, release decision, Postiz draft id. Daily total against the 6 USD assignment budget. A summary after day 7.

## 7. Cost estimate

- Part 1: under 0.01 USD.
- Part 2 per day: about 0.30–0.80 USD of text (Sonnet/Opus) plus at most 0.25 USD for the banner. Seven days: about 2–7.50 USD, capped by the 6 USD assignment budget (a run that would exceed it stops). Within the 50 USD monthly limit.

## 8. Decisions for Mario

1. Route configuration a): set it as proposed (you in Settings → AI, or I do it with your approval)?
2. Code fix b): implement and deploy before the test?
3. Add the two price facts, or keep prices out of the posts?
4. Start part 1 now (under 1 cent)?
5. Assignment as described (daily 18:00, 6 USD, `human_each`, stop after 7 days)?
