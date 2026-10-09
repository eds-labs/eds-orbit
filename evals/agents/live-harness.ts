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
 * run, and only against a local database.
 */
import { vi } from "vitest";
import { scoped } from "../../packages/db/src/index.ts";
import {
  embed,
  generate,
  resolveRoute,
  type ModelRoute,
  type OpenAiRuntimeConfig,
} from "../../packages/ai/src/index.ts";
import type { Scope } from "../../packages/schemas/src/index.ts";
import {
  create,
  data,
  entity,
  list,
  update,
} from "../../apps/api/src/shared.ts";
import { errorCode } from "../../apps/api/src/modules/telemetry.ts";
import {
  runtimeOpenAiConfiguration,
  saveOpenAiConfiguration,
} from "../../apps/api/src/modules/openai-configuration.ts";
import {
  runAgentTask,
  taskReservations,
} from "../../apps/api/src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../../apps/api/src/modules/agents/specialists/index.ts";
import { reviewStep } from "../../apps/api/src/modules/agents/specialists/review.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "../../apps/api/tests/support/package-project.ts";
import { assignmentRun } from "../../apps/api/tests/support/assignment-review.ts";
import {
  assertLocalDatabase,
  removeStaleEvals,
} from "../generation/harness.ts";
import { isBareHost, type ReviewCase } from "./review-set.ts";
import {
  caseAsPlanned,
  casePasses,
  reviewDatasetHash,
  type CaseResult,
  type ReviewReport,
  type VerdictClass,
} from "./live-plan.ts";

// Exact name of the workspace, project and users the harness creates; the
// residue of a hard-killed run is removed by the next run after 12 hours.
export const REVIEW_EVAL_MARKER = "Synthetic agent review eval";
// Policy schema maximum for perRunBudgetMicros.
const MAX_COST_MICROS = 100_000_000;
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
type Harness = ReturnType<typeof assignmentRun>;

/** The eval transmits only review calls: drafts, revisions and embeddings must be stubs. */
function assertStubs() {
  if (!vi.isMockFunction(generate) || !vi.isMockFunction(embed))
    throw new Error("EVAL_STUBS_REQUIRED");
}

/**
 * The run of one confirmed X assignment up to its review step, as in the
 * offline replay: the copywriter writes one draft whose shape (mission,
 * evidence, slot) every case reuses; the draft itself is archived.
 */
async function prepare(project: Project, maxCostMicros: number) {
  const h = assignmentRun(project);
  // The ceiling is also the project's budget: the policy refuses beyond it.
  await h.setPolicy({
    startAt: new Date(Date.now() - DAY_MS).toISOString(),
    // A short window limits what a hard-killed run leaves usable.
    endAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    channels: [X, TELEGRAM],
    maxPerDay: 2,
    minIntervalMinutes: 120,
    dailyBudgetMicros: maxCostMicros,
    monthlyBudgetMicros: maxCostMicros,
    perRunBudgetMicros: maxCostMicros,
  });
  registerAgentSpecialists();
  // No Telegram bot is linked, so no notification is queued.
  await h.makeAssignment({
    schedule: {
      rhythm: "daily",
      weekdays: [],
      times: ["10:00"],
      leadMinutes: 360,
    },
  });
  await h.planWithBriefs((slots) => slots.map((slot) => h.brief(slot)));
  await runAgentTask(h.worker(), (await h.task(`copywriter:${X}`)).id);
  const [template] = await h.rows("content");
  if (!template) throw new Error("EVAL_TEMPLATE_MISSING");
  await archive(h, project.owner, template.id);
  // The run's own next steps (its review) are canceled, so nothing but the
  // cases can call the model with the key, even if a worker picked them up.
  await h.run(async (tx) => {
    for (const row of await list(tx, project.owner, "agent_tasks"))
      if (!["done", "failed", "canceled"].includes(data(row).status))
        await update(tx, project.owner, row, {
          ...data(row),
          status: "canceled",
        });
  });
  return { h, template };
}

async function archive(h: Harness, owner: Scope, contentId: string) {
  await h.run(async (tx) => {
    const row = await entity(tx, owner, "content", contentId);
    await update(tx, owner, row, { ...data(row), status: "archived" });
  });
}

/** Stores the run's key and the planned `agent_review` route, then checks that the route resolves as planned. */
async function configure(
  owner: Scope,
  runtime: OpenAiRuntimeConfig,
  route: ModelRoute,
) {
  await scoped(owner.workspaceId, owner.projectId, async (tx) => {
    await saveOpenAiConfiguration(tx, owner, {
      apiKey: runtime.apiKey,
      verifiedModels: runtime.verifiedModels,
      rateCard: runtime.rateCard,
      modelRoutes: {
        fast: route.model,
        standard: route.model,
        quality: route.model,
        escalation: route.model,
      },
      taskRoutes: { agent_review: route },
    });
    const resolved = resolveRoute(
      "agent_review",
      await runtimeOpenAiConfiguration(tx, owner),
    );
    if (JSON.stringify(resolved) !== JSON.stringify(route))
      throw new Error("EVAL_ROUTE_MISMATCH");
  });
}

/** What the ceiling still allows: every reservation of the project, settled at its settled amount, open at its reserved one. */
async function remainingMicros(owner: Scope, maxCostMicros: number) {
  const rows = await scoped(owner.workspaceId, owner.projectId, (tx) =>
    tx.budgetReservation.findMany({
      where: { projectId: owner.projectId, state: { not: "released" } },
    }),
  );
  const held = rows.reduce(
    (sum, row) =>
      sum +
      Number(row.state === "settled" ? row.settledMicros : row.amountMicros),
    0,
  );
  return maxCostMicros - held;
}

/** One case: its draft, its channel history and its own review task; returns its metrics. */
async function runCase(
  h: Harness,
  owner: Scope,
  template: Record<string, any>,
  c: ReviewCase,
  ceilingMicros: number,
): Promise<{ result: CaseResult; unknown: boolean }> {
  const { id: _id, version: _version, ...shape } = template;
  const setup = await h.run(async (tx) => {
    const content = await create(tx, owner, "content", {
      ...shape,
      title: c.id,
      body: c.body,
      claims: [{ text: "Learn more.", kind: "style" }],
      jobId: `eval:${c.id}`,
      status: "draft",
    });
    const posts = [];
    for (const [index, text] of (c.channelHistory ?? []).entries())
      posts.push(
        await create(tx, owner, "channel_posts", {
          channel: X,
          remoteId: `eval-${c.id}-${index}`,
          publishedAt: new Date(Date.now() - DAY_MS).toISOString(),
          state: "PUBLISHED",
          text,
          source: "external",
          syncedAt: new Date().toISOString(),
        }),
      );
    const task = await create(tx, owner, "agent_tasks", {
      runId: template.assignmentRunId,
      stepKey: "review",
      role: "review",
      assignmentId: template.assignmentId,
      assignmentVersion: 1,
      // What is left of the ceiling: a larger reservation is refused (AGENT_LIMIT).
      ceilingMicros,
      input: {
        inputs: {
          [`copywriter:${X}`]: { contentIds: [content.id], failed: [] },
        },
      },
      output: null,
      status: "running",
      errorCode: null,
      costMicros: 0,
    });
    return { contentId: content.id, task, posts };
  });
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
  return h.run(async (tx) => {
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
    const reservations = (
      await taskReservations(tx, owner, setup.task.id)
    ).filter((row) => row.taskClass === "agent_review");
    const original = data(await entity(tx, owner, "content", setup.contentId));
    // A revision that failed (it is a stub, so this is not the planned path) is an error.
    const revisionError = original.agentReviewDecision?.revisionError;
    if (!failure && revisionError) failure = String(revisionError);
    if (!failure && first?.verdict === "revise" && !first.revisedTo)
      failure = "EVAL_REVISION_MISSING";
    // Cleanup of the case: its drafts leave the run, its history the channel.
    for (const id of [setup.contentId, first?.revisedTo]) {
      if (!id) continue;
      const row = await entity(tx, owner, "content", id);
      await update(tx, owner, row, { ...data(row), status: "archived" });
    }
    for (const post of setup.posts)
      await tx.entity.delete({ where: { id: post.id } });
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
      unknown: reservations.some((row) => row.state === "unknown"),
    };
  });
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
  route: ModelRoute;
  maxCostMicros: number;
  runtime: OpenAiRuntimeConfig;
  datasetVersion: string;
}): Promise<ReviewReport> {
  assertLocalDatabase();
  assertStubs();
  const { cases, route, maxCostMicros, runtime } = options;
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
  await removeStaleEvals(REVIEW_EVAL_MARKER);
  const startedAt = new Date().toISOString();
  const agents = process.env.ORBIT_AGENTS;
  // The copywriter task that shapes the cases runs only with Orbit Agents on.
  process.env.ORBIT_AGENTS = "true";
  const results: CaseResult[] = [];
  let stoppedReason: string | null = null;
  let project: Project | null = null;
  let setupError: unknown = null;
  try {
    project = await createPackageProject({ name: REVIEW_EVAL_MARKER });
    const { h, template } = await prepare(project, maxCostMicros);
    // The key enters the project only now, after the stubbed draft.
    await configure(project.owner, runtime, route);
    try {
      for (const c of cases) {
        const remaining = await remainingMicros(project.owner, maxCostMicros);
        if (remaining <= 0) {
          stoppedReason = "BUDGET_EXCEEDED";
          break;
        }
        const { result, unknown } = await runCase(
          h,
          project.owner,
          template,
          c,
          remaining,
        );
        results.push(result);
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
  // Cleanup always runs. The workspace cascades to the project, its
  // encrypted key and every row of the run.
  let cleanupError: unknown = null;
  try {
    await project?.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (agents === undefined) delete process.env.ORBIT_AGENTS;
  else process.env.ORBIT_AGENTS = agents;
  // Setup fails before any review call; a failed cleanup after paid calls is
  // reported with the results instead, so the evidence is still written.
  if (setupError) throw setupError;
  return {
    datasetVersion: options.datasetVersion,
    datasetHash: reviewDatasetHash(cases, route, maxCostMicros),
    startedAt,
    workspaceId: project!.owner.workspaceId,
    route,
    stoppedReason,
    cleanupError: cleanupError ? errorCode(cleanupError) : null,
    results,
  };
}
