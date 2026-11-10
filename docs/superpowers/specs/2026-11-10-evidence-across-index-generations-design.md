# Evidence across index generations

Date: 2026-11-10. Status: design approved in conversation (Mario chose variant A); spec awaiting review.

## Problem

`validateEvidence` (`packages/knowledge/src/index.ts`) rejects every evidence pack whose `indexId` is not the project's currently active index generation (`index_generation_changed`). Activating a new generation therefore invalidates every pending draft, support reply and other record that cites evidence, even when nothing it cites has changed.

This happened on production on 2026-11-10. The FamilyPlan GitBook read-in changed the corpus. The publication gate then required a new live-evaluated index (`LIVE_RAG_EVAL_REQUIRED`). Activating generation 5 made both drafts for the 18:30 slot fail with `EVIDENCE_INVALID`. Assignment runs that have finished cannot be retried, so the post had to be recreated by hand in Social. Site sources update weekly, so this will happen again with every new generation.

## Why the rule adds little protection

`docs/KNOWLEDGE_ARCHITECTURE.md` ("Controlled index generations") states that "execution preflight refuses evidence from a different active generation". The other checks already cover what the rule claims to protect:

- **Changed or removed knowledge** is caught per cited item. `validateEvidence` already rechecks evidence status and purpose, source rights, generation, embargo and audiences, fact versions and validity, the active document version, validity windows, freshness (`maxAgeHours`) and that each chunk still exists. Knowledge impact handlers also move dependent content back to review.
- **New knowledge** does not depend on generations. Documents added later are embedded into the *active* generation, and existing evidence stays valid while they are (FamilyPlan generation 3 held 735 embeddings against a 108-chunk manifest). A new generation is not the point at which new knowledge first becomes visible.

So the rule fires on one event only, index activation, and when it does it rejects evidence whose citations are all still valid.

What the rule does protect is retrieval quality. Evidence should come from a retriever that passed the live quality gate. That property is worth keeping, so it moves to the generation the evidence came from.

## Goal and success criteria

- Activating a newly evaluated generation leaves evidence valid when it came from a live-evaluated generation and every cited item still passes the item checks.
- Evidence from a generation that never passed a live evaluation (legacy baseline, synthetic test evaluation, failed or missing evaluation) stays invalid after a switch, as it is today.
- Every item-level check stays exactly as strict as today.
- No schema change, no migration, no provider calls, no new cost.

## Design

### Rule

In `validateEvidence`, replace

```
if (d.indexId && activeIndex.id !== d.indexId) reasons.push("index_generation_changed");
```

with: when `d.indexId` is set and differs from the active index id, load that origin index from the same workspace and project. The evidence counts as from an evaluated generation only if all of these hold:

1. The origin index exists in scope. A deleted index cascades its embeddings; missing means invalid.
2. Its stored evaluation has `passed === true`, `provenance === "live"` and `manifestHash` equal to the index's own `manifestHash`. The record belongs to this generation.
3. The evaluation was current when the evidence was created: `executedAt <= evidence.createdAt` and `evidence.createdAt - executedAt <= 30 days`. This uses the same window as `EVALUATION_MAX_AGE_MS`; reuse that constant rather than copying the number.

`activatedAt` is deliberately not checked. A rollback re-activates a retired generation and overwrites its `activatedAt`, which would wrongly reject evidence retrieved during its first active period. `retrieve` only ever uses the active generation, so the origin was active when the evidence was created. If a retired generation is evaluated again, its `executedAt` moves past older evidence and condition 3 rejects that evidence. This fails closed and is accepted, because evaluating a retired generation again is not a normal path.

If any condition fails, push `index_generation_changed`, as now. When the ids match, behaviour is unchanged: the publication gate (`validateActiveIndexEvaluation`) keeps guarding the active generation separately.

Evidence without `indexId` (records older than index generations) keeps today's behaviour: the check is skipped.

The rule deliberately does not check the embedding profile, the retriever and chunk versions beyond the evaluation record, or whether the origin index is still `retired` rather than `active`. Profile and versions describe how the evidence was found, which the evaluation already vouched for. The citations are revalidated item by item either way.

### Unchanged

- `validateActiveIndexEvaluation` and the `LIVE_RAG_EVAL_REQUIRED` publication gate: a release still needs a currently live-evaluated active index.
- Activation and rollback rules, manifests and corpus checks.
- Impact handlers and invalidation on source, fact or document changes.
- The reason code and its UI text (`index_generation_changed`, "The search index was replaced"). They still appear when the origin generation was never evaluated.

### Callers

Every caller of `validateEvidence` inherits the rule. These are the Marketing claim check and policy, generation, workflow duplicates, export, novelty and profile checks; platform retrieval, `knowledge_search` and shares; and Support through retrieval. No caller changes are needed. Evidence that used to fail only for `index_generation_changed` now passes when the origin generation qualifies.

### Error handling

The origin lookup runs inside the caller's scoped transaction, like the other reads in `validateEvidence`, so row-level security applies unchanged. A malformed evaluation record (missing fields, unparsable dates) counts as not evaluated, so the check fails closed.

## Testing

Integration tests in `packages/knowledge/tests/index-generations.integration.test.ts`, using its fixtures:

1. Evidence from a generation with a passed `live` evaluation stays valid after a second live-evaluated generation is activated, and after rolling back to the first one.
2. Evidence from a generation whose evaluation is `synthetic_test` reports `index_generation_changed` after a switch. The existing assertion around `oldEvidence` keeps covering this case.
3. Evidence created more than 30 days after its origin's evaluation reports `index_generation_changed` after a switch. Set `executedAt` back in time directly in the fixture.
4. Evidence created before its origin's evaluation ran (`executedAt` after `createdAt`) reports `index_generation_changed`.
5. Evidence from a qualifying origin whose cited chunk or document version has changed still fails with the item reason (`document_changed_or_expired` or `chunk_unavailable`), not with `index_generation_changed`.

Live provenance needs settled receipts. The fixture writes the evaluation record directly with `provenance: "live"` (test database only) instead of calling a provider.

Then run the Marketing policy tests that cover `EVIDENCE_INVALID` and the safety nets (`rls-matrix`, `access-matrix`) unchanged, followed by `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.

## Documentation

- `docs/KNOWLEDGE_ARCHITECTURE.md`, "Controlled index generations": replace "execution preflight refuses evidence from a different active generation" with the new rule. Add the reason to the `validateEvidence` paragraph: item checks cover changes, and the origin generation's live evaluation covers retrieval quality.
- `docs/IMPLEMENTATION_STATUS.md`: one entry.

## Rollout and rollback

- Risk: medium. It relaxes an integrity check that every module uses, without changing schema, data or cost. No feature flag; a flag would add a second code path for a single comparison.
- Delivery: commit to `main` after Mario's approval (a push deploys production). No schema hash is needed.
- Verification on production: `validateEvidence` on a FamilyPlan draft created under generation 5 stays valid after the next generation is activated. Until then, check read-only that the 10.11 drafts (generation 3, live evaluation of 26.10, created 10.11) would now pass. They are past their slot and stay expired.
- Rollback: revert the commit. Evidence returns to the strict rule; no data was changed.

## Out of scope

- The search-index display fixes (counting embeddings only within a generation's manifest; warning when the active generation's live evaluation is no longer valid). These are tracked separately.
- Retrying finished assignment runs, and warning before activation about affected drafts (variant C).
- Rebuilding evidence automatically on activation (variant B).
