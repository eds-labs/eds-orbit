# Social S5b: Facebook Page sending — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dispatcher sends approved posts to connected Facebook Pages (text, one or more images), with the same exactly-once, read-back and live gates as X, Instagram and Telegram.

**Architecture:** A small Orbit Graph adapter `adapters/facebook.ts` behind the existing `SocialSender` interface (no SDK version ships Facebook; 0.5.0 is still the newest on npm, 2026-11-03). Images go up unpublished (`POST /{page}/photos`, multipart, `published=false`, invisible, deleted by Meta after about 24 h); then exactly one call creates the visible post (`POST /{page}/feed` with `message` and `attached_media`). Only that call can publish, so only its unclear answers are `unknown`; a failed upload is a plain failure that may be retried. Unknown sends are read back from `GET /{page}/posts`. The Page token and Graph v26.0 come from the S2 Meta connection (`accounts/meta.ts`).

**Tech Stack:** TypeScript, Orbit bounded transport (`socialFetch`), Graph API v26.0, vitest.

**Spec:** [2026-11-02-social-module.md](2026-11-02-social-module.md) (§3 S-D1, S-D4; §6.1; §10 S5) and [ADR 0020](../../adr/0020-social-module.md). Stacked on S6 (`claude/social-s6`).

## Global Constraints

- No new dependency, no migration (schema hash stays `12cf3d02…`).
- Postiz (AGPL-3.0) was read for the flow only (unpublished photos + one `/feed` call; Graph error codes); no code is copied.
- Graph facts (Meta docs, 2026-11-03): Page photos JPEG/PNG ≤ 4 MB; `attached_media[n] = {"media_fbid": id}`; unpublished photos expire after about 24 h; Page token with `pages_manage_posts`; post URL `https://www.facebook.com/<post id>`.
- Live sends keep every S5 gate: live mode, `ORBIT_SOCIAL_PLATFORMS` lists `facebook`, write-verified account (or its verification post).
- Docs and comments in English.

## Review Focus

1. **A timeout or 5xx on `/feed`** after the photos went up: expect `unknown` (never a second post), then one read-back that finds the post by text and time.
2. **A refused or timed-out photo upload**: nothing visible exists; expect `failed` with a delay, so the next attempt uploads again.
3. **Graph error codes**: 190 → reconnect (token), 10/200–299 → reconnect (permission), 4/17/32/341/613/80001+ → wait, 368 → wait an hour, 1/2/transient on `/feed` → unknown, anything else → refused for good.
4. **Images above 4 MB**: the JPEG rendition goes instead; a rendition above 4 MB is a validation issue before approval.
5. **A post without text**: cannot be matched on read-back, so it stays with the owner (not_found), never guessed.

---

### Task 1: Facebook as a sendable platform

**Files:** `packages/config/src/index.ts` (`ORBIT_SOCIAL_PLATFORMS` accepts `facebook`), `apps/api/src/modules/social/dispatch/gates.ts` (`SENDABLE_PLATFORMS` + `facebook`), `media/rules.ts` (Facebook: original ≤ 4 MB, else JPEG; JPEG > 4 MB → `SOCIAL_MEDIA_TOO_LARGE`), `dispatch/claim.ts` (unknown read-back for every platform whose sender can read back); tests `social-gates.test.ts`, `social-media-rules.test.ts`, config test.

- [ ] Failing tests: `platformEnabled("facebook")` true when listed; `SENDABLE_PLATFORMS` = `["x","facebook","instagram","telegram"]`; `renditionFor({size: 4_100_000}, "facebook")` = `"jpeg"`, `{size: 3_900_000}` = `"original"`; a JPEG rendition of 4.2 MB → `SOCIAL_MEDIA_TOO_LARGE`; config refuses `myspace`, accepts `facebook`.
- [ ] Implement; run `…/t apps/api/tests/social-gates.test.ts apps/api/tests/social-media-rules.test.ts packages/config` — PASS.
- [ ] Commit `feat(social): facebook as a sendable platform with its 4 MB photo rule`.

### Task 2: Facebook sender

**Files:** Create `apps/api/src/modules/social/adapters/facebook.ts`; modify `adapters/registry.ts`; test `apps/api/tests/social-adapter-facebook.test.ts` (fake transport through `setSocialFetchForTests`, as `social-adapter-x.test.ts`).

**Produces:** `facebookSender: SocialSender` (`send`, `reconcile`), registered for `facebook`.

Behaviour: Page id = `credentials.config.pageId ?? credentials.externalId`; `Authorization: Bearer <page token>`. Each image: `POST /{page}/photos` multipart (`source` blob with its MIME, `published=false`) → `id`. Then `POST /{page}/feed` JSON `{message, attached_media?: [{media_fbid}], published: true}` with `fields=id,permalink_url`. Permalink = `permalink_url` from that answer, else `https://www.facebook.com/<id>`. Read-back: `GET /{page}/posts?fields=id,message,created_time,permalink_url&limit=20`, match whitespace-normalised `message` and `created_time ≥ since − 5 min`; empty body → `not_found`.

- [ ] Failing tests: text post → one `/feed` call, `published` with the permalink; two images → two multipart `/photos` calls with `published=false` then `/feed` with both `media_fbid`s; Graph code 190 → `failed after-reconnect SOCIAL_META_TOKEN_INVALID`; 200 → `after-reconnect SOCIAL_META_PERMISSION_MISSING`; 4/613 → `after-delay SOCIAL_RATE_LIMITED` (60 s), 368 → `after-delay` 1 h; 503 or code 2 on `/feed` → `unknown`; a thrown transport error on `/feed` → `unknown`, on `/photos` → `failed after-delay`; code 100 → `failed never SOCIAL_PROVIDER_REJECTED`; `/feed` 200 without id → `unknown`; read-back finds the matching post, ignores older or different ones, empty body → `not_found`.
- [ ] Implement; run `…/t apps/api/tests/social-adapter-facebook.test.ts` — PASS.
- [ ] Commit `feat(social): send to Facebook Pages`.

### Task 3: End to end through the dispatcher

**Files:** `apps/api/tests/social-deliver.integration.test.ts` (or a new `social-facebook-deliver.integration.test.ts`).

- [ ] Failing test: live mode with `ORBIT_SOCIAL_PLATFORMS=facebook`, a write-verified Facebook account with a Page token in the vault, an approved post with one image → `deliverPublication` sends `/photos` then `/feed` (fake Graph), the publication is `published` with the permalink; a `/feed` timeout → `outcome_unknown` and a read-back job is queued; the write-verification post of an unverified Facebook account marks it `write_verified`.
- [ ] Implement whatever the test shows missing; run the social integration tests — PASS.
- [ ] Commit `test(social): facebook delivery end to end`.

### Task 4: Docs and verification

**Files:** `docs/SOCIAL.md`, `docs/OPERATIONS.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `.env.example` comment.

- [ ] Docs: Facebook sending, its rules and errors, going live for Facebook (Meta app Live mode, `pages_manage_posts`, write verification).
- [ ] Lint, API and web typecheck, framework check, full vitest, schema hash unchanged.
- [ ] Commit `docs(social): S5b facebook sending`.
