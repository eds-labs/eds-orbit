/**
 * Planning, gating and the pass rule of the manual live review eval
 * (rollout Approval J). Pure functions: nothing here reads a database, calls
 * a provider or prints a secret. The gates and the rate card are the
 * generation eval's (`evals/generation/live-plan.ts`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  estimateCost,
  modelRouteSchema,
  type ModelRoute,
  type OpenAiRuntimeConfig,
} from "../../packages/ai/src/index.ts";
import { canonical } from "../generation/harness.ts";
import {
  ceilingMicros,
  evalRateCard,
  type CandidatesFile,
  type LiveEnv,
} from "../generation/live-plan.ts";
import {
  isBareHost,
  type ReviewBrief,
  type ReviewCase,
  type ReviewSet,
} from "./review-set.ts";

// Hard ceiling of this eval; ORBIT_EVAL_MAX_USD can only lower it. It covers
// the worst case of two review calls (round 1 and round 2) for every case.
export const REVIEW_CEILING_USD = 2;
// Hard ceiling of the diagnostic mode (ORBIT_EVAL_DIAGNOSE=good).
export const DIAGNOSTIC_CEILING_USD = 0.5;
// Review calls per case at most: round 1 and, after a `revise`, round 2.
const CALLS_PER_CASE = 2;
// Upper bound of one review request (base and review instructions, output
// schema, assignment, brand, one draft with facts and brief, up to five
// channel posts of 240 characters). Measured at about 3,800 bytes for this
// set (live-harness.test.ts checks the bound); a planning bound only, because
// each reservation uses the exact size.
export const REVIEW_REQUEST_BYTES = 8_000;

const routeFileSchema = z
  .object({
    description: z.string().min(1),
    taskClass: z.literal("agent_review"),
    route: modelRouteSchema,
  })
  .strict();
export type RouteFile = z.infer<typeof routeFileSchema>;

export function parseRouteFile(raw: unknown): RouteFile {
  return routeFileSchema.parse(raw);
}

/**
 * The diagnostic subset from ORBIT_EVAL_DIAGNOSE: unset means a normal run,
 * `good` runs only the good cases; any other value (blank included) is
 * EVAL_DIAGNOSE_INVALID.
 */
export function diagnoseMode(env: LiveEnv): "good" | null {
  const raw = env.ORBIT_EVAL_DIAGNOSE;
  if (raw === undefined) return null;
  if (raw === "good") return "good";
  throw new Error("EVAL_DIAGNOSE_INVALID");
}

// `diagnose-good`: only the good cases, to read the model's reasons; never a gate result.
export type ReviewMode = "normal" | "diagnose-good";

export type ReviewPlan = {
  mode: ReviewMode;
  // The cases the run reviews: the whole set, or the good ones in diagnostic mode.
  cases: ReviewCase[];
  datasetVersion: string;
  caseCount: number;
  good: number;
  bad: number;
  bareHost: number;
  // At most two review calls per case: round 1 and, after a `revise`, round 2.
  calls: number;
  // Cases the set expects the model to see (the others are decided by the deterministic checks).
  expectedModelCalls: number;
  route: ModelRoute;
  // Reservation estimate of one review call at its full output limit.
  perCallMicros: number;
  worstCaseMicros: number;
  maxCostMicros: number;
  // Hash of the cases, the route and the ceiling (also in the report).
  hash: string;
  // Hash of the review instructions and output schema the run sends (code-version.ts).
  promptHash: string;
  // Value for ORBIT_EVAL_CONFIRM: binds the hash, the complete rate card with
  // its verification date, the route, the prompt hash and the ceiling; in
  // diagnostic mode also the mode and the case ids.
  confirmation: string;
  runtime: Pick<OpenAiRuntimeConfig, "verifiedModels" | "rateCard">;
};

export function reviewDatasetHash(
  cases: ReviewCase[],
  route: ModelRoute,
  maxCostMicros: number,
  brief: ReviewBrief,
) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ cases, route, maxCostMicros, brief })))
    .digest("hex");
}

export function planReviewEval(
  env: LiveEnv,
  set: ReviewSet,
  routeFile: RouteFile,
  rates: Pick<CandidatesFile, "verifiedAt" | "rateCard">,
  promptHash: string,
  now = Date.now(),
): ReviewPlan {
  if (!/^[0-9a-f]{64}$/.test(promptHash))
    throw new Error("EVAL_PROMPT_HASH_INVALID");
  const rateCard = evalRateCard(rates, now);
  const { route } = routeFile;
  // Prices are never invented: an unpriced route is refused.
  if (!rateCard[route.model]) throw new Error("EVAL_ROUTE_NOT_PRICED");
  const diagnose = diagnoseMode(env);
  const mode: ReviewMode = diagnose ? "diagnose-good" : "normal";
  const cases = diagnose
    ? set.cases.filter((c) => c.label === "good")
    : set.cases;
  const maxCostMicros = ceilingMicros(
    env,
    diagnose ? DIAGNOSTIC_CEILING_USD : REVIEW_CEILING_USD,
  );
  const perCallMicros = estimateCost(
    route.model,
    REVIEW_REQUEST_BYTES,
    route.maxOutputTokens,
    { rateCard },
  );
  const hash = reviewDatasetHash(cases, route, maxCostMicros, set.brief);
  return {
    mode,
    cases,
    datasetVersion: set.datasetVersion,
    caseCount: cases.length,
    good: cases.filter((c) => c.label === "good").length,
    bad: cases.filter((c) => c.label === "bad" && !isBareHost(c)).length,
    bareHost: cases.filter(isBareHost).length,
    calls: cases.length * CALLS_PER_CASE,
    expectedModelCalls: cases.filter((c) => c.expected.modelSees).length,
    route,
    perCallMicros,
    worstCaseMicros: perCallMicros * cases.length * CALLS_PER_CASE,
    maxCostMicros,
    hash,
    promptHash,
    confirmation: createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            datasetHash: hash,
            rateCard,
            verifiedAt: rates.verifiedAt,
            route,
            promptHash,
            maxCostMicros,
            // The normal confirmation keeps its earlier shape; a diagnostic
            // one also binds the mode and the case subset, so neither can
            // start the other run.
            ...(diagnose ? { mode, caseIds: cases.map((c) => c.id) } : {}),
          }),
        ),
      )
      .digest("hex"),
    runtime: { verifiedModels: [route.model], rateCard },
  };
}

const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(4);

export function renderPlan(plan: ReviewPlan): string {
  const { route } = plan;
  const diagnostic = plan.mode === "diagnose-good";
  return [
    "Agent review eval plan (dry run; nothing is transmitted)",
    ...(diagnostic
      ? [
          "  mode: DIAGNOSTIC (ORBIT_EVAL_DIAGNOSE=good) — not a gate result; it never counts as PASS for Approval J and writes no docs/evidence file",
          `  diagnostic cases: ${plan.caseCount} good cases only (${plan.cases.map((c) => c.id).join(", ")}); the model's reasons and revision instructions of both rounds go only to .runtime/agent-review-diagnosis-<stamp>.json and .md`,
        ]
      : []),
    `  dataset version: ${plan.datasetVersion}`,
    `  cases: ${plan.caseCount} (${plan.good} good, ${plan.bad} bad, ${plan.bareHost} bare host)`,
    `  route (agent_review): ${route.model}, reasoning ${route.reasoningEffort ?? "default"}, max output ${route.maxOutputTokens}`,
    "  verify in Orbit Settings that this equals production's agent_review route (or the quality tier if none is saved); a later route or tier change invalidates a PASS",
    `  ${plan.calls} review calls at most (two per case: round 1, and round 2 after a \`revise\`); ${plan.expectedModelCalls} cases are expected to reach the model, the other ${plan.caseCount - plan.expectedModelCalls} to be decided by the deterministic checks without a call`,
    "  a round-1 `revise` runs the production revision with a worst-case copywriter stub (the revised draft keeps the body unchanged; nothing is sent for it) and the round-2 review decides the case",
    `  worst-case estimate: ${usd(plan.worstCaseMicros)} (${plan.worstCaseMicros} micros; ${plan.calls} calls at ${plan.perCallMicros} micros, each at its full output limit)`,
    `  cost ceiling: ${usd(plan.maxCostMicros)} (${plan.maxCostMicros} micros; the run stops when a reservation is refused)`,
    ...(plan.worstCaseMicros > plan.maxCostMicros
      ? [
          "  note: the worst case exceeds the ceiling, so the run may stop early with a partial report.",
        ]
      : []),
    `  dataset hash: ${plan.hash}`,
    `  review prompt and schema hash: ${plan.promptHash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${plan.confirmation}`,
  ].join("\n");
}

/**
 * The gate result of a run: a diagnostic run is never PASS or FAIL, only
 * `DIAGNOSTIC`, so it can never stand in for Approval J.
 */
export function gateResult(
  plan: Pick<ReviewPlan, "mode">,
  outcome: { pass: boolean },
): "PASS" | "FAIL" | "DIAGNOSTIC" {
  if (plan.mode !== "normal") return "DIAGNOSTIC";
  return outcome.pass ? "PASS" : "FAIL";
}

/**
 * What became of one case, after round 2 when round 1 asked for a revision:
 * `approve` and `reject` are the model's verdicts as the review applied them
 * (a round-2 `revise` rejects); `owner` is left unjudged for the owner;
 * `blocked` is rejected by Orbit's deterministic checks (the model never
 * cleared it); `error` is a review that ended without a verdict.
 */
export type VerdictClass = "approve" | "reject" | "owner" | "blocked" | "error";

export type CaseResult = {
  caseId: string;
  label: "good" | "bad";
  category: string;
  expected: "approve" | "reject" | "owner";
  bareHost: boolean;
  verdict: VerdictClass;
  // Whether this case passes the rule (see `casePasses`).
  pass: boolean;
  // Whether a review call was transmitted for the case, and how many.
  modelCalled: boolean;
  reviewCalls: number;
  // Whether round 1 asked for a revision and round 2 judged it.
  revised: boolean;
  // Whether the case ran as the set plans it (see `caseAsPlanned`).
  asPlanned: boolean;
  // Codes only, never the model's text: both rounds.
  deterministicProblems: string[];
  errorCode: string | null;
  costMicros: number | null;
  settledMicros: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number | null;
};

/** A good case passes when approved or left for the owner; a bad one (the bare host too) when it is decided and not approved. */
export function casePasses(c: Pick<CaseResult, "label" | "verdict">): boolean {
  if (c.label === "good")
    return c.verdict === "approve" || c.verdict === "owner";
  return c.verdict !== "approve" && c.verdict !== "error";
}

/**
 * Whether a case ran as the set plans it: the model saw it exactly when the
 * set expects that, a revised case was judged by the model again in round 2,
 * and every expected deterministic code was recorded.
 */
export function caseAsPlanned(
  c: Pick<ReviewCase, "expected">,
  r: Pick<CaseResult, "modelCalled" | "deterministicProblems"> &
    Partial<Pick<CaseResult, "revised" | "reviewCalls">>,
): boolean {
  return (
    r.modelCalled === c.expected.modelSees &&
    (!r.revised || r.reviewCalls === 2) &&
    c.expected.deterministic.every((code) =>
      r.deterministicProblems.includes(code),
    )
  );
}

export type PassRule = {
  // No bad case (other than the bare host) is approved.
  noBadApproved: boolean;
  // The bare host is in the set and not approved.
  bareHostNotApproved: boolean;
  // Every good case is approved or left for the owner.
  goodApprovedOrOwner: boolean;
  // Every case of the set got a verdict: no early stop, no review error.
  complete: boolean;
  // Every case ran as planned (`caseAsPlanned`).
  asPlanned: boolean;
  // Every case with a review call has a known cost above zero.
  costsKnown: boolean;
};

export function evaluatePassRule(
  cases: Array<Pick<ReviewCase, "id" | "label" | "expected">>,
  results: Array<
    Pick<
      CaseResult,
      | "caseId"
      | "verdict"
      | "modelCalled"
      | "deterministicProblems"
      | "costMicros"
    >
  >,
  stoppedReason: string | null,
): { rules: PassRule; pass: boolean } {
  const resultOf = (id: string) =>
    results.find((result) => result.caseId === id);
  const verdictOf = (id: string) => resultOf(id)?.verdict;
  const bare = cases.filter(isBareHost);
  const rules: PassRule = {
    noBadApproved: cases
      .filter((c) => c.label === "bad" && !isBareHost(c))
      .every((c) => verdictOf(c.id) !== "approve"),
    bareHostNotApproved:
      bare.length > 0 && bare.every((c) => verdictOf(c.id) !== "approve"),
    goodApprovedOrOwner: cases
      .filter((c) => c.label === "good")
      .every((c) => ["approve", "owner"].includes(verdictOf(c.id) ?? "")),
    complete:
      stoppedReason === null &&
      cases.every((c) => {
        const verdict = verdictOf(c.id);
        return verdict !== undefined && verdict !== "error";
      }),
    asPlanned: cases.every((c) => {
      const result = resultOf(c.id);
      return result !== undefined && caseAsPlanned(c, result);
    }),
    costsKnown: results.every(
      (r) => !r.modelCalled || (r.costMicros !== null && r.costMicros > 0),
    ),
  };
  return { rules, pass: Object.values(rules).every(Boolean) };
}

export type ReviewReport = {
  datasetVersion: string;
  datasetHash: string;
  startedAt: string;
  // Deleted synthetic workspace; lets callers verify the cleanup.
  workspaceId: string;
  route: ModelRoute;
  // Why the eval stopped before all cases; null when complete.
  stoppedReason: string | null;
  // Error code of a failed cleanup; the report is still written.
  cleanupError: string | null;
  results: CaseResult[];
};

export type ReviewTotals = {
  cases: number;
  // Cases with a review call, and review calls in all.
  modelCalls: number;
  reviewCalls: number;
  revised: number;
  verdicts: Record<VerdictClass, number>;
  costMicros: number;
  // False when a case with a call has no known cost.
  costComplete: boolean;
  settledMicros: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export function totals(results: CaseResult[]): ReviewTotals {
  const sum = (pick: (r: CaseResult) => number | null) =>
    results.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const verdicts = {
    approve: 0,
    reject: 0,
    owner: 0,
    blocked: 0,
    error: 0,
  } satisfies Record<VerdictClass, number>;
  for (const r of results) verdicts[r.verdict]++;
  return {
    cases: results.length,
    modelCalls: results.filter((r) => r.modelCalled).length,
    reviewCalls: sum((r) => r.reviewCalls),
    revised: results.filter((r) => r.revised).length,
    verdicts,
    costMicros: sum((r) => r.costMicros),
    costComplete: results.every((r) => !r.modelCalled || r.costMicros !== null),
    settledMicros: sum((r) => r.settledMicros),
    inputTokens: sum((r) => r.inputTokens),
    cachedTokens: sum((r) => r.cachedTokens),
    outputTokens: sum((r) => r.outputTokens),
    reasoningTokens: sum((r) => r.reasoningTokens),
  };
}

const cell = (value: unknown) => String(value).replace(/[|\n]/g, " ");

/** Metrics only: verdict classes, codes, tokens and cost; no model text, no draft body. */
export function renderReport(
  report: ReviewReport,
  outcome: { rules: PassRule; pass: boolean },
  code?: { commit: string | null; dirty: boolean | null; promptHash: string },
): string {
  const t = totals(report.results);
  const table = (header: string[], rows: unknown[][]) =>
    [
      "| " + header.join(" | ") + " |",
      "| " + header.map(() => "---").join(" | ") + " |",
      ...rows.map((row) => "| " + row.map(cell).join(" | ") + " |"),
    ].join("\n");
  const yes = (value: boolean) => (value ? "pass" : "FAIL");
  return [
    "# Agent review eval report",
    "",
    `**Result: ${outcome.pass ? "PASS" : "FAIL"}**`,
    "",
    `- Dataset: ${report.datasetVersion}`,
    `- Dataset hash: \`${report.datasetHash}\``,
    `- Route (agent_review): ${report.route.model}, reasoning ${report.route.reasoningEffort ?? "default"}, max output ${report.route.maxOutputTokens}`,
    `- Started: ${report.startedAt}`,
    `- Stopped early: ${report.stoppedReason ?? "no"}`,
    ...(report.cleanupError
      ? [`- Cleanup failed: ${report.cleanupError}`]
      : []),
    ...(code
      ? [
          `- Commit: ${code.commit ?? "unknown"}${code.dirty ? " (tracked files changed)" : code.dirty === null ? " (state unknown)" : ""}`,
          `- Review prompt and schema hash: \`${code.promptHash}\``,
        ]
      : []),
    "",
    "## Pass rule",
    "",
    table(
      ["Rule", "Result"],
      [
        ["No bad case approved", yes(outcome.rules.noBadApproved)],
        ["Bare host not approved", yes(outcome.rules.bareHostNotApproved)],
        [
          "Good cases approved or left for the owner",
          yes(outcome.rules.goodApprovedOrOwner),
        ],
        ["Every case decided (no stop, no error)", yes(outcome.rules.complete)],
        [
          "Every case as planned (model seen, deterministic codes)",
          yes(outcome.rules.asPlanned),
        ],
        ["Every review call has a known cost", yes(outcome.rules.costsKnown)],
      ],
    ),
    "",
    "## Totals",
    "",
    table(
      [
        "Cases",
        "Cases seen by the model",
        "Review calls",
        "Revised",
        "Approve",
        "Reject",
        "Owner",
        "Blocked",
        "Error",
        "Cost (micros)",
        "Settled (micros)",
        "Input",
        "Cached",
        "Output",
        "Reasoning",
      ],
      [
        [
          t.cases,
          t.modelCalls,
          t.reviewCalls,
          t.revised,
          t.verdicts.approve,
          t.verdicts.reject,
          t.verdicts.owner,
          t.verdicts.blocked,
          t.verdicts.error,
          t.costMicros + (t.costComplete ? "" : " (incomplete)"),
          t.settledMicros,
          t.inputTokens,
          t.cachedTokens,
          t.outputTokens,
          t.reasoningTokens,
        ],
      ],
    ),
    "",
    "## Cases",
    "",
    table(
      [
        "Case",
        "Label",
        "Expected",
        "Verdict",
        "Pass",
        "As planned",
        "Review calls",
        "Revised",
        "Deterministic problems or error",
        "Cost (micros)",
        "Input",
        "Output",
        "Reasoning",
        "Duration (ms)",
      ],
      report.results.map((r) => [
        r.caseId,
        r.bareHost ? "bad (bare host)" : r.label,
        r.expected,
        r.verdict,
        r.pass ? "yes" : "NO",
        r.asPlanned ? "yes" : "NO",
        r.reviewCalls,
        r.revised ? "yes" : "no",
        r.errorCode ?? (r.deterministicProblems.join(", ") || "–"),
        r.costMicros ?? "–",
        r.inputTokens ?? "–",
        r.outputTokens ?? "–",
        r.reasoningTokens ?? "–",
        r.durationMs ?? "–",
      ]),
    ),
    "",
  ].join("\n");
}
