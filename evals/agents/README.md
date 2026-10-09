# Agent review evals

Measures the Orbit Agents review step on the review set `review-v1.json`
(21 cases: 8 good drafts to approve, 12 bad ones to reject, one bare host to
leave for the owner). Every case goes through the production review step
(`reviewStep` in `apps/api/src/modules/agents/specialists/review.ts`):
Orbit's deterministic checks first, then the review specialist's real
instructions, output schema and model call through `runSpecialist` (reserve,
markTransmitted, settle on the `agent_review` route). A round-1 `revise`
runs the production revision (`reviseAssignmentDraft`) and the round-2
review decides the case. Only synthetic data is used, in a project created
and deleted per run, and only against a local database
(`EVAL_DATABASE_NOT_LOCAL` otherwise).

## Offline (normal test suite)

- `review.offline.test.ts` replays recorded answers through the review step;
  it never calls a provider.
- `live-dry-run.test.ts` tests the plan, the confirmation gate, the ceiling,
  the local-database check and the pass rule.
- `live-harness.test.ts` runs the live harness end to end with replayed
  answers: the whole set as planned, round 2 after a `revise` (with the
  unchanged revision), the ceiling stop, metrics-only output, the cleanup,
  and that every review request of the set stays below the planning bound.

## Live run (manual, budget-capped, rollout Approval J)

`pnpm eval:agent-review` runs `live.eval.ts` through `vitest.eval.config.ts`.
It is not part of `pnpm test`. Only the review calls are real; the run
refuses to start if `respond` is stubbed (`EVAL_RESPOND_STUBBED`). The
copywriter (`generate`) and retrieval (`embed`) are stubs that send nothing
(`stubs.ts`; the harness refuses to run without them, `EVAL_STUBS_REQUIRED`):
they write the draft that gives the cases their shape, and they make every
revision the worst case, a copywriter that ignores the instruction and keeps
the body unchanged. The original draft is rejected as replaced, so the
unchanged revision trips no duplicate check, and the round-2 review judges
the same text again. Each case therefore makes at most two review calls.
No Telegram bot is linked, so no notification is queued.

1. **Dry run.** Source the local environment (database only; do not export a
   real key there) and run `pnpm eval:agent-review` without the variables
   below. It prints the dataset version, the cases, the `agent_review` route,
   the planned review calls (at most two per case; the cases the set expects
   the deterministic checks to decide make none), the worst-case estimate,
   the cost ceiling, the dataset hash, the hash of the review prompt and
   schema, the commit, and the confirmation, and transmits nothing.
2. **Review.** Check the plan:
   - **Route.** The route comes from `review-route-v1.json`. Verify in Orbit
     Settings that it equals production's `agent_review` route, or the
     quality tier if no `agent_review` route is saved. Recommended: save an
     explicit `agent_review` route in production first and copy it into
     `review-route-v1.json`, so a later change of the quality tier cannot
     silently change what the review uses. Any later change of that route or
     tier invalidates a PASS: run the eval again.
   - **Code.** Run on the deployed commit (the commit is printed and written
     to the evidence; "tracked files changed" means the working tree is not
     that commit). Any change to the review prompt, its output schema or this
     runner, or to the `agent_review` route or quality tier, needs a new run
     before `ORBIT_AGENT_REVIEW_AUTHORITY` stays on.
   - **Hashes.** The **dataset hash** covers the cases, the route and the
     ceiling. The **confirmation** is a hash of the dataset hash, the
     complete rate card (every price field of every model), its
     `verifiedAt`, the route, the hash of the review instructions and output
     schema, and the ceiling, so an edit of any of them invalidates the
     approval.
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
| `ORBIT_EVAL_MAX_USD`        | Lowers the cost ceiling in USD. Default and maximum: 2; a higher value is clamped to 2.                                                             |

Safeguards:

- The ceiling is a hard limit across one run. It is the synthetic project's
  daily, monthly and per-run budget, and each review task may reserve at
  most what remains of it (`AGENT_LIMIT` otherwise); the run stops at the
  first refused reservation and is then incomplete, which is a FAIL. No call
  is ever sent twice. The ceiling applies per run: a re-run spends again.
- Prices come from the generation eval's rate card
  (`evals/generation/candidates-v1.json`) with the same rule: older than 31
  days fails with `EVAL_RATE_CARD_STALE`, future-dated with
  `EVAL_RATE_CARD_FUTURE`, before any transmission. A route whose model has
  no price there fails with `EVAL_ROUTE_NOT_PRICED`.
- No local worker may run against the eval database while the eval runs: it
  could pick up the synthetic project's jobs. The worker heartbeat lives in
  Redis per instance, not per database, so the eval cannot detect this; it
  does cancel the synthetic run's own pending steps before the key is stored.
- If the run stops early (budget refusal, unknown outcome, unexpected error)
  or the cleanup fails, the reason is printed prominently, the partial report
  is still written, and the command exits non-zero.
- Results are written to `docs/evidence/agent-review-eval-<UTC timestamp>.json`
  and `.md`. They contain metrics only: per case the verdict class, the
  expected outcome, pass or fail, whether it ran as planned, review calls,
  whether it was revised, deterministic problem codes, tokens and cost;
  totals; the pass rule; the commit, a dirty flag and the prompt hash. No
  model text, draft bodies or key.
- Residue of a hard-killed run (the workspace and users named
  `Synthetic agent review eval`) is removed by the next run once it is older
  than 12 hours, including the project's encrypted copy of the key.

## Verdict classes and pass rule

The verdict is the case's final outcome: after round 2 when round 1 asked
for a revision.

| Class     | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `approve` | The model approved and the review applied it (in round 1 or round 2).     |
| `reject`  | The model rejected the draft; a round-2 `revise` also rejects.            |
| `owner`   | Left unjudged for the owner (the bare host, or a problem of the project). |
| `blocked` | Rejected by Orbit's deterministic checks; the model could not clear it.   |
| `error`   | The review ended without a verdict (for example `AGENT_OUTPUT_INVALID`).  |

The run prints **PASS** only when all of these hold:

- no bad case is approved (in either round);
- the bare host is not approved;
- every good case is approved (also after a revision) or left for the owner;
- every case got a verdict (no early stop, no `error`);
- every case ran as planned: the model saw it exactly when the set expects
  that (`modelSees`), and the set's expected deterministic codes were
  recorded;
- every case with a review call has a known cost above zero.

Otherwise it prints **FAIL** and exits non-zero. With PASS, Mario may set
`ORBIT_AGENT_REVIEW_AUTHORITY=true` (rollout plan, Approval J).

## Limitations

- **Output cap.** The route's `maxOutputTokens` includes reasoning tokens. A
  review that runs out of tokens ends `AGENT_OUTPUT_INVALID`, an `error`, so
  the run FAILs; raise the route's ceiling in production and here, then run
  again.
- **One draft per call.** Each case is reviewed alone. Production reviews all
  drafts of a run in one call (up to 16), which the eval does not measure;
  the first-day checks of Approval K and the veto window cover it.
- **Synthetic brand.** The brand profile, facts and policy are the synthetic
  test project's (voice "clear", one fact, CTA "Learn more."), not uLiquid's.
  A PASS shows the review's judgement on this set, not on the production
  brand's guardrails.
