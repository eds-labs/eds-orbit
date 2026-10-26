# Issue center (`issues`)

The issue center collects product problems that customers, staff and connected systems report. It groups their reports into issues and follows each issue through its tasks to the production release. Decision: [ADR 0018](adr/0018-issue-center.md). Plan: [plans/issue-center-phase-3.md](plans/issue-center-phase-3.md). Privacy assessment: [SECURITY_REVIEW.md](SECURITY_REVIEW.md#issue-center-adr-0018-prepared-2026-10-26-local-only).

State on 2026-10-26: implemented locally on the branch `claude/issue-center-phase-3`. It is not merged or deployed, and `ORBIT_ISSUES` is off.

## Terms

| Term | Meaning |
|---|---|
| Issue (`ISS-12`) | One product problem: type, severity, priority, components, status. It aggregates 1..n reports and is implemented by 0..n tasks. |
| Report | One inbound signal from a Support hand-in, a person, a signed webhook or n8n. It is stored redacted and never as a raw payload. |
| Duplicate candidate | A possible pair of issues found by the lexical stage. A person confirms it (merge) or rejects it (never proposed again). |
| Delivery | A record of what happened to a fix: PR opened or merged, deployed to an environment, verified. Records are append-only. |
| Share review | An editor's or owner's mark: "no personal data, reviewed". It is needed before an issue's fields go into a coding brief. |

## Switching it on

Three layers, as for Support, Finance and project management ([MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)):

1. Installation: `ORBIT_ISSUES=true` (default `false`). While it is off, every route answers 404 `ISSUES_DISABLED`. Tools, jobs, subscribers, the retention task and the attention items are inactive.
2. Project: an owner enables Issues in Settings → Modules.
3. Member: permissions below; module roles (`ORBIT_MODULE_ROLES`) may narrow them per member.

Public webhook sources also need `ORBIT_PUBLIC_INGRESS=true`.

## Permissions

| Key | Default roles | Covers |
|---|---|---|
| `issues.read` | owner, editor, viewer | issues, redacted reports, dashboard, releases |
| `issues.report` | owner, editor | new issues and reports, Support hand-in (with `support.tickets.read`) |
| `issues.triage` | owner, editor | fields, status, assignee, merges, duplicate decisions, tasks, deliveries, share review, AI triage |
| `issues.diagnostics.read` (sensitive) | owner, editor | the diagnostics block of reports; never exposed through tools or MCP |
| `issues.github` (sensitive) | owner | reserved for the GitHub App (WP3.10, after the MVP) |
| `issues.settings` | owner | components, categories, thresholds, automation, retention, inbound sources |

A typical role setup with module roles: support staff `support: editor`, `issues: editor`, `work: none` or `viewer`; developers `support: none` or `viewer`, `issues: editor`, `work: editor`. Developers then see redacted issues and a "Support ticket (restricted)" placeholder instead of ticket titles (Q-P3-1).

## Data and privacy

- Tables `IssueCounter`, `Issue`, `IssueReport`, `IssueEvent`, `IssueAttachment`, `IssueDuplicateCandidate`, `IssueExternalRef` and `IssueDelivery` (migration `202610260001_issues_core`). All are project-scoped with FORCE RLS and composite same-project keys. The business role cannot delete reports, history or deliveries; they go only with their issue.
- Every stored text passes strict redaction (`platform/privacy/redact.ts`): e-mail addresses, phone numbers, IBANs (check digits), card numbers (Luhn), IP addresses, tokens, JWTs and credential URLs, wallet addresses and transaction hashes, and the names the caller knows. Reports keep counts of what was removed, never the removed text.
- Raw payloads are not kept. After processing, the intake job drops the stored webhook body from the platform's row and its versions (`scrubWebhookBody`).
- Issue rows carry no customer identity. The only bridge to a customer is the `reported_in` link to the ticket, which resolves with Support permissions.
- History rows, audits and domain events hold ids, keys and field names only.

## Status

```
new → triage → needs_info | confirmed | wont_fix
confirmed → planned → in_progress → fix_ready → released → verified → closed
```

- `duplicate` is reached only by a merge.
- `fix_ready` means merged or done, **not deployed**. Only `released` means in production.
- People move issues along the allowed transitions; reopen paths are `released/verified → in_progress`, `wont_fix → triage` and `closed → triage`. A new report on a closed issue reopens it into triage.
- Automatic moves (sync rules) go forward only. The single exception is S7: a reopened task takes a `fix_ready` issue back to `in_progress`.

## Intake and sources

Every source runs through `intake.ts`, in this order:

1. Bound: integrations are capped per project and day (default 500); members are not capped.
2. Normalize and redact.
3. Match: a known external reference attaches the report (stage 2). Otherwise the fingerprint of an open or recently closed issue attaches it (stage 1, `autoAttachFingerprint`).
4. If nothing matched, create a new issue in `new` and look for lexical duplicate candidates.

| Source | How |
|---|---|
| Support hand-in | Ticket → "Report as product issue". The agent writes or takes over the text (preview with what was removed); the contact's name and addresses are replaced. Sensitive tickets (hard rules) need an acknowledgement. The ticket itself is unchanged. Support reaches the issue center only through the platform's handoff registry (`issues.report`). |
| Manual | The list's "Report an issue" form, or a report on an existing issue. |
| Webhook / n8n | Contract [`issues.report.v1`](integrations/issues-report-v1.md): `POST /api/hooks/issues/<workspace>/<project>/<source>`, HMAC-signed like the customer context contract. Sources are created in Settings → Issues; the secret is shown once. |
| MCP | `issues_propose_report`, and `support_report_issue` for a ticket (both scopes). |

## Duplicates

Two issues are never merged automatically. The lexical stage scores candidates by title overlap, text overlap and shared components, with light stemming and a fixed German/English glossary of product terms (`duplicates.ts`). Candidates above `suggestThreshold` (default 0.35) appear in the issue and in the triage queue. Rejected pairs are remembered. A merge moves reports, attachments, external references and links (tickets stay linked, now to the kept issue) and copies delivery records. Eval: [evals/issues-dedupe](../evals/issues-dedupe/README.md).

The vector and AI judge stages are not built (settings fixed to off).

## Tasks and synchronization

"Create task" uses the work module's handoff target `work.task_from_issue`. The task is built from the issue's redacted, curated fields and is linked to the issue with `implements`. The issue must be confirmed first; the member also needs `work.write`.

The `issues.sync` subscriber follows plan §2.6:

| Rule | Trigger | Effect |
|---|---|---|
| S1 | task in progress, in review or blocked | issue → in progress |
| S2 | all tasks finished, at least one done (`autoFixReady`) | issue → fix ready |
| S3 | delivery "merged" with no open task | issue → fix ready |
| S4 | delivery "deployed" to a production environment while the issue is fix ready | issue → released |
| S5 | issue released | Support: internal note and attention on each reported ticket; no customer message |
| S6 | issue closed (won't fix, duplicate, closed) with open tasks | attention item; tasks are never changed |
| S7 | a done task reopened | fix ready → in progress |

Loop safety: no rule writes the object type of its own trigger (a test checks the rule table). Writes carry the origin `issues.sync`, which the subscriber ignores. Moves are forward-only, and the platform stops event chains deeper than five.

## Deliveries and releases

In the MVP a triager records deliveries manually: merged, deployed per environment, verified. Production environments are a setting (default `production`). The Releases view lists fix-ready and released issues with their deployments per environment. A person's "verified" record moves a released issue to verified.

## AI triage

Task class `issue_triage`, run kind `issues`: one structured call without tools on redacted texts. It runs within the spend mandate and the module's own daily ceiling (default USD 0.50). It suggests type, severity, priority, configured components, questions for the reporter, reproduction steps and whether to create a task now. The suggestion is stored on the issue; a triager applies the chosen fields. AI triage is off by default for new issues (`triage.aiEnabled`); a triager may ask for one issue at a time.

## Dashboard

Counts (open, critical, new in 7 days, awaiting triage, fix ready, released in 30 days, duplicate candidates), critical and most reported issues, breakdowns by component, source and status, the age of open issues and median lead times over 90 days. A figure without data shows "—".

## Assistant and MCP

| Tool | Kind | Scopes |
|---|---|---|
| `issues_search`, `issues_get`, `issues_stats`, `issues_duplicates` | read; never diagnostics | `orbit:issues` |
| `issues_propose_report`, `issues_propose_update`, `issues_propose_merge` | proposals decided by an editor | `orbit:issues` |
| `issues_propose_task` | proposal decided by an editor | `orbit:issues` + `orbit:work` |
| `support_report_issue` (Support) | proposal decided by the owner | `orbit:support` + `orbit:issues` |

## Retention and erasure

- Closed and merged issues go after `closedIssueMonths` (default 36). Their reports, history, deliveries and candidates go with them. Report diagnostics are emptied after `diagnosticsMonths` (default 12). The task runs once a day.
- When Support erases a contact, it publishes `support.contact.erased` with the ticket ids. The issue center replaces those reports' texts with "[removed on erasure]", keeps their counts, and clears an issue's title or summary that was still the report's text.

## Rollout runbook (each step needs Mario's approval)

1. Merge to main. The push deploys the additive migration `202610260001_issues_core`, which also widens the `AgentRun.kind` check by `issues`.
2. Set `ORBIT_ISSUES=true` in Coolify and redeploy. Check that `/api/health/ready` is OK and that `GET /issues/overview` answers 404 in projects without the module.
3. Q-P3-1: enable `ORBIT_MODULE_ROLES` after its security review, before inviting developers who must not see Support.
4. Enable Issues in the Support project (uLiquid, then FamilyPlan, Q-P3-2), configure components and production environments.
5. Optional: AI triage. Route `issue_triage` in Settings → AI and set the ceiling; the first live run is its own approval.
6. Optional: an n8n source. This needs `ORBIT_PUBLIC_INGRESS`, a source in Settings → Issues and the secret in n8n's credentials.
7. Later: the GitHub App (WP3.10), Sentry and monitoring (WP3.14), each with its own approval.

## Rollback

Set `ORBIT_ISSUES=false` and redeploy: everything stops and nothing is deleted. Links to issues show as unavailable. The migration is additive; dropping the tables is a separate, explicit decision.

## Not built in this phase

- GitHub App, inbound GitHub issues, automatic deployment detection (WP3.10).
- Sentry and monitoring sources (WP3.14).
- Vector and AI judge duplicate stages.
- Attachment routes (the table exists).
- The work module's PM subscriber for issue recommendations; the triage suggests whether to create a task instead.
- S6 creates an attention item instead of a task proposal.

## Testing

`apps/api/tests/issues-*.ts` (schema, services, routes and webhook intake, Support hand-in, triage with a scripted model, sync rules, MCP, retention), `privacy-redact.test.ts`, `evals/issues-dedupe/`, `apps/web/src/modules/issues/issues.test.tsx`, and the e2e spec `apps/web/tests/issues.spec.ts` (`E2E_ISSUES=1`, needs a stack).
