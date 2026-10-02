# ADR 0008: Generic action approvals

## Status

Accepted by Mario, 2026-09-30 (alignment plan decision D4, default matrix as written in plan §9.3). Extends [ADR 0002](0002-owner-mandates.md); it does not weaken any existing gate.

## Context

Orbit has five approval flavours with the same core idea but separate storage and code: package-hash approvals for publication (`policy.ts`, `Entity(kind="approvals")`, fixed 24-hour expiry), chat proposal confirmation (`ChatProposal`), signed Slack decisions, the owner live-draft-once action and Postiz draft handoff confirmation. Agents will propose more side effects (Postiz drafts, images, weekly plans), so approvals need one model.

## Decision

1. Actions carry a risk class: `R0` read, `W0` internal write, `C1` paid AI in mandate, `C2` material paid generation, `W1` external non-public write, `W2` external public write, `D1` local deletion, `D2` external deletion, `F1` paid media creation, `F2` budget change, `G` governance.
2. Approval modes: `auto`, `auto_within_policy`, `approval_required`, `approval_required_reauth`, `ui_only`, `forbidden`.
3. Default matrix (plan §9.3): research, planning, analysis and drafts are `auto`; paid model calls are `auto_within_policy`; image generation, Postiz drafts, Drive saves, publishing and schedule changes default to `approval_required` and a project policy may relax them to `auto_within_policy`; local deletion is `approval_required`; external deletion, budget changes and governance changes are `ui_only`; ad campaign creation is `approval_required_reauth`; infrastructure actions are `forbidden`.
4. Hard floors (`D1`, `D2`, `F1`, `F2`, `G`, infrastructure) are code constants. No policy, prompt, imported document or model output can relax them. Agent-initiated actions default one step stricter than user-initiated ones where the mode is configurable.
5. A shared `ActionRequest` record holds action type, risk class, resolved mode with policy version, requester (user, agent run or workflow), package hash, versioned payload reference, optional cost ceiling, per-action-type expiry, decision (user, time, channel, re-authentication) and atomic single-use consumption.
6. Agents never execute side effects. A proposal tool creates the request; the deterministic executor runs after the decision with preflight at claim and immediately before the provider call. Agent runs resume after approval only when they must reason about the approved result.
7. Migration is incremental: existing flows get adapters onto `ActionRequest` one by one; their user-visible behaviour and tests stay unchanged until each adapter is accepted.

## Alternatives

Keeping five flavours avoids a migration but lets approval rules drift. SDK `needsApproval` alone would keep approvals inside run state, which the SDK documentation itself says must be authenticated and consumed server-side.

## Consequences

One approvals inbox and one audit trail for web, Slack and later Telegram decisions. Expiry becomes configurable per action type instead of the fixed 24 hours.

## Addendum 2026-10-02: storage and first consumers

Decided by Mario with the [Orbit Core plan](../plans/ORBIT_CORE_JARVIS_PLAN.md) (D-J2).

- `ActionRequest` is stored as `Entity(kind="action_requests")` without a migration (`apps/api/src/modules/action-requests.ts`). It inherits FORCE RLS, optimistic versions and `EntityVersion` history. It is not a generic collection, so the generic collection routes neither list nor write it.
- Fields: `actionType`, `riskClass`, `approvalMode`, `policy` (id, version), `requestedBy` (user, or agent on behalf of a user), `payload`, `packageHash` (canonical hash of type and payload), `costCeilingMicros`, `status`, `expiresAt`, `decision` (user, decision, time, channel) and `consumedBy` (execution, time).
- Action types are code constants: risk class, approval mode, deciding role and expiry cannot be changed by a policy, prompt, document or model output. The first type is `image.generate`: `C2`, `approval_required`, owner decision, 24 hours. Its payload is bound to the image model and per-image ceiling configured at creation; a different configuration at decision or execution makes it stale.
- A decision must match the version and hash that were shown, comes from an authenticated user and never from the worker's scope, and is idempotent for a repeated identical click. Expired, rejected or already decided requests cannot be approved.
- Approval queues one single-attempt job. The worker runs it with the decider's current project role. The approval is consumed in the same transaction as the budget reservation, after every other precondition, so a failed precondition leaves it unused. A reservation without a result is an unknown outcome and is never sent again.
- Existing approval flavours are unchanged. Content-package start and the decision route follow with the Orbit Core packages (PR2, PR3); publication approvals come later as adapters.
- Second action type (2026-10-02, PR2): `content_package.start`, `C1`, `approval_required`, decided by the requesting editor or owner, 24 hours. Its payload is the deterministic package plan; at decision time the plan is rebuilt from current data and must hash identically (`PACKAGE_STALE` otherwise). Approval creates the package's draft-only missions and generation jobs in the same transaction.
- Owner inbox (2026-10-02): `GET …/action-requests` lists pending, unexpired requests that need an owner, with the exact prompt and ceiling; an editor's package image waits there until an owner decides it.
- Third action type (2026-10-02, Orbit Core J3.1): `content.schedule`, `W2`, `approval_required`, owner only, 24 hours, no cost. Its payload is one package post as proposed: content id and version, text, asset, channel, slot, execution mode and the publishing package hash (`packageFor`, which covers policy, evidence and publisher). At decision time the post and the slot are rechecked (`SCHEDULE_STALE`, `SCHEDULE_SLOT_TAKEN`). Approval lets the draft-only mission publish exactly this post until its slot (audited as `mission.publish_authorized`), records the owner's review of the shown text, records the assisted-mode approval until the slot, and calls `publishIntent`; the request is consumed in the same transaction, and any preflight blocker rolls the whole decision back. The existing publisher still runs its full preflight immediately before the handoff.
