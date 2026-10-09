# Agent review evals

Measures the Orbit Agents review step on the review set `review-v1.json`
(21 cases: 8 good drafts to approve, 12 bad ones to reject, one bare host to
leave for the owner). Every case goes through the production review step
(`reviewStep` in `apps/api/src/modules/agents/specialists/review.ts`):
Orbit's deterministic checks first, then the review specialist's real
instructions, output schema and model call through `runSpecialist` (reserve,
markTransmitted, settle on the `agent_review` route). Only synthetic data is
used, in a project created and deleted per run, and only against a local
database (`EVAL_DATABASE_NOT_LOCAL` otherwise).

## Offline (normal test suite)

- `review.offline.test.ts` replays recorded answers through the review step;
  it never calls a provider.
- `live-dry-run.test.ts` tests the plan, the confirmation gate, the ceiling,
  the local-database check and the pass rule.
- `live-harness.test.ts` runs the live harness end to end with replayed
  answers: verdict classes, metrics, the ceiling stop, the cleanup, and that
  a review request stays below the planning bound.

## Live run (manual, budget-capped, rollout Approval J)

`pnpm eval:agent-review` runs `live.eval.ts` through `vitest.eval.config.ts`.
It is not part of `pnpm test`. Only the review call is real: the copywriter
draft that gives the cases their shape (`generate`, `embed`) is a stub, and
a round-1 `revise` is recorded as such without running the revision (the
production review can call the model up to three times per draft: review,
copywriter revision, second review). The harness refuses to run without
those stubs (`EVAL_STUBS_REQUIRED`). No Telegram bot is linked, so no
notification is queued.

1. **Dry run.** Source the local environment (database only; do not export a
   real key there) and run `pnpm eval:agent-review` without the variables
   below. It prints the dataset version, the cases, the `agent_review` route,
   the planned review calls (at most one per case; the cases the set expects
   the deterministic checks to decide make none), the worst-case estimate,
   the cost ceiling, the dataset hash and the confirmation, and transmits
   nothing.
2. **Review.** Check the plan. The route comes from `review-route-v1.json`
   and mirrors the effective production `agent_review` route; if an
   `agent_review` route has been saved in production since, copy it there
   first. Two values are printed:
   - the **dataset hash** covers the cases, the route and the ceiling;
   - the **confirmation** is a hash of the dataset hash, the complete rate
     card (every price field of every model), its `verifiedAt`, the route and
     the ceiling, so any later edit of one of them invalidates the approval.
3. **Live run.** Mario runs, with the local environment sourced:

   ```sh
   ORBIT_EVAL_OPENAI_API_KEY=<key> ORBIT_EVAL_CONFIRM=<confirmation> pnpm eval:agent-review
   ```

   `ORBIT_EVAL_CONFIRM` must equal the confirmation printed by the dry run for
   the same inputs (`EVAL_CONFIRMATION_MISMATCH` otherwise; the dataset hash
   alone is not accepted). A missing or blank key with a confirmation is
   `EVAL_KEY_REQUIRED`. A key or a confirmation alone never falls back to a
   silent dry run: the missing half is an error.

| Variable                    | Meaning                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORBIT_EVAL_OPENAI_API_KEY` | Key for this run only. Stored like the production configuration (encrypted) in the synthetic project and deleted with it. Never printed or written. |
| `ORBIT_EVAL_CONFIRM`        | Confirmation value from the dry run (not the dataset hash).                                                                                         |
| `ORBIT_EVAL_MAX_USD`        | Lowers the cost ceiling in USD. Default and maximum: 1; a higher value is clamped to 1.                                                             |

Safeguards:

- The ceiling is a hard limit across the whole run. It is the synthetic
  project's daily, monthly and per-run budget, and each review task may
  reserve at most what remains of it (`AGENT_LIMIT` otherwise); the run stops
  at the first refused reservation. No call is ever sent twice.
- Prices come from the generation eval's rate card
  (`evals/generation/candidates-v1.json`) with the same rule: older than 31
  days fails with `EVAL_RATE_CARD_STALE`, future-dated with
  `EVAL_RATE_CARD_FUTURE`, before any transmission. A route whose model has
  no price there fails with `EVAL_ROUTE_NOT_PRICED`.
- If the run stops early (budget refusal, unknown outcome, unexpected error),
  the stop reason is printed prominently, the partial report is still
  written, and the command exits non-zero.
- Results are written to `docs/evidence/agent-review-eval-<UTC timestamp>.json`
  and `.md`. They contain metrics only: per case the verdict class, the
  expected outcome, pass or fail, deterministic problem codes, tokens and
  cost; totals; the pass rule. No model text, draft bodies or key.
- Residue of a hard-killed run (the workspace and users named
  `Synthetic agent review eval`) is removed by the next run once it is older
  than 12 hours, including the project's encrypted copy of the key.

## Verdict classes and pass rule

| Class     | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `approve` | The model approved and the review applied it.                             |
| `revise`  | The model asked for a revision (round 1); the draft is not approved.      |
| `reject`  | The model rejected the draft.                                             |
| `owner`   | Left unjudged for the owner (the bare host, or a problem of the project). |
| `blocked` | Rejected by Orbit's deterministic checks; the model could not clear it.   |
| `error`   | The review ended without a verdict (for example `AGENT_OUTPUT_INVALID`).  |

The run prints **PASS** only when all of these hold: no bad case is approved,
the bare host is not approved, every good case is approved or left for the
owner, and every case got a verdict (no early stop, no `error`). Otherwise it
prints **FAIL** and exits non-zero. With PASS, Mario may set
`ORBIT_AGENT_REVIEW_AUTHORITY=true` (rollout plan, Approval J).
