# Social module (`social`)

The social module connects a project's social accounts and publishes posts to them directly, without a managed publishing service. It owns accounts, posts with one variant per account, media, the calendar, scheduling, publication state and technical metrics. Marketing keeps strategy, campaigns, generation and its own approvals and will publish through this module. Decision: [ADR 0020](adr/0020-social-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-02-social-module.md](superpowers/plans/2026-11-02-social-module.md). Phase S1 plan: [superpowers/plans/2026-11-02-social-s1-module-skeleton.md](superpowers/plans/2026-11-02-social-s1-module-skeleton.md).

State on 2026-11-02: **phases S1 (module skeleton) and S2 (developer apps, OAuth, token vault, accounts, Telegram channels) on branches `claude/social-module-plan` and `claude/social-s2`, not merged.** `ORBIT_SOCIAL` is off. Accounts can be connected and checked; nothing is published yet (S5). Postiz remains the publishing path for Marketing. S2 plan: [superpowers/plans/2026-11-02-social-s2-accounts.md](superpowers/plans/2026-11-02-social-s2-accounts.md).

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
| `approval` | `owner_each` | `owner_each`: the owner approves every publication; `editor_each`: editors with `social.approve` may approve too (S-D9). |
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

## Setting up the developer apps (for the owner of the installation)

1. **Meta:** create a Meta app of type Business. Add Facebook Login for Business and create a configuration with a *user access token* and the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`; note its configuration id. Valid OAuth redirect URI: `<Orbit address>/api/social/oauth/callback/meta`. People with a role on the app can connect their own Pages without App Review (Standard Access). **While the app is in development mode, only app members see its posts**; before public posting (S5) the app must be Live, which needs a privacy policy URL and the data-deletion callback URL `<Orbit address>/api/callbacks/social/meta-data-deletion` (requires `ORBIT_PUBLIC_INGRESS`).
2. **X:** create a project and app in the X developer portal with OAuth 2.0, type *confidential client* (web app), callback `<Orbit address>/api/social/oauth/callback/x`. X bills per use (as of 2026-11-02: a post $0.015, a post with a link $0.20); set a spending cap there.
3. In Orbit: create both apps as system connections with the JSON secrets above, grant them to the organization and then to the projects.
4. **Telegram:** create a bot with @BotFather for publishing only (not the project's Orbit bot) and make it an administrator of the channel with the right to post.

## Platform constraints known so far

| Platform | Constraint | Phase |
|---|---|---|
| Instagram | Images JPEG only, aspect ratio 4:5 to 1.91:1, at most 8 MB, at a public URL; at most 50 API posts per 24 h (read `content_publishing_limit` at runtime); captions ≤ 2200 characters, ≤ 30 hashtags | S3, S5 |
| Facebook | Posts of an app in development mode are visible only to app members | S5 |
| X | `POST /2/tweets` 100 per 15 min per user; images ≤ 5 MB, up to 4 per post; refresh tokens rotate | S5 |
| Telegram | ~20 messages per minute in a group or channel (documented for groups), 1 per second per chat; photo uploads ≤ 10 MB, captions ≤ 1024 characters | S5 |
