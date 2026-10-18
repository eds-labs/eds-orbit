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
| `POST /tickets/:ticketId/merge` | assign | Moves the messages and closes the source ticket. Both tickets must belong to the same contact (`MERGE_CONTACT_MISMATCH`): merge the contacts first. |
| `GET /contacts`, `GET /contacts/:id` | read | Live contacts; a contact comes with its tickets. |
| `PATCH /contacts/:id`, `POST /contacts/:id/merge` | contacts | A merge moves the tickets and identities, then tombstones the duplicate. The tombstone keeps no name, address or notes. |
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
  2. **Threading.** It threads by `In-Reply-To` and `References` against the ticket's Message-IDs (merges followed), then by the subject token `[#<number>]`. Both count only when the sender is the ticket contact's correspondence address; anyone else opens a new ticket.
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
- Otherwise it is also mailed, but only to the contact's correspondence address. A claimed (typed, unverified) address is never mailed.

**Owners** create the embed key with `POST /inboxes/:inboxId/widget-key`. A new key revokes the old one.

**Platform changes.**
- A public GET route may `stream` (`PublicRoute.stream`). `serveEventStream` keeps the CORS headers through the hijack.
- The web proxy now forwards `Authorization` under `/api/public/`. Before, no public session could pass the proxy.

## Notifications and automations (WP5.5)

**Notifications.** The kinds go through the WP4.7 member notifications (`ORBIT_NOTIFICATIONS`). Each member sets in-app and e-mail per kind. The title names only the ticket number, never its subject or text, and links to the ticket.

| Kind | To | E-mail by default |
|---|---|---|
| `support_ticket_new` | every support agent (except the auto-assignee) | no |
| `support_ticket_assigned` | the new assignee, unless they assigned it to themselves | yes |
| `support_customer_replied` | the assignee, else every agent | no |
| `support_sla_at_risk` / `support_sla_breached` | the assignee, else every agent | no / yes |
| `support_ai_handoff` | the assignee, else every agent | yes |
| `support_mention` | an agent named as `@Name` in an internal note | no |

**Automations.**

| Automation | Behaviour | Switch |
|---|---|---|
| Auto-assign | `fixed` takes the inbox's default assignee while they are an agent. `round_robin` takes the agent after the inbox's last assignee. | `assignmentPolicy` |
| SLA timers | The per-project sweep raises `sla_at_risk` within 60 minutes of a pending due time and `sla_breached` after it, once per clock (first response, resolution), with a notification. Due times are set on create and recomputed on a priority change. | `sla` |
| Auto-close | Closes tickets waiting on the customer after `autoCloseDays`, counted from when they started waiting. | `autoClose`, `autoCloseDays` |
| Auto-acknowledgement | See the e-mail channel. | `autoAck` |
| Reopen on reply | See the e-mail channel. | `reopenOnReply` |

`rules` on the inbox (migration `202610180003`) switches each automation. A missing key keeps the project default.

## Support AI (WP5.6)

These are drafts for agents only; a person always sends (Q-17). The inbox switch is `aiMode`: `off` (default) or `draft`.

| Task | When | What it does |
|---|---|---|
| Triage (`support_triage`) | each new ticket | Suggests language, category, priority, sentiment and a one-sentence summary. An empty category is filled; priority stays the agents' call. The summary is an internal note, and the suggestions are an `ai_triage` event without text. |
| Draft (`support_draft`) | each customer message, or an agent's "AI draft" (`POST /tickets/:id/ai-draft`) | Retrieves `support`-audience knowledge (WP3.5) for the latest customer message, then asks the model for a reply that cites `fact:<id>` and `chunk:<id>`. |

**Checks on a draft**, before an agent sees it. The draft is withheld, and the ticket handed off, when:
- it has no citations, or cites an id it was not given;
- the evidence pack is invalid;
- it contains a forbidden promise or advice.

Without evidence, an internal gap note replaces the draft and the ticket is handed off. A draft the model is unsure about is kept, but the ticket is handed off too.

**Hard rules** (`modules/support/hard-rules.ts`). Trading or investment questions, account security, billing and legal matters go straight to a human, without a model call. The offline eval `evals/support/hard-rules.test.ts` requires recall 1.0 on its sensitive cases.

**Handoff.** `aiState` becomes `handed_off`, with a `handoff` event carrying the reason and the `support_ai_handoff` notification.

**Personal data (Q-12a, option B).**
- The model never sees the contact's name or any e-mail address; placeholders stand in, and the agent's draft gets the name back.
- The platform always sends `store: false`, and there is no trace export.
- Telemetry stores input hashes only.

**Who gets AI.** Anonymous widget visitors get no AI jobs; verified app users and e-mail customers do. An agent's "AI draft" also works after a handoff.

**Cost and limits.**
- A per-project daily support AI cap, `aiDailyBudgetMicros` (default 2 USD), on top of the project's mandate (`SUPPORT_AI_BUDGET_EXCEEDED`).
- A job's paid call is keyed to the job: a retried job never pays twice (`SUPPORT_CALL_UNKNOWN`), and a failure after a paid call ends the job (`SUPPORT_TASK_NOT_RETRIED`).
- Sensitive messages skip the triage call as well.
- The model never sees the contact's name in any form (full, parts, any case) or any e-mail address.
- The evidence pack loses the customer's query, and its history, once the draft is done.
- Category `support_text` under the project's spend mandate, with run budget `support:<ticketId>`.
- `AgentRun` kind `support` (migration `202610180004`).
- The ticket view shows the AI cost per ticket.
- Paid calls are never retried after a transmit (`SUPPORT_CALL_UNKNOWN`).
- A paused project gets no call; the worker blocks jobs and the call path checks again.

**The Orbit Assistant** gets `support_insights`, which returns counts only: no ticket content reaches the assistant's model.

**Paid eval** (`pnpm eval:support`, manual):
- 12 triage and 8 draft cases, synthetic;
- the routes as in production;
- a hard 3 USD ceiling, also enforced by the eval project's spend mandate, and a confirmation hash;
- the key from the keychain (`orbit-eval-openai`);
- a local database;
- a report of ids and numbers only.

The first run on 2026-10-17 cost $0.0227 and FAILED on one handoff case; see `docs/evidence/support-ai-eval-2026-10-17.json` and the status entry.

The second run on 2026-10-17, after the handoff instruction was sharpened, cost $0.0221 (`docs/evidence/support-ai-eval-2026-10-17-run2.json`). It handed off 2/2 but still FAILED: triage category and language reached only 10/12. The two misses, T09 and T11, are sensitive questions that the hard rules now hand off before any model call (review fix 4), so they get no model category or language by design. The eval still scores them as model triage.

**Not in the MVP:** the widget's AI first answer (`widget_answer`, Q-17).

## Statistics (WP5.7)

There are two routes:
- `GET /stats?from=&to=[&inboxId=&category=&agent=]` (permission `support.stats.read`);
- `GET /stats/export` with the same query, which returns CSV (`metric,value`).

Numbers are computed on read over the tickets **created in the range**, at most 5,000 (`truncated` says when the cap was hit).

| Metric | Definition |
|---|---|
| Volume | Total, by channel, inbox and category |
| First response | Median and mean minutes from creation to the first agent reply |
| Resolution | Median and mean minutes from creation to resolution |
| Backlog | Open tickets now, by age (< 1 d, 1–3 d, 3–7 d, > 7 d) |
| Reopen rate | Resolved tickets that a customer reopened ÷ resolved tickets |
| SLA | First responses within their due time ÷ first responses; `sla_breached` events |
| AI | Drafts, drafts followed by an agent reply ("used"), sent unchanged or edited, withheld, AI handoffs |
| Cost | AI cost (settled, else reserved) in total and per ticket with AI |

The web view sits under Support > Statistics: last 7, 30 or 90 days, per inbox, with a CSV download. There are no rollups yet; they come once measurements show a need.

## Privacy and operations (WP5.8)

**Owner routes:**
- `GET /contacts/:id/export`: JSON for a data-subject request;
- `POST /contacts/:id/erase`: deletes the tickets with their messages, attachments and events, the attachment files, identities and widget sessions, the mailbox rows of the contact's sent and received mails, the raw mail files, and the contact itself.

Both are audited with counts only.

**Retention.** The daily periodic task `support-retention` applies the Q-12b settings:
- closed tickets after `closedTicketMonths`;
- unsent AI drafts after `aiDraftDays`;
- widget sessions after `widgetSessionDays` since last seen;
- contacts without tickets;
- the raw files of mails support recorded, after `rawEmailDays`. The mailbox row keeps only `messageId`, `connectionId`, `uid` and `uidValidity`, and its history goes.

**Abuse caps:**
- 5 conversations per anonymous widget session;
- 20 customer messages per conversation in 10 minutes;
- 10 new e-mail tickets per sender and hour.

These come on top of the platform's rate limits.

**No content in telemetry.** A canary test checks that no message text or address reaches the audit, events, agent runs, spans or notifications.

**Runbook:** `docs/OPERATIONS.md`, section Support (mail outage, widget abuse, AI kill switch).

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
