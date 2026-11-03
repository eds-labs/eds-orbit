# Social module (`social`)

The social module connects a project's social accounts and publishes posts to them directly, without a managed publishing service. It owns accounts, posts with one variant per account, media, the calendar, scheduling, publication state and technical metrics. Marketing keeps strategy, campaigns, generation and its own approvals and will publish through this module. Decision: [ADR 0020](adr/0020-social-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-02-social-module.md](superpowers/plans/2026-11-02-social-module.md). Phase S1 plan: [superpowers/plans/2026-11-02-social-s1-module-skeleton.md](superpowers/plans/2026-11-02-social-s1-module-skeleton.md).

State on 2026-11-02: **phases S1 (module skeleton), S2 (developer apps, OAuth, token vault, accounts, Telegram channels) and S3 (media library, public media URLs) on branches `claude/social-module-plan`, `claude/social-s2` and `claude/social-s3`, not merged.** `ORBIT_SOCIAL` is off. Accounts can be connected and images uploaded; nothing is published yet (S5). Postiz remains the publishing path for Marketing. Later phases on top: S4 posts and approvals, S5 sending, S6 calendar (`claude/social-s6`). Plans: [S2](superpowers/plans/2026-11-02-social-s2-accounts.md), [S3](superpowers/plans/2026-11-02-social-s3-media.md). Facebook sending (S5b) is on `claude/social-s5b` on top of S6.

## Switching it on

Three layers, as for Support, Finance, Work and Issues ([MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)):

1. Installation: `ORBIT_SOCIAL=true` (default `false`). While off, every social route answers 404 `SOCIAL_DISABLED`.
2. Project: an owner enables the module in Settings → Modules (`enabled = true` row). The module is opt-in (`defaultEnabled: false`), so it stays off without that row even while `ORBIT_MODULES` is off.
3. Member: the permissions below; module roles may narrow them (`none` hides the module).

Switching it off deletes nothing.

## Permissions

| Key | Default roles | Purpose |
|---|---|---|
| `social.read` | owner, editor, viewer | Accounts, posts, calendar |
| `social.compose` | owner, editor | Create and edit posts and media |
| `social.publish` | owner, editor | Request scheduling or publication |
| `social.approve` | owner | Approve a publication |
| `social.accounts.manage` | owner (sensitive) | Connect, check, disconnect accounts |
| `social.analytics.read` | owner, editor, viewer | Metrics of published posts |
| `social.settings` | owner | Module settings |

## Settings

Stored in the module's `ProjectModule` row, versioned (`PUT /api/projects/:projectId/social/settings` with `{settings, version}`):

| Setting | Default | Meaning |
|---|---|---|
| `approval` | `owner_each` | `owner_each`: the owner approves every publication. `editor_each` (editors approve too, S-D9) is refused with 409 `SOCIAL_SETTING_NOT_AVAILABLE` for now: who decides is fixed per action type, and the platform has no per-project hook yet (S4 ruling). |
| `mcpOwnerPublishWithoutApproval` | `false` | An owner's direct MCP call may publish without a separate request. |

## Data model

Migration `202611020001_social_core`: `SocialAccount`, `SocialPost`, `SocialPostVariant`, `SocialPostMedia`, `SocialPublication`, `SocialDeliveryAttempt`, `SocialAccountThrottle`, `SocialOAuthState`, `SocialMetricSnapshot`, `SocialProviderState`. Every table is project-scoped with forced row-level security and composite same-project keys. Publication idempotency keys are unique. A publication always delivers its variant to that variant's own account (composite key). Publications are deleted only with their project: the business role cannot delete one, and a post or variant that has publications cannot be deleted either (posts are archived instead). Delivery attempts and metric snapshots are append-only and deleted only by retention. Tokens are never stored here; they will be sealed `ConnectionSecret`s of project connections (ADR 0014).

## Boundaries

- Only direct platform adapters: `scripts/boundaries.json` → `forbiddenImportPrefixes` makes `pnpm lint` fail on any `@opencoredev/social-sdk/cloud…` import.
- Post media are private to the module (`files.privateToModule`).

## Routes

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/social/status` | `social.read` |
| `PUT /api/projects/:projectId/social/settings` | `social.settings` |
| `GET /api/projects/:projectId/social/accounts` | `social.read` |
| `POST /api/projects/:projectId/social/accounts/connect/:app` (`meta`, `x`) | `social.accounts.manage` |
| `GET /api/social/oauth/callback/:app` | the owner who started the flow (session) |
| `POST /api/projects/:projectId/social/accounts/telegram` `{botToken, chat}` | `social.accounts.manage` |
| `POST /api/projects/:projectId/social/accounts/:accountId/check` | `social.accounts.manage` |
| `POST /api/projects/:projectId/social/accounts/:accountId/disconnect` `{version}` | `social.accounts.manage` |
| `PATCH /api/projects/:projectId/social/accounts/:accountId` `{version, settings: {xLongPosts}}` | `social.accounts.manage` |
| `POST /api/callbacks/social/meta-data-deletion` | Meta's signed request; needs `ORBIT_PUBLIC_INGRESS` |

Later phases (S3–S12, see the programme plan) add media, posts, approvals, the dispatcher, the calendar, MCP tools, analytics, the Marketing integration and the Postiz migration.

## Accounts and tokens (S2)

- **Developer apps** are system connections in global administration (Administration → Connections): `social.app.meta` and `social.app.x`. The secret field holds JSON: Meta `{"appId", "appSecret", "configId"}`, X `{"clientId", "clientSecret"}`. An administrator grants the app to the organization (purpose `social_oauth`, module `social`); then an administrator or organization owner grants it to each project. The Meta app check reads the app with its app token; the X app cannot be checked without a user.
- **Accounts.** Every connected account (an X user, a Facebook Page, an Instagram professional account, a Telegram channel) owns a project connection `social.account.<platform>`. Its tokens exist only as that connection's sealed secret (key ring of ADR 0014); the business role reads it through the project grant, and only the platform service `platform/connections/project-secrets.ts` writes it (auth role, advisory lock per connection, system audit). These providers are `managedByModule`: neither the generic connector form nor the administration offers them.
- **X** uses the SDK's OAuth provider: authorization code with PKCE (S256), confidential client, scopes `tweet.read tweet.write users.read offline.access media.write`. Access tokens live two hours; a token that expires within five minutes is refreshed under the connection's lock (refresh tokens are single use). A refused refresh marks the account `reconnect_required`.
- **Meta** uses Facebook Login for Business (Graph API v26.0, `config_id`, no PKCE): code → short-lived user token → long-lived user token → `/me/accounts`. Every Page the person selected in Meta's dialog with a posting task (`CREATE_CONTENT` or `MANAGE`) becomes a `facebook` account, and its linked Instagram professional account an `instagram` account; both store the Page token (which does not expire). A reconnect rotates the tokens; Pages no longer granted become `reconnect_required`.
- **Telegram** uses a separate publishing bot per channel (S-D3): the owner enters its token and the channel (`@name` or id); the bot must be an administrator allowed to post. The project's own Orbit bot is refused (`SOCIAL_TELEGRAM_OWNER_BOT`). The social module never calls `getUpdates`, `setWebhook`, `deleteWebhook`, `logOut` or `close`.
- **Health.** "Check" reads with the stored credentials (X `users/me`, Meta `debug_token` incl. the publishing permission for this asset, Telegram `getChatMember`). A refusal marks the account `reconnect_required` (attention item for readers, a notification to the owners once); an outage is only recorded. The periodic task `social-account-health` checks every active account every six hours, at most 20 per project and run.
- **Disconnect** revokes the account's connection (and, for X, the token at X, best effort) and keeps the account row for the history.
- **Meta data deletion.** Meta's data-deletion request (`signed_request`, HMAC-SHA256 with the app secret) disconnects every account of that Meta user in every project and answers `{url, confirmation_code}`. The status page `/social/data-deletion?code=…` is not built yet.

## Media library (S3)

- **Images only** (PNG, JPEG, WebP up to the file storage's limit, default 20 MB); videos are refused (`SOCIAL_VIDEO_NOT_AVAILABLE`) until S3b. Needs the platform file storage (`ORBIT_FILES` and `FILES_ENCRYPTION_KEY`); the project quota (default 100 MB) applies.
- **Normalization** (`packages/creative` `prepareSocialImage`, sharp): orientation applied, all metadata removed (EXIF, GPS), long side at most 4096 pixels; JPEG and every opaque image become a JPEG original (photos stay small); an image with transparency stays PNG while it is at most 10 MiB, else it becomes JPEG too (X takes no WebP). The name takes the stored type's extension. Every image also gets a **JPEG rendition** at most 1440 pixels wide in sRGB, the form Instagram accepts. Animated GIFs and images over 40 megapixels are refused; an animated WebP is read as its first frame. The type is taken from the bytes (PNG, JPEG or WebP signature), not from the declared type. At most two images are prepared at a time per process; more get 503 `SOCIAL_MEDIA_BUSY`. Removing an unused image checks its use, deletes the entry and marks both files deleted in one transaction (the file rows are locked against a post attaching them); the stored objects are purged after the commit.
- **Library entry** `SocialMediaAsset` (dimensions, sizes, alt text, both files); the bytes are encrypted platform files private to the module. Removing an image a post uses only archives it; otherwise both files are deleted.
- **Platform rules** (`media/rules.ts`): Instagram gets the JPEG rendition (4:5 to 1.91:1, at least 320 pixels wide, at most 8 MB; a carousel needs equal ratios, at most 10); X gets the original up to 5 MiB, else the rendition (at most 4 images); Facebook gets the original up to 4 MB (the Page photo limit), else the rendition, which must stay ≤ 4 MB (S5b); Telegram gets the original up to 10 MB (width + height ≤ 10000, ratio ≤ 20). The editor (S4) shows these as hints; publishing (S5) enforces them.
- **Public media URLs** for platforms that fetch media by URL: `GET /api/public/social/media/<token>`. The token names project, publication and file, expires after two hours and carries a 128-bit HMAC (key derived from `AUTH_SECRET`, label `orbit-social-media-v1`). The route serves only a rendition of a medium of a publication that is `claimed`, `sending` or `processing`, never lists, audits `social.media.public_served`, and answers the same 404 otherwise. It needs `ORBIT_PUBLIC_INGRESS` and `ORBIT_SOCIAL_MEDIA_PUBLIC` (both off).

| Route | Permission |
|---|---|
| `POST /api/projects/:projectId/social/media` (raw body, `x-file-name`, `x-file-type`) | `social.compose` |
| `GET /api/projects/:projectId/social/media` | `social.read` |
| `GET /api/projects/:projectId/social/media/:mediaId/content?rendition=original\|jpeg` | `social.read` |
| `PATCH /api/projects/:projectId/social/media/:mediaId` `{altText, version}` | `social.compose` |
| `DELETE /api/projects/:projectId/social/media/:mediaId` | `social.compose` |
| `GET /api/public/social/media/:token` | the signed token (public ingress) |

## Posts, variants and approvals (S4)

- **A post** has a base text and base images (library images, up to 10) and one **variant** per account (up to 10 accounts). A variant inherits the base text and images until it gets its own; inheritance is stored (`inheritsText`, `inheritsMedia`, migration `202611020003_social_post_base`), so a later change of the base reaches only inheriting variants. Texts up to 25,000 characters; the title (up to 200) is only shown in Orbit.
- **Versions:** every change sends the current `version`; an old one gets 409 `SOCIAL_VERSION_CONFLICT`. Posts mirrored from Postiz are read-only (`SOCIAL_POST_READ_ONLY`).
- **Validation** (`posts/validation.ts`, no network): X text by the SDK's weighted 280 limit (links count 23), or up to 25,000 characters when the account allows long posts (`xLongPosts`, X Premium); Instagram needs an image and a caption ≤ 2,200 (SDK check); Facebook ≤ 63,206; Telegram ≤ 4,096, with images ≤ 1,024; the S3 media rules; options per platform (X `replySettings`, Telegram `disableLinkPreview`, `silent`); a disconnected account is an error, an account without tested posting a warning. Saving a draft never fails on validation; scheduling does (409 `SOCIAL_VALIDATION_FAILED` with the issues per account).
- **Time** (`posts/schedule-time.ts`, `platform/time/zoned-time.ts`): a local date and time in the project's zone (or another), or an instant. A time that does not exist because the clocks go forward is refused with the next valid one (`SOCIAL_SCHEDULE_TIME_GAP`); a time that exists twice needs `fold: earlier|later` (`SOCIAL_SCHEDULE_TIME_AMBIGUOUS`). At least two minutes ahead, at most 365 days.
- **Approval** (S-D6, S-D9): the owner's own schedule or publish-now is its approval. Anyone else's creates an ActionRequest (`social.post.schedule` or `social.post.publish_now`, W2, decided by the owner in Decisions, never mandatable, not proposable through MCP yet) and the post waits in `needs_approval`. The approval binds the package: every variant's account, text, options and images (by hash, in order) and the time, not the title. A change of the package returns the post to `draft` and withdraws a pending request; moving an approved post asks for approval again (an editor's move creates a new request, an owner confirms the new time). Deciding a request whose post changed answers 409 `SOCIAL_APPROVAL_STALE`; a time that came too close while the request waited answers `SOCIAL_SCHEDULE_TOO_SOON`.
- **States in S4:** `draft` → `needs_approval` → `scheduled` (at a time) or `approved` (publish now); `cancel` returns a waiting or approved post to `draft`; drafts and finished posts can be archived. Nothing is sent: publishing starts with S5.
- **Web:** Social → Posts lists the posts; the editor has a tab for all accounts and one per account (own text and images, preview cut at the platform's limit, character counts), the publication time with the time zone and the choices for clock changes, and the server's issues per account. The owner sees the request with every account's text and images in Decisions.

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/social/posts?status&from&to&cursor&limit` | `social.read` |
| `POST /api/projects/:projectId/social/posts`, `PATCH …/posts/:postId` | `social.compose` |
| `GET /api/projects/:projectId/social/posts/:postId` | `social.read` |
| `POST …/posts/:postId/validate`, `…/cancel`, `…/archive` | `social.compose` |
| `POST …/posts/:postId/schedule`, `…/publish-now`, `…/reschedule` | `social.publish` (the owner decides the request) |

## Sending (S5)

- **One scheduler:** three queue classes on the Orbit worker, found through the outbox's `availableAt` (no BullMQ delays, no SDK timers). `social_dispatch` is enqueued when a post is approved (owner's own action or the owner's decision), due at the post's time (now for publish-now), keyed by the post version: editing, moving or canceling the post before then cancels it, and a job of an older version does nothing. When it runs it creates one `SocialPublication` per variant (unique idempotency key over post, variant, account and package hash), sets the post to `publishing` and enqueues one `social_deliver` per publication.
- **Exactly once:** `social_deliver` claims the publication in a transaction (row lock, new fence, attempts + 1) after checking again: account active, live mode with the platform switched on and a write-verified account (or a write verification post), Instagram with public media URLs, the package unchanged since the approval, the throttle. It marks the publication `sending` and commits before the provider call, sends outside any transaction, then writes one delivery attempt (no text, no token) and the result with the same fence. A duplicate or late worker finds another status or fence and does nothing. A lease that runs out while `sending` turns the publication into `outcome_unknown` (exception `SOCIAL_OUTCOME_UNKNOWN`), never into a second send.
- **Modes:** live sends need `EXECUTION_MODE=live`, `ENABLE_EXTERNAL_WRITES=true` and the platform in `ORBIT_SOCIAL_PLATFORMS` (comma list of `x`, `facebook`, `instagram`, `telegram`; empty by default). Otherwise publications are test publications (`externalPostId test:…`, marked "Test") without a provider call.
- **Adapters:** X and Instagram through the SDK 0.5.0 adapters' own publish path (X Premium texts above 280 characters go out unchanged; X images as Blobs ≤ 5 MiB, no alt text in 0.5.0). Instagram (Graph v25.0, the Page token) reads the daily quota first, creates containers from the signed media URLs and keeps its container flow in `SocialProviderState` (one workflow per publication, compare-and-set, 5-minute claim), so a retry or read-back continues it and never creates a second post. Telegram uses the account's own publishing bot through Orbit's connector: a text message (link preview on unless switched off, optionally silent), a photo, or an album of 2–10 photos with the caption on the first. Facebook Pages (S5b) use Orbit's own Graph calls (v26.0, the Page token; no SDK version ships Facebook): each image goes up unpublished as multipart bytes (`POST /{page}/photos`, `published=false`; invisible, Meta deletes unused ones after about a day, no public media URL needed), then exactly one `POST /{page}/feed` with `message` and `attached_media` creates the post. Only that call can publish: a failed upload is a plain failure that may be retried, while an unclear `/feed` answer is `outcome_unknown`.
- **Results:** published (with the permalink: `x.com/<handle>/status/<id>`, the Instagram permalink, `t.me/<channel>/<id>` for public channels, `facebook.com/<post id>`); processing (Instagram) → `social_reconcile` polls after 15 s, 30 s, 60 s … at most 15 minutes apart, 12 times, then `outcome_unknown`; a refusal where nothing was posted: rate limits are retried after `max(Retry-After, 60 s)`, at most 3 attempts; 401/403 (token or bot lost) blocks with `ACCOUNT_RECONNECT_REQUIRED` and marks the account; anything else fails for good. An unclear send (5xx or network error after the request left, a lost lease, a delivery stuck in `sending`) is `outcome_unknown`: after a provider answer, X, Facebook and Instagram are read back once after 2 minutes (recent posts matched by text from 5 minutes before the send; a Facebook post without text is never guessed) and confirmed when found; otherwise, and always for Telegram, the owner settles it ("It was published" / "It was not published"). Nothing is resent automatically.
- **Throttles** (per account, UTC windows): Telegram 20/minute per channel; X 6/minute and 300/day; Facebook 30/hour per Page; Instagram 50/day plus the live quota. Facebook error codes: 190 (token) and 10/200–299 (permission) ask for a reconnect, the throttle codes (4, 17, 32, 341, 613, 80001…) wait a minute, 368 (temporary block) waits an hour. A throttled publication waits for the next window.
- **Cancel, pause:** canceling a `publishing` post stops what was not sent (`canceled`, its jobs too). A claimed one that has not called the provider is dropped (`cancel_requested` → `canceled`). A send in flight stays `sending` with a stop marker: if it went out it is `published`, if unclear `outcome_unknown`, and a refusal or Instagram's processing ends as `canceled` instead of a retry. A paused project blocks deliveries and due dispatches (`PROJECT_PAUSED`); on resume only those due within the last 30 minutes go out (Instagram read-backs start again); approved posts whose time passed longer ago stay and show as the attention item `social_post_missed` until they get a new time.
- **Stuck deliveries:** a periodic sweep settles publications still `sending` ten minutes after their claim as `outcome_unknown` (for example when writing the result failed after the provider call) and queues `claimed` ones again.
- **Write verification:** an owner asks for a test post with a text of their choice and, for Instagram (which posts nothing without one), a library image that fits the platform (`POST /accounts/:accountId/verify-write`, live mode only); approving the request (`social.account.verify_write`, W2, owner, never a mandate) creates a publish-now post of origin type `write_verification` that may go out before verification; once it is published live the account is `write_verified`.
- **Events and attention:** `social.publication.published|failed|outcome_unknown` (ids and platform only); the attention item `social_publication_problem` counts unclear and held back publications and, for a week and until the owner settled them, failed ones.
- **Worker fix:** a job whose outbox row was handed to BullMQ more than ten minutes ago, that is still `queued` or `retry_scheduled` and has no live BullMQ job (Redis lost it), gets a new outbox row (checked at most every five minutes per project).

| Route | Permission |
|---|---|
| `POST /api/projects/:projectId/social/posts/:postId/cancel` (also for `publishing` posts) | `social.compose` |
| `POST /api/projects/:projectId/social/publications/:publicationId/resolve` `{resolution, permalink?, version}` | `social.approve` (owner) |
| `POST /api/projects/:projectId/social/accounts/:accountId/verify-write` `{version, text}` | `social.accounts.manage` (owner) |

## Calendar (S6)

Social → Calendar shows the posts that have a time, in the project's time zone; unplanned drafts stay in Social → Posts. Plan: [superpowers/plans/2026-11-03-social-s6-calendar.md](superpowers/plans/2026-11-03-social-s6-calendar.md).

- **Views:** month (whole weeks from Monday, up to three posts per day and "+N more", which opens that week), week (a time column and seven days of half hours: 48 rows, 50 in the week the clocks go back with the repeated hour marked "2nd"; in the week they go forward the Sunday's skipped half hours are empty cells) and a list (the project's posts with the same filters, 50 at a time with "Load more"). Each post shows its time, platforms, title or text, status and markers for unclear sends, test publications and posts from Postiz. The view, period, scope and filters are in the address, so a calendar can be shared and back/forward work.
- **Filters:** accounts, platforms, status and origin; in the organization scope projects instead of accounts.
- **Organization scope:** members with more than one project in the organization can switch to "All projects": the posts of up to 20 of their projects where the social module is on and they may read Social (module role not `none`), each with its project name. Other projects' posts are read-only there and link to their project; projects the member cannot read are not mentioned at all. There is no organization page of its own: the switch is on the project's calendar.
- **Preview:** a post opens in a panel with its time (and its own zone when it differs), status, approval, the preview per account, its publications and the link to the editor.
- **Moving** (drag and drop with pointer, touch or keyboard, or "Move to…" in the panel; S-D6): a draft moves at once. An approved or waiting post needs a new approval: an owner confirms "Moving an approved post approves the new time", an editor confirms that the post goes back to approval (an ActionRequest the owner decides). Posts being sent or finished, read-only posts and other projects' posts never move; viewers move nothing. A month drop keeps the post's time of day; a week drop takes the slot's time (the repeated hour sends `fold`). A time the clocks skip offers the next valid time, a time that exists twice asks for earlier or later, and a calendar that is out of date (someone else changed the post) shows a notice and reloads; nothing is overwritten silently.
- **Limits:** at most 62 days and 500 posts per calendar request, and in the organization scope at most 20 projects (the view says when a period or the organization has more; narrow with the project filter).

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/social/calendar?from&to&accountIds&platforms&statuses&origins` | `social.read` |
| `GET /api/organizations/:workspaceId/social/calendar?from&to&projectIds&…` | organization member; per project `social.read` and the module on |

## Setting up the developer apps (for the owner of the installation)

1. **Meta:** create a Meta app of type Business. Add Facebook Login for Business and create a configuration with a *user access token* and the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`; note its configuration id. Valid OAuth redirect URI: `<Orbit address>/api/social/oauth/callback/meta`. People with a role on the app can connect their own Pages without App Review (Standard Access). **While the app is in development mode, only app members see its posts**; before public posting (S5) the app must be Live, which needs a privacy policy URL and the data-deletion callback URL `<Orbit address>/api/callbacks/social/meta-data-deletion` (requires `ORBIT_PUBLIC_INGRESS`).
2. **X:** create a project and app in the X developer portal with OAuth 2.0, type *confidential client* (web app), callback `<Orbit address>/api/social/oauth/callback/x`. X bills per use (as of 2026-11-02: a post $0.015, a post with a link $0.20); set a spending cap there.
3. In Orbit: create both apps as system connections with the JSON secrets above, grant them to the organization and then to the projects.
4. **Telegram:** create a bot with @BotFather for publishing only (not the project's Orbit bot) and make it an administrator of the channel with the right to post.

## Platform constraints known so far

| Platform | Constraint | Phase |
|---|---|---|
| Instagram | Images JPEG only, aspect ratio 4:5 to 1.91:1, at most 8 MB, at a public URL; at most 50 API posts per 24 h (read `content_publishing_limit` at runtime); captions ≤ 2200 characters, ≤ 30 hashtags | S3, S5 |
| Facebook | Posts of an app in development mode are visible only to app members; Page photos JPEG/PNG ≤ 4 MB; unpublished photos expire after about 24 h; text up to 63,206 characters | S5, S5b |
| X | `POST /2/tweets` 100 per 15 min per user; images ≤ 5 MB, up to 4 per post; refresh tokens rotate; text 280 weighted characters, X Premium accounts up to 25,000 (the SDK 0.5.0 `prepareTarget` knows only 280, so long posts are checked by Orbit and S5 calls the adapter's `publishTarget` directly) | S4, S5 |
| Telegram | ~20 messages per minute in a group or channel (documented for groups), 1 per second per chat; photo uploads ≤ 10 MB, captions ≤ 1024 characters | S5 |
