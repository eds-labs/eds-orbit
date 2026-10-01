# Generation evals

Compares model routes on synthetic fixtures (`fixtures-v1.json`). Every run
goes through the production path: `generateMissionLive` (routing, reservation,
telemetry) and `checkClaims` (the review gate). Only synthetic data is used,
in a workspace that is created and deleted per eval, and only against a local
database (`EVAL_DATABASE_NOT_LOCAL` otherwise).

## Offline (normal test suite)

`offline.test.ts` replays recorded outputs; it never calls a provider.
`live-dry-run.test.ts` tests the planning and confirmation gates.

## Live run (manual, budget-capped)

`pnpm eval:generation` runs `live.eval.ts` through
`vitest.eval.config.ts`. It is not part of `pnpm test`. `embed` is always
replaced by a deterministic stub; `generate` is real.

1. **Dry run.** Source the local environment (database only; do not export a
   real key there) and run `pnpm eval:generation` without the variables
   below. It prints the dataset version, cases, candidates, repetitions,
   planned calls, worst-case estimate, cost ceiling, the dataset hash and the
   confirmation, and transmits nothing. A key variable that is empty or only
   whitespace, without a confirmation, is also a dry run.
2. **Review.** Show the plan to Mario. Two values are printed:
   - the **dataset hash** covers the fixtures, the candidates
     (`candidates-v1.json`), the repetitions and the ceiling;
   - the **confirmation** is a hash of the dataset hash, the complete rate card
     (every price field of every model, including the embedding model), the
     rate card's `verifiedAt` and the ceiling. The ceiling is enforced in
     rate-card micros, so a price edit after approval changes what the same
     ceiling can buy; binding the prices makes any such edit invalidate the
     approval.
3. **Live run.** Mario runs, with the local environment sourced:

   ```sh
   ORBIT_EVAL_OPENAI_API_KEY=<key> ORBIT_EVAL_CONFIRM=<confirmation> pnpm eval:generation
   ```

   `ORBIT_EVAL_CONFIRM` must equal the confirmation printed by the dry run for
   the same inputs (`EVAL_CONFIRMATION_MISMATCH` otherwise; the dataset hash
   alone is not accepted). A missing or blank key with a confirmation is
   `EVAL_KEY_REQUIRED`. A key or confirmation alone never falls back to a
   silent dry run: the missing half is an error.

| Variable                    | Meaning                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORBIT_EVAL_OPENAI_API_KEY` | Key for this run only. Stored like the production configuration (encrypted) in the synthetic project and deleted with it. Never printed or written. |
| `ORBIT_EVAL_CONFIRM`        | Confirmation value from the dry run (not the dataset hash).                                                                                         |
| `ORBIT_EVAL_MAX_USD`        | Lowers the cost ceiling in USD. Default and maximum: 5.                                                                                             |

Safeguards:

- The ceiling is a hard limit across the whole run: each call may reserve at
  most what remains, and the run stops when a reservation is refused.
- The rate card in `candidates-v1.json` carries one verification date applied
  to every model. Production rejects prices older than 31 days, so a stale
  card fails with `EVAL_RATE_CARD_STALE` before any transmission; a
  future-dated one fails with `EVAL_RATE_CARD_FUTURE`. Update the
  prices and `verifiedAt` from the provider's price list before re-running.
- If the run stops early (budget refusal, unknown cost, unexpected error),
  the stop reason is printed prominently, the partial report is still
  written, and the command exits non-zero.
- Results are written to `docs/evidence/generation-eval-<UTC timestamp>.json`
  and `.md`. They contain metrics only: no prompts, model outputs or key.
- Residue of a hard-killed eval (marker-named workspaces and users) is
  removed by the next eval run once it is older than 12 hours. That residue
  includes the project's encrypted copy of the key, which is deleted with its
  workspace.
