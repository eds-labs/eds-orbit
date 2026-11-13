# Creative vision eval

Measures the production vision review of Creative Studio creatives
(`visionReviewCreative` in
`apps/api/src/modules/marketing/creative/vision-review.ts`) on the set
`vision-v1.json` (`creative-vision-v1`, 8 cases: 4 good, 4 bad). Once this
eval and the agent review eval (`evals/agents`, `review-v3.json`) pass, the
owner may let the review agent release creative posts whose image passed the
vision review (`ORBIT_AGENT_REVIEW_CREATIVES`, spec
`docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md` §7). So
the eval must show above all that bad images do not pass.

## The set

Every case is a real creative in the 4:5 `feed_portrait` format (1080×1350),
composed for free by the production studio (`produceCreative`) from the
offline fixtures in `packages/creative/fixtures/demo-brands.ts`: the
fictional demo brands Lumora Home (`lumora`, warm home goods, coral on cream)
and Kestrel Analytics (`kestrel`, teal and lime), their logos and
`fixtureArt(kind)`. No image provider is called. A case names:

- `brand`: the project's brand when the review runs, so the brief the model
  reads next to the image (brand name, palette, imagery, format, template,
  key message) and the post's image copy.
- `kitBrand`: the brand whose art, palette, fonts and logo the creative is
  composed from. It differs from `brand` only in the wrong-kit case.
- `art`: `good`, `tiny_subject`, `flat` or `bright`; `template`: the layout.
- `expected`: `pass` for a good case, `needs_correction` for a bad one.
- `recorded`: a hand-written answer (seven scores and issues) that gives the
  expected verdict under production's rule (`visionVerdict`: every score at
  least 3 and the mean at least 3.5). It is a replay for the offline tests,
  not a model's output.

| Case                         | Label | Art            | Brand / kit       | Template        | Composition checks                                          |
| ---------------------------- | ----- | -------------- | ----------------- | --------------- | ----------------------------------------------------------- |
| `lumora-good-lifestyle`      | good  | `good`         | lumora / lumora   | `lifestyle`     | pass                                                        |
| `lumora-good-brand-message`  | good  | `good`         | lumora / lumora   | `brand_message` | pass                                                        |
| `kestrel-good-lifestyle`     | good  | `good`         | kestrel / kestrel | `lifestyle`     | pass                                                        |
| `kestrel-good-brand-message` | good  | `good`         | kestrel / kestrel | `brand_message` | corrected (free variant switch, `centered` → `text_bottom`) |
| `lumora-bad-tiny-subject`    | bad   | `tiny_subject` | lumora / lumora   | `lifestyle`     | needs owner: `SUBJECT_TOO_SMALL`, `EMPTY_AREA_EXCESSIVE`    |
| `kestrel-bad-flat`           | bad   | `flat`         | kestrel / kestrel | `lifestyle`     | needs owner: `SUBJECT_TOO_SMALL`, `EMPTY_AREA_EXCESSIVE`    |
| `kestrel-bad-bright`         | bad   | `bright`       | kestrel / kestrel | `brand_message` | pass                                                        |
| `lumora-bad-wrong-kit`       | bad   | `good`         | lumora / kestrel  | `lifestyle`     | pass                                                        |

`tiny_subject` is a small object on a smooth field, `flat` an almost uniform
field, `bright` a bright, busy scene of pastel shapes and confetti with no
main subject (its defect is the missing subject and the busy decoration, not
legibility: the composition raises the text scrim until contrast passes). The
wrong-kit case is Kestrel's complete creative (its good art, palette, fonts and
logo) with Lumora's image copy, judged against Lumora's brief, so palette,
imagery and logo are visibly off-brand. The last column is what production's
own composition path (with its free corrections) decides before the review, as
recorded on this host: the good cases, the bright scene and the wrong kit pass
the studio's checks, so the vision review is their only gate; the offline test
asserts this per case. The schema (`vision-set.ts`) refuses
a set without exactly 4 good and 4 bad cases, a good case that is not its
brand's good art in its own kit, a recorded answer that does not give the
expected verdict, a template that needs a product or draws no art, and image
copy longer than a case's template allows.

## Offline (normal test suite)

Both files run in `pnpm test` (the main Vitest config includes
`evals/**/*.test.ts`); neither calls a provider.

- `vision.offline.test.ts` checks the set (counts, the four bad kinds, the
  brands' palettes and fonts against the fixtures, copy limits, refusals),
  replays every recorded answer through `visionVerdict`, and runs the live
  harness end to end against the worktree's test database with replayed
  answers (`respond` mocked): one call per case on the route file's route
  with the run's key stored as the project's Anthropic key, the rendition as
  a PNG image, the brief of the case's brand within the planning bound, no
  case id in the request; per case that the image sent is the recorded
  rendition, drawn from the kit brand's art and logo (the wrong kit's from
  Kestrel's, not Lumora's), and that the composition verdict is as the table
  above shows (blockers of the tiny subject and the empty field, the other
  cases clean); every case's verdict as expected, metrics-only
  output, the ceiling stop before any call and across cases, an invalid answer
  as a paid error, the refusals before any project exists, and the deletion
  of the synthetic workspace.
- `vision-dry-run.test.ts` tests the route file, the plan and its printout
  (route, worst case, ceiling, confirmation), that a dry run sends nothing,
  that a key alone or a confirmation alone is an error, `EVAL_ROUTE_NOT_PRICED`
  before any call, `EVAL_KEY_REQUIRED` without the route provider's key, the
  rate card date rules, the ceiling clamp, what the confirmation binds, and the
  pass rule. It plans with a fixture rate card (Orbit's catalog price of
  `claude-sonnet-5-5`), never the repository's.

## Live run (manual, budget-capped)

`pnpm eval:creative-vision` runs `vision.eval.ts` through
`vitest.eval.config.ts`. It is not part of `pnpm test`. Only the vision review
calls are real; the run refuses to start if `respond` is stubbed
(`EVAL_RESPOND_STUBBED`).

1. **Dry run.** Source the local environment (database only; do not export a
   real key there) and run `pnpm eval:creative-vision` without the variables
   below. It prints the dataset version, the cases, the `creative_review`
   route with its provider (`provider anthropic, model claude-sonnet-5-5,
reasoning default, max output 1500`), 8 review calls at most (one per
   case), the worst-case estimate (every call at its full output limit and
   the request bound, priced with the rate card), the 0.50 USD ceiling, the
   pass rule, the dataset hash, the hash of the vision prompt and output
   schema, the commit, and the confirmation, and transmits nothing. At the
   catalog price ($2 input, $2.50 cache write and $10 output per million
   tokens) the worst case is about $0.23 (8 calls at 28,890 micros, with the
   5,556-token request bound), below the ceiling.
   **The rate card is stale and has no Claude price:** its `verifiedAt` is
   2026-09-30, so until it is refreshed the dry run stops with
   `EVAL_RATE_CARD_STALE` before it prints anything, and a refreshed card
   without `claude-sonnet-5-5` stops with `EVAL_ROUTE_NOT_PRICED`.
2. **Review.** Check the plan:
   - **Route.** `vision-route-v1.json` mirrors production's `creative_review`
     route as read on 2026-11-11 in FamilyPlan Settings → AI (provider
     `anthropic`, model `claude-sonnet-5-5`, 1,500 output tokens, no
     reasoning effort). Verify in Orbit Settings before the dry run that it
     still equals production's route, provider included, and copy any change
     into the file. The run stores its key in the synthetic project as
     production stores a project key of that provider (encrypted, through
     `saveAiConfiguration`, reusing the review eval's `configureEvalRoute`)
     and refuses to start unless `creative_review` resolves to exactly the
     file's route and provider (`EVAL_ROUTE_MISMATCH`) with the run's key
     (`EVAL_KEY_NOT_APPLIED`); a call on any other model is an error. Any
     later change of that route invalidates a PASS: run the eval again.
   - **Code.** Run on the deployed commit (printed and written to the
     evidence; "tracked files changed" means the working tree is not that
     commit). Any change to the vision prompt, its output schema, the verdict
     rule or this runner, or to the `creative_review` route, needs a new run
     before the authority stays on.
   - **Hashes.** The **dataset hash** covers the cases (with their recorded
     answers), both brands (name, identity, post, image copy), the format,
     the provider, the route and the ceiling. The **confirmation** is a hash
     of the dataset hash, the complete rate card (every price field of every
     model), its `verifiedAt`, the provider, the route, the hash of the vision
     instructions and output schema, and the ceiling, so an edit of any of
     them invalidates the approval.
3. **Live run.** Mario runs, with the local environment sourced:

   ```sh
   ORBIT_EVAL_ANTHROPIC_API_KEY=<key> ORBIT_EVAL_CONFIRM=<confirmation> pnpm eval:creative-vision
   ```

   `ORBIT_EVAL_CONFIRM` must equal the confirmation printed by the dry run for
   the same inputs (`EVAL_CONFIRMATION_MISMATCH` otherwise; the dataset hash
   alone is not accepted). A missing or blank key for the route's provider
   with a confirmation is `EVAL_KEY_REQUIRED`, also when the other provider's
   variable is set. A key (of either provider) or a confirmation alone never
   falls back to a silent dry run: the missing half is an error. The run
   unsets `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` for itself.

   **Key from the macOS keychain.** As for the agent review eval
   (`evals/agents/README.md`): store the key once with
   `security add-generic-password -s orbit-eval-anthropic -a "$USER" -U -w`
   (`-w` last, so macOS prompts for it hidden) and run with
   `ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-anthropic` in place of
   `ORBIT_EVAL_ANTHROPIC_API_KEY`. The keychain is read only for a run whose
   confirmation matches (`evals/agents/eval-key.ts`); the key is never printed
   or logged.

| Variable                       | Meaning                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORBIT_EVAL_ANTHROPIC_API_KEY` | Anthropic key for this run only. Stored like the production configuration (encrypted) in the synthetic project and deleted with it. Never printed or written. |
| `ORBIT_EVAL_OPENAI_API_KEY`    | OpenAI key, read only if the route file names an OpenAI route. Stored and deleted the same way.                                                               |
| `ORBIT_EVAL_KEYCHAIN_SERVICE`  | macOS keychain service holding the route provider's key, read only when that provider's key variable is unset and the confirmation matches.                   |
| `ORBIT_EVAL_CONFIRM`           | Confirmation value from the dry run (not the dataset hash).                                                                                                   |
| `ORBIT_EVAL_MAX_USD`           | Lowers the cost ceiling in USD. Default and maximum: 0.5 (`VISION_CEILING_USD`); a higher value is clamped.                                                   |

Safeguards:

- The ceiling is a hard limit across one run. It is the synthetic project's
  daily, monthly and per-run budget (all reviews share one run key), and each
  review checks in its reservation transaction, through the review's
  `authorize` hook, that what the project's reservations already hold plus
  its estimate stays within the ceiling (`BUDGET_EXCEEDED` otherwise, before
  any cost). The run stops at the first refused reservation and is then
  incomplete, which is a FAIL. No rendition is sent twice (production keys
  the reservation on the rendition, R50). The ceiling applies per run: a
  re-run spends again.
- Prices come from the generation eval's rate card
  (`evals/generation/candidates-v1.json`) with the same rule: older than 31
  days fails with `EVAL_RATE_CARD_STALE`, future-dated with
  `EVAL_RATE_CARD_FUTURE`, before any transmission. A route whose model has no
  price there fails with `EVAL_ROUTE_NOT_PRICED`.
- Only a local database is accepted (`EVAL_DATABASE_NOT_LOCAL` otherwise).
  The synthetic project is created and deleted per run; residue of a
  hard-killed run (the workspace and users named
  `Synthetic creative vision eval`, with the project's encrypted copy of the
  key) is removed by the next run once it is older than 12 hours.
- A creative that does not come out in the case's template and format is a
  setup fault (`EVAL_CREATIVE_TEMPLATE_MISMATCH`,
  `EVAL_CREATIVE_FORMAT_MISMATCH`) and stops the run.
- If the run stops early (budget refusal, unknown outcome, unexpected error)
  or the cleanup fails, the reason is printed prominently, the partial report
  is still written, and the command exits non-zero.
- Results are written to
  `docs/evidence/creative-vision-eval-<UTC timestamp>.json` and `.md`. They
  contain metrics only: per case the verdict, the expected outcome, pass or
  fail, the composition verdict and its failed check codes, the variant drawn,
  the SHA-256 of the rendition sent and of the art and logo it was drawn
  from, the format, the seven scores, the number of issues per kind, the
  error code, tokens and cost; totals; the pass rule; the commit, a dirty flag
  and the prompt hash. Never the image bytes, the model's notes or the key.
  A verdict for any other rendition than the one composed for the case is an
  error (`EVAL_RENDITION_MISMATCH`).

## Verdicts and pass rule

| Verdict            | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `pass`             | The vision review passed the image (every score at least 3, mean at least 3.5).          |
| `needs_correction` | The vision review failed the image; production leaves such a creative for the owner.     |
| `error`            | The review ended without a verdict (for example `VISION_REVIEW_OUTPUT_INVALID`, a stop). |

The run prints **PASS** only when all of these hold:

- no bad case passes;
- at least 3 of the 4 good cases pass (a failing good image only sends a post
  to the owner, but a review that fails most good images would make the
  authority useless);
- every case got a verdict (no early stop, no `error`);
- every case has a known cost above zero.

Otherwise it prints **FAIL** and exits non-zero.

## Limitations

- **Deterministic fixtures.** Typical AI art defects (malformed hands or
  faces, garbled objects) cannot be drawn from deterministic fixtures and are
  not measured. Mitigation: the 180-minute stop window and the first-day watch
  (spec §9).
- **One draw per defect kind.** The set holds one sample of each defect (tiny
  subject, empty field, busy scene without a subject, wrong brand), so a PASS
  is one draw per defect kind, not a rate. Mitigation: the 180-minute stop
  window and the first-day watch (spec §9).
- **Composition quality checks.** The studio's own checks already mark the
  tiny-subject and flat creatives for the owner (`SUBJECT_TOO_SMALL`,
  `EMPTY_AREA_EXCESSIVE`); the eval measures the vision review's verdict
  regardless. The bright scene and the wrong kit pass those checks, so for
  them the vision review is the only gate. Fixture bytes may differ between
  hosts (fonts, librsvg); the offline test asserts the composition verdicts
  on the host that runs it, and the evidence records them for the live run.
- **Two fictional brands.** A PASS shows the review's judgement on this set,
  not on a production brand's imagery or palette.
- **Output cap.** The route's `maxOutputTokens` bounds the answer; a cut-off
  answer is `VISION_REVIEW_OUTPUT_INVALID`, an `error`, so the run FAILs;
  raise the route's limit in production and here, then run again.
