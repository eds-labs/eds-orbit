/**
 * Live vision eval harness (spec §7). Each case's creative is composed for
 * free from the offline fixtures (`fixtureArt`, the demo brands' logos) by
 * the production studio (`produceCreative`), then judged by the production
 * vision review (`visionReviewCreative`): spend mandate, reservation,
 * transmission and settlement on the `creative_review` route, the verdict
 * decided by Orbit (`visionVerdict`). It never mocks anything itself; the
 * caller decides whether `respond` is real (vision.eval.ts refuses a stub).
 *
 * Only synthetic data is used, in one project created and deleted per run,
 * and only against a local database. The run's key is stored for the route
 * file's provider as production stores a project key (`configureEvalRoute`
 * of the review eval), and `creative_review` must resolve to exactly the
 * route. The ceiling is the project's daily, monthly and per-run budget, and
 * each review checks in its reservation transaction that it stays within
 * what the whole run has left.
 */
import { scoped, type DbTx } from "../../packages/db/src/index.ts";
import {
  routeProvider,
  sourceSizeFor,
  type ModelRoute,
  type ProviderId,
} from "../../packages/ai/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../packages/schemas/src/index.ts";
import { sha256Hex } from "../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../packages/creative/fixtures/demo-brands.ts";
import {
  create,
  data,
  DomainError,
  list,
  update,
} from "../../apps/api/src/shared.ts";
import { errorCode } from "../../apps/api/src/modules/telemetry.ts";
import { produceCreative } from "../../apps/api/src/modules/marketing/creative/pipeline.ts";
import {
  visionReviewCreative,
  type StoredVision,
} from "../../apps/api/src/modules/marketing/creative/vision-review.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  TELEGRAM,
} from "../../apps/api/tests/support/package-project.ts";
import {
  assertLocalDatabase,
  removeStaleEvals,
} from "../generation/harness.ts";
import {
  configureEvalRoute,
  type EvalRuntime,
} from "../agents/live-harness.ts";
import {
  VISION_CEILING_USD,
  visionCasePasses,
  visionDatasetHash,
  type VisionCaseResult,
  type VisionReport,
  type VisionVerdictClass,
} from "./vision-plan.ts";
import type { VisionBrand, VisionCase, VisionSet } from "./vision-set.ts";

// Exact name of the workspace, project and users the harness creates; the
// residue of a hard-killed run is removed by the next run after 12 hours.
export const VISION_EVAL_MARKER = "Synthetic creative vision eval";
// The eval's hard ceiling (VISION_CEILING_USD): no run may be given more.
const MAX_COST_MICROS = Math.round(VISION_CEILING_USD * 1_000_000);
// The Postiz channel identifier of the package project's Telegram channel:
// the brand kit renders only the set's format for it.
const CHANNEL_IDENTIFIER = "telegram";
// Reviews that ended without a verdict at a known cost: errors, the run goes on.
const CASE_ERRORS = new Set([
  "MODEL_REQUEST_NOT_ACCEPTED",
  "VISION_REVIEW_OUTPUT_INVALID",
]);
// Refused reservations: every further case would be refused as well.
const BUDGET_REFUSALS = new Set([
  "BUDGET_EXCEEDED",
  "RUN_BUDGET_EXCEEDED",
  "BUDGET_NOT_APPROVED",
  "PROVIDER_BUDGET_STOP",
  "POLICY_REQUIRED",
  "PAID_MANDATE_EXPIRED",
]);
const DAY_MS = 86_400_000;

type Project = Awaited<ReturnType<typeof createPackageProject>>;
type Brands = VisionSet["brands"];
type BrandName = keyof Brands;
type Fixtures = {
  logos: Record<BrandName, string>;
  // Art asset per `${kitBrand}:${art}` the cases use.
  art: Map<string, string>;
};
/** The fixture art a case's creative is composed from: drawn for its kit's brand. */
const artKey = (c: Pick<VisionCase, "kitBrand" | "art">) =>
  `${c.kitBrand}:${c.art}`;

const runIn = <T>(project: Project, work: (tx: DbTx) => Promise<T>) =>
  scoped(project.owner.workspaceId, project.owner.projectId, work);

/**
 * The ceiling as the project's budget: daily, monthly and per run, in a
 * short window that limits what a hard-killed run leaves usable.
 */
async function limitPolicy(project: Project, maxCostMicros: number) {
  await runIn(project, async (tx) => {
    const row = (await list(tx, project.owner, "policies")).find(
      (p) => data(p).active === true,
    );
    if (!row) throw new Error("EVAL_POLICY_MISSING");
    await update(tx, project.owner, row, {
      ...data(row),
      startAt: new Date(Date.now() - DAY_MS).toISOString(),
      endAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      dailyBudgetMicros: maxCostMicros,
      monthlyBudgetMicros: maxCostMicros,
      perRunBudgetMicros: maxCostMicros,
    });
  });
}

/** An approved fixture image the owner lets go to a provider (R28), as the upload route stores one. */
const addAsset = (project: Project, type: string, bytes: Buffer) =>
  runIn(project, async (tx) => {
    const row = await create(tx, project.owner, "assets", {
      name: `Synthetic eval ${type}`,
      type,
      mime: "image/png",
      base64: bytes.toString("base64"),
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      source: "Offline creative fixture",
      license: "Synthetic rights fixture",
      validUses: ["brand", "social"],
      usageApproved: true,
      assetStatus: "approved",
      providerUse: true,
      driveSyncStatus: "LOCAL_ONLY",
    });
    return row.id;
  });

/**
 * Each demo brand's primary logo and every art the cases use, drawn for the
 * case's kit brand at the image model's 4:5 size: the wrong kit's case is
 * the other brand's complete creative (art, palette, logo).
 */
async function addFixtures(
  project: Project,
  cases: VisionCase[],
): Promise<Fixtures> {
  const logos = {} as Record<BrandName, string>;
  for (const name of ["lumora", "kestrel"] as const)
    logos[name] = await addAsset(
      project,
      "logo",
      (await demoBrand(name)).logos[0]!.bytes,
    );
  const [width, height] = sourceSizeFor(IMAGE_MODEL, 1080 / 1350)
    .split("x")
    .map(Number);
  const art = new Map<string, string>();
  for (const c of cases) {
    const key = artKey(c);
    if (art.has(key)) continue;
    const drawn = await fixtureArt(c.art, c.kitBrand, {
      width: width!,
      height: height!,
    });
    art.set(key, await addAsset(project, "photo", drawn.bytes));
  }
  return { logos, art };
}

/**
 * Makes `brand` the project's brand: its name and brand kit (palette,
 * fonts, imagery, logo) over the profile the project has, with the vision
 * review on and only the set's format for the Telegram channel.
 */
async function setBrand(
  project: Project,
  brand: VisionBrand,
  logoAssetId: string,
  format: string,
) {
  await runIn(project, async (tx) => {
    const where = {
      workspaceId: project.owner.workspaceId,
      projectId: project.owner.projectId,
    };
    const current = await tx.projectMarketingProfile.findFirstOrThrow({
      where,
    });
    const profile = marketingProfile.parse({
      ...(current.data as object),
      productName: brand.productName,
      visualIdentity: {
        ...brand.visualIdentity,
        logoAssetId,
        creative: {
          visualReview: true,
          formatsByChannel: { [CHANNEL_IDENTIFIER]: [format] },
        },
      },
    });
    await tx.projectMarketingProfile.updateMany({
      where,
      data: { data: profile as any, version: { increment: 1 } },
    });
  });
}

/** The brand's post on the Telegram channel, reviewed, in a mission with ready evidence. */
const newContent = (project: Project, brand: VisionBrand) =>
  runIn(project, async (tx) => {
    const mission = await create(tx, project.owner, "missions", {
      title: brand.post.title,
      status: "active",
      targetAction: brand.copy.cta,
    });
    const evidence = await create(tx, project.owner, "evidence", {
      status: "ready",
      purpose: "public",
      facts: [],
      items: [],
    });
    return create(tx, project.owner, "content", {
      title: brand.post.title,
      body: brand.post.body,
      type: "social",
      channel: TELEGRAM,
      status: "reviewed",
      missionId: mission.id,
      evidenceId: evidence.id,
      claims: [],
    });
  });

/** What the project's reservations hold: settled at their settled amount, open or unknown at their reserved one. */
async function heldMicros(tx: DbTx, owner: Scope) {
  const rows = await tx.budgetReservation.findMany({
    where: { projectId: owner.projectId, state: { not: "released" } },
  });
  return rows.reduce(
    (sum, row) =>
      sum +
      Number(row.state === "settled" ? row.settledMicros : row.amountMicros),
    0,
  );
}

/** One case: compose its creative, review it once, and return its metrics. */
async function runCase(
  project: Project,
  set: VisionSet,
  fixtures: Fixtures,
  c: VisionCase,
  options: { route: ModelRoute; maxCostMicros: number; runKey: string },
): Promise<{ result: VisionCaseResult; unknown: boolean }> {
  const { owner } = project;
  const brand = set.brands[c.brand];
  // Composed from the kit brand's art, palette, fonts and logo with the
  // brand's post and image copy, through production's composition path and
  // its free corrections; free (no image provider).
  await setBrand(
    project,
    set.brands[c.kitBrand],
    fixtures.logos[c.kitBrand],
    set.format,
  );
  const content = await newContent(project, brand);
  const creative = await produceCreative(project.editor, {
    contentId: content.id,
    template: c.template,
    copy: brand.copy,
    artAssetId: fixtures.art.get(artKey(c))!,
  });
  // A setup fault, not the review's: the case must be what the set describes.
  if (creative.template !== c.template)
    throw new Error("EVAL_CREATIVE_TEMPLATE_MISMATCH");
  if (
    creative.renditions.length !== 1 ||
    creative.renditions[0]!.format !== set.format
  )
    throw new Error("EVAL_CREATIVE_FORMAT_MISMATCH");
  const rendition = creative.renditions[0]!;
  // What the composition decided before the review (metrics only): its
  // verdict after the free corrections, its failed checks, the variant drawn,
  // and the hashes of the rendition and of the art and logo it was drawn from.
  const composition = {
    compositionVerdict: creative.qa.verdict,
    compositionFailed: [
      ...new Set(
        creative.qa.checks
          .filter((check) => !check.passed)
          .map((check) => check.code),
      ),
    ],
    variant: rendition.variant ?? creative.variant,
    renditionSha256: rendition.sha256,
    artSha256: creative.components.artSha256 ?? null,
    logoSha256: creative.components.logo.sha256,
  };
  // The review reads the brief of the project's brand (the wrong kit's case
  // is judged against the brand it was not composed for).
  if (c.kitBrand !== c.brand)
    await setBrand(project, brand, fixtures.logos[c.brand], set.format);

  let failure: string | null = null;
  let vision: StoredVision | null = null;
  try {
    const view = await visionReviewCreative(owner, creative.id, {
      runKey: options.runKey,
      // In the reservation transaction: the whole run stays within the ceiling.
      authorize: async (tx, estimateMicros) => {
        if (
          (await heldMicros(tx, owner)) + estimateMicros >
          options.maxCostMicros
        )
          throw new DomainError("BUDGET_EXCEEDED", 409);
      },
    });
    vision = (view.qa.vision as StoredVision | undefined) ?? null;
    if (!vision) failure = "EVAL_VERDICT_MISSING";
  } catch (error) {
    failure = errorCode(error);
  }

  const measured = await runIn(project, async (tx) => {
    const runs = await tx.agentRun.findMany({
      where: {
        projectId: owner.projectId,
        subjectType: "creative",
        subjectId: creative.id,
      },
    });
    // The model call; the output check records a span of its own without cost.
    const spans = runs.length
      ? (
          await tx.agentSpan.findMany({
            where: {
              runId: { in: runs.map((run) => run.id) },
              type: "model_call",
            },
          })
        ).filter((span) => span.name !== "output_validation")
      : [];
    const reservations = await tx.budgetReservation.findMany({
      where: {
        projectId: owner.projectId,
        key: {
          startsWith: `${owner.projectId}:creative-review:${creative.id}:`,
        },
      },
    });
    return { spans, reservations };
  });
  const { spans, reservations } = measured;
  const modelCalled = reservations.some((row) => row.state !== "released");
  const model = spans[0]?.model ?? reservations[0]?.model ?? null;
  // A call on any other model than the route's is not this eval's measurement.
  if (!failure && modelCalled && model !== options.route.model)
    failure = "EVAL_ROUTE_MISMATCH";
  if (!failure && vision?.format !== set.format)
    failure = "EVAL_CREATIVE_FORMAT_MISMATCH";
  // The verdict must belong to the rendition composed for the case.
  if (!failure && vision?.renditionSha256 !== composition.renditionSha256)
    failure = "EVAL_RENDITION_MISMATCH";
  const verdict: VisionVerdictClass = failure ? "error" : vision!.verdict;
  const known = spans.filter((span) => span.costMicros !== null);
  const sum = (pick: (span: (typeof spans)[number]) => number | null) =>
    spans.length ? spans.reduce((n, span) => n + (pick(span) ?? 0), 0) : null;
  const settled = reservations.filter((row) => row.state === "settled");
  const issues = vision?.issues ?? [];
  const result: VisionCaseResult = {
    caseId: c.id,
    label: c.label,
    brand: c.brand,
    kitBrand: c.kitBrand,
    art: c.art,
    template: c.template,
    expected: c.expected,
    verdict,
    pass: visionCasePasses({ label: c.label, verdict }),
    ...composition,
    format: vision?.format ?? null,
    modelCalled,
    model,
    scores: vision ? { ...vision.scores } : null,
    issueKinds: vision
      ? {
          art: issues.filter((issue) => issue.kind === "art").length,
          layout: issues.filter((issue) => issue.kind === "layout").length,
          copy: issues.filter((issue) => issue.kind === "copy").length,
          logo: issues.filter((issue) => issue.kind === "logo").length,
        }
      : null,
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
}

// Whether a finished case stops the run, and why.
function stopReason(result: VisionCaseResult, unknown: boolean) {
  if (unknown || result.errorCode === "VISION_REVIEW_OUTCOME_UNKNOWN")
    return "RESERVATION_UNKNOWN";
  if (result.errorCode === null || CASE_ERRORS.has(result.errorCode))
    return null;
  if (BUDGET_REFUSALS.has(result.errorCode)) return result.errorCode;
  return "UNEXPECTED:" + result.errorCode;
}

export async function runVisionEval(options: {
  set: VisionSet;
  route: ModelRoute;
  // Who serves the route (the route file's provider); the key is stored for it.
  provider: ProviderId;
  // The run's key for `provider`; never printed or written.
  apiKey: string;
  maxCostMicros: number;
  // The eval's verified model and rate card (the plan's runtime).
  runtime: EvalRuntime;
}): Promise<VisionReport> {
  assertLocalDatabase();
  const { set, route, provider, apiKey, maxCostMicros, runtime } = options;
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
  await removeStaleEvals(VISION_EVAL_MARKER);
  const startedAt = new Date().toISOString();
  // The review needs the Creative Studio, as in production; restored afterwards.
  const savedFlag = process.env.ORBIT_CREATIVE_STUDIO;
  process.env.ORBIT_CREATIVE_STUDIO = "true";
  const results: VisionCaseResult[] = [];
  let stoppedReason: string | null = null;
  let project: Project | null = null;
  let setupError: unknown = null;
  try {
    project = await createPackageProject({ name: VISION_EVAL_MARKER });
    await limitPolicy(project, maxCostMicros);
    const fixtures = await addFixtures(project, set.cases);
    // The key enters the project last, once every fixture is in place.
    await configureEvalRoute(
      project.owner,
      provider,
      apiKey,
      runtime,
      route,
      "creative_review",
    );
    // One run budget for every review of this run (per-run budget = ceiling).
    const runKey = `creative-vision-eval:${startedAt}`;
    try {
      for (const c of set.cases) {
        const { result, unknown } = await runCase(project, set, fixtures, c, {
          route,
          maxCostMicros,
          runKey,
        });
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
  // Cleanup always runs: the workspace cascades to its project, its
  // encrypted key and every row of the run.
  let cleanupError: unknown = null;
  if (project)
    try {
      await project.cleanup();
    } catch (error) {
      cleanupError = error;
    }
  if (savedFlag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
  else process.env.ORBIT_CREATIVE_STUDIO = savedFlag;
  // Setup fails before any review call; a failed cleanup after paid calls is
  // reported with the results instead, so the evidence is still written.
  if (setupError) throw setupError;
  return {
    datasetVersion: set.datasetVersion,
    datasetHash: visionDatasetHash(set, route, maxCostMicros, provider),
    startedAt,
    workspaceId: project!.owner.workspaceId,
    provider,
    route,
    format: set.format,
    stoppedReason,
    cleanupError: cleanupError ? errorCode(cleanupError) : null,
    results,
  };
}
