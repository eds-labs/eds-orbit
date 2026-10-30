# ADR 0019: Bounded agent mandates for internal actions

## Status

Accepted, 2026-10-30. Proposed 2026-10-28 (Approval UX v2, plan [`docs/plans/APPROVAL_UX_V2.md`](../plans/APPROVAL_UX_V2.md)). Mario had the flag `ORBIT_AGENT_MANDATES` (code default `false`) switched on in production on 2026-10-30. No mandate exists until an owner creates one. This ADR extends [ADR 0008](0008-action-approvals.md) and [ADR 0002](0002-owner-mandates.md). It uses the spending authority of [ADR 0015](0015-ai-spend-policy.md) and changes no hard floor.

## Context

ADR 0008 defines risk classes and the approval modes `auto`, `auto_within_policy`, `approval_required`, `approval_required_reauth`, `ui_only` and `forbidden`. The code implements only `approval_required`:

- `ActionDefinition.approvalMode` has the one value `approval_required`.
- `riskClass` accepts only `C1`, `C2`, `W2` and `W0_internal`.
- `approvedOperation()` (`platform/tasks/operation-tools.ts`) gives every assistant and MCP write the class `W2` and the mode `approval_required`, whatever the operation does.

The WP-M4 addendum of ADR 0008 chose this on purpose: until a looser mode existed, the strictest mode was the safe default for MCP. As a result, an internal preview that publishes nothing needs the same owner click as a public post. Owners approve many requests whose risk they already accepted with the AI spending authority, and the useful approvals get lost among them.

There is one standing authorization: the Support inbox rule `mcpOwnerRepliesWithoutApproval`. It is limited to one operation, one inbox and the owner's own MCP calls. It is a module setting, not a platform mechanism, and this ADR does not change it.

A spending authority (ADR 0015) answers "how much paid AI may run". It does not answer "which actions may an agent take without asking". Reading a budget as a general permission would turn every budget into a blanket approval.

## Decision

1. **Risk classes in code.** `ActionDefinition.riskClass` takes the full ADR 0008 set: `R0`, `W0`, `C1`, `C2`, `W1`, `W2`, `D1`, `D2`, `F1`, `F2` and `G` (the legacy `W0_internal` stays readable). Each operation names its class; `approvedOperation` keeps `W2` as the default, so an operation without a class is treated as before.
2. **Mandatable types.** An action type can be covered by a mandate only if its definition sets `mandate` (a code constant with its title, scope text and largest cost per action). Only the internal classes `W0`, `C1` and `C2` may set it. `W1`, `W2`, `D1`, `D2`, `F1`, `F2`, `G`, infrastructure, operations with a direct external effect (`mcpDirectEffect`) and the Support reply are never mandatable. A test fails if one of them is marked. Marking a type is a reviewed decision of its own, like `mcpProposable`.
3. **Agent mandates.** A platform entity kind, `agent_mandates`, stores one versioned record per project and action type. It has FORCE RLS, versions, export and retention like every entity, and no migration is needed. The record holds:
   - the action type;
   - who it covers: the requesting members (by default only the owner who grants it), the Orbit Assistant, and MCP clients (separate, off by default, optionally limited to named client ids);
   - the window (`startAt`, `endAt`, at most 90 days);
   - a cost limit per action, which can never exceed the type's own limit;
   - a number of actions per UTC day;
   - for types that generate images, an optional separate rights consent (point 7);
   - `grantedBy`, `grantedAt`, and `revokedBy`/`revokedAt` once revoked.

   Saving deactivates the older record of the same type. Revoking writes a new inactive version. The audit events are `agent_mandate.granted` and `agent_mandate.revoked`. Granting and revoking are governance actions (`G`, `ui_only`): only an owner in the authenticated web UI can do them. No MCP tool, assistant tool, prompt or imported document can create, widen or extend a mandate.
4. **One decision function.** `resolveAuthorization` (`platform/governance/authorization.ts`) decides, deterministically and on the server, whether a new request runs under a mandate. Its inputs are the stored request (type, requester, cost limit, payload), the action definition, the active mandate, the grantor's and requester's current roles, the MCP grant, the spending authority and today's count. The requester cannot pass a mode or class. The function returns `auto_within_policy` with the mandate, or `approval_required` with the codes of every failed condition:
   - `ORBIT_AGENT_MANDATES` is on and the type is mandatable (point 2);
   - an active, unexpired, unrevoked mandate exists for the type;
   - its grantor is still an owner in the type's module;
   - the requester is covered: the requesting member is named, the channel (assistant or MCP) is covered, and an MCP request comes from a covered client whose grant still proposes in this project (`mcpGrantStillProposes`, with the type's scopes). Delegated work orders (MCP 2.0 tasks), specialist tasks of assignment runs and requests on behalf of another member are not covered;
   - the request's cost limit is within the mandate's limit;
   - a paid type (`C1`, `C2` with a limit above 0) has an active spending authority that allows paid use now;
   - the day's count of mandate approvals for the type is below the mandate's number (counted in the project transaction, which holds the project lock);
   - the type's own `mandate.check` accepts the payload (for example, which art modes a creative mandate covers).
5. **Execution.** When the result is `auto_within_policy`, the request is decided by the existing `decideActionRequest`, with the grantor as the deciding owner and the channel `mandate` (mandate id and version). Every existing guard of a decision therefore runs unchanged: the role, version and hash, expiry, the MCP grant guard, `revalidate`, single use. The request records `authorization {mode, mandateId, mandateVersion}`. The audit event `action_request.auto_approved` names the mandate, the requester kind, the MCP client and grant, and the cost limit, never the payload. Paid work still reserves against the spending authority (`reserve`), which enforces the daily, monthly, per-run and organization limits. A mandate is never a budget and never raises one.
6. **Revocation and expiry.** A revoked or expired mandate authorizes no new request. Work already approved under it checks the mandate again immediately before payment (the reservation transaction). If the mandate ended, nothing is paid and the work stops with `AGENT_MANDATE_ENDED`. After a reservation, the existing rules apply: a transmitted call is settled or stays an unknown outcome, and it is never sent again.
7. **Rights stay separate.** A passed technical QA never approves usage rights. Approved brand assets are used as before. Art that Orbit generates under a mandate becomes approved only if the owner gave the mandate's separate rights consent. That consent is stored with its exact scope (mandate id and version, image model and ceiling at grant time), is recorded on the asset as `rightsSource`, and applies only while the image route still matches. Without it, the art stays an unapproved reference, and the creative stays `needs_rights` until the owner decides. External and unclear assets always need an owner decision. The consent is checked in the reservation transaction, immediately before payment; an image paid under a mandate that was in force then keeps the consent even if the mandate is revoked while the provider call runs.
8. **MCP one step stricter.** This replaces the WP-M4 sentence "a looser mode … must stay one step stricter for MCP requests" with a concrete rule: MCP coverage is a separate opt-in of the mandate (off by default, optionally per client). It also needs the grant's `orbit:propose` and module scopes, at creation and at decision. The assistant and MCP use the same function, so neither channel can obtain more than the other.
9. **Failures.** If the execution of a request approved under a mandate fails (its revalidation or the operation itself), the whole proposal transaction rolls back and the caller gets the error; nothing is stored or run, and the caller may propose again.
10. **Publishing never under a mandate.** Publishing, scheduling, Postiz drafts, external messages, ad spend, deletion, budget and governance changes keep their approvals (`W1`, `W2`, `D*`, `F*`, `G`). A preview made under a mandate is not a publishing approval (`approval.publishing = "not_requested"`).

## Alternatives

- **Relax `approvedOperation` to `auto_within_policy` for every internal operation.** Rejected: the owner never decided it, and a budget would become a blanket permission.
- **Treat the spending authority as the mandate.** Rejected for the reason above (ADR 0015 grants spend, not actions).
- **A module setting per operation, like the Support inbox rule.** Rejected as the general mechanism: every module would build its own, with its own checks. The Support rule stays as it is.
- **A new table.** Rejected for the same reasons as ADR 0015: entities already bring RLS, versions, export and retention.

## Consequences

- Fewer approval clicks for internal work an owner has explicitly delegated. Every automatic approval is still an ActionRequest with a decision, an audit event and single use.
- A new owner surface (Settings → Agent permissions) and a mandate column in the approvals history.
- The approval inbox shows the reason for each remaining approval (risk class, external effect, missing mandate).
- Rollback: set `ORBIT_AGENT_MANDATES=false`. Every request then needs an approval again, and stored mandates stay in place but are inert.
