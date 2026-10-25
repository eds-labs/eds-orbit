# MCP 2.0: delegated work orders

This extends the existing gateway; it does not replace the Orbit Assistant,
module services, specialist agents or approval system. Local implementation
only. Production rollout and live-client acceptance are separate steps.

## Architecture

`orbit_create_task` stores a private `Entity(kind=orbit_tasks)` and a native
ChatConversation, and creates a hash-bound `platform.task.start` ActionRequest in
one project-locked transaction. The idempotency key is scoped to project, user
and client. Reusing a key with different normalized arguments is rejected.

After the owner approves the exact start request, its callback creates the
normal ChatRun and `chat` job/outbox in the same transaction. The existing
worker calls `runChatJob`; there is no second orchestrator. Original grant and
token scope intersection, explicit task modules and mode narrow its tools.
Membership, module access and the active grant are checked before model calls
and each tool execution. Revoked/replaced grants stop future task execution;
a new connection must submit a new work order. An in-flight transmission cannot
be undone. The exact owner-approved chat ceiling is rechecked at approval and
before each model reservation, with a bounded share for each of the six possible
calls. The maximum includes an owner-configured OpenAI fallback from an
Anthropic route. The native provider budget/call plan, refusal handling and
settlement remain authoritative. A higher route/price ceiling requires a new request. Existing budget
reservations and unknown-outcome recovery apply.

Native module operations use the registered `OrbitTool`/ActionDefinition
contracts. Their adapters call the existing ticket, ingestion, fact, campaign,
package, image and scheduling services. Approving a mutation executes it or
queues its existing native job once; external clients never call the decision
endpoint. Repeating an approval returns the recorded result.

## Configuration and consent

- Existing prerequisites: `ORBIT_MCP_OAUTH=true`, `ORBIT_MCP_GATEWAY=true`, valid
  public resource/routing/JWKS and an authenticated, project-scoped OAuth grant.
- New functionality: `ORBIT_MCP_TASKS=true` (default false). Mutations also need
  `ORBIT_MCP_PROPOSALS=true`. Configure the flag consistently on API, MCP and worker.
- `orbit:read`: information and task/result reads.
- `orbit:propose`: draft/work-order/mutation proposals. It is not permission to
  approve or publish. Even a read-mode task needs a start approval because the
  Orbit Assistant can incur model costs.
- `orbit:write`: additionally permits internal tools in `execute` task mode;
  external writes still need their exact native approval. This scope is an
  explicit, initially unchecked option in the consent UI.
- `orbit:support`: explicit, initially unchecked consent to access ticket
  content through an external client. Counts-only `support_insights` keeps its
  original contract. Sensitive operations require both this scope and their
  normal risk scope. Contact addresses/names are omitted or replaced with the
  native Support AI placeholders before returning message content.
- `orbit:finance.read` / `orbit:finance.extract`: explicit, initially unchecked
  finance consents. The first is required (with `orbit:read`) for the finance
  document reads and for a task that names the `finance` module
  (`MCP_FINANCE_CONSENT_REQUIRED`); the second (with `orbit:propose`) for the
  owner-approved `finance_retry_extraction` proposal. Every scope in a tool's
  `mcpScopes` is required (all-of). Finance tools stay hidden, also from
  discovery, without their scope. See [Finance](FINANCE.md#mcp).
- `orbit:work`: explicit, initially unchecked consent for project management
  (ADR 0016): the five work reads (with `orbit:read`) and the four work
  proposals (with `orbit:propose`), which an owner or editor approves. See
  [Project management](WORK.md#assistant-and-mcp).
- `orbit:work.pm` and `orbit:work.coding` (ADR 0017, local; `ORBIT_WORK_PM`
  off): explicit, unchecked consents of the AI project manager. With
  `orbit:work` and `orbit:propose`, `orbit:work.pm` offers
  `work_pm_propose_plan` and `work_pm_propose_report` (paid from the PM
  budget; an owner or editor approves), and `orbit:work.coding` offers
  `work_pm_propose_coding_run` (the owner approves the exact redacted brief,
  which dispatches it). The PM reads (`work_pm_status`, `work_pm_findings`,
  `work_pm_get_report`, `work_pm_get_plan`) and `work_pm_propose_changes`
  need `orbit:work`. Delegated work orders may read the PM's state but are
  refused every PM tool that spends or dispatches. See
  [AI project manager](WORK.md#ai-project-manager-phase-2-adr-0017).
- Module roles, installation switches and project activation still apply.
  Support also needs `ORBIT_SUPPORT` and explicit per-project activation.
- Text generation needs the existing spend mandate, priced/verified model and
  budgets. Packages/images/assignments need their existing feature flags and
  native configuration. Readiness blockers (knowledge, RAG evaluation, channel
  verification, Drive reconnect, etc.) remain authoritative in native execution.

Existing clients must reconnect and explicitly consent to new optional scopes
before using capabilities they did not previously grant. No credential or
provider call is made by installing this code or turning on the new flag alone.

## Native Support completion

[Support MCP](SUPPORT_MCP.md) documents the canonical ticket tools,
`support_list_tickets`, `support_get_ticket`, `support_list_messages`,
`support_reply_ticket`, `support_add_internal_note` and the extended
`support_update_ticket`. Existing names below remain compatible. Reply/note
aliases share one idempotent operation identity. Replies bind their native
destination into the exact owner approval; action results project current
native delivery state. Internal notes and private drafts require the new
owner/editor `support.notes.read` permission in native and MCP reads/search.

## Tools

All new results include `schemaVersion: 1` except proposal receipts, which retain
the existing MCP proposal shape (`actionRequestId`, `deduplicated`, `approveUrl`).
Object schemas are strict. Service-side limits remain authoritative even when
model-facing schemas use null for optional fields. Response bodies stay under
the gateway's 64 KiB cap; lists expose opaque pagination cursors.

| Tool | Purpose |
| --- | --- |
| `orbit_create_task` | Persist an explicit module-scoped work order and start approval |
| `orbit_list_tasks` | Page the user's tasks created through this client |
| `orbit_get_task` | Status, phase, real agent/tool usage, blockers, approvals and artifact references |
| `orbit_get_task_result` | Durable assistant result and native generated artifacts |
| `orbit_cancel_task` | Cooperatively cancel the run and its pending approvals |
| `orbit_get_action_result` | Durable receipt/result of the client's approved module operation |
| `support_tickets` | Filter/search native tickets |
| `support_ticket` | Bounded message timeline with placeholder redaction |
| `support_statistics` | Existing native support statistics |
| `support_update_ticket` | Propose assignment, priority, close or reopen |
| `support_add_note` | Propose an internal native note |
| `support_prepare_reply` | Save an exact draft after approval; never sends it |
| `support_generate_reply` | Queue existing grounded, budgeted Support AI after approval |
| `support_send_reply` | Queue the exact approved reply through the existing native channel |
| `marketing_campaigns` / `marketing_content` | Page native campaigns and drafts |
| `marketing_performance` | Read previously imported native measurements |
| `marketing_create_campaign` / `marketing_update_campaign` | Validated draft-only campaigns |
| `marketing_prepare_package` | Prepare the existing multi-channel copy/artwork package |
| `marketing_request_image` | Prepare the native exact-prompt/image-ceiling request |
| `marketing_schedule_content` | Prepare native exact-content/date scheduling |
| `knowledge_sources` | Source rights, sync and freshness metadata |
| `knowledge_facts` | Facts passing the same K-1 and audience rules as MCP fetch |
| `knowledge_add_source` | Owner-approved source with explicit rights |
| `knowledge_add_document` | Native text/Markdown ingestion or versioned update |
| `knowledge_import_url` | Existing allowlisted website/GitBook sync job |
| `knowledge_propose_fact` | A candidate, never implicit verification |
| `knowledge_verify_fact` | Exact owner-verified values through native fact/conflict rules |
| `knowledge_withdraw_fact` | Version-bound withdrawal and downstream invalidation |

The original `orbit_profile`, `orbit_projects`, `search`, `fetch`,
`marketing_project_status`, `support_insights`, `orbit_action_status` and
`marketing_assignment_propose` retain their names and response contracts.
A complete marketing job uses the existing assistant campaign/package/assignment
and revision tools, including its native specialist workflows. Simple direct
operations complement that path. There is no project-management task board.

## Examples

Submit with the project's actual UUID, not a hard-coded deployment ID:

```json
{
  "name": "orbit_create_task",
  "arguments": {
    "projectId": "<project UUID from orbit_projects>",
    "idempotencyKey": "journal-campaign-2026-10-19-1",
    "description": "Research the Trading Journal using approved knowledge, prepare social copy and graphics, review the package and submit it for approval.",
    "modules": ["marketing", "knowledge"],
    "mode": "draft"
  }
}
```

Keep the returned task and action IDs. The owner follows `approveUrl`, reviews
the exact task/module/mode and maximum chat estimate, and decides in Orbit.
The start estimate covers the bounded chat model calls; child generation,
research and images keep their native ceilings and further approvals.

```json
{"name":"orbit_get_task_result","arguments":{"projectId":"<project UUID>","taskId":"<returned task UUID>"}}
```

Support: list with `support_tickets` (`q`, `status`, `priority`, `inboxId`,
`openOnly`, `cursor`, `limit`), read with `support_ticket`, then propose
`support_prepare_reply` with `ticketId`, `bodyText` and a new `idempotencyKey`.
Approval of that operation only creates a private native draft. Sending is a
separate `support_send_reply` proposal and approval.

Knowledge: propose `knowledge_add_document` with an existing `sourceId`, stable
`externalId`, title, text, language, MIME type and idempotency key. After owner
approval, native ingestion chunks it and it is lexically searchable through
`search`. Reuse `externalId` for a versioned update. Semantic indexing still
uses the separately budgeted embedding/index pipeline. Supported remote imports
retain the source's origin/path allowlist and ingestion queue.

## Events and reconnects

Every task advertises a resource URI `orbit://tasks/<projectId>/<taskId>`.
`resources/read` returns the same authorized durable snapshot. On protocol
2026-07-28, clients may send `subscriptions/listen` with
`params.notifications.resourceSubscriptions: [uri]`. The server acknowledges
with `notifications/subscriptions/acknowledged` and sends standard
`notifications/resources/updated` invalidations when state changes. Clients
read the resource or use the tools for the latest complete state.

This uses the installed SDK's resource subscription schema, not an invented
notification protocol or the optional Tasks extension. References:
[MCP 2026-07-28 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts),
[Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).

Streams use existing Redis realtime wakeups for the chat run when available,
with bounded periodic SQL replay for missed wakeups, approval changes and
revocation. They recheck token expiry and grant/module access. Each user/client/
workspace has at most two streams per gateway process, each with at most five
resources and a 60-second lifetime. Reconnect after the stream completes;
resubscribe and reread durable state after network loss. Clients using the
legacy 2025-11-25 protocol continue to poll the tools. No Tasks-extension or
2025-era session subscription capability is claimed.

## Native UI and data lifecycle

Orbit Chat shows a compact private work-order history, phase and blockers,
conversation/results link and cancellation. The existing approval inbox shows
the exact task or operation payload. Support changes appear in the same ticket
records; campaigns, packages, documents and facts use their normal module UI.

Tasks are private to the initiating user, and MCP reads also require the same
client identity. Project-wide exports exclude task records and strip operation
payload/receipt bodies from shared action rows. Project deletion cascades.
The existing owner retention action purges old terminal work orders, associated
private chat history and task-bound approval payload/history, in bounded batches.
A stopped task does not retract already approved downstream work or transmitted
calls; use the native module's cancellation/reconciliation controls for those.

## Deployment and rollback

No new table or schema migration, dependency or provider is required. Deploy the
code with `ORBIT_MCP_TASKS=false`, run existing gateway health/read conformance,
then independently enable the flag only under the deployment authorization.
Confirm module gates/rights, new optional consent, exact approval, native UI,
worker and subscription behavior in staging before production.

For rollback, turn the new flag off before returning to the previous image.
Pending MCP 2.0 approvals cannot execute with the flag off; owner rejection
remains available.
Do not retry a transmitted paid job or ambiguous external delivery. Saved
entities remain in PostgreSQL. The old image does not understand the new action
types; pause affected work and keep these approvals inert until the compatible
image is restored. Re-enabling requires rechecking current grants and budgets.

## Verification

Local evidence, reproduction steps and limitations are recorded in
`docs/evidence/mcp2-local-validation.md`, `docs/plans/MCP_2_0.md` and
`docs/IMPLEMENTATION_STATUS.md`. Tests use an isolated worktree database,
synthetic accounts and mocked model/provider calls. They never send a customer
reply or publish a social post. A real ChatGPT/dots/Claude connection and genuine
paid generation remain operator acceptance steps, not simulated test claims.
