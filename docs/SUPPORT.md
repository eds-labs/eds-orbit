# Support module

The support module is Orbit's own ticket and communication system (Phase 5, `plans/orbit-modularization/06-support-readiness.md`). WP5.1 adds its skeleton:
- tables;
- permissions;
- settings;
- inbox management;
- ticket creation;
- the channel adapter contract.

Channels, the agent workspace, notifications, AI, statistics and privacy operations follow in WP5.2–WP5.8. The pilot is WP5.9.

The decisions behind it are in `plans/orbit-modularization/10-support-pilot-decisions.md`: Q-12, the retention defaults and the pilot inbox.

## Switching it on

Support is opt-in twice:

1. **Installation:** `ORBIT_SUPPORT=true`. The default is `false`.
2. **Project:** an owner enables the module, which writes an explicit `ProjectModule` row with `enabled = true`. Enabling modules needs `ORBIT_MODULES=true`.

The explicit row is required because, while `ORBIT_MODULES` is off, the platform counts every module as enabled, except modules that are off by default: those count only where an owner enabled them. This is how the platform's enabled set treats support's tools, jobs and similar contributions too.

While `ORBIT_SUPPORT` is off, the module is **unavailable**:
- none of its contributions count anywhere, not even while `ORBIT_MODULES` is off;
- projects do not list it;
- owners cannot enable it;
- members cannot get a module role for it;
- every support route answers 404.

A project where support is not enabled gets 404 `SUPPORT_DISABLED`, or `MODULE_DISABLED` while module switching is on.

## Data

There are eight project tables (migration `202610180001_support_core`). All of them have FORCE RLS, the `project_scope` policy and grants for `orbit_app`.

| Table | Holds |
|---|---|
| `SupportInbox` | Entry points: an e-mail address and/or a widget with its allowed origins, an encrypted widget secret, defaults and the AI mode |
| `SupportContact` | Customers per project: the correspondence e-mail, stored lowercased and unique while live; a `claimedEmail` that a widget user typed but nobody verified, which is never used for matching; a tombstone `deletedAt` |
| `SupportContactIdentity` | A host app's user id per inbox and channel, verified by the widget's HMAC (WP5.4) |
| `SupportTicket` | Tickets: the per-project number, status, priority, category, tags, assignee, SLA due times and AI state |
| `SupportMessage` | The timeline: customer messages, replies, internal notes, AI drafts and system entries, with a full-text vector (`simple` configuration) |
| `SupportAttachment` | Links from messages to platform files (`docs/PLATFORM_FILES.md`) |
| `SupportTicketEvent` | Status, priority, assignee and category changes, with field values only |
| `SupportTicketCounter` | The last ticket number per project, so numbers are never reused, even after deletions |

Foreign key checks bypass RLS. Every reference between support rows is therefore a composite `("projectId", id)` key, so a row can only point at rows of its own project. Attachments reference `File` the same way.

**Personal data (Q-12a).** Message text, subjects, names and e-mail addresses stay in these tables. Audit entries and ticket events carry ids, counts and field values, never content.

## Permissions

| Key | Default roles |
|---|---|
| `support.tickets.read` | owner, editor, viewer |
| `support.tickets.reply` | owner, editor |
| `support.tickets.assign` | owner, editor |
| `support.notes.write` | owner, editor |
| `support.contacts.manage` | owner, editor |
| `support.stats.read` | owner, editor, viewer |
| `support.settings.manage` | owner (sensitive) |

Module roles (WP4.5, `ORBIT_MODULE_ROLES`) apply:
- a member with support role `none` does not see support;
- a support role can never grant `support.settings.manage`, because inboxes set CORS origins and hold widget secrets.

## Settings

The settings are stored versioned in the module's `ProjectModule.settings`. They are read and saved through the generic `platform/modules/settings.ts` helpers.

| Setting | Default |
|---|---|
| `categories` | none (key and label; at most 50, unique keys) |
| `sla` (first response / resolution, minutes, 24/7) | urgent 240 / 720, high 480 / 1440, normal 1440 / 4320, low 4320 / 12960 |
| `autoAck`, `reopenOnReply` | on |
| `autoCloseDays` | 7 |
| `retention` (Q-12b) | closed tickets 24 months (at most 72), raw e-mail 90 days, unsent AI drafts 90 days, widget sessions 30 days |

Retention is enforced by WP5.8.

## API

Every route sits below `/api/projects/:projectId/support`.

| Route | Permission | Notes |
|---|---|---|
| `GET /settings` | read | `{ settings, version }`; the defaults until saved |
| `PUT /settings` | settings | `{ settings, version }`; a stale version gives 409 `SETTINGS_VERSION_CONFLICT` |
| `GET /inboxes` | read | Never contains the widget secret, only `hasWidgetSecret` |
| `POST /inboxes` | settings | Returns `widgetSecret` **once** when the inbox has a widget |
| `PATCH /inboxes/:inboxId` | settings | `{ version, …changes }`; 409 `INBOX_VERSION_CONFLICT`, 409 `INBOX_ARCHIVED` |
| `POST /inboxes/:inboxId/rotate-widget-secret` | settings | The new secret, once; the old one stops working |
| `POST /inboxes/:inboxId/archive` | settings | No new tickets; existing ones stay |

Further rules:
- An e-mail inbox needs an address, and a widget inbox needs at least one exact origin.
- The AI mode is `off` (the default) or `draft`. A widget answer without a human follows only with WP5.6, after Q-17.

## Tickets and channels

`createTicket` (`modules/support/tickets.ts`) is the one entry the channels use for a customer's first message. In order, it:
1. checks that support is active, the inbox is live and the inbox has the channel;
2. returns the existing ticket for a channel message id it has already seen;
3. finds the contact by verified identity, then by e-mail, skipping deleted contacts, or creates one. A verified user id joins an existing contact by e-mail only when the channel also verified the e-mail (`emailVerified`); otherwise anyone could attach themselves to another customer's history.
4. takes the next number from the project's counter under the project lock, so numbers are never reused;
5. sets the SLA due times from the settings;
6. writes the message, its attachments, the `created` event and the audit entry.

The channel contract is `SupportChannelAdapter` (`modules/support/channels/adapter.ts`). E-mail (WP5.3) and the widget (WP5.4) implement it. There is no adapter yet.

## Rollback

| Step | Effect |
|---|---|
| Keep or set `ORBIT_SUPPORT=false` | Everything is unreachable again. |
| Disable the module per project | That project's support routes stop. |

The tables stay in both cases. The migration is additive; dropping the tables would need its own approved migration.
