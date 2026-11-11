/**
 * Planning, gating and the pass rule of the manual live vision eval (spec
 * docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md §7).
 * Nothing here reads a database, calls a provider or prints a secret; the
 * only side effect is the key gate's keychain read of a confirmed run. The
 * rate card rules and the ceiling are the generation eval's
 * (`evals/generation/live-plan.ts`), the route file schema the review eval's
 * (`evals/agents/live-plan.ts`), the key gate `evals/agents/eval-key.ts`.
 */
import { createHash } from "node:crypto";
import {
  attachmentInputTokens,
  estimateCost,
  type ModelRoute,
  type OpenAiRuntimeConfig,
  type ProviderId,
} from "../../packages/ai/src/index.ts";
import { structuredOutputSchema } from "../../apps/api/src/platform/agents/structured-run.ts";
import {
  VISION_INSTRUCTIONS,
  visionAnswer,
  type VisionVerdict,
} from "../../apps/api/src/modules/marketing/creative/vision-review.ts";
import { canonical } from "../generation/harness.ts";
import {
  ceilingMicros,
  evalRateCard,
  type CandidatesFile,
  type LiveEnv,
} from "../generation/live-plan.ts";
import { routeFileSchemaFor } from "../agents/live-plan.ts";
import { EVAL_KEY_VARIABLES, resolveEvalKey } from "../agents/eval-key.ts";
import type { VisionCase, VisionSet } from "./vision-set.ts";

// Hard ceiling of this eval; ORBIT_EVAL_MAX_USD can only lower it.
export const VISION_CEILING_USD = 0.5;
// Good cases that must pass, of the set's four: a failing good image only
// sends a post to the owner, but a review that fails most good images would
// make the authority useless.
export const MIN_GOOD_PASSES = 3;
// Upper bound of the brief the model reads next to the image (brand,
// palette, imagery, format, template, key message and image copy as JSON),
// in bytes; the offline replay checks every request of the set against it.
// A planning bound only: each reservation uses the exact size.
export const VISION_BRIEF_BYTES = 2_000;

const visionRouteFileSchema = routeFileSchemaFor("creative_review");
export type VisionRouteFile = ReturnType<typeof visionRouteFileSchema.parse>;

/** The route file (`vision-route-v1.json`): production's `creative_review` route and its provider. */
export function parseVisionRouteFile(raw: unknown): VisionRouteFile {
  return visionRouteFileSchema.parse(raw);
}

/** Hash of the vision instructions and the strict output schema exactly as `visionReviewCreative` sends them. */
export function visionPromptHash() {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          instructions: VISION_INSTRUCTIONS,
          outputSchema: structuredOutputSchema(visionAnswer),
        }),
      ),
    )
    .digest("hex");
}

/**
 * The input bound of one review call as production estimates it
 * (instructions, brief, output schema and the image's token allowance),
 * with the brief at its planning bound.
 */
export function visionRequestBound() {
  return (
    Buffer.byteLength(VISION_INSTRUCTIONS) +
    VISION_BRIEF_BYTES +
    Buffer.byteLength(JSON.stringify(structuredOutputSchema(visionAnswer))) +
    attachmentInputTokens([{ kind: "image" }])
  );
}

/** Hash of the cases, the brands, the format, the provider, the route and the ceiling. */
export function visionDatasetHash(
  set: Pick<VisionSet, "cases" | "brands" | "format">,
  route: ModelRoute,
  maxCostMicros: number,
  provider: ProviderId,
) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          format: set.format,
          brands: set.brands,
          cases: set.cases,
          provider,
          route,
          maxCostMicros,
        }),
      ),
    )
    .digest("hex");
}

export type VisionPlan = {
  datasetVersion: string;
  format: string;
  caseCount: number;
  good: number;
  bad: number;
  // One review call per case.
  calls: number;
  // Who serves the route; the run's key is stored for this provider.
  provider: ProviderId;
  route: ModelRoute;
  // Reservation estimate of one review call at its full output limit.
  perCallMicros: number;
  worstCaseMicros: number;
  maxCostMicros: number;
  // Hash of the set, the provider, the route and the ceiling (also in the report).
  hash: string;
  // Hash of the vision instructions and output schema the run sends.
  promptHash: string;
  // Value for ORBIT_EVAL_CONFIRM: binds the hash, the complete rate card with
  // its verification date, the provider, the route, the prompt hash and the ceiling.
  confirmation: string;
  runtime: Pick<OpenAiRuntimeConfig, "verifiedModels" | "rateCard">;
};

/**
 * The plan of a run: refuses a malformed prompt hash, a stale or future rate
 * card (`EVAL_RATE_CARD_STALE`, `EVAL_RATE_CARD_FUTURE`), a route whose model
 * has no price (`EVAL_ROUTE_NOT_PRICED`) and a malformed ceiling, all before
 * any transmission.
 */
export function planVisionEval(
  env: LiveEnv,
  set: VisionSet,
  routeFile: VisionRouteFile,
  rates: Pick<CandidatesFile, "verifiedAt" | "rateCard">,
  promptHash: string,
  now = Date.now(),
): VisionPlan {
  if (!/^[0-9a-f]{64}$/.test(promptHash))
    throw new Error("EVAL_PROMPT_HASH_INVALID");
  const rateCard = evalRateCard(rates, now);
  const { route, provider } = routeFile;
  // Prices are never invented: an unpriced route is refused.
  if (!rateCard[route.model]) throw new Error("EVAL_ROUTE_NOT_PRICED");
  const maxCostMicros = ceilingMicros(env, VISION_CEILING_USD);
  const perCallMicros = estimateCost(
    route.model,
    visionRequestBound(),
    route.maxOutputTokens,
    { rateCard },
  );
  const hash = visionDatasetHash(set, route, maxCostMicros, provider);
  return {
    datasetVersion: set.datasetVersion,
    format: set.format,
    caseCount: set.cases.length,
    good: set.cases.filter((c) => c.label === "good").length,
    bad: set.cases.filter((c) => c.label === "bad").length,
    calls: set.cases.length,
    provider,
    route,
    perCallMicros,
    worstCaseMicros: perCallMicros * set.cases.length,
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
            provider,
            route,
            promptHash,
            maxCostMicros,
          }),
        ),
      )
      .digest("hex"),
    runtime: { verifiedModels: [route.model], rateCard },
  };
}

const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(4);

export function renderVisionPlan(plan: VisionPlan): string {
  const { route } = plan;
  return [
    "Creative vision eval plan (dry run; nothing is transmitted)",
    `  dataset version: ${plan.datasetVersion}`,
    `  cases: ${plan.caseCount} (${plan.good} good, ${plan.bad} bad), all in ${plan.format}; each creative composed for free from the offline fixtures in one synthetic project (no image provider)`,
    `  route (creative_review): provider ${plan.provider}, model ${route.model}, reasoning ${route.reasoningEffort ?? "default"}, max output ${route.maxOutputTokens}`,
    "  verify in Orbit Settings that this equals production's creative_review route (or the standard tier if none is saved); a later route or tier change invalidates a PASS",
    `  ${plan.calls} review calls at most (one per case, through the production vision review)`,
    `  worst-case estimate: ${usd(plan.worstCaseMicros)} (${plan.worstCaseMicros} micros; ${plan.calls} calls at ${plan.perCallMicros} micros, each at its full output limit and the request bound)`,
    `  cost ceiling: ${usd(plan.maxCostMicros)} (${plan.maxCostMicros} micros; the run stops when a reservation would exceed it)`,
    ...(plan.worstCaseMicros > plan.maxCostMicros
      ? [
          "  note: the worst case exceeds the ceiling, so the run may stop early with a partial report.",
        ]
      : []),
    `  pass rule: no bad case passes, at least ${MIN_GOOD_PASSES} of ${plan.good} good cases pass, every case has a verdict and a known cost above zero`,
    `  dataset hash: ${plan.hash}`,
    `  vision prompt and schema hash: ${plan.promptHash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${plan.confirmation}`,
  ].join("\n");
}

/**
 * Plans the run and prints the plan (and `code`, the commit line), then
 * reads the key of the route's provider. A null key is a dry run: the
 * commands for a live run are printed and nothing is transmitted. A key
 * alone or a confirmation alone is an error, never a dry run
 * (`EVAL_CONFIRMATION_MISMATCH`, `EVAL_KEY_REQUIRED`). The key is never printed.
 */
export async function startVisionEval(
  env: LiveEnv,
  inputs: {
    set: VisionSet;
    routeFile: VisionRouteFile;
    rates: Pick<CandidatesFile, "verifiedAt" | "rateCard">;
    now?: number;
    code?: string;
  },
  print: (text: string) => void = console.log,
): Promise<{ plan: VisionPlan; apiKey: string | null }> {
  const plan = planVisionEval(
    env,
    inputs.set,
    inputs.routeFile,
    inputs.rates,
    visionPromptHash(),
    inputs.now,
  );
  print(renderVisionPlan(plan));
  if (inputs.code) print(inputs.code);
  const apiKey = await resolveEvalKey(plan.provider, env, plan.confirmation);
  if (apiKey === null)
    print(
      `\nDry run only. To run live on ${plan.provider}, review the plan above, then run:\n` +
        `  ${EVAL_KEY_VARIABLES[plan.provider]}=<key> ORBIT_EVAL_CONFIRM=${plan.confirmation} pnpm eval:creative-vision\n` +
        "or, with the key stored in the macOS keychain (README.md):\n" +
        `  ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-${plan.provider} ORBIT_EVAL_CONFIRM=${plan.confirmation} pnpm eval:creative-vision`,
    );
  return { plan, apiKey };
}

/** A case's verdict: the vision review's, or `error` when it ended without one. */
export type VisionVerdictClass = VisionVerdict["verdict"] | "error";
type IssueKind = VisionVerdict["issues"][number]["kind"];

export type VisionCaseResult = {
  caseId: string;
  label: VisionCase["label"];
  brand: VisionCase["brand"];
  kitBrand: VisionCase["kitBrand"];
  art: VisionCase["art"];
  template: VisionCase["template"];
  expected: VisionCase["expected"];
  verdict: VisionVerdictClass;
  // Whether this case meets its expectation (`visionCasePasses`).
  pass: boolean;
  // The composition before the review, through production's path and its
  // free corrections: its verdict, its failed check codes and the variant
  // drawn, so the evidence shows the case was what the set describes.
  compositionVerdict: "pass" | "corrected" | "needs_owner";
  compositionFailed: string[];
  variant: string;
  // Hashes only, never bytes: the rendition sent, and the art and logo it was
  // drawn from (the kit brand's).
  renditionSha256: string;
  artSha256: string | null;
  logoSha256: string;
  // The format of the rendition the review judged.
  format: string | null;
  // Whether a review call was transmitted (a reservation that was not released).
  modelCalled: boolean;
  model: string | null;
  // The seven scores and the number of issues per kind; never the notes.
  scores: VisionVerdict["scores"] | null;
  issueKinds: Record<IssueKind, number> | null;
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

/** A good case passes with a passing verdict, a bad one with `needs_correction`; an error never passes. */
export function visionCasePasses(
  c: Pick<VisionCaseResult, "label" | "verdict">,
): boolean {
  return c.label === "good"
    ? c.verdict === "pass"
    : c.verdict === "needs_correction";
}

export type VisionPassRule = {
  // No bad case gets a passing verdict.
  noBadPassed: boolean;
  // At least MIN_GOOD_PASSES good cases get a passing verdict.
  goodPassed: boolean;
  // Every case got a verdict: no early stop, no error.
  complete: boolean;
  // Every case has a known cost above zero.
  costsKnown: boolean;
};

export function evaluateVisionPassRule(
  cases: Array<Pick<VisionCase, "id" | "label">>,
  results: Array<Pick<VisionCaseResult, "caseId" | "verdict" | "costMicros">>,
  stoppedReason: string | null,
): { rules: VisionPassRule; pass: boolean; goodPasses: number } {
  const resultOf = (id: string) => results.find((r) => r.caseId === id);
  const goodPasses = cases.filter(
    (c) => c.label === "good" && resultOf(c.id)?.verdict === "pass",
  ).length;
  const rules: VisionPassRule = {
    noBadPassed: cases
      .filter((c) => c.label === "bad")
      .every((c) => resultOf(c.id)?.verdict !== "pass"),
    goodPassed: goodPasses >= MIN_GOOD_PASSES,
    complete:
      stoppedReason === null &&
      cases.every((c) => {
        const verdict = resultOf(c.id)?.verdict;
        return verdict !== undefined && verdict !== "error";
      }),
    costsKnown: cases.every((c) => {
      const cost = resultOf(c.id)?.costMicros;
      return typeof cost === "number" && cost > 0;
    }),
  };
  return { rules, pass: Object.values(rules).every(Boolean), goodPasses };
}

export type VisionReport = {
  datasetVersion: string;
  datasetHash: string;
  startedAt: string;
  // The deleted synthetic workspace; lets callers verify the cleanup.
  workspaceId: string;
  provider: ProviderId;
  route: ModelRoute;
  format: string;
  // Why the eval stopped before all cases; null when complete.
  stoppedReason: string | null;
  // Error code of a failed cleanup; the report is still written.
  cleanupError: string | null;
  results: VisionCaseResult[];
};

export type VisionTotals = {
  cases: number;
  modelCalls: number;
  verdicts: Record<VisionVerdictClass, number>;
  costMicros: number;
  // False when a case with a call has no known cost.
  costComplete: boolean;
  settledMicros: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export function visionTotals(results: VisionCaseResult[]): VisionTotals {
  const sum = (pick: (r: VisionCaseResult) => number | null) =>
    results.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const verdicts = { pass: 0, needs_correction: 0, error: 0 };
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
    cacheWriteTokens: sum((r) => r.cacheWriteTokens),
    outputTokens: sum((r) => r.outputTokens),
    reasoningTokens: sum((r) => r.reasoningTokens),
  };
}

const cell = (value: unknown) => String(value).replace(/[|\n]/g, " ");

/** Metrics only: verdicts, scores, issue counts, codes, tokens and cost; no notes, no image, no key. */
export function renderVisionReport(
  report: VisionReport,
  outcome: { rules: VisionPassRule; pass: boolean; goodPasses: number },
  code?: { commit: string | null; dirty: boolean | null; promptHash: string },
): string {
  const t = visionTotals(report.results);
  const table = (header: string[], rows: unknown[][]) =>
    [
      "| " + header.join(" | ") + " |",
      "| " + header.map(() => "---").join(" | ") + " |",
      ...rows.map((row) => "| " + row.map(cell).join(" | ") + " |"),
    ].join("\n");
  const yes = (value: boolean) => (value ? "pass" : "FAIL");
  return [
    "# Creative vision eval report",
    "",
    `**Result: ${outcome.pass ? "PASS" : "FAIL"}**`,
    "",
    `- Dataset: ${report.datasetVersion}`,
    `- Dataset hash: \`${report.datasetHash}\``,
    `- Format: ${report.format}`,
    `- Route (creative_review): provider ${report.provider}, model ${report.route.model}, reasoning ${report.route.reasoningEffort ?? "default"}, max output ${report.route.maxOutputTokens}`,
    `- Started: ${report.startedAt}`,
    `- Stopped early: ${report.stoppedReason ?? "no"}`,
    ...(report.cleanupError
      ? [`- Cleanup failed: ${report.cleanupError}`]
      : []),
    ...(code
      ? [
          `- Commit: ${code.commit ?? "unknown"}${code.dirty ? " (tracked files changed)" : code.dirty === null ? " (state unknown)" : ""}`,
          `- Vision prompt and schema hash: \`${code.promptHash}\``,
        ]
      : []),
    "",
    "## Pass rule",
    "",
    table(
      ["Rule", "Result"],
      [
        ["No bad case passes", yes(outcome.rules.noBadPassed)],
        [
          `At least ${MIN_GOOD_PASSES} good cases pass (${outcome.goodPasses} passed)`,
          yes(outcome.rules.goodPassed),
        ],
        ["Every case decided (no stop, no error)", yes(outcome.rules.complete)],
        [
          "Every case has a known cost above zero",
          yes(outcome.rules.costsKnown),
        ],
      ],
    ),
    "",
    "## Totals",
    "",
    table(
      [
        "Cases",
        "Review calls",
        "Pass",
        "Needs correction",
        "Error",
        "Cost (micros)",
        "Settled (micros)",
        "Input",
        "Cached",
        "Cache write",
        "Output",
        "Reasoning",
      ],
      [
        [
          t.cases,
          t.modelCalls,
          t.verdicts.pass,
          t.verdicts.needs_correction,
          t.verdicts.error,
          t.costMicros + (t.costComplete ? "" : " (incomplete)"),
          t.settledMicros,
          t.inputTokens,
          t.cachedTokens,
          t.cacheWriteTokens,
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
        "Art",
        "Brand / kit",
        "Template (variant)",
        "Composition (failed checks)",
        "Rendition SHA-256",
        "Expected",
        "Verdict",
        "Pass",
        "Scores (subject, balance, legibility, brand, message, channel, value)",
        "Issues (art, layout, copy, logo)",
        "Error",
        "Cost (micros)",
        "Input",
        "Output",
        "Duration (ms)",
      ],
      report.results.map((r) => [
        r.caseId,
        r.label,
        r.art,
        `${r.brand} / ${r.kitBrand}`,
        `${r.template} (${r.variant})`,
        r.compositionVerdict +
          (r.compositionFailed.length
            ? ` (${r.compositionFailed.join(", ")})`
            : ""),
        `\`${r.renditionSha256.slice(0, 12)}\``,
        r.expected,
        r.verdict,
        r.pass ? "yes" : "NO",
        r.scores
          ? [
              r.scores.subject,
              r.scores.balance,
              r.scores.legibility,
              r.scores.brandFit,
              r.scores.messageFit,
              r.scores.channelFit,
              r.scores.value,
            ].join(", ")
          : "–",
        r.issueKinds
          ? [
              r.issueKinds.art,
              r.issueKinds.layout,
              r.issueKinds.copy,
              r.issueKinds.logo,
            ].join(", ")
          : "–",
        r.errorCode ?? "–",
        r.costMicros ?? "–",
        r.inputTokens ?? "–",
        r.outputTokens ?? "–",
        r.durationMs ?? "–",
      ]),
    ),
    "",
  ].join("\n");
}
