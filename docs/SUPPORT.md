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

## Agent workspace (WP5.2)

These routes also sit below `/api/projects/:projectId/support`, and every one of them goes through the support gate.

| Route | Permission | Notes |
|---|---|---|
| `GET /tickets` | read | `view` is `mine`, `unassigned` or `all`. Filters are `status`, `inboxId`, `category` and `priority`. `q` searches the subject, the contact, and the message full text including internal notes. Results come with a keyset `cursor` and `limit` ≤ 50. |
| `GET /tickets/:ticketId` | read | The ticket, its contact and inbox, and a timeline of messages (with attachments) and events. |
| `POST /tickets/:ticketId/replies` | reply | Stored as `pending`; the channel jobs (WP5.3/WP5.4) deliver it. Sets the first response and moves the ticket to "waiting on customer". Attachments must be live support files. |
| `POST /tickets/:ticketId/notes` | notes | Internal; never shown to the customer. |
| `PATCH /tickets/:ticketId` | assign | Status, priority, category, tags and assignee, with one event per change. A priority change recomputes the pending due times. The assignee must be a support agent. |
| `POST /tickets/:ticketId/merge` | assign | Moves the messages and closes the source ticket. |
| `GET /contacts`, `GET /contacts/:id` | read | Live contacts; a contact comes with its tickets. |
| `PATCH /contacts/:id`, `POST /contacts/:id/merge` | contacts | A merge moves the tickets and identities, then tombstones the duplicate. |
| `GET /agents` | read | Members whose support role is owner or editor. |
| `GET /summary` | read | Open, unassigned, at-risk (due within 60 minutes) and overdue counts. |

**Web module** (`apps/web/src/modules/support`):
- the inbox, which shows the open ticket beside it on wide screens and alone on phones (`?ticket=`);
- the contacts page;
- the "Support" settings tab with inboxes (the widget secret is shown once), categories, SLA and retention;
- a home tile.

The module is opt-in in the web shell too. It stays hidden until the server lists it as enabled, so it never shows while `ORBIT_SUPPORT` is off.

## E-mail channel (WP5.3)

The channel uses the project's mailbox from WP4.7 (`ORBIT_EMAIL`, SMTP and IMAP; see `docs/EMAIL_AND_NOTIFICATIONS.md`) and platform files for the raw MIME and the attachments.

- **Inbound.** The platform polls IMAP, stores each mail and queues `support_email_inbound`. Support then does the following:
  1. **Routing.** It routes the mail to the live e-mail inbox whose address is among the recipients, else to the only one. An unroutable mail is audited and dropped.
  2. **Threading.** It threads by `In-Reply-To` and `References` against the ticket's Message-IDs (merges followed), then by the subject token `[#<number>]`, but only from the ticket's own contact.
  3. **Reopening.** A customer answer to a ticket that is waiting on the customer, resolved or closed reopens it, while `reopenOnReply` is on.
  4. **Attachments.** Allowed types only (images, PDF, text, CSV), at most 10 per mail. Others are skipped and counted.
  5. **Dedupe.** Each mail is recorded once per Message-ID.
- **Loop protection.**
  - Automatic mail (auto-replies, lists, bulk, mailer daemons) never opens a ticket, reopens one or gets an acknowledgement. When it threads, it is only appended.
  - Bounces are the platform's.
- **Acknowledgement.** New tickets get an automatic mail in the inbox's language with the ticket number, while `autoAck` is on, at most 3 per contact in 24 hours.
- **Outbound.**
  - Replies and acknowledgements go through `queueEmail` with `Re: <subject> [#<number>]`, `In-Reply-To` and `References`. The message's `externalId` is the Orbit Message-ID.
  - The platform job never resends after an ambiguous transmit.
  - The periodic `support-email-delivery` copies the outcome onto the message: `pending`, `sent`, `rejected`, `not_sent`, `unknown`, or `bounced` (migration `202610180002`).
  - Without the e-mail flag, a verified mailbox or a contact address, a reply is `not_sent`.
- **Not in the MVP.** HTML bodies are not kept; the text part is. A reply token in the address (`support+token@`) is not used, because the mailbox may not support plus-addressing.

## Livechat widget (WP5.4)

The widget's public API lives at `/api/public/support/<publicKey>/…`. It is mounted by the platform (WP4.2b) and needs `ORBIT_PUBLIC_INGRESS`; live updates need `ORBIT_REALTIME`. App teams: see `docs/SUPPORT_WIDGET.md`.

| Route | Purpose |
|---|---|
| `POST /session` | Platform: a bearer session, 12 hours. |
| `POST /identify` | Anonymous with an e-mail, which stays a claim on a contact of this session. Or verified: `externalUserId` plus the HMAC `signature`. |
| `GET` and `POST /conversations` | The visitor's conversations; open one. |
| `GET /messages?ticket=&after=` | Messages the customer may see, numbered from 1. Internal notes and AI drafts are never included. |
| `POST /messages` | The customer's next message. It reopens the ticket like e-mail does. |
| `POST /handoff` | "Talk to a human": the AI state becomes `handed_off` and the ticket opens. |
| `GET /stream?ticket=` | Server-sent events with `Last-Event-ID` resume. The platform adds the key's CORS header. |

**Visibility.**
- A verified user sees their tickets in the inbox.
- An anonymous visitor sees only the tickets their session opened.
- Anyone else gets 404.

**Delivery of agent replies.**
- While the visitor was seen in the last 2 minutes, the reply is `sent` in the widget.
- Otherwise it is also mailed to the contact's address or claimed address, threaded so a mail answer lands in the same ticket.

**Owners** create the embed key with `POST /inboxes/:inboxId/widget-key`. A new key revokes the old one.

**Platform changes.**
- A public GET route may `stream` (`PublicRoute.stream`). `serveEventStream` keeps the CORS headers through the hijack.
- The web proxy now forwards `Authorization` under `/api/public/`. Before, no public session could pass the proxy.

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
