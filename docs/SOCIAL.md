# Social module (`social`)

The social module connects a project's social accounts and publishes posts to them directly, without a managed publishing service. It owns accounts, posts with one variant per account, media, the calendar, scheduling, publication state and technical metrics. Marketing keeps strategy, campaigns, generation and its own approvals and will publish through this module. Decision: [ADR 0020](adr/0020-social-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-02-social-module.md](superpowers/plans/2026-11-02-social-module.md). Phase S1 plan: [superpowers/plans/2026-11-02-social-s1-module-skeleton.md](superpowers/plans/2026-11-02-social-s1-module-skeleton.md).

State on 2026-11-02: **phase S1 (module skeleton) on the branch `claude/social-module-plan`, not merged.** `ORBIT_SOCIAL` is off. No platform is connected, nothing can be published, and no SDK dependency is installed yet. Postiz remains the publishing path for Marketing.

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

Migration `202611020001_social_core`: `SocialAccount`, `SocialPost`, `SocialPostVariant`, `SocialPostMedia`, `SocialPublication`, `SocialDeliveryAttempt`, `SocialAccountThrottle`, `SocialOAuthState`, `SocialMetricSnapshot`, `SocialProviderState`. Every table is project-scoped with forced row-level security and composite same-project keys. Publication idempotency keys are unique. The business role cannot delete a publication (it goes with its post or project); delivery attempts and metric snapshots are append-only and deleted only by retention. Tokens are never stored here; they will be sealed `ConnectionSecret`s of project connections (ADR 0014).

## Boundaries

- Only direct platform adapters: `scripts/boundaries.json` → `forbiddenImportPrefixes` makes `pnpm lint` fail on any `@opencoredev/social-sdk/cloud…` import.
- Post media are private to the module (`files.privateToModule`).

## Routes (S1)

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/social/status` | `social.read` |
| `PUT /api/projects/:projectId/social/settings` | `social.settings` |

Later phases (S2–S12, see the programme plan) add accounts, OAuth, media, posts, approvals, the dispatcher, the calendar, MCP tools, analytics, the Marketing integration and the Postiz migration.
