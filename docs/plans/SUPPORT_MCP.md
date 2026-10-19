# Native Support MCP completion

Risk: high. Environment: isolated local development. Primary profile:
backend-api, supplemented by fullstack-saas and ai-agent-app. Existing
TypeScript/Fastify/PostgreSQL modular-monolith stack; feature workflow.

## Plan and acceptance

1. Extend the native ticket query/timeline service for assignee/date filters,
   permission-aware internal content and chronological keyset pagination.
2. Register `support_list_tickets`, `support_get_ticket`,
   `support_list_messages`, `support_reply_ticket` and
   `support_add_internal_note`; extend `support_update_ticket`. Preserve the
   existing tools, shared registry, module roles and ActionRequests.
3. Snapshot the reply destination in the hashed approval payload; show it in
   the existing approval inbox and refuse changed destinations at execution.
   Return content-free durable receipts with current native delivery state.
4. Test SQL-backed and HTTP/OAuth flows using synthetic tickets and mocked
   providers; run full lint/typecheck/test/build, boundary, Compose and schema
   generation checks. Document rollout, client reconnect and rollback.

## Threats and safeguards

- Foreign project/workspace ids: current membership, module activation,
  OAuth scopes, module permission, explicit project predicates and FORCE RLS.
- Internal notes/search side channels: editor/owner-only internal-content
  permission; filter before pagination and full-text matching.
- Reply injection/destination changes: imported text is untrusted data;
  proposing cannot approve. Project, ticket, channel, contact and exact body
  are hash-bound. Current role/grant/destination are rechecked at approval.
- Duplicate/expired/rejected requests: existing project transaction lock,
  client/user/key identity and single-use ActionRequest decision/consumption.
- Large messages and attachments: bounded JSON output, resumable body chunks,
  metadata only for native authorized attachments, no storage credentials.
- Customer privacy: preserve native model placeholders/sensitive-text rules;
  no message bodies or addresses in audit, telemetry or exception messages.

## Test strategy

SQL integration: read filters/cursors, message chunks/ties/internal visibility,
foreign ids/tenants/module roles/scopes/flags, exact reply approval and one-time
delivery enqueue, reject/expiry/conflicts/recipient change, notes, partial
ticket changes, durable delivery receipts and content-free audit. HTTP/OAuth:
tool discovery and calls, input/output schemas, scope refusal, native approvals.
Regression: existing MCP, main assistant, support workspace, RLS/access matrix
and worker dispatch; full repository suite with no paid/customer calls.

## Deployment and rollback

No migration, new dependency or production mutation is required for local
completion. Existing flags and explicit OAuth consent remain authoritative.
Release/activation follow the existing rollout runbook. Roll back by disabling
MCP proposals/tasks or redeploying the prior commit; native tickets and queued
delivery receipts remain authoritative. Do not retry an ambiguous delivery.

## Authorized main delivery

The existing user instruction to commit/push the MCP work to main and let
Coolify deploy it is retained. The current owner-approved workflow at
`6dac139` explicitly delivers authorized work directly to main after relevant
local checks, without a required pre-push GitHub CI gate. Integrate it and
Knowledge fix `f1827f5` before the fast-forward push; never force-push.

Production change plan: code-only Support MCP completion, risk high. No new
migration, dependency, secret, feature flag or customer/provider action.
The pre-delivery application was `running:healthy`; Coolify deployment
`vn3ucops2kj5vcd2wb77nbwv` finished with `6dac139` and is the verified code
rollback target. Existing persistent-data backups/configuration remain
unchanged; there is no data transformation requiring a restore. Post-push
monitor the automatic deployment's exact commit and completion, native
readiness and public OAuth metadata. A live client/content/send acceptance
requires its explicit consent/feature activation and controlled test recipient.
