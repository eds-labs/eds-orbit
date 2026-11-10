# Social S8: Technical analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit reads the public engagement figures of posts it published (Facebook, Instagram, and X when the owner allows the paid reads) and shows them per post and in Social → Analytics; Marketing can read them later through the contract (S9).

**Architecture:** `apps/api/src/modules/social/analytics/` with one reader per platform behind `metricsOf(platform)` (own small calls through `socialFetch`, like the senders), a periodic task `social-metrics` that stores `SocialMetricSnapshot` rows, a service `postMetrics(tx, scope, postIds)` (latest value per publication and metric), a route and a web view. Telegram's Bot API has no figures for channel posts: shown as "not available".

**Tech Stack:** TypeScript, Orbit bounded transport, Graph API v26.0, X API v2, Prisma, React.

**Spec:** [2026-11-02-social-module.md](2026-11-02-social-module.md) §10 S8, §11 (retention 24 months); [ADR 0020](../../adr/0020-social-module.md). Stacked on `claude/social-s7`.

## Global Constraints

- No migration (`SocialMetricSnapshot` exists since S1); schema hash stays `12cf3d02…`. No new dependency, no new Meta permission (Facebook: `pages_read_engagement`; Instagram: `instagram_basic` fields only, insights such as reach need `instagram_manage_insights`, not requested).
- Per project and run at most 50 provider calls; only publications `published`, not test publications, published at most 30 days ago, account `active`.
- X bills reads (pay-per-use, about $0.005 per post read as of 2026-11): X figures only with the project setting `xMetrics: true` (owner, default `false`) and at most once per 24 h per post.
- A provider error never stops the run for other posts; no account is marked for a reconnect by the metrics task (the health task owns that).
- Docs and comments in English.

## Rulings taken while planning

- Facebook: `GET /{post-id}?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)` → `reactions`, `comments`, `shares`. Instagram: `GET /{media-id}?fields=like_count,comments_count` → `likes`, `comments`. X: `GET /2/tweets?ids=…&tweet.fields=public_metrics` (up to 100 ids per call) → `likes`, `reposts`, `replies`, `quotes`, `impressions`, `bookmarks`.
- Values are lifetime counters (`period: "lifetime"`); every run stores a new row per metric (`observedAt` = run time), so trends stay visible; the view shows the latest.
- No MCP tool in S8: `social_post_get` stays as it is; Marketing gets the figures through the contract in S9.

## Review Focus

1. A project with 200 published posts: one run makes at most 50 calls and continues where it stopped next time (least recently observed first).
2. A Graph or X error (token expired, 429, 5xx, a deleted post) for one post: that post gets no row, the others do, nothing throws.
3. A test publication or a post older than 30 days: never read.
4. `xMetrics` off: no X call at all; on: at most one read per post per 24 h.
5. A viewer from another project: no metrics of this project (route permission and project scope).

---

### Task 1: Readers per platform

**Files:** Create `apps/api/src/modules/social/analytics/readers.ts`; test `apps/api/tests/social-metrics-readers.test.ts` (fake transport, like `social-adapter-facebook.test.ts`).

**Produces:** `type MetricValue = { metric: string; value: number }`; `readMetrics(platform, credentials, externalPostIds): Promise<Map<externalId, MetricValue[] | null>>` (null = not read).

- [ ] Failing tests: Facebook fields and parsing (summary total counts, shares count, missing shares → 0); Instagram like/comment counts; X batches ids by 100 and maps public_metrics; a 5xx or thrown transport error → `null` for that post; Telegram → empty map (not available).
- [ ] Implement; PASS. Commit `feat(social): metric readers for Facebook, Instagram and X`.

### Task 2: Periodic task and storage

**Files:** Create `analytics/collect.ts` (`socialMetrics: PeriodicTask`, `postMetrics`); modify `contributions.ts` (periodic), `settings.ts` (`xMetrics`); test `apps/api/tests/social-metrics.integration.test.ts`.

- [ ] Failing tests: run stores rows for published live publications only; ≤ 50 calls (fetch counter) and the next run reads the rest first; test publications and old posts skipped; error isolation; X only with `xMetrics` and not again within 24 h; `nextDueAt` null without candidates; `postMetrics` returns the latest value per metric.
- [ ] Implement; PASS. Commit `feat(social): collect post metrics every six hours`.

### Task 3: Route and web

**Files:** `posts/routes.ts` (`GET /api/projects/:projectId/social/posts/:postId/metrics`, `GET …/social/analytics?from&to`), `apps/web/src/modules/social/analytics.tsx` (replaces the placeholder), drawer section; access matrix; web tests.

- [ ] Failing tests: route permission `social.analytics.read` (viewer yes, outsider 404); analytics list of the last 30 days with latest figures; web renders figures and "not available" for Telegram, German labels.
- [ ] Implement; PASS. Commit `feat(social): post metrics in the calendar panel and Social → Analytics`.

### Task 4: Docs and verification

**Files:** `docs/SOCIAL.md`, `docs/OPERATIONS.md` (X read costs, `xMetrics`), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`.

- [ ] Docs; typechecks, source check, framework/compose checks, full vitest; schema hash unchanged. Commit `docs(social): S8 technical analytics`.
