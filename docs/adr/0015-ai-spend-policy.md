# ADR 0015: AI spending authority as a platform capability

## Status

Accepted by Mario, 2026-10-24 (decisions E-2 to E-7 in [orbit-architecture-cleanup.md](../plans/orbit-architecture-cleanup.md)). This ADR completes ADR 0009 AD-10 step 2. Implementation is local and nothing is deployed.

## Context

ADR 0009 AD-10 kept the AI spend mandate as a projection of the active Marketing policy (`Entity.kind = "policies"`). It deferred separate storage "until a non-marketing module needs paid AI".

That condition has been met. The mandate now authorizes every paid model call:
- the assistant chat
- Support triage and drafts
- Finance extraction
- Knowledge embedding, reindexing and evaluation
- Marketing

The coupling has three consequences (findings F1, F2 and F7 of the plan):
- Only Marketing can write the mandate (`savePolicy`, collection owner `marketing`). With Marketing off, an owner cannot create or change it.
- `requireSpendMandate` validates the whole Marketing schema. A malformed publishing field therefore stops paid AI in every module.
- Every approval request outside four types needs an active Marketing policy, including requests that spend nothing.

## Decision

1. **Own record.** The spending authority is a platform entity kind, `ai_spend_policies` (E-2). It uses the same versioning, export, retention and row-level security as every entity. Its fields:
   - `startAt` and `endAt`;
   - `approvedPaidUse`;
   - `dailyBudgetMicros`, `monthlyBudgetMicros` and `perRunBudgetMicros`;
   - `profile`: `off`, `test`, `normal` or `custom` (E-4).

   It is versioned like the Marketing policy: a save deactivates the older rows and creates a new active row with `activatedBy` and `activatedAt`. The audit events are `ai_spend_policy.activated` and, for the backfill, `ai_spend_policy.migrated`. Only owners may write it.
2. **Authority and transition.**
   - When an active `ai_spend_policies` record exists, it is the mandate. `requireSpendMandate` and `activeSpendMandateRef` return it.
   - `reserve` enforces its limits even when the caller passes other limits (Marketing callers pass their policy today).
   - Without such a record the old projection applies. It reads only the budget fields of the active Marketing policy and no longer validates publishing fields.
3. **No change to Marketing records.**
   - The migration and the platform service never write a `policies` row. Package hashes, policy versions and assignment checks therefore stay as they are.
   - The Marketing editor stops editing budget fields. It sends the effective values unchanged and links to the AI & budget page.
4. **Backfill.** `scripts/ai-spend-policy-backfill.ts` copies the budget fields of each project's active Marketing policy into a new active `ai_spend_policies` row.
   - It records `sourcePolicyId` and `sourcePolicyVersion`.
   - It is idempotent and skips projects that already have a record.
   - It runs read-only by default; `--apply` writes.
   - A production run needs its own approval.
5. **Approvals.** `ActionDefinition` gets `requires` (`spend_mandate`, `publishing_policy`, or neither).
   - The default for an existing type keeps today's behaviour, so a definition without `requires` behaves as before.
   - Non-spending types are relaxed one by one after review (E-5).
   - A request records `spendPolicy {id, version}` next to the legacy `policy`.
6. **Surfaces.**
   - The platform owns Settings → AI & budget: status, spending authority with profiles, the budget layers, and module caps read-only (E-3).
   - Marketing keeps "Publishing rules".
   - The platform also takes over project readiness (aggregated from module contributions), the approval inbox, Telegram activation (`ORBIT_TELEGRAM`, default `ORBIT_AGENTS`) and an installation-wide Marketing switch (`ORBIT_MARKETING`, default `true`, E-7).
   - `Project.mode` moves into the Marketing settings, and the field stays readable (E-6).

## Consequences

- Projects without Marketing can authorize and use paid AI.
- There are two possible sources until the legacy fallback is removed (phase 3.8, only after evidence and a separate approval).
- Removing the fallback requires every project to have a platform record.
- Marketing heuristics that read their own policy's budget (for example batch sizing) can differ from the platform record until the next Marketing save. Enforcement is unaffected, because `reserve` uses the platform record.
- Rollback: delete nothing. Set `ORBIT_SPEND_POLICY_SOURCE=fallback`, so the Marketing budget applies without a platform record, or `marketing`, so the platform record is ignored.
- **Fallback removed by default (plan 3.8, Mario 2026-10-25).** After the production backfill gave every project a platform record, the default `platform` reads only the platform record. `reserve` also refuses a caller's own Marketing budget without one. The test suite runs in `fallback` mode (`tests/setup.ts`) because most suites seed only a Marketing policy; dedicated tests cover the strict default.

## Alternatives considered

- **A separate Prisma table.** Rejected by Mario (E-2). It would need its own export, retention and RLS code.
- **Rewriting the Marketing policy without budget fields.** Rejected because it changes policy versions and package hashes (incident `PACKAGE_CHANGED`, 2026-10-12).
