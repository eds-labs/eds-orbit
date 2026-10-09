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
import { isBareHost, type ReviewCase, type ReviewSet } from "./review-set.ts";

// Hard ceiling of this eval; ORBIT_EVAL_MAX_USD can only lower it.
export const REVIEW_CEILING_USD = 1;
// Upper bound of one review request (base and review instructions, output
// schema, assignment, brand, one draft with facts and brief, up to five
// channel posts of 240 characters). Measured at about 3,300 bytes for this
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

export type ReviewPlan = {
  datasetVersion: string;
  caseCount: number;
  good: number;
  bad: number;
  bareHost: number;
  // At most one review call per case: the eval never runs a revision.
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
  // Value for ORBIT_EVAL_CONFIRM: binds the hash, the complete rate card with
  // its verification date, the route and the ceiling.
  confirmation: string;
  runtime: Pick<OpenAiRuntimeConfig, "verifiedModels" | "rateCard">;
};

export function reviewDatasetHash(
  cases: ReviewCase[],
  route: ModelRoute,
  maxCostMicros: number,
) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ cases, route, maxCostMicros })))
    .digest("hex");
}

export function planReviewEval(
  env: LiveEnv,
  set: ReviewSet,
  routeFile: RouteFile,
  rates: Pick<CandidatesFile, "verifiedAt" | "rateCard">,
  now = Date.now(),
): ReviewPlan {
  const rateCard = evalRateCard(rates, now);
  const { route } = routeFile;
  // Prices are never invented: an unpriced route is refused.
  if (!rateCard[route.model]) throw new Error("EVAL_ROUTE_NOT_PRICED");
  const maxCostMicros = ceilingMicros(env, REVIEW_CEILING_USD);
  const perCallMicros = estimateCost(
    route.model,
    REVIEW_REQUEST_BYTES,
    route.maxOutputTokens,
    { rateCard },
  );
  const hash = reviewDatasetHash(set.cases, route, maxCostMicros);
  return {
    datasetVersion: set.datasetVersion,
    caseCount: set.cases.length,
    good: set.cases.filter((c) => c.label === "good").length,
    bad: set.cases.filter((c) => c.label === "bad" && !isBareHost(c)).length,
    bareHost: set.cases.filter(isBareHost).length,
    calls: set.cases.length,
    expectedModelCalls: set.cases.filter((c) => c.expected.modelSees).length,
    route,
    perCallMicros,
    worstCaseMicros: perCallMicros * set.cases.length,
    maxCostMicros,
    hash,
    confirmation: createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            datasetHash: hash,
            rateCard,
            verifiedAt: rates.verifiedAt,
            route,
            maxCostMicros,
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
  return [
    "Agent review eval plan (dry run; nothing is transmitted)",
    `  dataset version: ${plan.datasetVersion}`,
    `  cases: ${plan.caseCount} (${plan.good} good, ${plan.bad} bad, ${plan.bareHost} bare host)`,
    `  route (agent_review): ${route.model}, reasoning ${route.reasoningEffort ?? "default"}, max output ${route.maxOutputTokens}`,
    `  ${plan.calls} planned review calls at most (one per case); ${plan.expectedModelCalls} expected, the other ${plan.calls - plan.expectedModelCalls} cases are expected to be decided by the deterministic checks without a call`,
    "  the production review can call the model up to 3 times per draft (review, copywriter revision, second review); this eval never runs the revision, so a round-1 `revise` is recorded as such and costs no further call",
    `  worst-case estimate: ${usd(plan.worstCaseMicros)} (${plan.worstCaseMicros} micros; ${plan.calls} calls at ${plan.perCallMicros} micros, each at its full output limit)`,
    `  cost ceiling: ${usd(plan.maxCostMicros)} (${plan.maxCostMicros} micros; the run stops when a reservation is refused)`,
    ...(plan.worstCaseMicros > plan.maxCostMicros
      ? [
          "  note: the worst case exceeds the ceiling, so the run may stop early with a partial report.",
        ]
      : []),
    `  dataset hash: ${plan.hash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${plan.confirmation}`,
  ].join("\n");
}

/**
 * What became of one case: `approve`, `revise` and `reject` are the model's
 * verdicts as the review applied them; `owner` is left unjudged for the
 * owner; `blocked` is rejected by Orbit's deterministic checks (the model
 * never cleared it); `error` is a review that ended without a verdict.
 */
export type VerdictClass =
  "approve" | "revise" | "reject" | "owner" | "blocked" | "error";

export type CaseResult = {
  caseId: string;
  label: "good" | "bad";
  category: string;
  expected: "approve" | "reject" | "owner";
  bareHost: boolean;
  verdict: VerdictClass;
  // Whether this case passes the rule (see `casePasses`).
  pass: boolean;
  // Whether a review call was transmitted for the case.
  modelCalled: boolean;
  // Codes only, never the model's text.
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

export type PassRule = {
  // No bad case (other than the bare host) is approved.
  noBadApproved: boolean;
  // The bare host is in the set and not approved.
  bareHostNotApproved: boolean;
  // Every good case is approved or left for the owner.
  goodApprovedOrOwner: boolean;
  // Every case of the set got a verdict: no early stop, no review error.
  complete: boolean;
};

export function evaluatePassRule(
  cases: Array<Pick<ReviewCase, "id" | "label" | "expected">>,
  results: Array<Pick<CaseResult, "caseId" | "verdict">>,
  stoppedReason: string | null,
): { rules: PassRule; pass: boolean } {
  const verdictOf = (id: string) =>
    results.find((result) => result.caseId === id)?.verdict;
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
  results: CaseResult[];
};

export type ReviewTotals = {
  cases: number;
  modelCalls: number;
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
    revise: 0,
    reject: 0,
    owner: 0,
    blocked: 0,
    error: 0,
  } satisfies Record<VerdictClass, number>;
  for (const r of results) verdicts[r.verdict]++;
  return {
    cases: results.length,
    modelCalls: results.filter((r) => r.modelCalled).length,
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
      ],
    ),
    "",
    "## Totals",
    "",
    table(
      [
        "Cases",
        "Review calls",
        "Approve",
        "Revise",
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
          t.verdicts.approve,
          t.verdicts.revise,
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
        "Model called",
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
        r.modelCalled ? "yes" : "no",
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
