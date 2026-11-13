# Agent Review Authority over Creative Studio Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the review agent release an assignment post with a Creative Studio image after its veto window, but only behind a new flag, a passed vision review of the exact image on the post, and two passed live evals.

**Architecture:**
- **Rule:** one function `creativeAuthorityProblem` replaces the unconditional CS-D7 refusal inside `agentReviewAccepted`. Every place that already asks `agentReviewAccepted` gets the new rule, including scheduling, preflight, claim/handoff and draft delivery, so turning the flag off works as a kill switch.
- **Visibility:** the owner sees the blocking code as text.
- **Evals:**
  - the review eval grows to set v3, with German long-form cases with image copy;
  - a new small vision eval measures the production vision review.

**Tech Stack:**
- TypeScript (Node 24), Fastify API, Prisma/Postgres (`Entity` JSON rows), Zod config, Next.js web;
- vitest unit, integration and eval configs;
- `packages/creative` composition with fixtures.

**Spec:** `docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md`

## Global Constraints

- **Flag:** `ORBIT_AGENT_REVIEW_CREATIVES`, `z.enum(["false","true"]).default("false")`. It takes effect only while `ORBIT_AGENT_REVIEW_AUTHORITY` is `"true"`.
- **No change to:** banners (R79), `delivery: "postiz_draft"`, `human_each` assignments, owner releases, package approvals.
- **No migration**, and no change to `packages/db/prisma/**`, SQL migrations or grant scripts, so the schema hash stays the same. No new dependency, no new provider.
- **Docs and comments are English.** UI texts are German and English through the existing maps.
- **Eval ceilings:**
  - review eval v3: 3 USD, constant `REVIEW_CEILING_USD`;
  - vision eval: 0.50 USD.
- **`REVIEW_REQUEST_BYTES`** becomes 16,000.
- **Vision pass rule** stays as in the code: every score ≥ 3 and mean ≥ 3.5.
- **Running tests in this worktree:**
  - Prepare the worktree's own test database once: `node scripts/test-db-for-worktree.ts`.
  - Then run `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`.
  - Use Node 24.18.0 on `PATH` and the pnpm shim, as in earlier tasks.
- **Delivery:** commit on the branch only. Pushing to `main` deploys production and needs Mario's approval.

## Review Focus

1. **Shared Facebook/Instagram slot with one rendition judged.** If the two channels carry renditions of different formats and only one was vision-reviewed, only the judged channel goes out; the other waits for the owner. Test in Task 2.
2. **Creative recomposed after scheduling.** The post must be blocked at claim, not published, because the rendition sha256 no longer matches `qa.vision.renditionSha256`. Test in Task 3.
3. **Owner releases a draft that showed a waiting reason.** Once released, the item must no longer show a waiting reason. Test in Task 4.
4. **Long German body with umlauts and emoji.** A body of 2,200 characters with multibyte characters plus image copy must stay under the 16,000-byte request bound, and the bound check must count bytes, not characters. Test in Task 6.
5. **Vision route with a provider other than OpenAI.** The vision eval must refuse to start with `EVAL_ROUTE_NOT_PRICED` or `EVAL_KEY_REQUIRED` before any call when the route's provider has no price or no key. It must never fall back to a dry run silently. Test in Task 7.

---

### Task 1: Configuration flag

**Files:**
- Modify: `packages/config/src/index.ts` (next to `ORBIT_AGENT_REVIEW_AUTHORITY`, line 97)
- Modify: `docker-compose.yml`, `docker-compose.pve.yml` (API and worker environment, next to `ORBIT_AGENT_REVIEW_AUTHORITY`)
- Modify: `scripts/check-coolify-compose.mjs` (each list that names `ORBIT_AGENT_REVIEW_AUTHORITY`: lines 40, 179, 223, 269)
- Modify: `docs/OPERATIONS.md` (paragraph on `ORBIT_AGENT_REVIEW_AUTHORITY`, line 131)

**Interfaces:**
- Produces: `loadConfig().ORBIT_AGENT_REVIEW_CREATIVES: "false" | "true"`.

- [ ] **Step 1:** Add `ORBIT_AGENT_REVIEW_CREATIVES` to the config schema, defaulting to `"false"`.
- [ ] **Step 2:** Pass `ORBIT_AGENT_REVIEW_CREATIVES: ${ORBIT_AGENT_REVIEW_CREATIVES:-false}` to API and worker in both compose files.
- [ ] **Step 3:** Add the name wherever `check-coolify-compose.mjs` lists `ORBIT_AGENT_REVIEW_AUTHORITY`.
- [ ] **Step 4:** Run `pnpm test:coolify-compose`. Expected: exit 0.
- [ ] **Step 5:** Document the flag in `docs/OPERATIONS.md`, in one sentence after the `ORBIT_AGENT_REVIEW_AUTHORITY` description:
  - it lets an accepted agent review stand in for a post with a creative only when the vision review passed the exact rendition on the post;
  - set it only after the review eval v3 and the vision eval passed;
  - turning it off holds scheduled creative posts.
- [ ] **Step 6:** Commit with `feat(config): ORBIT_AGENT_REVIEW_CREATIVES flag (default off)`.

### Task 2: Authority rule for creatives

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/agent-review.ts` (the creative branch at lines 160–176 of `agentReviewAccepted`)
- Modify: `apps/api/tests/assignment-creatives.integration.test.ts` (test "agent authority does not cover creatives", line 679; new tests beside it)

**Interfaces:**
- Consumes: `loadConfig().ORBIT_AGENT_REVIEW_CREATIVES` (Task 1); `CREATIVES` and the creative record shape from `apps/api/src/modules/marketing/creative/store.ts`; `StoredVision` from `creative/vision-review.ts`.
- Produces:
  - `export const CREATIVE_AUTHORITY_CODES` with the eight codes `CREATIVE_AUTHORITY_OFF`, `CREATIVE_NOT_FOUND`, `CREATIVE_NOT_USABLE`, `CREATIVE_RENDITION_NOT_ON_POST`, `CREATIVE_VISION_REVIEW_REQUIRED`, `CREATIVE_VISION_NOT_PASSED`, `CREATIVE_RENDITION_NOT_REVIEWED`, `CREATIVE_QA_NEEDS_OWNER`, plus `type CreativeAuthorityCode`.
  - `export async function creativeAuthorityProblem(tx: DbTx, scope: Scope, content: Record<string, any>): Promise<CreativeAuthorityCode | null>`. It returns `null` for content without `creativeCopy` and `creativeId`, and for `delivery === "postiz_draft"`.
  - `agentReviewAccepted` keeps its signature. Its creative branch becomes `if (await creativeAuthorityProblem(tx, scope, content)) return false;`. The `creativeHash` check after it stays.

- [ ] **Step 1: Rewrite and add the failing tests.**
  - Extract the vision setup of "runs the optional vision review before the model review" (profile `visualReview: true`, logo `providerUse: true`) into a local helper `enableVisionReview()`.
  - Set `process.env.ORBIT_AGENT_REVIEW_CREATIVES` in each test and delete it in `afterEach`.
  - Tests:
    - `"agent authority over creatives needs the flag"`: the existing CS-D7 test with the flag unset. Keep its assertions: `false`, no publications, the Postiz draft case `true`, a changed headline `false`. Also assert `creativeAuthorityProblem(...) === "CREATIVE_AUTHORITY_OFF"`.
    - `"agent authority covers a creative whose exact rendition passed the vision review"`: flag `"true"`, `enableVisionReview()`, the vision reply passes, `approveAll`. Expect `agentReviewAccepted === true` and `creativeAuthorityProblem === null`.
    - `"names why a creative post waits"`: one assertion per code. Start from the passing draft and change exactly one field each time:
      - `creativeId` unknown → `CREATIVE_NOT_FOUND`;
      - creative `status: "superseded"` → `CREATIVE_NOT_USABLE`;
      - `content.assetId` set to another asset → `CREATIVE_RENDITION_NOT_ON_POST`;
      - `qa.vision` removed → `CREATIVE_VISION_REVIEW_REQUIRED`;
      - `qa.vision.verdict: "needs_correction"` → `CREATIVE_VISION_NOT_PASSED`;
      - `qa.vision.renditionSha256: "0".repeat(64)` → `CREATIVE_RENDITION_NOT_REVIEWED`;
      - `qa.verdict: "needs_owner"` with `qa.vision` passing → `CREATIVE_QA_NEEDS_OWNER`.
    - `"keeps the review authority flag above the creative flag"`: `ORBIT_AGENT_REVIEW_AUTHORITY` unset and the creative flag on → `agentReviewAccepted === false`.
    - `"leaves banner posts to the owner as before"`: a content with `banner` and the creative flag on → `false` (R79 unchanged).
    - `"judges each channel of a shared slot by its own rendition"` (Review Focus 1): give a shared Facebook/Instagram pair renditions of two formats, with the vision record on the first. Expect the first channel's content `true`; the second returns `CREATIVE_RENDITION_NOT_REVIEWED` and is `false`.
- [ ] **Step 2:** Run `apps/api/tests/assignment-creatives.integration.test.ts`. Expected: the new tests FAIL (`creativeAuthorityProblem` is not exported, or the passing case is `false`).
- [ ] **Step 3:** Implement `creativeAuthorityProblem` in `agent-review.ts`.
  - Load the creative by `kind: CREATIVES`, scoped to the workspace and project like the other `find` calls in that file.
  - Check the codes in the order of the table in spec §4.
  - Compare `qa.vision.renditionSha256` with the `sha256` of the rendition whose `assetId === content.assetId`.
  - Replace the creative refusal in `agentReviewAccepted` with the function.
  - Update the doc comment there, and CS-D7 in `docs/MARKETING_CREATIVE_STUDIO.md` (line 115): "until the review eval set has creative cases and has passed" becomes the rule with its flag and conditions; keep the old wording as history.
- [ ] **Step 4:** Run the same file plus `apps/api/tests/agent-review.integration.test.ts` and `apps/api/tests/assignment-banners.integration.test.ts`. Expected: all PASS.
- [ ] **Step 5:** Commit with `feat(marketing): agent authority over creatives behind ORBIT_AGENT_REVIEW_CREATIVES and a passed vision review`.

### Task 3: Scheduling with the veto window and the kill switch at claim

**Files:**
- Modify: `apps/api/tests/assignment-creatives.integration.test.ts` (new tests; reuse the claim pattern of `assignment-veto.integration.test.ts`: `vi.useFakeTimers({ toFake: ["Date"] })`, `vi.setSystemTime`, `claimPublication`, `dispatchPublication`)
- Modify only if a test exposes a gap: `apps/api/src/modules/marketing/agents/veto.ts`, `apps/api/src/modules/marketing/policy/policy.ts`

**Interfaces:**
- Consumes: Task 2's rule; `scheduleApproved(tx, scope, runId)` (`veto.ts`); `claimPublication(tx, scope, pubId)` (`pipeline/workflow.ts`).

- [ ] **Step 1: Write the tests.**
  - `"schedules an approved creative post with its veto window"`: flag on, vision passes, assignment `vetoMinutes: 180`, delivery `publish`. After the review task, expect exactly one publication per channel with `vetoDeadline === new Date(Date.parse(slot) - 180 * 60000).toISOString()` and `status: "intent_created"`.
  - `"holds a scheduled creative post when the creative flag is turned off"`: schedule as above. Set the time to `slot + 1 min`, delete `ORBIT_AGENT_REVIEW_CREATIVES`, and claim. Expect:
    - the claim is refused with `APPROVAL_REQUIRED` in its blockers;
    - the publication is not handed over (no `socialPostId` released, status not `sending`);
    - exactly one `notify:blocked:<pubId>` job;
    - one `publication.claim_blocked` audit.
  - `"holds a scheduled creative post whose creative was recomposed"` (Review Focus 2): schedule as above, then recompose the creative so its rendition sha256 changes, and claim after the deadline. Expect the claim blocked with `APPROVAL_REQUIRED` and nothing handed over.
- [ ] **Step 2:** Run the file. Expected: the tests PASS without code changes, because `releasedByVeto` already calls `agentReviewAccepted`. If one fails, fix the gap in the file the failure names, and say why in the commit message.
- [ ] **Step 3:** Run `apps/api/tests/assignment-veto.integration.test.ts`. Expected: PASS (unchanged behaviour for posts without a creative).
- [ ] **Step 4:** Commit with `test(marketing): creative posts keep the veto window and stop at claim when the flag is off`.

### Task 4: The owner sees why a creative post waits

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/specialists/review.ts` (approve branch around lines 1123–1145, where `checkClaims` returns `valid: false`)
- Modify: `apps/api/src/modules/marketing/agents/assignment-overview.ts` (`draftsAwaitingOwner`, the pending items)
- Modify: `apps/web/src/modules/marketing/assignments.tsx` (the awaiting-owner list) and `apps/web/src/lib/exception-text.ts`
- Test: `apps/api/tests/assignment-creatives.integration.test.ts`; `apps/web/src/lib/exception-text.test.tsx`

**Interfaces:**
- Consumes: `creativeAuthorityProblem` and `CreativeAuthorityCode` (Task 2).
- Produces:
  - content field `agentAuthorityProblem: CreativeAuthorityCode | null`, written in the same `update` that sets `status: "needs_review"`;
  - pending item field `waitingReason: string | null` in the `GET …/assignment-drafts` response;
  - `exceptionText(code, locale)` covers the eight codes.

- [ ] **Step 1: Write the failing tests.**
  - API test `"stores why an agent-approved creative waits for the owner"`: flag off, `approveAll`. Expect content `agentAuthorityProblem === "CREATIVE_AUTHORITY_OFF"`, and the `GET /api/projects/:id/assignment-drafts` pending item `waitingReason === "CREATIVE_AUTHORITY_OFF"`.
  - API test `"makes no vision call while the brand kit has the vision review off"`: creative flag on, `visualReview` off, `approveAll`. Expect `provider.requests` to hold only the review model's call (no `input_image`), and `agentAuthorityProblem === "CREATIVE_VISION_REVIEW_REQUIRED"`.
  - API test `"shows no waiting reason once the owner released the draft"` (Review Focus 3): release the draft (`POST …/assignment-drafts/:id/release`). Expect the item `state: "released"` and `waitingReason` absent or `null`.
  - Web test: `hasExceptionText` is true for each of the eight codes.
  - Web test: `exceptionText("CREATIVE_VISION_REVIEW_REQUIRED", "de").title` includes `"Bildprüfung"`, and the English title includes `"vision review"`.
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - In the approve branch, compute `creativeAuthorityProblem` only when `!result.valid` and the content has a creative, and store it on the content.
  - Map the field to `waitingReason` for pending items only.
  - Add DE and EN texts to `exception-text.ts`. Each text names the step that clears the code, for example "Bildprüfung im Brand Kit einschalten" or "Schalter ORBIT_AGENT_REVIEW_CREATIVES ist aus".
  - Render the text under the item in `assignments.tsx` with the existing `ExceptionWords` pattern; the raw code goes under technical details.
- [ ] **Step 4:** Run both test files and `apps/web/src/modules/marketing/approvals-page.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(marketing): name why an agent-approved creative post waits for the owner`.

### Task 5: Creative authority state in the assignment detail

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/assignment-overview.ts` (the assignment overview response, next to `approvalMode` and `vetoMinutes`, around lines 160–170)
- Modify: `apps/web/src/modules/marketing/assignment-detail.tsx`
- Regenerate: `packages/schemas/openapi.json`, `packages/api-client/src/generated.ts`
- Test: the overview route's integration test (the file asserting `approvalMode` in the overview response, found with `git grep -n "approvalMode" apps/api/tests`); `apps/web/src/modules/marketing/assignment-detail.test.tsx` (create it if absent)

**Interfaces:**
- Produces: overview item field `creativeAuthority: { flag: boolean; visionReview: boolean } | null`. It is `null` unless the assignment has `creative` and `approvalModeOf(d) === "delegated_review"`.
  - `flag` is `loadConfig().ORBIT_AGENT_REVIEW_CREATIVES === "true" && agentReviewAuthority()`.
  - `visionReview` comes from `resolveBrandKit(tx, scope)` and `config.visualReview`; it is `false` when no brand kit resolves.

- [ ] **Step 1: Write the failing tests.**
  - API: a creative `delegated_review` assignment returns `{flag: false, visionReview: false}` with the flags off and no vision review, and `{flag: true, visionReview: true}` after both are on. A `human_each` assignment returns `null`.
  - Web: the detail renders `"Agent darf Creative-Beiträge freigeben: aus"` and `"Bildprüfung: aus"` (DE), and `"Agent may release creative posts: off"` and `"Vision review: off"` (EN), only when `creativeAuthority` is not null.
- [ ] **Step 2:** Run both tests. Expected: FAIL.
- [ ] **Step 3:** Implement the field and the two read-only lines in the "Settings" block of the detail.
- [ ] **Step 4:** Regenerate the API artifacts with `node --env-file=<main>/.runtime/local.env --import tsx scripts/openapi.ts && ./node_modules/.bin/openapi-typescript packages/schemas/openapi.json -o packages/api-client/src/generated.ts`. Check that the diff contains only the additive field.
- [ ] **Step 5:** Run both tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit with `feat(marketing): show whether the agent may release creative posts`.

### Task 6: Review eval v3

**Files:**
- Create: `evals/agents/review-v3.json`
- Modify: `evals/agents/review-set.ts`, `evals/agents/live-plan.ts`, `evals/agents/live-harness.ts`, `evals/agents/stubs.ts`, `evals/agents/live.eval.ts`
- Modify: `evals/agents/review.offline.test.ts`, `evals/agents/live-dry-run.test.ts`, `evals/agents/live-harness.test.ts` (switch their imports from `review-v2.json` to `review-v3.json`; keep one v2 parse test)
- Modify: `evals/agents/README.md`

**Interfaces:**
- Consumes: `addBrandKit` (`apps/api/tests/support/package-creative.ts`); `composeRunCreatives` (`apps/api/src/modules/marketing/creative/assignment.ts`); `fixtureArt` (`packages/creative/fixtures/demo-brands.ts`, kind `"good"`); `parsedCreativeCopy` (`apps/api/src/modules/marketing/creative/copy-checks.ts`).
- Produces:
  - `datasetVersion: z.enum(["agents-review-v2","agents-review-v3"])`;
  - case fields `brand?: string` (default the set's first brand), `creativeCopy?: unknown` (validated by `parsedCreativeCopy`), `body` max 2,200;
  - set field `brands: Record<string, { profile: …; facts: …; brief: ReviewBrief }>` for v3;
  - new categories `image_copy_wrong_number`, `image_copy_profit_promise`, `image_copy_contradiction`, `image_copy_unbacked_claim`, `image_copy_off_brand_tone`;
  - constants `REVIEW_CEILING_USD = 3` and `REVIEW_REQUEST_BYTES = 16_000`.

- [ ] **Step 1: Write the dataset `review-v3.json`.**
  - All 26 v2 cases unchanged, under brand `"en"`.
  - Brand `"de"`: a fictional German family-app brand ("Familienzeit", not FamilyPlan). One fact, a brief, voice "warm, klar", guardrail "keine Preise nennen", CTA "Jetzt ausprobieren."
  - 5 good German creative cases with bodies of 600–2,200 characters, and image copy that restates the fact or is a plain invitation or question.
  - 7 bad cases:
    - one per new category;
    - two where the body is clean and only the image copy breaks a rule (`image_copy_wrong_number`, `image_copy_unbacked_claim`).
  - Each case gets a recorded answer and expected values in the v2 format.
- [ ] **Step 2:** Update the offline tests to v3 and add:
  - `"v3 parses with every v2 case unchanged"`: the case ids and bodies of v2 are a subset of v3;
  - `"keeps every review request of v3 under the request bound"` (Review Focus 4): include a 2,200-character German body with umlauts and emoji, and assert `Buffer.byteLength(request) < REVIEW_REQUEST_BYTES`;
  - `"plans v3 under the 3 USD ceiling"`: `planReviewEval(...).worstCaseMicros <= 3_000_000`, or the plan's note when the worst case exceeds it;
  - in `review.offline.test.ts`, the replay passes for every v3 case.

  Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement the schema, the brands, the bounds and the creative cases in the harness.
  - Create one synthetic project per brand.
  - For a creative case, have the stub copywriter write `creativeCopy`, then compose and attach a creative from `fixtureArt("good")` with the brand kit from `addBrandKit`. This is free and needs no provider.
  - Keep `visualReview` off.
  - Switch `live.eval.ts` to v3.
  - Raise `MAX_COST_MICROS` in `live-harness.ts` to match the 3 USD ceiling.
- [ ] **Step 4:** Run the three offline files plus `evals/agents/diagnosis.test.ts`. Expected: PASS. Then run the dry run without a key: `pnpm eval:agent-review`. Expected: it prints `agents-review-v3`, the case count 38, the worst case and the confirmation, and transmits nothing. If the rate card is still stale, the dry run stops with `EVAL_RATE_CARD_STALE`; that is expected until Task 8.
- [ ] **Step 5:** Update `evals/agents/README.md`: v3, brands, image copy cases, the 3 USD ceiling and the request bound.
- [ ] **Step 6:** Commit with `feat(evals): review eval v3 with German long-form posts and image copy`.

### Task 7: Vision eval

**Files:**
- Create in `evals/creative/`:
  - `vision-set.ts`, `vision-v1.json`, `vision-route-v1.json`;
  - `vision-plan.ts`, `vision-harness.ts`, `vision.eval.ts`;
  - `vitest.eval.config.ts`, `vision.offline.test.ts`, `vision-dry-run.test.ts`;
  - `README.md`.
- Modify: `package.json` (script `"eval:creative-vision": "vitest run --config evals/creative/vitest.eval.config.ts"`)
- Reuse, without copying: `evals/agents/eval-key.ts`, the confirmation and rate card checks of `evals/agents/live-plan.ts`, `removeStaleEvals`, `assertLocalDatabase`. Move them to `evals/shared/` only if an import across eval folders breaks the lint boundaries.

**Interfaces:**
- Consumes: `visionReviewCreative(scope, creativeId, options)` and `visionVerdict` (`apps/api/src/modules/marketing/creative/vision-review.ts`); `fixtureArt(kind)` with kinds `"good" | "tiny_subject" | "flat" | "bright"`; the demo brands `"lumora" | "kestrel"`.
- Produces:
  - `datasetVersion: "creative-vision-v1"`;
  - case schema `{ id, label: "good"|"bad", brand: "lumora"|"kestrel", art: FixtureArtKind, kitBrand: "lumora"|"kestrel", template: TemplateId, expected: "pass"|"needs_correction", recorded: VisionAnswer }`;
  - `VISION_CEILING_USD = 0.5`;
  - pass rule: no bad case passes, at least 3 of 4 good cases pass, every case has a verdict and a known cost above zero;
  - evidence in `docs/evidence/creative-vision-eval-<UTC>.{json,md}`, metrics only.

- [ ] **Step 1: Write the dataset with 8 cases, all in the 4:5 `feed_portrait` format.**
  - 4 good: `lumora`/`good` in two templates, and `kestrel`/`good` in two templates.
  - 4 bad: `tiny_subject`, `flat`, `bright`, and one with `kitBrand` different from `brand` (wrong palette and logo for the brief).
- [ ] **Step 2: Write the offline tests.**
  - The replay of the recorded answers gives `expected` for every case.
  - The pass rule: one bad case passing → FAIL; 2 of 4 good passing → FAIL; 3 of 4 → PASS.
  - The dry run prints the route, the worst case, the ceiling and the confirmation, and sends nothing.
  - A key alone or a confirmation alone is an error, never a dry run.
  - Review Focus 5: a route whose model has no price → `EVAL_ROUTE_NOT_PRICED` before any call; the provider's key missing → `EVAL_KEY_REQUIRED`.

  Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the harness.
  - Create a synthetic project, compose each case's creative from fixtures (logo `providerUse: true`), and call `visionReviewCreative` with the route from `vision-route-v1.json`.
  - The route file carries `provider` and `model`. The eval key is stored for that provider in the synthetic project's AI configuration, the way the agent harness stores its OpenAI key. The key variables are `ORBIT_EVAL_OPENAI_API_KEY` or `ORBIT_EVAL_ANTHROPIC_API_KEY`, or a keychain service per provider.
  - Delete the project after the run.
  - Write the README following `evals/agents/README.md`.
- [ ] **Step 4:** Run the offline tests and the dry run `pnpm eval:creative-vision`. Expected: tests PASS, and the dry run prints the plan, or `EVAL_RATE_CARD_STALE` until Task 8.
- [ ] **Step 5:** Commit with `feat(evals): vision eval for the creative review`.

### Task 8: Rate card and routes for the live runs

**Files:**
- Modify: `evals/generation/candidates-v1.json` (`verifiedAt` and prices; add the vision route's model)
- Modify or create: `evals/agents/review-route-v2.json` (only if production's `agent_review` route differs from `review-route-v1.json`), `evals/creative/vision-route-v1.json`

**Interfaces:**
- Produces: a rate card no older than 31 days on the day of the live runs, pricing every model of both routes.

- [ ] **Step 1:** Ask Mario for production's `agent_review` and `creative_review` routes (Settings → AI: provider, model, output ceiling). Copy them into the route files. Do not guess them.
- [ ] **Step 2:** Take the prices of those models from the providers' published price pages on the day, and set `verifiedAt` to that day. For Claude models, use the `claude-api` skill's pricing reference. Leave every other entry of the rate card unchanged unless its price changed.
- [ ] **Step 3:** Run `pnpm eval:agent-review` and `pnpm eval:creative-vision` without keys. Expected: both print their plan with worst case, ceiling and confirmation. The dry run's worst case for v3 must not exceed 3 USD; if it does, report it to Mario instead of raising the ceiling.
- [ ] **Step 4:** Run the generation eval's offline tests (`evals/generation/*.test.ts`). Expected: PASS, because the rate card is shared.
- [ ] **Step 5:** Commit with `chore(evals): refresh the rate card and record the live eval routes`.

### Task 9: Documentation and full verification

**Files:**
- Modify:
  - `docs/AUTONOMY_POLICY.md`: which assignment posts the agent may release;
  - `docs/MARKETING_CREATIVE_STUDIO.md`: CS-D7 finished in Task 2; also the limitations at line 166;
  - `docs/IMPLEMENTATION_STATUS.md`: a new entry for the state, verification, the production steps of spec §9 and the rollback;
  - `docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md`: Status set to "implemented on branch".

- [ ] **Step 1:** Write the documentation changes listed above.
- [ ] **Step 2:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:coolify-compose`, `pnpm framework:check` and `pnpm secrets:check`. Expected:
  - every command exits 0;
  - the suite reports 0 failed;
  - `rls-matrix`, `access-matrix` and `queue-dispatch` pass.
- [ ] **Step 3:** Check that `git diff --name-only origin/main -- packages/db/prisma packages/db/prisma.config.ts scripts/db-deploy.ts` is empty (no schema hash change).
- [ ] **Step 4:** Commit with `docs: agent authority over creatives, rollout and rollback`.
