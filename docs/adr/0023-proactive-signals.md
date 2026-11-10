# ADR 0023: Proactive signals, notification dedupe, digests and per-user Telegram

## Status

Accepted, 2026-11-04. Mario answered D-18 on 2026-11-04 ([ADR 0021](0021-agent-platform.md) addendum "Phases 3 and 4"): in-app, e-mail and per-user Telegram in Phase 4. This ADR turns that answer and the [Phase 4 plan](../plans/agent-platform-phase-4.md) (§2.1–§2.5) into the design. Nothing here is live until its work package lands and `ORBIT_PROACTIVE` is switched on.

It extends [ADR 0021](0021-agent-platform.md) (work orders, events) and [ADR 0022](0022-personal-space-assistant.md) (personal space, notices, per-user cap). It also builds on the member notifications of WP4.7 (`docs/EMAIL_AND_NOTIFICATIONS.md`) and the owner bot of WP2.5b.

## Context

Orbit already emits content-free domain events and writes project-scoped member notifications (in-app plus e-mail through the project's mailbox), with preferences per project, user and kind. It has no dedupe key, digest, quiet hours or user-level view across projects. A broken connector can therefore produce hundreds of identical notices. Users also want to be told about urgent tickets, failed or finished agent work, aging approvals, budget thresholds and due tasks without asking, and some want those notices in Telegram.

## Decision

1. **Signals are deterministic and cost no AI.** A signal is a module or platform contribution (`ModuleContributions.signals`), fed either by a domain event or by a periodic detector on the existing due-marker pass. It returns fingerprints, recipients, a severity (`info | attention | urgent`), a title key, parameters (ids, counts, codes; no free text) and a link.
   - No new loop runs: periodic detectors are `PeriodicTask`s at hourly granularity (T4-2).
   - An AI model runs only at a defined processing step: the opted-in briefing summary (2 model calls, 4 tool calls, USD 0.05 ceiling by default, inside the user's assistant cap).
2. **No cross-project writes.** A signal writes ordinary `Notification` rows in the project where it happens, for recipients resolved with their current membership and module role there. Cross-project views (bell "All projects", bubble badge, briefing) read one project per transaction, as the approvals summary does.
3. **Dedupe by key.** `Notification` gains `dedupeKey`, `occurrences` and `lastOccurredAt`, with a partial unique index on `(projectId, userId, dedupeKey)`. The fingerprint carries its period bucket (for example `agent_failed:<agentId>:<code>:<utcDay>`).
   - A repeat increments `occurrences` and updates `lastOccurredAt`; it sends no new e-mail or Telegram message.
   - A row is marked unread again only when the severity rises.
   - The Phase 1 failure-notice guard is replaced by this key.
4. **Existing kinds are mapped, not re-detected.** Support's SLA and handoff notifications and Marketing's assignment notices join the signal feed and the digest through their existing senders. Nothing is detected twice.
5. **User-level delivery preferences** live in the user's personal space (a user-private entity `notification_preferences`, no migration):
   - quiet hours in the user's time zone;
   - the digest time;
   - e-mail and Telegram mode per severity (`immediate | digest | off`);
   - whether urgent signals break quiet hours (off by default).

   A per-project switch that turns a kind off still wins.
6. **Channels (D-18).**
   - **In-app:** always, subject to the per-kind switch.
   - **Immediate e-mail:** through the project's default mailbox, unchanged.
   - **Cross-project digest e-mail:** through the system SMTP channel, at most one per user and digest slot. It holds titles, counts and links only, never customer content.
   - **Per-user Telegram:**
     - **Linking.** The user connects a Telegram bot to their own personal space with the existing owner-bot flow (`platform/connections/telegram.ts`): their bot token, a one-time link code (10 minutes, stored as a hash) and `/start <code>` from a private chat. The personal space's only member is the user, so only they can link or see it.
     - **Delivery.** Notices from every project the user can access are rendered as short notice texts (title key, parameters, link) and sent to that chat once per dedupe key. The rules are the same as for e-mail: severity mode, quiet hours, digest. Customer content is never sent.
     - **Ending it.** Unlinking, `/stop` or a deactivated account end delivery at once. Losing access to a project ends that project's notices at the next send, because recipients are re-checked.
     - **Bot permissions.** The bot needs nothing beyond private-chat messages; no group or channel rights are requested. The webhook secret check of the owner bot applies unchanged.
7. **Budget thresholds.** `reserve` emits `platform.ai.budget_threshold_crossed` once per (layer, scope, period, threshold) at 80 % and 100 %, through an idempotent event key, so parallel reservations emit at most once. The event payload is content-free: layer, scope id, period, threshold and remaining bucket.
8. **Briefings.** Off by default.
   - **Settings** (per user, personal space): daily or weekdays, a local time, the included projects and the sections (approvals, agent work, urgent ticket counts, due tasks, budget status).
   - **Scheduling.** A personal-space scheduler contribution moves the due marker to the next slot in the user's time zone.
   - **Aggregation** is deterministic. It writes a `notice` message into a dedicated "Briefings" conversation (T4-1) and the digest e-mail.
   - **The AI summary** is opt-in: a read-only work order of the platform template `platform.briefing_summarizer`. If it fails, the deterministic briefing stands and a failure signal is raised.
9. **Realtime badge.** The notification writer publishes a content-free wake-up after commit on the recipient's personal-space channel. Without a personal space the client polls once a minute, as the bell does today.

## Alternatives

- **One user-level notification table outside projects.** Rejected: it needs a project-less RLS branch and breaks per-project retention and erasure.
- **An Orbit-wide shared Telegram bot for all users.** Rejected for now: it needs a platform bot token, a second webhook and an unlinked-user policy. The per-space owner-bot flow reuses audited code and keeps the bot under the user's control.
- **AI triage of notifications.** Rejected: detection stays deterministic (R4-1, cost).

## Consequences

- One additive migration (`Notification` columns and index). It needs a Coolify-approved schema hash before the `main` push.
- The system SMTP sender gets a second, low-volume use (digests). Its reputation is watched (R4-6).
- Users without a personal space get in-app and project e-mail only, with no digest, briefing or Telegram, until they first open the assistant.
- Rollback: `ORBIT_PROACTIVE=false` stops signals, digests, briefings and Telegram delivery. Written notifications and columns stay.
