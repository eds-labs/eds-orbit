/**
 * Live review eval harness (rollout Approval J). Each case goes through the
 * production review step (`reviewStep`): Orbit's deterministic checks, then
 * the review specialist's real instructions, output schema and model call
 * through `runSpecialist` (reserve, markTransmitted, settle under the
 * `agent_review` route). A round-1 `revise` runs the production revision
 * (`reviseAssignmentDraft`) and the round-2 review decides the case. It must
 * run inside Vitest: the caller stubs `generate` and `embed` (stubs.ts), so
 * the copywriter draft that gives the cases their shape and every revision
 * send nothing; the revision is the worst case and keeps the body unchanged.
 * The harness refuses to run without those stubs and never mocks anything
 * itself. Only synthetic data is used, in a project created and deleted per
 * run, and only against a local database. Each brand of the set gets its
 * own synthetic project (brand-projects.ts); a case with image copy is
 * reviewed with a creative composed for free from the offline fixtures, with
 * the vision review off, so only the review model is measured. The ceiling
 * holds across all projects of a run. The run's key is stored for the route
 * file's provider, as production stores a project's key for that provider
 * (OpenAI or Anthropic), and `agent_review` must resolve to exactly the route.
 */
import { vi } from "vitest";
import { scoped } from "../../packages/db/src/index.ts";
import {
  embed,
  generate,
  resolveRoute,
  routeProvider,
  type ModelRoute,
  type OpenAiRuntimeConfig,
  type ProviderId,
} from "../../packages/ai/src/index.ts";
import type { Scope } from "../../packages/schemas/src/index.ts";
import { data, entity, list, update } from "../../apps/api/src/shared.ts";
import { errorCode } from "../../apps/api/src/modules/telemetry.ts";
import {
  runtimeOpenAiConfiguration,
  saveAiConfiguration,
} from "../../apps/api/src/modules/openai-configuration.ts";
import {
  runSpend,
  taskReservations,
} from "../../apps/api/src/modules/agents/specialists/runner.ts";
import { reviewStep } from "../../apps/api/src/modules/agents/specialists/review.ts";
import { createPackageProject } from "../../apps/api/tests/support/package-project.ts";
import {
  assertLocalDatabase,
  removeStaleEvals,
} from "../generation/harness.ts";
import {
  caseBrand,
  isBareHost,
  type ReviewBrands,
  type ReviewCase,
} from "./review-set.ts";
import type { CaseDiagnosis, RoundDiagnosis } from "./diagnosis.ts";
import {
  caseAsPlanned,
  casePasses,
  REVIEW_CEILING_USD,
  reviewDatasetHash,
  type CaseResult,
  type ReviewReport,
  type VerdictClass,
} from "./live-plan.ts";
import {
  caseDraft,
  endCase,
  prepareBrandRun,
  type BrandRun,
} from "./brand-projects.ts";

// Exact name of the workspace, project and users the harness creates; the
// residue of a hard-killed run is removed by the next run after 12 hours.
export const REVIEW_EVAL_MARKER = "Synthetic agent review eval";
// The eval's hard ceiling (REVIEW_CEILING_USD, 3 USD): no run may be given more.
const MAX_COST_MICROS = Math.round(REVIEW_CEILING_USD * 1_000_000);
// Refused reservations: every further case would be refused as well.
const BUDGET_REFUSALS = new Set([
  "AGENT_LIMIT",
  "BUDGET_EXCEEDED",
  "RUN_BUDGET_EXCEEDED",
  "BUDGET_NOT_APPROVED",
  "ASSIGNMENT_BUDGET_EXHAUSTED",
]);
// Reviews that ended without a verdict but at a known cost: counted as
// errors, the run goes on.
const CASE_ERRORS = new Set([
  "MODEL_REQUEST_NOT_ACCEPTED",
  "AGENT_OUTPUT_INVALID",
]);
const DAY_MS = 86_400_000;

type Project = Awaited<ReturnType<typeof createPackageProject>>;

/** The eval transmits only review calls: drafts, revisions and embeddings must be stubs. */
function assertStubs() {
  if (!vi.isMockFunction(generate) || !vi.isMockFunction(embed))
    throw new Error("EVAL_STUBS_REQUIRED");
}

/**
 * A brand's project up to its review step, as in the offline replay
 * (`prepareBrandRun`): the copywriter writes one draft whose shape (mission,
 * evidence, slot) every case of the brand reuses; the draft itself is
 * archived. The ceiling is also the project's budget: the policy refuses
 * beyond it, and the run's pool (R75) is lowered before each case to what
 * the whole eval has left (`remainingMicros`).
 */
async function prepare(
  project: Project,
  brand: string,
  brands: ReviewBrands,
  creative: boolean,
  maxCostMicros: number,
) {
  const run = await prepareBrandRun(project, brand, brands[brand]!, {
    creative,
    policy: {
      startAt: new Date(Date.now() - DAY_MS).toISOString(),
      // A short window limits what a hard-killed run leaves usable.
      endAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      maxPerDay: 2,
      minIntervalMinutes: 120,
      dailyBudgetMicros: maxCostMicros,
      monthlyBudgetMicros: maxCostMicros,
      perRunBudgetMicros: maxCostMicros,
    },
  });
  // No Telegram bot is linked, so no notification is queued. The run's own
  // next steps (its review, its visual step) are canceled, so nothing but the
  // cases can call a model with the key, even if a worker picked them up.
  await run.h.run(async (tx) => {
    for (const row of await list(tx, project.owner, "agent_tasks"))
      if (
        !["done", "failed", "canceled", "outcome_unknown"].includes(
          data(row).status,
        )
      )
        await update(tx, project.owner, row, {
          ...data(row),
          status: "canceled",
        });
  });
  return run;
}

/**
 * Lets a brand's run pool (R75) take at most `remaining` more: every case
 * reserves from it, and the projects of one eval share one ceiling.
 */
async function capRun(run: BrandRun, remaining: number) {
  const { owner } = run.project;
  await run.h.run(async (tx) => {
    const row = await entity(
      tx,
      owner,
      "assignment_runs",
      String(run.template.assignmentRunId),
    );
    await update(tx, owner, row, {
      ...data(row),
      ceilingMicros:
        (await runSpend(tx, owner, String(run.template.assignmentRunId))) +
        remaining,
    });
  });
}

type EvalRuntime = Pick<OpenAiRuntimeConfig, "verifiedModels" | "rateCard">;

/**
 * Stores the run's key and the planned `agent_review` route through
 * production's save path (`saveAiConfiguration`): the model section with the
 * eval's verified model, rate card and task route, and the key where
 * production keeps that provider's project key (encrypted): an OpenAI key in
 * the model section, an Anthropic key in the provider section. Then checks
 * that `agent_review` resolves to exactly the route on that provider, and
 * that its calls would carry the run's key.
 */
async function configure(
  owner: Scope,
  provider: ProviderId,
  apiKey: string,
  runtime: EvalRuntime,
  route: ModelRoute,
) {
  await scoped(owner.workspaceId, owner.projectId, async (tx) => {
    const models = {
      verifiedModels: runtime.verifiedModels,
      rateCard: runtime.rateCard,
      modelRoutes: {
        fast: route.model,
        standard: route.model,
        quality: route.model,
        escalation: route.model,
      },
      taskRoutes: { agent_review: route },
    };
    await saveAiConfiguration(
      tx,
      owner,
      provider === "anthropic"
        ? {
            models,
            providers: { anthropicApiKey: apiKey, defaultProvider: "anthropic" },
          }
        : { models: { apiKey, ...models } },
    );
    const configured = await runtimeOpenAiConfiguration(tx, owner);
    const resolved = resolveRoute("agent_review", configured);
    if (
      JSON.stringify(resolved) !== JSON.stringify(route) ||
      routeProvider(resolved, configured) !== provider
    )
      throw new Error("EVAL_ROUTE_MISMATCH");
    // Never a granted connection's or the environment's key in its place.
    const used =
      provider === "anthropic" ? configured.anthropicApiKey : configured.apiKey;
    if (used !== apiKey) throw new Error("EVAL_KEY_NOT_APPLIED");
  });
}

/** What the ceiling still allows: every reservation of every project, settled at its settled amount, open at its reserved one. */
async function remainingMicros(owners: Scope[], maxCostMicros: number) {
  let held = 0;
  for (const owner of owners) {
    const rows = await scoped(owner.workspaceId, owner.projectId, (tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: owner.projectId, state: { not: "released" } },
      }),
    );
    held += rows.reduce(
      (sum, row) =>
        sum +
        Number(row.state === "settled" ? row.settledMicros : row.amountMicros),
      0,
    );
  }
  return maxCostMicros - held;
}

/** One case: its draft (with a composed creative for image copy), its channel history and its own review task; returns its metrics. */
async function runCase(
  run: BrandRun,
  c: ReviewCase,
  ceilingMicros: number,
  diagnose: boolean,
): Promise<{
  result: CaseResult;
  unknown: boolean;
  diagnosis: CaseDiagnosis | null;
}> {
  const { h } = run;
  const { owner } = run.project;
  // What is left of the ceiling (informational on the task): the run's pool
  // refuses a larger reservation (AGENT_LIMIT, R75).
  const setup = await caseDraft(run, c, ceilingMicros);
  type Decision = {
    contentId: string;
    verdict: string;
    deterministicProblems: string[];
    revisedTo?: string | null;
  };
  let failure: string | null = null;
  let first: Decision | undefined;
  let final: Decision | undefined;
  try {
    const output = (await reviewStep(h.worker(), {
      id: setup.task.id,
      ...(data(setup.task) as any),
    })) as { decisions: Decision[] };
    first = output.decisions.find((d) => d.contentId === setup.contentId);
    // A revised draft is decided by its round-2 review.
    final = first?.revisedTo
      ? output.decisions.find((d) => d.contentId === first!.revisedTo)
      : first;
    if (!final) failure = "EVAL_DECISION_MISSING";
  } catch (error) {
    failure = errorCode(error);
  }
  const measured = await h.run(async (tx) => {
    // Every review call of the task: one agent run per round.
    const runs = await tx.agentRun.findMany({
      where: {
        projectId: owner.projectId,
        kind: "agent",
        subjectType: "agent_task",
        subjectId: setup.task.id,
      },
    });
    const spans = runs.length
      ? await tx.agentSpan.findMany({
          where: {
            runId: { in: runs.map((run) => run.id) },
            type: "model_call",
          },
        })
      : [];
    // Review reservations only; the stubbed revision draft reserves under the draft route.
    const allReservations = await taskReservations(tx, owner, setup.task.id);
    const reservations = allReservations.filter(
      (row) => row.taskClass === "agent_review",
    );
    const original = data(await entity(tx, owner, "content", setup.contentId));
    // Diagnostic mode only: each round's decision as the review step stored
    // it on the draft it judged (round 1 on the original, round 2 on the revision).
    const rounds: RoundDiagnosis[] = [];
    if (diagnose)
      for (const id of [setup.contentId, first?.revisedTo]) {
        if (!id) continue;
        const v =
          id === setup.contentId
            ? original
            : data(await entity(tx, owner, "content", id));
        const stored = v.agentReviewDecision;
        if (stored?.taskId !== setup.task.id) continue;
        rounds.push({
          round: stored.round,
          verdict: stored.verdict,
          modelVerdict: stored.modelVerdict ?? null,
          reasons: [...(stored.reasons ?? [])],
          revisionInstructions: stored.revisionInstructions ?? null,
          deterministicProblems: [...(stored.deterministicProblems ?? [])],
          body: String(v.body),
        });
      }
    // A revision that failed (it is a stub, so this is not the planned path) is an error.
    const revisionError = original.agentReviewDecision?.revisionError;
    if (!failure && revisionError) failure = String(revisionError);
    if (!failure && first?.verdict === "revise" && !first.revisedTo)
      failure = "EVAL_REVISION_MISSING";
    const problems = [
      ...new Set([
        ...(first?.deterministicProblems ?? []),
        ...(final && final !== first ? final.deterministicProblems : []),
      ]),
    ];
    const verdict: VerdictClass = failure
      ? "error"
      : final!.verdict === "needs_owner"
        ? "owner"
        : final!.verdict === "reject" && final!.deterministicProblems.length
          ? "blocked"
          : final!.verdict === "approve"
            ? "approve"
            : "reject";
    const known = spans.filter((span) => span.costMicros !== null);
    const sum = (pick: (span: (typeof spans)[number]) => number | null) =>
      spans.length ? spans.reduce((n, span) => n + (pick(span) ?? 0), 0) : null;
    const settled = reservations.filter((row) => row.state === "settled");
    const modelCalled = reservations.some((row) => row.state !== "released");
    const result: CaseResult = {
      caseId: c.id,
      label: c.label,
      category: c.category,
      expected: c.expected.verdict,
      bareHost: isBareHost(c),
      verdict,
      pass: casePasses({ label: c.label, verdict }),
      modelCalled,
      reviewCalls: reservations.filter((row) => row.state !== "released")
        .length,
      revised: Boolean(first?.revisedTo),
      asPlanned: caseAsPlanned(c, {
        modelCalled,
        deterministicProblems: problems,
        revised: Boolean(first?.revisedTo),
        reviewCalls: reservations.filter((row) => row.state !== "released")
          .length,
      }),
      deterministicProblems: problems,
      errorCode: failure,
      costMicros:
        spans.length && known.length === spans.length
          ? known.reduce((n, span) => n + Number(span.costMicros), 0)
          : null,
      settledMicros: settled.length
        ? settled.reduce((n, row) => n + Number(row.settledMicros ?? 0), 0)
        : null,
      inputTokens: sum((span) => span.inputTokens),
      cachedTokens: sum((span) => span.cachedTokens),
      cacheWriteTokens: sum((span) => span.cacheWriteTokens),
      outputTokens: sum((span) => span.outputTokens),
      reasoningTokens: sum((span) => span.reasoningTokens),
      durationMs: sum((span) => span.durationMs),
    };
    return {
      result,
      // Any unknown outcome stops the run, the revision draft's included.
      unknown: allReservations.some((row) => row.state === "unknown"),
      diagnosis: diagnose
        ? {
            caseId: c.id,
            label: c.label,
            category: c.category,
            verdict,
            errorCode: failure,
            rounds,
          }
        : null,
    };
  });
  // Cleanup of the case: its drafts leave the run, its history the channel.
  await endCase(run, setup, [setup.contentId, first?.revisedTo]);
  return measured;
}

// Whether a finished case stops the run, and why.
function stopReason(result: CaseResult, unknown: boolean) {
  if (unknown || result.errorCode === "AGENT_OUTCOME_UNKNOWN")
    return "RESERVATION_UNKNOWN";
  if (result.errorCode === null || CASE_ERRORS.has(result.errorCode))
    return null;
  if (BUDGET_REFUSALS.has(result.errorCode)) return result.errorCode;
  return "UNEXPECTED:" + result.errorCode;
}

export async function runReviewEval(options: {
  cases: ReviewCase[];
  // The set's brands: one synthetic project each, for the brands of `cases`.
  brands: ReviewBrands;
  route: ModelRoute;
  // Who serves the route (the route file's provider); the key is stored for it.
  provider: ProviderId;
  // The run's key for `provider`; never printed or written.
  apiKey: string;
  maxCostMicros: number;
  // The eval's verified model and rate card (the plan's runtime).
  runtime: EvalRuntime;
  datasetVersion: string;
  // Diagnostic mode: receives each case's stored reasons, revision
  // instructions and draft bodies. They never enter the metrics report.
  diagnose?: (entry: CaseDiagnosis) => void;
}): Promise<ReviewReport> {
  assertLocalDatabase();
  assertStubs();
  const { cases, route, provider, apiKey, maxCostMicros, runtime } = options;
  if (
    !Number.isSafeInteger(maxCostMicros) ||
    maxCostMicros < 1 ||
    maxCostMicros > MAX_COST_MICROS
  )
    throw new Error("EVAL_MAX_COST_INVALID");
  if (
    !runtime.verifiedModels.includes(route.model) ||
    !runtime.rateCard[route.model]
  )
    throw new Error("EVAL_ROUTE_NOT_CONFIGURED");
  // A route its provider does not serve would send the key to the wrong
  // provider: refused before any project exists.
  if (routeProvider(route, {}) !== provider)
    throw new Error("EVAL_ROUTE_MISMATCH");
  if (!apiKey.trim()) throw new Error("EVAL_KEY_REQUIRED");
  await removeStaleEvals(REVIEW_EVAL_MARKER);
  const startedAt = new Date().toISOString();
  // The copywriter task that shapes the cases runs only with Orbit Agents
  // on, and a case with image copy needs the Creative Studio (as in
  // production); both are restored afterwards.
  const saved = {
    ORBIT_AGENTS: process.env.ORBIT_AGENTS,
    ORBIT_CREATIVE_STUDIO: process.env.ORBIT_CREATIVE_STUDIO,
  };
  process.env.ORBIT_AGENTS = "true";
  process.env.ORBIT_CREATIVE_STUDIO = "true";
  const results: CaseResult[] = [];
  let stoppedReason: string | null = null;
  const projects: Project[] = [];
  const runs = new Map<string, BrandRun>();
  let setupError: unknown = null;
  try {
    // The brands of the cases, in the order they first appear.
    const brands = [...new Set(cases.map((c) => caseBrand(options, c)))];
    for (const brand of brands) {
      if (!options.brands[brand]) throw new Error("EVAL_BRAND_UNKNOWN");
      const project = await createPackageProject({ name: REVIEW_EVAL_MARKER });
      projects.push(project);
      runs.set(
        brand,
        await prepare(
          project,
          brand,
          options.brands,
          cases.some(
            (c) =>
              caseBrand(options, c) === brand && c.creativeCopy !== undefined,
          ),
          maxCostMicros,
        ),
      );
    }
    // The key enters the projects only now, after the stubbed drafts.
    for (const project of projects)
      await configure(project.owner, provider, apiKey, runtime, route);
    try {
      for (const c of cases) {
        const remaining = await remainingMicros(
          projects.map((project) => project.owner),
          maxCostMicros,
        );
        if (remaining <= 0) {
          stoppedReason = "BUDGET_EXCEEDED";
          break;
        }
        const run = runs.get(caseBrand(options, c))!;
        await capRun(run, remaining);
        const { result, unknown, diagnosis } = await runCase(
          run,
          c,
          remaining,
          Boolean(options.diagnose),
        );
        results.push(result);
        if (diagnosis) options.diagnose?.(diagnosis);
        stoppedReason = stopReason(result, unknown);
        if (stoppedReason) break;
      }
    } catch (error) {
      // Keep the completed cases; the cleanup below still runs.
      stoppedReason = "UNEXPECTED:" + errorCode(error);
    }
  } catch (error) {
    setupError = error;
  }
  // Cleanup always runs. Each workspace cascades to its project, its
  // encrypted key and every row of its run.
  let cleanupError: unknown = null;
  for (const project of projects)
    try {
      await project.cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  // Setup fails before any review call; a failed cleanup after paid calls is
  // reported with the results instead, so the evidence is still written.
  if (setupError) throw setupError;
  return {
    datasetVersion: options.datasetVersion,
    datasetHash: reviewDatasetHash(
      cases,
      route,
      maxCostMicros,
      options.brands,
      provider,
    ),
    startedAt,
    workspaceIds: projects.map((project) => project.owner.workspaceId),
    provider,
    route,
    stoppedReason,
    cleanupError: cleanupError ? errorCode(cleanupError) : null,
    results,
  };
}
