# Agent review evals

Measures the Orbit Agents review step on the review set `review-v3.json`
(38 cases: 13 good drafts to approve, 24 bad ones to reject, one bare host to
leave for the owner). `review-v2.json` stays unchanged as the record of run 3
(the authority PASS of 2026-10-10), `review-v1.json` as the record of the
first live run (2026-10-09, FAIL, see
`docs/plans/ORBIT_CORE_ROLLOUT_PLAN.md`, Approval J). v3 is the set the review
step must pass before it gains authority over Creative Studio posts
(`ORBIT_AGENT_REVIEW_CREATIVES`, spec
`docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md` §6).
The live run measures the route production uses for FamilyPlan's review,
`review-route-v2.json`: Anthropic `claude-opus-5-5`, reasoning effort
`medium`, 5,000 output tokens. `review-route-v1.json` (OpenAI `gpt-6.1-sol`,
the effective route of runs 1 to 3) stays as their record.

## The set (v3)

- **Brands.** Every brand has its own synthetic project with its profile
  fields, facts, assignment fields and brief (`brands` in the set; a case
  names its `brand`, absent: the first). `en` is v2's synthetic brand (voice
  "clear", one fact, CTA "Learn more."), with all 26 v2 cases unchanged, on
  one X slot. `de` is the fictional German family brand "Familienzeit" (no
  FamilyPlan text or data): one fact (`familienzeit.wochenplan`), voice
  "warm, klar", guardrail "keine Preise nennen", CTA "Jetzt ausprobieren.",
  on one Facebook slot of a creative assignment (X cannot carry its long
  posts).
- **Image copy cases.** The 12 `de` cases are long-form posts (bodies up to
  2,200 characters, Instagram's caption limit) with image copy
  (`creativeCopy`, validated with `parsedCreativeCopy` and the `lifestyle`
  template's limits). 5 good ones restate the fact and add only everyday
  moments, questions or invitations; their image copy restates the fact or
  is a plain invitation or question. 7 bad ones, in the categories
  `image_copy_wrong_number`, `image_copy_profit_promise`,
  `image_copy_contradiction`, `image_copy_unbacked_claim` and
  `image_copy_off_brand_tone`; in two of them (`de-bad-image-number-words`,
  `de-bad-image-holidays`) the body is clean and only the image copy breaks
  a rule, so the model must read both. A figure in digits on the image
  (`de-bad-image-number-digits`) is Orbit's deterministic image copy check
  (`CREATIVE_UNSUPPORTED_CLAIM`): one deterministic revision, which the
  worst-case copywriter ignores, then a reject; the model sees neither round.
- **Creatives.** For a case with image copy, the harness composes a real
  creative and attaches it before the review (`brand-projects.ts`): the
  fictional Lumora Home brand kit (`addBrandKit`), the `lifestyle` template,
  and one approved art asset per run from the offline fixtures
  (`fixtureArt("good")`), composed by `composeRunCreatives`. This is free:
  no image provider is called. The brand kit's vision review
  (`visualReview`) stays off, so only the review model is measured; an
  approved creative post then still waits for the owner
  (`CREATIVE_VISION_REVIEW_REQUIRED`), which the offline replay checks.

The set follows Mario's rule for free text: an invitation, question or call
to action that states nothing about the product, brand or offer needs no
fact, as long as it fits voice, guardrails and tone; anything that states a
capability, feature, figure, name, date, status, promise or outcome about the
product, brand or offer needs a backing fact. Good cases therefore pair the
fact with at most a plain question, invitation or call to action; the bad
`unbacked_claim` cases add one unbacked capability or promise. Their recorded
offline answer is a round-1 `reject`; a live `revise` passes too, because the
unchanged revision must then be rejected in round 2. Every case goes through the production review step
(`reviewStep` in `apps/api/src/modules/agents/specialists/review.ts`):
Orbit's deterministic checks first, then the review specialist's real
instructions, output schema and model call through `runSpecialist` (reserve,
markTransmitted, settle on the `agent_review` route). A round-1 `revise`
runs the production revision (`reviseAssignmentDraft`) and the round-2
review decides the case. Only synthetic data is used, in a project created
and deleted per run, and only against a local database
(`EVAL_DATABASE_NOT_LOCAL` otherwise).

## Offline (normal test suite)

- `review.offline.test.ts` replays recorded answers through the review step
  for every v3 case, with the composed creatives; it never calls a provider.
  It also checks that v2 still parses and that every v2 case is in v3
  unchanged, and that the set expects exactly the deterministic image copy
  codes the production check finds.
- `live-dry-run.test.ts` tests the plan, the confirmation gate, the ceiling,
  the local-database check and the pass rule, on both route files: v1 parses
  with the provider `openai` by default, v2 is planned on `anthropic` with a
  fixture rate card (never the repository's), the provider is part of the
  dataset hash and the confirmation, and a confirmation without the
  Anthropic key is `EVAL_KEY_REQUIRED`.
- `live-harness.test.ts` runs the live harness end to end with replayed
  answers: the whole set as planned, on the OpenAI route and on the
  Anthropic route (the key stored as the project's Anthropic key, every call
  on the route file's route), round 2 after a `revise` (with the
  unchanged revision), the ceiling stop, metrics-only output, the cleanup of
  every brand's project, the diagnostic reasons file under `.runtime/`, and
  that every review request of the set, and one with a 2,200-character
  German body with umlauts and emoji, stays below the request bound
  (counted in bytes).
- `diagnosis.test.ts` tests the diagnostic reasons file (banner, content,
  refusal to write the key); `eval-key.test.ts` the key per provider and the
  keychain lookup with a mocked `execFile`. Other live evals reuse the key
  helper (`eval-key.ts`).

## Live run (manual, budget-capped, rollout Approval J)

`pnpm eval:agent-review` runs `live.eval.ts` through `vitest.eval.config.ts`.
It is not part of `pnpm test`. Only the review calls are real; the run
refuses to start if `respond` is stubbed (`EVAL_RESPOND_STUBBED`). The
copywriter (`generate`) and retrieval (`embed`) are stubs that send nothing
(`stubs.ts`; the harness refuses to run without them, `EVAL_STUBS_REQUIRED`):
they write the draft that gives the cases their shape, and they make every
revision the worst case, a copywriter that ignores the instruction and keeps
the body and image copy unchanged. The original draft is rejected as replaced, so the
unchanged revision trips no duplicate check, and the round-2 review judges
the same text again. Each case therefore makes at most two review calls.
No Telegram bot is linked, so no notification is queued.

1. **Dry run.** Source the local environment (database only; do not export a
   real key there) and run `pnpm eval:agent-review` without the variables
   below. It prints the dataset version, the cases, the `agent_review` route,
   the planned review calls (at most two per case; the cases the set expects
   the deterministic checks to decide make none), the worst-case estimate
   (two calls for every case; for `review-v2` about $1.98 at the former
   8,000-byte bound and 2 USD ceiling),
   the cost ceiling, the dataset hash, the hash of the review prompt and
   schema, the commit, and the confirmation, and transmits nothing.
   For `review-v3` it prints `agents-review-v3`, 38 cases, the cases per
   brand, the route with its provider (`provider anthropic, model
   claude-opus-5-5, reasoning medium, max output 5000`) and 76 review calls
   at most. The worst case it prints is every call at its full output limit
   and the 16,000-byte request bound, priced with the current rate card and
   route; when that exceeds the 3 USD ceiling, the plan says so and the run
   may stop early with a partial report (a FAIL). On the Opus route it does
   by far (at $4 input, $5 cache write and $20 output per million tokens,
   $0.18 per call, about $13.68 for 76 calls); the ceiling stays 3 USD, and
   whether to run at 3 USD is Mario's decision at the dry run. Real requests
   are far smaller than the bound (about 7 KB for the longest German post),
   and run 3 spent $0.075 on v2 with `gpt-6.1-sol`.
   **The rate card is stale and has no Claude price:** its `verifiedAt` is
   2026-09-30, so until it is refreshed the dry run stops with
   `EVAL_RATE_CARD_STALE` before it prints anything, and a refreshed card
   without `claude-opus-5-5` stops with `EVAL_ROUTE_NOT_PRICED`.
2. **Review.** Check the plan:
   - **Route.** The route comes from `review-route-v2.json`, which mirrors
     FamilyPlan's explicit `agent_review` task route as read on 2026-11-11
     (Settings → AI → Task routes). Verify in Orbit Settings that it still
     equals production's `agent_review` route, provider included, and copy
     any change into the file. The file names its `provider` (`openai` when
     absent, as in v1), which must be the provider of its model
     (`EVAL_ROUTE_PROVIDER_MISMATCH` otherwise). The run stores its key in
     each synthetic project as production stores a project key of that
     provider (encrypted, through `saveAiConfiguration`: an Anthropic key in
     the provider section, an OpenAI key in the model section) and refuses
     to start unless `agent_review` resolves to exactly the file's model,
     effort, output limit and provider (`EVAL_ROUTE_MISMATCH`) with the
     run's key (`EVAL_KEY_NOT_APPLIED`). Any later change of that route
     invalidates a PASS: run the eval again.
   - **Code.** Run on the deployed commit (the commit is printed and written
     to the evidence; "tracked files changed" means the working tree is not
     that commit). Any change to the review prompt, its output schema or this
     runner, or to the `agent_review` route or quality tier, needs a new run
     before `ORBIT_AGENT_REVIEW_AUTHORITY` stays on.
   - **Hashes.** The **dataset hash** covers the cases, every brand
     (profile fields, facts, assignment fields, brief), the provider, the
     route and the ceiling. The **confirmation** is a hash of the dataset
     hash, the complete rate card (every price field of every model), its
     `verifiedAt`, the provider, the route, the hash of the review
     instructions and output schema, and the ceiling, so an edit of any of
     them invalidates the approval.
3. **Live run.** Mario runs, with the local environment sourced, the key
   variable of the route's provider (`ORBIT_EVAL_ANTHROPIC_API_KEY` for v2,
   `ORBIT_EVAL_OPENAI_API_KEY` for an OpenAI route):

   ```sh
   ORBIT_EVAL_ANTHROPIC_API_KEY=<key> ORBIT_EVAL_CONFIRM=<confirmation> pnpm eval:agent-review
   ```

   `ORBIT_EVAL_CONFIRM` must equal the confirmation printed by the dry run for
   the same inputs (`EVAL_CONFIRMATION_MISMATCH` otherwise; the dataset hash
   alone is not accepted). A missing or blank key for the route's provider
   with a confirmation is `EVAL_KEY_REQUIRED`, also when the other
   provider's variable is set: only the route provider's key is read. A key
   (of either provider) or a confirmation alone never falls back to a
   silent dry run: the missing half is an error. The run unsets
   `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` for itself, so only its own key
   is used.

   **Key from the macOS keychain.** Instead of putting the key on the
   command line, store it once in the login keychain, one item per provider
   (suggested service names `orbit-eval-anthropic` and `orbit-eval-openai`):

   ```sh
   security add-generic-password -s orbit-eval-anthropic -a "$USER" -U -w
   ```

   Keep `-w` as the last option: without a value macOS prompts for the key
   hidden, so it never enters the shell history. Then run with
   `ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-anthropic` in place of
   `ORBIT_EVAL_ANTHROPIC_API_KEY`. The service must hold the key of the
   route's provider. The route provider's key variable wins when both are
   set. The keychain is read only for a run whose confirmation matches, with
   `security find-generic-password -s <service> -w` through `execFile` (no
   shell); the key is never printed or logged. A service alone, without a
   confirmation, leaves the run a dry run. No key in either place (or an
   unknown item) is `EVAL_KEY_REQUIRED`.

| Variable                       | Meaning                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORBIT_EVAL_ANTHROPIC_API_KEY` | Anthropic key for this run only (route provider `anthropic`, v2). Stored like the production configuration (encrypted) in the synthetic project and deleted with it. Never printed or written. |
| `ORBIT_EVAL_OPENAI_API_KEY`    | OpenAI key for this run only (route provider `openai`, v1). Stored and deleted the same way. Never printed or written.                                                                     |
| `ORBIT_EVAL_KEYCHAIN_SERVICE`  | macOS keychain service holding the route provider's key, read only when that provider's key variable is unset and the confirmation matches.                                             |
| `ORBIT_EVAL_CONFIRM`           | Confirmation value from the dry run (not the dataset hash).                                                                                                                             |
| `ORBIT_EVAL_MAX_USD`           | Lowers the cost ceiling in USD. Default and maximum: 3 (0.5 in diagnostic mode); a higher value is clamped.                                                                             |
| `ORBIT_EVAL_DIAGNOSE`          | `good` runs the diagnostic mode (below). Any other value is `EVAL_DIAGNOSE_INVALID`.                                                                                                    |

Safeguards:

- The ceiling is a hard limit across one run, over the projects of all
  brands. It is each synthetic project's daily, monthly and per-run budget;
  before each case the run pool of the case's project is lowered to what
  the whole run has left, so each review task may reserve at most what
  remains of it (`AGENT_LIMIT` otherwise); the run stops at the
  first refused reservation and is then incomplete, which is a FAIL. No call
  is ever sent twice. The ceiling applies per run: a re-run spends again.
- Prices come from the generation eval's rate card
  (`evals/generation/candidates-v1.json`) with the same rule: older than 31
  days fails with `EVAL_RATE_CARD_STALE`, future-dated with
  `EVAL_RATE_CARD_FUTURE`, before any transmission. A route whose model has
  no price there fails with `EVAL_ROUTE_NOT_PRICED`, a card without
  `text-embedding-3-small` with `EVAL_EMBEDDING_NOT_PRICED`: the stubbed
  embeddings send nothing, but their reservation is priced, and a revision
  would otherwise stop the run after paid review calls.
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

## Diagnostic mode

`ORBIT_EVAL_DIAGNOSE=good` runs only the set's good cases through the same
production review step, to read why the model rejected them (run 2 on
2026-10-10 rejected 5 of 8 good cases). It is a diagnosis, never a gate:

- **Plan.** The dry run (`ORBIT_EVAL_DIAGNOSE=good pnpm eval:agent-review`)
  states the mode, the good case ids and count (13 in v3, both brands), at
  most two review calls per case, the worst case and the ceiling.
- **Confirmation.** The diagnostic confirmation also binds the mode and the
  case ids, so a normal confirmation never starts a diagnostic run and a
  diagnostic one never starts a normal run (`EVAL_CONFIRMATION_MISMATCH`).
  The normal confirmation is unchanged.
- **Ceiling.** Default and maximum 0.5 USD; `ORBIT_EVAL_MAX_USD` can only
  lower it. The worst-case estimate (every call at its full output limit,
  with the 16,000-byte request bound) is above 0.5 USD, so the plan notes a
  possible early stop; run 2 spent about $0.05 on the good cases.
- **Reasons file.** For each case and round the run reads the decision the
  review step stores on the draft it judged (`content.agentReviewDecision`,
  written by `recordDecision` in `decideRound`; round 1 on the original
  draft, round 2 on the revision): verdict, model verdict, `reasons`,
  `revisionInstructions`, deterministic codes, and the synthetic draft body.
  They are written only to
  `.runtime/agent-review-diagnosis-<UTC timestamp>.json` and `.md`
  (gitignored, owner-only); stdout gets a one-line pointer to the file. The
  file never contains the key (`EVAL_DIAGNOSIS_SECRET` refuses to write it).
- **No gate result.** The run prints `DIAGNOSTIC — not a gate result`,
  writes no `docs/evidence` file, and its result is `DIAGNOSTIC`, never PASS
  or FAIL: it can never count for Approval J. It still exits non-zero after
  an early stop or a failed cleanup.

```sh
ORBIT_EVAL_DIAGNOSE=good ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-anthropic ORBIT_EVAL_CONFIRM=<diagnostic confirmation> pnpm eval:agent-review
```

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
- **Synthetic brands.** The brand profiles, facts and policies are synthetic
  (`en`: voice "clear", one fact, CTA "Learn more."; `de`: the fictional
  "Familienzeit"), not uLiquid's or FamilyPlan's. A PASS shows the review's
  judgement on this set, not on a production brand's guardrails.
- **No image.** The review model judges the body and the image copy, never
  the image; the vision review is measured by its own eval. Composed
  creatives use one fixture art for every case.

## The brief

The review checks that a draft follows its brief, so every case is judged against its brand's `brief` in the set (`review-v3.json`; a brief may name its own `topic`, as the German one does, else the topic names the slot). It must match the drafts. A mismatched brief makes good cases fail and lets bad cases pass for the wrong reason. Run 2's diagnosis found exactly that: the harness's default test brief asked for day-one use and "Join the beta." The briefs are part of the dataset hash and the confirmation.
