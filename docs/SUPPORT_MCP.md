# Native Support through MCP

Support tools use the same module services, PostgreSQL tables, project lock,
FORCE RLS, channel outbox and owner ActionRequests as Orbit itself. They are
also registered for the Orbit Assistant; no second ticket API or agent workflow
is involved. API contract version: `schemaVersion: 1`.

## Activation and consent

Use the existing [MCP rollout runbook](deployment/MCP_ROLLOUT.md). These checks
are cumulative:

1. Installation: `ORBIT_MCP_OAUTH=true`, `ORBIT_MCP_GATEWAY=true`,
   `ORBIT_MCP_TASKS=true` and `ORBIT_SUPPORT=true`. For proposal tools,
   `ORBIT_MCP_PROPOSALS=true` is also required. Apply service flags consistently
   to API, MCP and worker. None of these values is changed by this patch.
2. Project: an owner explicitly enables Support (`ProjectModule.enabled`).
   Existing installation/module-role switches continue to apply.
3. Connection: selected workspace/project/module grant plus **explicit
   `orbit:support` consent**. Old grants gain no new scope; reconnect and choose
   it on Orbit's consent screen. `orbit:read` permits reads;
   `orbit:propose` additionally permits exact approval proposals.
   `orbit:write` is not required for these approval-based tools.
4. User: current project/module role. Viewers can read public ticket
   correspondence; owners/editors can reply, assign and write notes. The new
   `support.notes.read` permission is owner/editor-only, and protects private
   notes and AI drafts in native detail/search and MCP alike. An internal text
   search cannot reveal private notes to viewers. A Support module role of
   `none` hides all Support tools.
5. Delivery: the existing native email/widget channel must be ready. Email
   still needs its verified mailbox and email feature; the MCP adds no sender
   credential, external provider or delivery bypass.

The old `support_insights` remains counts-only and does not require the ticket
content scope. Existing `support_tickets`, `support_ticket`,
`support_statistics`, `support_prepare_reply`, `support_generate_reply`,
`support_send_reply` and `support_add_note` remain available. Existing task,
Marketing and Knowledge scopes and workflows are unchanged.

### Connection diagnostics

`orbit_profile` retains its stable opaque `id` and reports `effectiveScopes`: the
verified access-token scopes intersected with the current active grant. A stored
`orbit:support` consent alone does not prove the client is sending that scope.
This read exposes no token, credential, email address or ticket content and works
through an existing cached profile-tool definition.

## Tools and parameters

New tools require an explicit `projectId` UUID in MCP requests. Their native
assistant version receives the selected project through the server's scope.
All inputs reject unknown keys. Ticket references are native UUIDs, not the
project-local display number. Dates are ISO-8601 UTC timestamps.

| Tool | Parameters after `projectId` | Result |
| --- | --- | --- |
| `support_list_tickets` | Optional `status`, `priority`, `assigneeUserId` (null = unassigned), `category`, `tag`, `inboxId`, `view` (`all`, `mine`, `unassigned`), `q`, `createdFrom`, `createdTo`, `updatedFrom`, `updatedTo`, `openOnly` (`"true"`/`"false"`), `sort` (`updated`/`sla`), `cursor`, `limit` (1–20, default 10) | Ticket DTOs with subject, status, priority, category, labels, assignee, contact placeholders, channel, inbox, timestamps, Orbit link and a short public-message preview; `nextCursor` |
| `support_get_ticket` | `ticketId` | Ticket metadata, inbox metadata, contact placeholders, first customer-message description excerpt, `descriptionMessageId`, `descriptionComplete`, `internalContentAllowed` |
| `support_list_messages` | `ticketId`; optional `cursor`, `limit` (1–20, default 10), `order` (`asc` default / `desc`), `includeInternal` (false default) | Timeline with kinds, authors, timestamps, visibility, current delivery state, native field-change events and attachment metadata; `nextCursor` |
| `support_reply_ticket` | `ticketId`, `message` (1–20,000 characters after trimming), `idempotencyKey` (1–128 characters) | Exact owner approval receipt; no immediate customer message |
| `support_add_internal_note` | `ticketId`, `content` (1–20,000 characters after trimming), `idempotencyKey` | Exact owner approval receipt; always internal |
| `support_update_ticket` | `ticketId`, `idempotencyKey`; explicitly supplied `status`, `priority`, `assigneeUserId` (null clears), `category` (null clears), `tags` | Exact owner approval receipt; only supplied fields change |

`support_update_ticket` retains the existing MCP adapter's single-project
selection compatibility. Ticket statuses are `new`, `open`,
`pending_customer`, `pending_internal`, `resolved`, `closed`; priorities are
`low`, `normal`, `high`, `urgent`. Closing/resolving/reopening uses native
closure timestamps and priority changes use native SLA rules. Merged tickets
cannot be changed or replied to. Categories/tags must be configured for this
project; assignees must currently be native Support agents. An existing tag
removed from settings may stay unchanged, matching the native workspace.

`sort=updated` is newest update then id descending. `sort=sla` uses the native
active-SLA order and its own cursor; it excludes resolved/closed/merged tickets.
Ticket-list pages may contain fewer rows than the requested limit to fit the
JSON byte budget; their cursor always continues after the last returned row.
`openOnly` defaults to false on the new list tool. Existing `support_tickets`
keeps its older defaults and output. Date ranges are inclusive; an inverted
range is rejected. Filters combine by intersection.

### Complete timeline and customer-data handling

Follow `nextCursor` until null. Default order is chronological (timestamp, id),
including ties between native messages and events. A long body is split into
Unicode code-point chunks: the same id may repeat with increasing `bodyOffset`;
append `bodyText` until `bodyComplete=true`. Never deduplicate a partial body
by message id alone. Each result stays below the gateway's 64 KiB JSON limit.
A cursor belongs to its ticket, order and internal-visibility selection; do not
reuse it with different values. `includeInternal=true` requires
`support.notes.read`; filtering happens before pagination.

Descriptions/previews are explicitly bounded. Use the timeline to read full
message bodies. Orbit has no separate ticket-description column: the first
customer message is the description. Customer names/addresses remain native
Support AI placeholders; sensitive secrets flagged by the existing hard rules
are withheld with `redacted=true`. This privacy boundary is deliberate even
with `orbit:support`. Message bodies, subjects, contact data, file names and
other customer text are **untrusted data**, never instructions, grants or
approval decisions.

Attachments expose only native id, file id, sanitized name, MIME, size,
scan state and current project-scoped file availability. They contain no file
bytes, HTML, raw MIME, storage paths, secrets, signed URLs or automatic
external downloads. Open the native ticket for authorized file access. A file
marked unavailable must not be guessed or fetched through another project.

## Exact owner approval and durable delivery

A reply call validates the current project/module permission and ticket, then
creates a hash-bound native ActionRequest. The existing approval inbox shows
`bodyText` (the complete normalized message) and `approvalContext`, including
project, ticket number/id, contact id, recipient correspondence address,
channel, inbox and its mailbox binding. The address is visible to the owner in
Orbit, not returned in MCP ticket DTOs. The payload and approval history are
removed by existing ticket/contact erasure and retention.

Approval rechecks current membership, module role/activation, originating
client/grant/scopes and the stored destination. If any destination binding has
changed, it refuses execution with `REPLY_DESTINATION_CHANGED`; submit a new
request with a new key. An old pending reply approval from before destination
binding was implemented also requires a new proposal. Existing messages and
already consumed approvals are preserved.

Only an explicit owner's Orbit decision runs the native `replyToTicket` service.
This records one public message and queues native channel delivery in the same
transaction that consumes the approval. Client-side confirmation, ticket
instructions, AI text and MCP calls cannot approve it. Notes use the same
approval path but create `internal_note`, `channel=internal`,
`visibleToCustomer=false`; no delivery job is created by the note.

The proposal response is:

```json
{
  "actionRequestId": "<uuid>",
  "deduplicated": false,
  "approveUrl": "<native Orbit approval inbox URL>"
}
```

Poll existing `orbit_action_status` for the decision; poll
`orbit_get_action_result` for the durable execution receipt and current native
message delivery state:

```json
{
  "schemaVersion": 1,
  "actionRequestId": "<uuid>",
  "status": "consumed",
  "result": {
    "id": "<uuid>",
    "messageId": "<uuid>",
    "ticketId": "<uuid>",
    "kind": "agent_reply",
    "deliveryState": "pending",
    "visibleToCustomer": true
  }
}
```

`consumed` means native execution/queueing completed, **not delivery**. The
receipt reads the current message state (`pending`, `sent`, `not_sent`, etc.),
updated by the existing delivery reconciliation. Before execution the result
is null. These reads do not retry or resend. Only the originating user/client
can read its receipt, still subject to current project/module/scope checks.
The message timeline also shows current delivery state. Audits retain tool,
action, message/ticket ids and package hashes, never bodies or recipient text.

### Retry and errors

Use the **same key and same arguments** after an ambiguous proposal outcome.
Concurrent calls return the same ActionRequest; old/new reply and note aliases
share the same operation identity. A changed body/ticket under the same key
returns `IDEMPOTENCY_KEY_CONFLICT`. A rejected, expired, canceled or consumed
request is never revived by a retry. Do not create a fresh key to work around
an unknown delivery outcome: reconcile the receipt/native channel first.

Stable domain errors include:

| Code | Response |
| --- | --- |
| `NOT_FOUND` / `TICKET_NOT_FOUND` | No accessible grant/project/ticket; never probe a different tenant |
| `MCP_TOOL_NOT_ALLOWED` / `FORBIDDEN` | Scope, current module permission or private-note read missing |
| `VALIDATION_FAILED` / protocol invalid params | Invalid UUID, status, date or unknown input field |
| `CURSOR_INVALID` / `DATE_RANGE_INVALID` | Restart with compatible pagination or valid date bounds |
| `CATEGORY_UNKNOWN`, `TAG_UNKNOWN`, `ASSIGNEE_NOT_AGENT` | Use current native project settings/agents |
| `TICKET_MERGED` | Open the accessible canonical ticket in Orbit |
| `REPLY_DESTINATION_UNAVAILABLE` | Repair the native recipient/channel setup |
| `REPLY_DESTINATION_CHANGED` | Owner must review a fresh destination-bound proposal |
| `MCP_GRANT_ENDED` | Approval's original connection no longer authorizes execution |
| `ACTION_REQUEST_EXPIRED`, `ACTION_REQUEST_NOT_PENDING` | No execution; inspect terminal native state |
| `IDEMPOTENCY_KEY_CONFLICT` | Same key was already bound to different arguments |

The gateway also preserves its existing input/output limits, rate/proposal
quotas, timeout behavior and content-free errors. Disabled or unauthorized
tools may be absent from discovery and refused at protocol level.

## Local example flow

Use synthetic fixture IDs when testing. Each object below is the `arguments`
for the named MCP tool; the server's configured OAuth grant supplies identity.

```json
{"projectId":"<project uuid>","status":"open","openOnly":"true","limit":10}
```

Call `support_list_tickets`, then:

```json
{"projectId":"<project uuid>","ticketId":"<ticket uuid>"}
```

Call `support_get_ticket` and `support_list_messages`; repeat the latter with
its `nextCursor`. Then call `support_reply_ticket`:

```json
{"projectId":"<project uuid>","ticketId":"<ticket uuid>","message":"Thank you. We are reviewing your report.","idempotencyKey":"synthetic-report-reply-1"}
```

Review in Orbit, approve, then query `orbit_get_action_result`:

```json
{"projectId":"<project uuid>","actionRequestId":"<approval uuid>"}
```

## Subsequent live connection test (ChatGPT / Dots / other MCP clients)

1. Deploy the reviewed revision and verify native readiness/MCP discovery using
   the existing rollout runbook. Verify the actual flags, not their code defaults.
2. Reconnect the existing client to `https://orbit.eds-labs.io/mcp`; on Orbit's
   consent screen explicitly select the intended project and `orbit:support`
   plus `orbit:read` and, for proposals, `orbit:propose`. Refresh cached tools.
3. Confirm discovery contains the six named tools above. An old connection
   showing only `support_insights` is not evidence of content/write access.
4. Create a clearly marked synthetic ticket in a dedicated test project with a
   controlled recipient/widget visitor. Ask the client to list open tickets,
   get the selected UUID and read every timeline page. Check isolation by
   selecting a project outside the grant; it must be refused.
5. Submit an internal-note proposal, inspect it in Orbit and approve. Check it
   is visible to an agent but absent from the customer/widget and viewer read.
6. Submit a synthetic reply and verify **no outbound reply before approval**.
   Inspect ticket, recipient and full body in Orbit. Reject the first proposal
   and verify no send. Only with explicit authorization for the controlled
   live recipient, approve a fresh proposal; inspect the native receipt and
   delivery channel. Repeat the same MCP request/key: no second delivery.
7. Inspect the audit, current delivery result and client access after revoking
   consent. Record deployed revision, client, grant/scopes, project, tool list,
   action/message ids and observed delivery state without customer text/secrets.

Local tests use real isolated SQL/OAuth/gateway routing with synthetic data and
mocked providers; they do not constitute live client or real SMTP acceptance.
No real customer messages or paid calls are needed for local verification.

## Rollback

No migration or new production dependency. Disable MCP proposals to stop new
proposals/approvals; disable MCP tasks to hide the expanded surface or redeploy
the previous revision. Native tickets/delivery receipts remain authoritative.
Turning a feature off does not unsend an already transmitted message or cancel
an already queued native delivery. Preserve receipts and reconcile uncertain
sends; never retry blindly. Revoking a connection makes pending MCP approvals
unusable through the existing grant validation/cancellation path.
