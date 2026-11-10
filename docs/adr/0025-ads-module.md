# ADR 0025: Ads module (paid advertising through official platform APIs)

## Status

Proposed, 2026-11-07. Mario accepted all recommendations A-D1 to A-D19 of the programme plan [`docs/superpowers/plans/2026-11-07-ads-module.md`](../superpowers/plans/2026-11-07-ads-module.md) (§3) on 2026-11-07. Steps A1 (module skeleton) and A2 (provider seam, Meta transport, money) are implemented, `ORBIT_ADS` stays off and no Meta call has been made; the ad-blocker test of A-D1 gates enabling the flag (Mario, 2026-11-09). Every developer app, App Review or verification submission, migration, flag, ad account connection and every live action that can spend money still needs its own approval.

This ADR extends [ADR 0008](0008-action-approvals.md) (addendum 2026-11-07), [ADR 0009](0009-modular-platform.md) and [ADR 0014](0014-central-connections-ai-knowledge.md). It leaves [ADR 0019](0019-agent-mandates.md) unchanged: no paid-media or budget class becomes mandatable. The phase 2 decisions (ChatGPT Ads, O-D1 to O-D3) and phase 3 decisions (Google Ads, G-D1 to G-D4) of the plan are still open.

## Context

- Orbit has no paid advertising channel. Marketing imports ad statistics from CSV files into its `metrics` entities (`importAdsCsv`, `import-metrics`); `docs/CONNECTOR_CAPABILITIES.md` and `docs/AUTONOMY_POLICY.md` assert no paid-account control adapter. The product baseline allows paid-ads write adapters only for providers that actually exist (`docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md` §7) and requires deterministic figures with separated sources (§3.7).
- Official APIs exist (plan §2.6, read 2026-11-07): Meta Marketing API v27.0, OpenAI's Advertiser API for ads in ChatGPT, Google Ads API v26 (developer tokens sunset on 2026-09-09).
- ADR 0008 makes paid media creation (F1) and budget changes (F2) hard floors, budget changes `ui_only` and ad campaign creation `approval_required_reauth`; neither mode is implemented. `plans/orbit-modularization/09-mcp-gateway.md` §6.1 keeps F1/F2 off MCP entirely.
- The Social module owns the only Meta app (`social.app.meta`, Pages and Instagram publishing scopes); all Meta code is private to it, and a Meta app has one data-deletion callback.
- AI spend reservations (`BudgetReservation`) and agent mandates measure AI cost in USD micros.

## Decision

1. **Own module `ads`** (opt-in, installation switch `ORBIT_ADS`, default off), `dependsOn: []`, dedicated `Ad*` tables (FORCE RLS, composite tenant keys), permissions `ads.*` (spend data sensitive, web `minAccess: "editor"`), own boundary zones. The technical id stays `ads` unless the ad-blocker test in step A0 blocks `/p/:id/ads` or `/api/projects/:id/ads/*`; then it becomes `advertising` with the display name "Ads"/"Werbung" (A-D1). DOM ids and CSS classes never contain `ad`, `ads`, `advert`, `banner` or `sponsor`. Marketing reaches the module only through `modules/ads/contract.ts` (declared dependency); Ads imports neither Marketing nor Social.
2. **Ads Core and provider adapters.** The core owns the domain model, change and approval state machines, internal guardrails, sync and metrics; adapters call the official APIs over HTTPS through `boundedFetch` (no SDK, no client library, no intermediary). Rows keep normalized columns plus a versioned, zod-validated `providerSpec`; types an adapter cannot represent faithfully import read-only. Meta first, OpenAI after gate O0, Google after gate G0. Meta's hosted Ads MCP server and Google's read-only Ads MCP server are not an execution path.
3. **Meta connection** (A-D2, A-D3, A-D17, A-D19). An own Meta app (Business type, Marketing API product) as system connection `ads.app.meta` with its own Facebook Login for Business configuration, OAuth callback `/api/ads/oauth/callback/meta` and data-deletion callback `/api/callbacks/ads/meta-data-deletion`; Social's app and flow stay untouched. Ad accounts are module-managed project connections `ads.account.meta`. Business-integration system-user tokens once the app qualifies as a tech provider; until then long-lived user tokens with stored expiry, a warning 14 days ahead and `reconnect_required` at expiry. Phase 1 serves businesses where the app's people have roles (Standard Access, tier Limited); other businesses follow after App Review, Business Verification and the Full tier, each Mario's decision. Ads pins its own `META_ADS_API_VERSION` (v27.0 at A2 start), separate from Social's Graph version, with an upgrade task per Meta release.
4. **Drafts live in Orbit** (A-D4). Validation runs locally and with the platform's validate-only option; objects are created at the platform only at launch, all paused, and activation is the last, separately guarded step.
5. **Exactly-once changes.** Every cost-relevant action is an `AdChange` with expected current values (`before`) and absolute target values (`after`). The executor claims it with a fence, reads the live values first (a mismatch makes it `stale`), writes outside transactions, never repeats a write whose outcome is unknown (read-back, then owner settlement) and respects the platform's change limits.
6. **Approvals** (A-D5, A-D6, A-D7). Launch and activation are F1; budget, bid, run-time and spend-cap increases, cost-increasing optimization bundles and raising the internal limit are F2. Only an owner decides them, only in the Orbit web UI, with a session authenticated within the last 15 minutes; they are never mandatable and never a direct effect of an MCP or chat call, but they may be proposed over MCP, chat and agents (ADR 0008 addendum 2026-11-07). Cost-neutral and cost-reducing changes (pause, budget down, earlier end) are direct for members with `ads.manage`; changes to the content or targeting of a running ad are W2 and decided by the owner. An owner's own action in the web UI, with its confirm dialog and recent authentication, is its approval. Ads action types set `requires: []` and carry ad amounts with their currency in their own payload, never in `costCeilingMicros`.
7. **Two kinds of limits** (A-D8, A-D9). An internal Orbit guardrail per project and currency (`AdBudgetPolicy`) checks Orbit-initiated changes and watches actual spend: warnings at 50/80/100 %, a pause proposal at 100 %, automatic pausing only as an owner opt-in. Platform limits are read and shown; Orbit never changes the ad account spending limit on its own, and raising it is an explicit owner F2 action. UI, API, tools and docs always say which limit is meant. Ad spend never uses the AI `BudgetReservation` or AI budgets.
8. **Money** (A-D10). BigInt micros plus ISO currency; Meta minor units (and the account spending limit written in major units) are converted exactly; Finance's money helpers move to an internal `packages/money`.
9. **Agents** (A-D11). No new Ads specialist. The module ships deterministic findings; Orbit Chat, the personal assistant and configured agents get its tools through feature `ads`; Marketing specialists get performance reads and draft proposals through the contract. AI cost stays AI cost.
10. **Creatives** (A-D12). A private ads media library (upload, Google Drive) plus Marketing's push into the contract (`importOriginCreative`) with a re-check of the Marketing source's rights.
11. **Measurement and history** (A-D13, A-D14). Conversions from platform insights for the action types the owner maps, a UTM template, no pixel or Conversions API management in the MVP (later with a privacy review and approval). Backfill 90 days by default, daily insights kept 25 months, change attempts 13 months, intraday spend snapshots 35 days.
12. **Compliance** (A-D15, A-D16). The special ad category is always declared (default `NONE`); housing, employment, credit, financial products and services, online gambling and gaming, and social issues, elections and politics are import and report only in the MVP. EU-targeted ad sets need the per-account settings `dsaBeneficiary` and `dsaPayor`.
13. **MVP objectives** (A-D18): traffic, awareness and engagement; leads and sales only with a website conversion event of an existing pixel or dataset; no instant forms; app promotion later.
14. **One scheduler.** All sync, insights, spend watch and change execution run on the Orbit outbox and `workDueAt` pump with bounded continuation jobs; no BullMQ repeatable or delayed jobs.

## Alternatives

- **Extend Marketing:** breaks independent activation and couples paid spend to Marketing's agent runtime.
- **Reuse Social's Meta app** (same app with a second configuration, or a platform-level Meta app with module fan-out for data deletion): couples App Review and secrets to the live Social flow, or needs a large Social refactor; kept as a later option.
- **Meta Business SDK, Google Ads client libraries:** large dependencies for a small set of documented REST endpoints.
- **Hosted ads MCP servers or intermediaries (n8n, Postiz, agency tools):** bypass Orbit's tenancy, approvals, guardrails and change log; ruled out by the request.
- **Drafts pushed to the platform as paused objects at once:** external writes and drift for every draft edit.
- **Ads objects as `Entity` kinds:** no unique keys or relational metric queries (ADR 0009 rule for relational modules).
- **AI budget reservation for ad spend:** mixes AI and ad budgets.
- **No F1/F2 over MCP:** agents could only describe changes in prose; a proposal changes nothing on its own.

## Consequences

- Five migrations (`ads_core`, `ads_objects`, `ads_insights`, `ads_budgets`, `ads_changes`), each with its own approved production schema hash; the RLS and access matrices, module lists, queue lists and the five MCP scope places grow.
- Platform additions in later steps: a recent-authentication check and a web-only decision channel for F1/F2 decisions, a "paid media" presentation in the Decisions inbox, `packages/money`.
- ADR 0008 and `09-mcp-gateway.md` §6.1 change for F1/F2 proposals (addendum 2026-11-07).
- A second Meta app with its own App Review and data-deletion callback; Marketing API upgrades about every four months.
- External gates decide go-live independently of the code: Meta App Review, Business Verification and the Full tier; OpenAI account verification and API keys; Google Cloud project access level and a verified production consent screen.
- `docs/CONNECTOR_CAPABILITIES.md` and `docs/AUTONOMY_POLICY.md` change only after a live-verified adapter (step A12).
