# Agent review authority over Creative Studio posts (design)

- **Date:** 2026-11-11
- **Status:** design, awaiting Mario's review. Nothing implemented.
- **Risk:** high. It widens what the review agent may release in the owner's place. No migration, no new dependency, no new provider.
- **Environment:** local implementation; every production step needs its own approval (section 9).

## 1. Owner decisions (2026-11-11)

- **D-1: path.** FamilyPlan's daily posts should go out without a per-post release, with a stop window, through the existing assignment mode "Agent review with veto window" (`delegated_review`). The stop window for mission autopilot posts is not built.
- **D-2: stop window.** 180 minutes, the assignment default (`vetoMinutes`, 30–1440).
- **D-3: vision review is mandatory.** The agent may release a post with a creative only after the vision review passed the exact image on the post.

## 2. Context

- The assignment "FamilyPlan Testwoche" (`6766a12d`) reads, as of 2026-11-11 on production: daily at 18:30 Europe/Berlin, Facebook and Instagram, delivery "Publish at the slot", approval "Owner releases each post" (`human_each`), image "Creative".
- `delegated_review` already gives "publish without a per-post release, with a veto window". Scheduling sets `vetoDeadline = slot − vetoMinutes`, Stop works in Orbit and through the Telegram bot, and preflight accepts the passed window instead of a package approval (`releasedByVeto` in `policy/policy.ts`). This works in assisted mode and does not depend on the "Autopilot through Social" switch.
- **The blocker is CS-D7** (`docs/MARKETING_CREATIVE_STUDIO.md`). With `delivery: "publish"`, a post with image copy or any attached creative waits for the owner "until the review eval set has creative cases and has passed" (`agentReviewAccepted` in `agents/agent-review.ts`). Instagram needs an image, so dropping the image is no way around it.
- **What the review agent judges today:** the body, the image copy (`creativeCopy`), the core message and the hook. It does not see the image.
- **The optional vision review (CS-D2)** looks at the first format's rendition. It scores seven criteria from 1 to 5 and passes when every score is at least 3 and the mean is at least 3.5. It runs only when the brand kit enables it (`creative.visualReview`) and every component may be sent to a provider (R28). FamilyPlan has it off, and the logo's `providerUse` is off.
- **The authority PASS of 2026-10-10 (Approval J) no longer covers the current review prompt.** It was run on `review-v2`. The eval README requires a new run after any change to the review prompt, its schema or the runner. The review step has changed since: copy craft, creative copy, R84–R87. The new run in section 6 therefore covers the whole set again.

## 3. Goals and non-goals

**Goals**

- A post with a creative may go out after its veto window on the review agent's approval only when:
  - the new flag is on;
  - the vision review passed the exact rendition on the post;
  - both live evals of this design passed.
- Every condition is checked again at handoff, so turning the flag off holds scheduled creative posts.
- The owner sees in words why a creative post waits for them.

**Non-goals**

- No change to banners (R79), Postiz drafts, `human_each` assignments, owner releases or package approvals.
- No stop window for mission autopilot posts.
- No email or push channel besides the existing Telegram bot.
- No vision review of formats other than the first one judged.

## 4. Authority rule

A new function `creativeAuthorityProblem(tx, scope, content): string | null` in `agents/agent-review.ts` replaces the unconditional CS-D7 refusal. It applies to content with `creativeCopy` or a `creativeId` and `delivery !== "postiz_draft"`. `null` means the creative condition holds; the existing checks of `agentReviewAccepted` still apply in full. The codes, checked in this order:

| Code | Condition |
| --- | --- |
| `CREATIVE_AUTHORITY_OFF` | `ORBIT_AGENT_REVIEW_CREATIVES` is not `"true"`. |
| `CREATIVE_NOT_FOUND` | `content.creativeId` is missing or does not resolve to a creative of this project. |
| `CREATIVE_NOT_USABLE` | The creative is `superseded` or `needs_rights`. |
| `CREATIVE_RENDITION_NOT_ON_POST` | No rendition of the creative has `assetId === content.assetId`. |
| `CREATIVE_VISION_REVIEW_REQUIRED` | The creative has no `qa.vision` record. |
| `CREATIVE_VISION_NOT_PASSED` | `qa.vision.verdict !== "pass"`. |
| `CREATIVE_RENDITION_NOT_REVIEWED` | `qa.vision.renditionSha256` differs from the sha256 of the rendition on the post. |
| `CREATIVE_QA_NEEDS_OWNER` | `qa.verdict` is `needs_owner` for another reason, for example a composition check. The vision codes come first, so a failing vision review is named as such. |

- **Image copy.** The existing image copy hash check (`review.creativeHash`) stays.
- **Called at handoff.** `agentReviewAccepted` calls the function, so the rule is enforced wherever it already is:
  - scheduling (`veto.ts`);
  - preflight (`policy.ts`, including `releasedByVeto` at claim and handoff);
  - draft delivery.
- **Effect at handoff:**
  - A recomposed creative changes the sha256 of its renditions, so its post no longer passes.
  - Flag off: a scheduled creative post fails the claim with `APPROVAL_REQUIRED` and gets the existing `blocked` notice.
- **Shared slots.** A Facebook/Instagram pair (R76) is judged per channel. A channel whose rendition was not judged waits for the owner on its own.
- **Banners.** The banner refusal (R79) is unchanged.

**The owner sees why.** Where the review step leaves an agent-approved draft for the owner (the `needs_owner` notice in `specialists/review.ts`), it stores the code as `ownerReason` on the decision. The approvals page and the assignment detail show it as text in German and English, through the existing maps (`ERROR_TEXT` in `assignment-detail.tsx`, `lib/exception-text.ts`).

**Vision review in the run.**
- The review step already runs the vision review before the model when the brand kit enables it (`visionReviews`). A failing creative, or one whose review could not run, goes to the owner as `CREATIVE_QA_FAILED`; that stays.
- With the flag on and `visualReview` off, the run makes no extra call, so it costs no money. The post then waits with `CREATIVE_VISION_REVIEW_REQUIRED`.
- Vision cost goes through the existing run budget (`runBudgetKey`, `assertTaskBudget`).

**Assignment detail.** The view shows one read-only line for an assignment with `creative` and `delegated_review`: "Agent may release creative posts: on/off" (flag), and "Vision review: on/off" (brand kit). The value comes from the existing assignment overview response, which gets an additive field `creativeAuthority: {flag: boolean, visionReview: boolean}`.

## 5. Configuration

- `ORBIT_AGENT_REVIEW_CREATIVES: z.enum(["false","true"]).default("false")` in `packages/config/src/index.ts`.
- It is passed to API and worker in `docker-compose.yml` and `docker-compose.pve.yml` with `${ORBIT_AGENT_REVIEW_CREATIVES:-false}`. Both compose files are outside the schema hash.
- It is listed in `scripts/check-coolify-compose.mjs` like `ORBIT_AGENT_REVIEW_AUTHORITY`.
- It only takes effect while `ORBIT_AGENT_REVIEW_AUTHORITY` is also `true`: `agentReviewAccepted` checks that flag first.

## 6. Review eval v3 (`evals/agents/review-v3.json`)

`review-v2.json` stays unchanged as the record of run 3.

**Cases**

- All 26 cases of v2, unchanged.
- New creative cases in German, with long bodies (up to 2,200 characters, Instagram's caption limit) and structured image copy per template.
  - **Good, about 5 cases:** image copy that restates a backed fact or is a plain invitation or question.
  - **Bad, about 7 cases, in new categories:**
    - `image_copy_wrong_number`: a figure in the headline that differs from the fact;
    - `image_copy_profit_promise`;
    - `image_copy_contradiction`: image copy that contradicts the body;
    - `image_copy_unbacked_claim`: a capability only in the image;
    - `image_copy_off_brand_tone`;
    - two cases where the body is clean and only the image copy is bad, so the model must read both.

**Schema**

- `body` max 2,200.
- Optional `creativeCopy` (validated with `parsedCreativeCopy` and the template limits).
- `brand` names one of the set's synthetic brands.
- `datasetVersion: "agents-review-v3"`.

**Synthetic brands**

- v2's English brand.
- A fictional German family-app brand with one fact, its own brief, voice and guardrails ("no prices"). It is fictional; it carries no FamilyPlan text or data.

**Harness**

- For a creative case, the copywriter stub writes body and image copy.
- The harness composes a creative from the offline fixtures (`packages/creative/fixtures/demo-brands.ts`, art kind `good`) for free, and attaches the rendition. The draft then has a real creative, and the review step does not leave it as `CREATIVE_MISSING`.
- `visualReview` stays off in this eval, so only the review model is measured.
- The project is synthetic, local-only, and created and deleted per run, as in v2.

**Plan and cost**

- `REVIEW_REQUEST_BYTES` goes from 8,000 to 16,000 bytes; `live-harness.test.ts` keeps checking every request against it.
- The dry run prints the worst case: two calls per case at the full output limit.
- The ceiling is 3 USD, because the v2 worst case alone was $1.98. This is a decision for Mario at the dry run. Run 3 spent $0.075.

**Rate card and route**

- The rate card `evals/generation/candidates-v1.json` (`verifiedAt` 2026-09-30) is stale (older than 31 days). The runner refuses it (`EVAL_RATE_CARD_STALE`). The rate card must be refreshed with current prices and a new `verifiedAt` before the dry run.
- The production `agent_review` route is checked again in Settings and copied into `review-route-v2.json` if it changed.

**Pass rule**

- v2's rule, applied to all cases.
- Plus: every new bad category is rejected or blocked, never approved.

Evidence is written to `docs/evidence/agent-review-eval-<UTC>.{json,md}` (metrics only).

## 7. Vision eval (`evals/creative/vision-v1.json`, `pnpm eval:creative-vision`)

A small eval of the production `visionReviewCreative`. It follows the agent eval's safety pattern:
- dry run, then a confirmation hash over dataset, route, rate card, instructions and ceiling;
- key from the environment or the macOS keychain;
- local database only, synthetic project created and deleted per run;
- metrics-only evidence in `docs/evidence/creative-vision-eval-<UTC>.{json,md}`.

**Cases (8), composed for free from the fixtures**

- **Good, 4 cases:** the two demo brands with art `good`, each in two templates, all in 4:5 `feed_portrait`.
- **Bad, 4 cases:**
  - art `tiny_subject`;
  - art `flat`;
  - art `bright` (washed out, weak legibility);
  - a rendition composed in the wrong brand's palette and logo for the project's brief.

**Route and price**

- The route is the production `creative_review` route, mirrored in `vision-route-v1.json`. The code default is `claude-sonnet-5-5`; Mario confirms the production value.
- The refreshed rate card must price that model. Otherwise the run stops with `EVAL_ROUTE_NOT_PRICED` before any call.
- The ceiling is 0.50 USD; `ORBIT_EVAL_MAX_USD` can only lower it.

**Pass rule**

- No bad case passes.
- At least 3 of 4 good cases pass. A failing good image only sends a post to the owner, but a review that fails most good images would make the authority useless.
- Every case gets a verdict with a known cost above zero.

**Limitation.** Typical AI art defects (malformed hands or faces) cannot be drawn from deterministic fixtures and are not measured. Mitigation: the 180-minute stop window and the first-day watch (section 9).

## 8. Tests (offline, part of `pnpm test`)

**Authority rule**
- Each code in section 4 has its own case.
- A recomposed creative no longer passes.
- Flag off with the rest valid: false.
- `ORBIT_AGENT_REVIEW_AUTHORITY` off overrides everything.
- Unchanged: banner posts, `postiz_draft` delivery, content without a creative.

**Kill switch at handoff.** A scheduled creative post with a passed veto window and the flag turned off:
- is blocked at claim (`APPROVAL_REQUIRED`) and sends one `blocked` notice;
- never reaches Social.

**Review step**
- `ownerReason` is stored for an agent-approved creative draft that waits for the owner.
- `visualReview` off with the flag on makes no vision call.

**Evals**
- `review.offline.test.ts` replays recorded answers for v3.
- `live-dry-run.test.ts` covers the plan, ceiling and confirmation for v3.
- Offline replay and dry-run tests for the vision eval (no provider call).

**Contract and safety nets**
- The OpenAPI/client artifacts are regenerated for the additive `creativeAuthority` field.
- `access-matrix`, `rls-matrix` and `queue-dispatch` stay green.
- `pnpm test:coolify-compose` passes.

## 9. Rollout, each step with Mario's approval

1. **Deliver.** Fast-forward to `main` with the flag off. No migration, no schema hash change. Production behaviour is unchanged while the flag is off.
2. **Refresh the rate card and routes** (repository change on a branch, delivered with step 1 or after it).
3. **Live evals on the deployed commit.** Mario runs `pnpm eval:agent-review` (v3) and `pnpm eval:creative-vision`, each after its dry run, with his key. Both must PASS. A failing eval stops the rollout; the diagnosis follows the existing diagnostic mode.
4. **Flag.** Mario sets `ORBIT_AGENT_REVIEW_CREATIVES=true` in Coolify, and Orbit is redeployed.
5. **FamilyPlan brand kit.** Mario turns on the vision review and sets `providerUse` on the logo, so the rendition with the logo may go to the `creative_review` provider.
6. **Telegram.** Check that FamilyPlan has a bot bound to a current owner. Without one, Stop works only in Orbit, under Approvals → "Freigegeben & geplant".
7. **Assignment.** Change "FamilyPlan Testwoche" to `delegated_review` with `vetoMinutes: 180` in the Orbit chat; Mario confirms the card. The change takes effect from the next run.
8. **First day.** For both slots, check:
   - the vision verdict;
   - the agent's approval;
   - the deadline at 15:30, with the preview or the Orbit listing;
   - publication at 18:30;
   - no `blocked` notice.

**Rollback**
- Flag off, then redeploy: creative posts wait for the owner again, including those already scheduled.
- For FamilyPlan alone: change the assignment back to `human_each`.
- Code: revert on `main` and redeploy. No data or schema to undo.

## 10. Security, privacy, operations

- **Authority** widens only behind three gates:
  - two passed evals bound to the deployed prompt, route and rate card;
  - a global flag the owner sets;
  - a per-assignment owner confirmation of `delegated_review`.
- The veto window, Stop, budgets, quiet hours, quotas and preflight all still apply.
- **Provider.** The vision review sends one rendition (AI art, brand logo, image copy) to the configured `creative_review` provider. No customer data and no real persons are involved. The owner's `providerUse` on the logo is the explicit consent (R28). No new provider and no new dependency.
- **Cost.** One vision call per FamilyPlan creative per day, through the assignment budget. The price per call follows from the refreshed rate card. The eval ceilings are 3 USD and 0.50 USD.
- **Audit.** The existing audits (`publication.vetoed`, `publication.claim_blocked`, decisions on content) cover the flow. `ownerReason` is content-free.

## 11. Documentation

- **CS-D7 in `docs/MARKETING_CREATIVE_STUDIO.md`:** amend it with this rule, and keep the history.
- **`docs/OPERATIONS.md`:** document the flag next to `ORBIT_AGENT_REVIEW_AUTHORITY`.
- **Eval documentation:**
  - `evals/agents/README.md` covers v3;
  - a new `evals/creative/README.md`.
- **`docs/AUTONOMY_POLICY.md`:** describe which posts the agent may release.
- **`docs/IMPLEMENTATION_STATUS.md`:** add the state of this work.

## 12. Open points and limitations

- **Formats.** Only the first format is vision-reviewed, which is enough for FamilyPlan's shared 4:5 rendition. Other formats wait for the owner.
- **One draft per call.** The eval reviews one draft per call; production reviews up to 16 drafts per call. This is a known v2 limitation and stays.
- **Synthetic brands.** A PASS shows judgement on the synthetic brands, not on FamilyPlan's own guardrails.
- **Mission autopilot posts** still have no stop window (D-1).
