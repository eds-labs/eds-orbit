# ADR 0018: Issue center

## Status

Accepted by Mario, 2026-10-25. The plan is [`docs/plans/issue-center-phase-3.md`](../plans/issue-center-phase-3.md); Mario answered its questions Q-P3-1 to Q-P3-6 on 2026-10-25 and asked to start the implementation on 2026-10-26, after Phase 2 went live (`699c0e54`). Implementation is local on the branch `claude/issue-center-phase-3`; nothing is merged or deployed, and `ORBIT_ISSUES` is off. The MVP scope is the plan's §10 MVP; the GitHub App (WP3.10) and Sentry/monitoring sources (WP3.14) follow later with their own approvals.

## Context

Orbit has Support tickets, project management tasks (ADR 0016) and an AI project manager with handoffs and coding work orders (ADR 0017), but no notion of a product problem that many customers report, that development fixes in one or more tasks and that is eventually released. Support staff hand things over in comments; development sees customer data or nothing.

## Decision

1. **I-1 Own module.** A separate opt-in module `issues` (tables `Issue*`, permissions `issues.`, routes `/api/projects/:projectId/issues/…`, web `/p/:projectId/issues/…`, installation switch `ORBIT_ISSUES`, default off). Each object owns its status: tickets stay in Support, tasks in `work`, issues in `issues`. Cross-object effects are domain-event subscriptions with explicit rules.
2. **I-2 Reports and issues.** An issue aggregates 1..n reports (Support hand-in, manual entry, generic webhook, n8n; later GitHub, Sentry, monitoring) and 0..n implementing tasks. Reports are never deleted by a merge; they move to the surviving issue.
3. **I-3 Duplicates.** Cheapest first: exact fingerprint and external reference (may attach a report automatically), then lexical full-text candidates; vector and AI stages are opt-in, off by default. **Two issues are never merged automatically**; merges and lexical candidates need a person.
4. **I-4 Loop-free synchronization.** Rules S1–S7 (plan §2.6) run as subscribers: tasks move issues forward (`planned → in_progress → fix_ready`), deliveries move them to `released`, released issues leave an internal note and attention on the reporting tickets, issues touch tasks only through proposals. Writes carry the origin `issues.sync`; automatic moves are forward-only; the platform's event depth limit applies.
5. **I-5 Privacy by redaction.** Every stored report and issue text passes `platform/privacy/redact.ts` (profile `strict` by default: e-mails, phone numbers, IBANs, card numbers, IP addresses, tokens and credential URLs, wallet addresses and transaction hashes, given names). Raw payloads are not stored. Customer identity is never stored on issue rows; the only bridge is the `reported_in` link to the ticket, resolved with Support permissions. A coding brief from an issue needs an explicit "no personal data, reviewed" mark.
6. **I-6 Status machine.** `new → triage → needs_info | confirmed | duplicate | wont_fix`, `confirmed → planned → in_progress → fix_ready → released → verified → closed`, with reopen paths. `fix_ready` means merged or done, **not deployed**; `released` means observed or confirmed in production.

Mario's decisions of 2026-10-25 (plan §11): `ORBIT_MODULE_ROLES` in production after its security review, as its own step (Q-P3-1); issues per product project, in the Support project (Q-P3-2); the GitHub App after the MVP with its own approval (Q-P3-3); wallet addresses and transaction hashes are personal data, redacted by default (Q-P3-4); closed issues kept 36 months, diagnostics 12 (Q-P3-5); `fix_ready` automatic when all implementing tasks are done, `released` only with production evidence or explicit confirmation (Q-P3-6).

## Alternatives

- **Issues as a task type:** an issue aggregates many reports and may need several tasks or none; support staff would need PM permissions.
- **Issues inside Support:** issues also come from monitoring and development, and development must see them without customer data.
- **Automatic duplicate merges:** convenient, but a wrong merge loses the link between a customer and their problem.

## Consequences

- New tables (`IssueCounter`, `Issue`, `IssueReport`, `IssueEvent`, `IssueAttachment`, `IssueDuplicateCandidate`, `IssueExternalRef`, `IssueDelivery`) with FORCE RLS and composite keys; RLS and access matrices grow.
- New content scope `orbit:issues`; new task classes `issue_triage` and `issue_dedupe`; new connection provider `issues_webhook` and signed webhook provider for the public ingress.
- Support gains a hand-in, an event on contact erasure and a subscriber for released issues; `work` gains the handoff target `work.task_from_issue`.
- Enabling `ORBIT_ISSUES`, public webhooks, AI triage spend and module roles in production are separate approvals.
