# ADR 0020: Social module (direct publishing, Postiz replacement)

## Status

Proposed, 2026-11-02. Mario answered the decisions S-D1 to S-D9 on 2026-11-02 (recorded below). The plan is [`docs/superpowers/plans/2026-11-02-social-module.md`](../superpowers/plans/2026-11-02-social-module.md). Nothing is implemented; the dependency on `@opencoredev/social-sdk`, the developer apps, the paid X API access, every migration, flag and live post still need their own approvals.

## Context

Marketing publishes only through Postiz, a managed publishing service. Publications, Postiz drafts, approvals and connectors are rows of the generic `Entity` table; Postiz integration ids are the channel ids in policies, assignments, missions, content and grants, and the Postiz connector is part of every marketing package hash. There is no direct publishing to Telegram channels; the Telegram connector serves the owner's private agent bot. The calendar is a month-filtered list, and nothing works for social media without the Marketing module.

`@opencoredev/social-sdk` (MIT, zero dependencies) offers direct adapters. Its published version 0.5.0 contains X, Instagram, LinkedIn and TikTok, OAuth helpers and an adapter interface (`defineAdapter`); Facebook Pages, `SocialScheduler`, PostgreSQL stores and MCP tools exist only unreleased on its `main`. It has no Telegram adapter. Upstream marks all providers as not live-verified.

## Decision

1. **Own module `social`** (opt-in, installation switch `ORBIT_SOCIAL`, default off) with dedicated tables (`Social*`, FORCE RLS, composite tenant keys), permissions `social.*`, routes `/api/projects/:projectId/social/…`, web `/p/:projectId/social/…`. It owns platform accounts, posts, variants, media, schedule, publication approval, delivery state and technical metrics. Marketing keeps strategy, campaigns, generation, marketing review/approval and the veto window, and reaches Social only through `modules/social/contract.ts` and domain events.
2. **Direct adapters only.** `@opencoredev/social-sdk` pinned at **0.5.0** (S-D1) for X and Instagram (phase 2: LinkedIn, TikTok); Facebook Pages from the first published 0.6.x, with a vendored pinned commit as fallback at the start of the dispatch phase. `@opencoredev/social-sdk/cloud/*` and every managed provider are forbidden by a source-check rule.
3. **One scheduler** (S-D2). Orbit's outbox/`workDueAt` pump, DB job leases and a publication fence schedule and execute all deliveries; `SocialPublication` is the only delivery state machine. The SDK's `SocialScheduler` is not used. The SDK outcome and error model (`DeliveryOutcome`, `RetryDisposition`, `SocialError`) is adopted at the adapter seam. Unknown outcomes are never resent.
4. **Telegram** (S-D3) is an Orbit adapter behind the SDK adapter interface over `packages/connectors/src/telegram.ts` (extended additively), using a separate publishing bot per project stored as a project connection. The social module never calls `setWebhook`, `deleteWebhook` or `getUpdates`; the private agent bot is untouched.
5. **Connections** follow ADR 0014: developer apps are system connections (`social.app.*`) in global administration; project accounts are project connections (`social.account.<platform>`) with versioned, sealed secrets; token refresh under a row lock. Meta uses one app with Facebook Login for Business for Pages and linked Instagram professional accounts (S-D4).
6. **Approvals** use ActionRequests: scheduling and publishing are `W2`, never mandatable; default policy `owner_each` (S-D9); an approval binds content, media, accounts and the scheduled time (S-D6). Marketing content that Marketing already approved exactly enters Social as `origin_authorized`, and Marketing's guard is re-run when the delivery is claimed.
7. **MCP and assistant** tools are `OrbitTool`s built with `readOperation`/`approvedOperation`, feature `social`, scope `orbit:social`. The SDK's MCP server and tool definitions are not used.
8. **Phase 1 publishes text and images** to Instagram, Facebook Pages, X (paid API access booked, S-D7) and Telegram; video follows when S3-compatible storage exists (S-D5).
9. **Postiz migration** per project through a marketing setting `publishingBackend` (`postiz` → `postiz_draining` → `social`); source rows are never rewritten; Postiz history appears in Social as an additive read-only mirror (S-D8); Postiz is switched off only after every project passed its end-to-end acceptance and 30 stable days.

## Alternatives

- **Keep Postiz** and only build a calendar: keeps a second system of record and a managed provider.
- **Use `SocialScheduler`** with a PostgreSQL store: unreleased, no indexed store, cannot schedule X media, and adds a second lease and job state next to Orbit's.
- **Own platform adapters without the SDK:** more code to maintain for X and Instagram; the SDK's adapters, outcome model and OAuth helpers are reusable at no dependency cost.
- **Managed providers inside the SDK** (Zernio, Post for Me, PostFast, Buffer, Upload-Post): ruled out by the request.
- **Publications as new `Entity` kinds:** no unique keys, no relational calendar queries, linear-scan idempotency; ADR 0009 gives new modules with relational needs their own tables.

## Consequences

- New tables `SocialAccount`, `SocialPost`, `SocialPostVariant`, `SocialPostMedia`, `SocialPublication`, `SocialDeliveryAttempt`, `SocialAccountThrottle`, `SocialOAuthState`, `SocialMetricSnapshot`, `SocialProviderState`; RLS and access matrices grow.
- A new production dependency with a single upstream maintainer; mitigated by pinning, an adapter registry seam, per-account live write verification and the vendoring fallback.
- Marketing gains a publishing-backend switch; Postiz projects keep their package hashes and behaviour until switched.
- A public, short-lived, HMAC-signed media URL route is needed for Instagram.
- Platform approvals and costs (Meta app review, X API tier, later LinkedIn and TikTok audits) gate go-live independently of the code.
- S5 note: no published SDK version has a Facebook adapter (0.5.0 is the newest, checked 2026-11-02), so S-D1's fallback (vendor a pinned upstream commit) has nothing to vendor yet. Facebook sending waits for Mario's decision (vendor unreleased upstream code, a small own Graph adapter, or a later SDK); until then live Facebook publications are held back with `SOCIAL_PLATFORM_NOT_AVAILABLE`.
- S5b (2026-11-03): Mario chose the own small Graph adapter (`adapters/facebook.ts`, Graph v26.0, unpublished photos plus one `/feed` call); 0.5.0 is still the newest SDK. Postiz (AGPL-3.0) was read for the flow only; no code was taken. If a later SDK ships Facebook, the adapter can be swapped behind `SocialSender`.
- S7 (2026-11-03): tools in `modules/social/tools.ts`, scope `orbit:social`. The owner decides every proposal; the approval of an MCP schedule or publish-now request is the post's approval (no second request). `social_request_approval` was folded into `social_schedule`, `social_cancel` is W0 (Orbit schedules no posts natively at a platform), and `mcpOwnerPublishWithoutApproval` stays refused until the platform has a generic direct-effect hook.
- S8 (2026-11-03): post figures through own small reads (Graph fields, X `public_metrics`), not the SDK's analytics (it has none for X and Facebook in 0.5.0); X reads are paid, so they need the owner's `xMetrics` setting. No new Meta permission.
- S4 note: `editor_each` (S-D9) needs a per-project decider hook in the platform's ActionRequests, which decide only by the type's static `deciderRole`; until that hook exists the setting is refused and the owner decides every request.
