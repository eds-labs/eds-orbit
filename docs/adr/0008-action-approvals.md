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
