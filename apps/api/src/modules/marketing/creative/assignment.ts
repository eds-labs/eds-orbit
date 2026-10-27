import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  artZones,
  checkArt,
  drawnArt,
  failedBlockers,
  formatsForChannel,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  type CreativeCopy,
  type FormatId,
  type LayoutSpec,
  type TemplateId,
} from "../../../../../../packages/creative/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import { errorCode } from "../../telemetry.ts";
import {
  assertCreativeReady,
  assignmentCreative,
  type AssignmentCreative,
} from "../agents/assignments.ts";
import { groupSlots } from "../agents/shared-posts.ts";
import {
  ASSIGNMENT_BUDGET_EXHAUSTED,
  assertTaskBudget,
  runBudgetKey,
} from "../agents/specialists/runner.ts";
import { briefKey } from "../agents/specialists/copywriter.ts";
import type { AgentTask } from "../agents/specialists/types.ts";
import {
  attachRefusal,
  imageRightsSource,
  lockRun,
  mediaRefusal,
  runAssets,
  runImageRequestId,
} from "../agents/specialists/visual.ts";
import {
  currentImageTerms,
  generateAssignmentImage,
} from "../brand/image-generation.ts";
import { currentMarketingProfile } from "../brand/marketing-profile.ts";
import { resolveChannelRules } from "../publishing/channel-rules.ts";
import { artPrompt, type ArtCorrection } from "./art-direction.ts";
import { artSize } from "./art.ts";
import { attachCreativeInTx } from "./attach.ts";
import {
  resolveBrandKit,
  resolveCreativeConfig,
  type BrandKitPlan,
  type EntityRow,
} from "./brand-kit.ts";
import {
  briefLayout,
  creativeBrief,
  resolveCreativeBrief,
  type ResolvedBrief,
  type StrategyCreative,
} from "./brief.ts";
import { assetSha, componentBytes } from "./components.ts";
import { creativeCopyProblems, creativeTemplateOf } from "./copy-checks.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  assertContentHolds,
  assertSourcesHold,
  storeComposed,
  type ComposedCreative,
} from "./persist.ts";
import {
  briefContent,
  checkedPlan,
  composePlan,
  creativeCopyOf,
  shownProducts,
  type Plan,
} from "./pipeline.ts";
import { artCorrectionFor } from "./quality.ts";
import {
  CREATIVES,
  findCreative,
  latestCreativeOfContent,
  type CreativeRecord,
} from "./store.ts";

// Creatives of assignment runs (Creative Studio, spec §11): an assignment
// with `creative` gets art from the strategy's creative brief in its visual
// step, one per post or one per run, with bounded paid art corrections in the
// run's budget; after the drafts exist, each draft's creative is composed in
// its channels' formats with the studio's building blocks (free corrections
// only) and attached in `run` mode, so the run's review judges it next. The
// review leaves a creative that is missing, failed to render, failed its
// checks or cannot go on its channel to the owner.

/** A creative of a run's draft could not be composed (render fault, overflow, refusal); recorded on the draft. */
export const CREATIVE_RENDER_FAILED = "CREATIVE_RENDER_FAILED";
/** The draft carries no creative of its current image copy. */
export const CREATIVE_MISSING = "CREATIVE_MISSING";
/** The draft's creative did not pass its checks (deterministic or vision): the owner decides. */
export const CREATIVE_QA_FAILED = "CREATIVE_QA_FAILED";
/** The draft's own channel cannot carry the creative (media or caption limit). */
export const CREATIVE_MEDIA_REFUSED = "CREATIVE_MEDIA_REFUSED";

/** The art unit of an assignment with one art per run. */
const RUN_UNIT = "run";
/** Refusals of a paid art call that end that unit's art, not the step. */
const BUDGET_REFUSALS = ["AGENT_LIMIT", ASSIGNMENT_BUDGET_EXHAUSTED];
/** Save failures that mean a source of every creative changed: the run's composing stops. */
const SOURCE_CHANGES = [
  "BRAND_ASSET_CHANGED",
  "MARKETING_PROFILE_CHANGED",
  "ASSET_RIGHTS_REQUIRED",
];

const inScope = <T>(scope: Scope, work: (tx: DbTx) => Promise<T>) =>
  scoped(scope.workspaceId, scope.projectId, work);

/**
 * The template a post's image copy and creative are made for: the first of
 * the strategy's proposal, the assignment's templates and the brand kit's
 * enabled templates that the brand kit enables, or null without any.
 */
export function creativeTemplateFor(
  proposed: TemplateId | undefined,
  creative: Pick<AssignmentCreative, "templates">,
  enabled: readonly TemplateId[],
): TemplateId | null {
  return (
    [proposed, ...(creative.templates ?? []), ...enabled].find(
      (id): id is TemplateId => id !== undefined && enabled.includes(id),
    ) ?? null
  );
}

/** The strategy's art plan of a post as stored, or null: absent or no longer valid counts as none (R44). */
export function storedCreativeBrief(value: unknown): StrategyCreative | null {
  const parsed = creativeBrief.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether a creative draws art: always where the template needs it, never where it has none, not for a graphic or product picture where it is optional. */
export function drawsArt(brief: Pick<ResolvedBrief, "template" | "imageKind">) {
  const art = TEMPLATE_NEEDS[brief.template].art;
  return (
    art === "required" ||
    (art === "optional" && !["graphic", "product"].includes(brief.imageKind))
  );
}

/** The channels a post goes out on: its own first, in a shared run (R76) every channel of its slot group. */
function postChannels(run: Record<string, any>, channel: string, at: string) {
  if (run.sharedAcrossChannels !== true) return [channel];
  const group = groupSlots(run.slots ?? [], channel, at).map((s) => s.channel);
  return [...new Set([channel, ...group])];
}

/** The formats of the channels, the first channel's first: its art and its own rendition. */
async function channelFormats(
  tx: DbTx,
  scope: Scope,
  channels: string[],
  config: BrandKitPlan["config"],
): Promise<FormatId[]> {
  const formats: FormatId[] = [];
  for (const channel of channels) {
    const rules = await resolveChannelRules(tx, scope, channel, "social", true);
    formats.push(
      ...formatsForChannel(rules.providerIdentifier, config.formatsByChannel),
    );
  }
  return [...new Set(formats)];
}

/**
 * A post's resolved brief: the strategy's proposal with the assignment's
 * image kind (unless `auto`), completed by the brand kit with the automated
 * rules (a disabled template or missing product falls back, R30).
 */
function postBrief(
  kit: BrandKitPlan,
  creative: AssignmentCreative,
  input: {
    proposal: StrategyCreative | null;
    content: { title: string; coreMessage?: string };
    template: TemplateId;
    formats: FormatId[];
  },
): ResolvedBrief {
  const { proposal } = input;
  return resolveCreativeBrief({
    proposal:
      proposal && creative.imageKind !== "auto"
        ? { ...proposal, imageKind: creative.imageKind }
        : proposal,
    content: input.content,
    profile: kit.profile,
    config: kit.config,
    hasProducts: kit.products.length > 0,
    channelFormats: input.formats,
    origin: "automated",
    template: input.template,
  });
}

/** The art checks of one art in a layout, judged as drawn (R21) without an empty product zone (R15). */
async function artFailures(
  scope: Scope,
  art: EntityRow,
  layout: LayoutSpec,
  withProduct: boolean,
) {
  const drawn = withProduct
    ? layout
    : { ...layout, reservedZones: layout.reservedZones.slice(0, 2) };
  const png = await drawnArt(await componentBytes(scope, art), drawn);
  return [...new Set(failedBlockers(await checkArt(png, artZones(drawn))))];
}

/** One art unit of a visual step: one post (`briefKey`) or the run, with its resolved brief. */
type ArtUnit = { key: string; index: number; brief: ResolvedBrief };
type StepPlan = {
  kit: BrandKitPlan;
  model: Parameters<typeof artSize>[0];
  rightsSource: ReturnType<typeof imageRightsSource>;
  userId: string;
  name: string;
  units: ArtUnit[];
};

/**
 * Generates or finds one art of a unit (`requestId`), with the owner's
 * assignment consent as its rights source, inside the task's budget
 * (`assertTaskBudget` in the reservation transaction), and records its art
 * findings in the unit's primary layout (`creativeArtFailed`).
 */
async function unitArt(
  scope: Scope,
  task: AgentTask,
  plan: StepPlan,
  unit: ArtUnit,
  requestId: string,
  correction?: ArtCorrection,
): Promise<{ id: string; failed: string[] }> {
  const layout = briefLayout(unit.brief, plan.kit.config.logoPlacement);
  // A restarted task finds its image instead of generating a second one (R26).
  const existing = await inScope(scope, (tx) =>
    tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assets",
        data: { path: ["generationId"], equals: requestId },
      },
    }),
  );
  const asset =
    existing ??
    (await generateAssignmentImage(
      scope,
      {
        requestId,
        name: `Assignment creative art: ${plan.name}`,
        prompt: artPrompt(unit.brief, plan.kit.profile, layout, correction),
        size: artSize(plan.model, layout),
        validUses: ["social"],
        references: [],
        styleDescription: null,
        userId: plan.userId,
        assetFields: {
          usageApproved: true,
          assetStatus: "approved",
          license:
            "AI-generated asset; usage approved by the owner's assignment confirmation",
          rightsSource: plan.rightsSource,
          // Orbit's own provider output: it may go back to a provider for the
          // optional vision review (R28), unlike the owner's uploads.
          providerUse: true,
          assignmentId: task.assignmentId,
          assignmentRunId: task.runId,
          agentTaskId: task.id,
          creativeArt: true,
          creativeUnit: unit.key,
          ...(correction ? { creativeArtCorrection: correction.kind } : {}),
        },
      },
      {
        runKey: runBudgetKey(task.runId),
        // In the reservation transaction: the consent still holds and the image fits the task and month.
        authorize: async (tx) => {
          imageRightsSource(
            await entity(tx, scope, "assignments", task.assignmentId),
          );
          const { imageConfig } = await currentImageTerms(tx, scope);
          await assertTaskBudget(
            tx,
            scope,
            task,
            imageConfig.maxCostMicrosPerImage,
          );
        },
      },
    ));
  const recorded = data(asset).creativeArtFailed;
  if (Array.isArray(recorded)) return { id: asset.id, failed: recorded };
  const failed = await artFailures(
    scope,
    asset,
    layout,
    shownProducts(unit.brief, plan.kit.products).length > 0,
  );
  await inScope(scope, async (tx) => {
    const row = await entity(tx, scope, "assets", asset.id);
    await update(tx, scope, row, { ...data(row), creativeArtFailed: failed });
  });
  return { id: asset.id, failed };
}

/**
 * The art of one unit: a first image, then while its art checks fail with a
 * blocker new art can fix (a small subject, an empty area) and attempts are
 * left (`maxArtCorrections`), a corrected image (`:c<n>`) in the task's
 * budget. A correction that fails (the budget refuses it, the provider
 * fails) ends the unit's corrections, with its code unless the budget
 * refused it; the unit keeps its art, and the composition later takes the
 * unit's art with the fewest failed blockers.
 */
async function unitArts(
  scope: Scope,
  task: AgentTask,
  plan: StepPlan,
  unit: ArtUnit,
) {
  const base = `${runImageRequestId(task.id)}:${unit.index}`;
  const max = plan.kit.config.maxArtCorrections;
  let attempt = await unitArt(scope, task, plan, unit, base);
  const ids = [attempt.id];
  let correctionError: string | null = null;
  for (let n = 1; n <= max; n++) {
    const correction = artCorrectionFor(
      { artIsOrbitGenerated: true, artAttempts: n - 1, maxArtCorrections: max },
      attempt.failed as Parameters<typeof artCorrectionFor>[1],
    );
    if (!correction) break;
    try {
      attempt = await unitArt(
        scope,
        task,
        plan,
        unit,
        `${base}:c${n}`,
        correction,
      );
    } catch (error) {
      const code = errorCode(error);
      if (!BUDGET_REFUSALS.includes(code)) correctionError = code;
      break;
    }
    ids.push(attempt.id);
  }
  return { ids, correctionError };
}

/** The strategy briefs of a run's visual task. */
function strategyBriefs(task: AgentTask) {
  const briefs = (task.input as any)?.inputs?.strategy?.briefs;
  if (!Array.isArray(briefs) || !briefs.length)
    throw new DomainError("AGENT_BRIEFS_MISSING");
  return briefs as Array<{
    channel: string;
    slotAt: string;
    topic: string;
    creative?: unknown;
  }>;
}

/**
 * The visual step of an assignment with `creative` (spec §11): before any
 * cost the owner's image consent, the Creative Studio, the assignment's
 * creative and the brand kit's logo are checked (`assertCreativeReady`) and
 * the image route must be configured. One art unit per post (`artPer`
 * "post", keyed by the post's brief) or the run's first post that draws art
 * ("run"); a post whose template draws no art (`drawsArt`) needs none. Each
 * unit's art comes from the strategy's creative brief through the art
 * direction (`artPrompt`) in the source size of its primary layout's art box,
 * as an approved asset of the run with the consent as its rights source,
 * with bounded corrections (`unitArts`). A unit the run's or month's budget
 * refuses (`AGENT_LIMIT`, `ASSIGNMENT_BUDGET_EXHAUSTED`) is skipped with its
 * code and the next goes on; when no art was made at all, the step fails with
 * that code (a used-up month pauses the assignment, R25). A correction that
 * failed otherwise is reported in `correctionErrors`.
 */
export async function creativeVisualStep(
  scope: Scope,
  task: AgentTask,
): Promise<{
  assetIds: string[];
  skipped: Array<{ unit: string; code: string }>;
  correctionErrors: Array<{ unit: string; code: string }>;
}> {
  const briefs = strategyBriefs(task);
  const plan: StepPlan = await inScope(scope, async (tx) => {
    const row = await entity(tx, scope, "assignments", task.assignmentId);
    const d = data(row);
    const rightsSource = imageRightsSource(row);
    const creative = assignmentCreative.parse(d.creative);
    const kit = (await assertCreativeReady(tx, scope, d))!;
    const { imageConfig } = await currentImageTerms(tx, scope);
    const run = data(await entity(tx, scope, "assignment_runs", task.runId));
    const units: ArtUnit[] = [];
    for (const [index, brief] of briefs.entries()) {
      const proposal = storedCreativeBrief(brief.creative);
      const template = creativeTemplateFor(
        proposal?.template,
        creative,
        kit.config.enabledTemplates,
      );
      if (!template) throw new DomainError("NO_CREATIVE_TEMPLATE_ENABLED", 409);
      const resolved = postBrief(kit, creative, {
        proposal,
        content: { title: String(brief.topic ?? "") },
        template,
        formats: await channelFormats(
          tx,
          scope,
          postChannels(run, brief.channel, brief.slotAt),
          kit.config,
        ),
      });
      if (!drawsArt(resolved)) continue;
      if (creative.artPer === "run") {
        units.push({ key: RUN_UNIT, index: 0, brief: resolved });
        break;
      }
      units.push({ key: briefKey(brief), index, brief: resolved });
    }
    return {
      kit,
      model: imageConfig.model,
      rightsSource,
      userId: String(d.confirmation.userId),
      name: String(d.name),
      units,
    };
  });
  const assetIds: string[] = [];
  const skipped: Array<{ unit: string; code: string }> = [];
  const correctionErrors: Array<{ unit: string; code: string }> = [];
  for (const unit of plan.units)
    try {
      const { ids, correctionError } = await unitArts(scope, task, plan, unit);
      assetIds.push(...ids);
      if (correctionError)
        correctionErrors.push({ unit: unit.key, code: correctionError });
    } catch (error) {
      const code = errorCode(error);
      if (!BUDGET_REFUSALS.includes(code)) throw error;
      skipped.push({ unit: unit.key, code });
    }
  // Nothing made: the task fails; a used-up month pauses the assignment (R25).
  if (!assetIds.length && skipped.length)
    throw new DomainError(
      skipped.some((s) => s.code === ASSIGNMENT_BUDGET_EXHAUSTED)
        ? ASSIGNMENT_BUDGET_EXHAUSTED
        : skipped[0]!.code,
    );
  return { assetIds, skipped, correctionErrors };
}

/** The image copy of a draft as a creative stores it, or null. */
function copyOf(raw: unknown): CreativeCopy | null {
  try {
    return creativeCopyOf(raw);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/** Whether a post has a creative composed from `key` already (an assignment run's, not superseded). */
async function composedBefore(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  key: string,
) {
  return Boolean(
    await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: CREATIVES,
        AND: [
          { data: { path: ["contentId"], equals: contentId } },
          { data: { path: ["composeKey"], equals: key } },
          { NOT: { data: { path: ["status"], equals: "superseded" } } },
        ],
      },
    }),
  );
}

/** The art units the run's finished visual step refused, from its output (`skippedUnits`). */
async function refusedUnits(tx: DbTx, scope: Scope, runId: string) {
  const tasks = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "agent_tasks",
      data: { path: ["runId"], equals: runId },
    },
  });
  return tasks.flatMap((row) => {
    const t = data(row);
    return t.role === "visual" &&
      t.status === "done" &&
      Array.isArray(t.output?.skippedUnits)
      ? (t.output.skippedUnits as Array<{ unit: string; code: string }>)
      : [];
  });
}

/** A unit's art for composing: the run's approved art of the unit with the fewest failed blockers (the earlier on a tie). */
function unitArtFor(arts: EntityRow[], unit: string) {
  let best: EntityRow | null = null;
  for (const row of arts) {
    const d = data(row);
    if (d.creativeUnit !== unit || !Array.isArray(d.creativeArtFailed))
      continue;
    if (
      !best ||
      d.creativeArtFailed.length < data(best).creativeArtFailed.length
    )
      best = row;
  }
  return best;
}

/** What a creative of a run shows besides its art and copy: the profile version and every logo's bytes. */
const brandKey = (kit: BrandKitPlan) =>
  hash({
    profileVersion: kit.profileVersion,
    logos: Object.entries(kit.logos).map(([role, row]) => [
      role,
      row!.id,
      assetSha(row),
    ]),
  });

/** Records why a draft has no creative (`creativeFailure`), once per code and key. */
async function recordFailure(
  scope: Scope,
  contentId: string,
  failure: { code: string; error?: string; key?: string; unit?: string },
) {
  await inScope(scope, async (tx) => {
    const row = await entity(tx, scope, "content", contentId);
    const v = data(row);
    if (
      v.status !== "draft" ||
      (v.creativeFailure?.code === failure.code &&
        v.creativeFailure?.key === failure.key)
    )
      return;
    await update(tx, scope, row, {
      ...v,
      creativeFailure: { ...failure, at: new Date().toISOString() },
    });
  });
}

/**
 * Composes the creatives of an assignment run's drafts (spec §11; free) and
 * attaches each to its draft. A draft gets a creative once its image copy
 * is clean (copy the review sends back or refuses gets none) and its art
 * unit's art exists, or its template draws none. Its brief is the mission's
 * creative brief completed by the brand kit, in the formats of its channels
 * (a shared run's slot group too, R76), with its own channel's first; the
 * art is the unit's with the fewest failed art checks. Each post is
 * composed once per key (art bytes, copy, template, variant, formats, brand):
 * the studio's composition with free corrections only, saved under the run's
 * lock while the consent, the profile, every component and the post still
 * hold (`BRAND_ASSET_CHANGED` and the like stop further saves; those stored
 * stay), and attached in `run` mode unless the draft is scheduled or its
 * channel cannot carry the image (`attachRefusal`), which the review reports.
 * A composition that fails is recorded on its draft as `creativeFailure`
 * (`CREATIVE_RENDER_FAILED`), as are a save of this draft alone that fails
 * (its code, e.g. `CONTENT_CHANGED`) and a unit whose art the budget refused
 * (`refused`, or the finished visual step's `skippedUnits`); a stored
 * creative clears it.
 * Without a creative assignment, or with the Creative Studio off, nothing
 * happens.
 */
export async function composeRunCreatives(
  scope: Scope,
  runId: string,
  options: { refused?: Array<{ unit: string; code: string }> } = {},
): Promise<{
  composed: string[];
  failed: { contentId: string; code: string }[];
  error: string | null;
}> {
  const composed: string[] = [];
  const failed: { contentId: string; code: string }[] = [];
  const plan = await inScope(scope, async (tx) => {
    const run = data(await entity(tx, scope, "assignment_runs", runId));
    const assignment = await entity(
      tx,
      scope,
      "assignments",
      String(run.assignmentId),
    );
    const d = data(assignment);
    if (!d.creative || !creativeStudioEnabled()) return null;
    const creative = assignmentCreative.parse(d.creative);
    const rightsSource = imageRightsSource(assignment);
    const kit = await resolveBrandKit(tx, scope);
    const arts = (await runAssets(tx, scope, runId)).filter(
      (row) =>
        data(row).creativeArt === true &&
        data(row).usageApproved === true &&
        data(row).assetStatus === "approved",
    );
    const refused = new Map(
      [
        ...(await refusedUnits(tx, scope, runId)),
        ...(options.refused ?? []),
      ].map((entry) => [entry.unit, entry.code]),
    );
    const drafts = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "content",
        data: { path: ["assignmentRunId"], equals: runId },
      },
      orderBy: { createdAt: "asc" },
    });
    const brand = brandKey(kit);
    const todo: Array<{ key: string; plan: Plan }> = [];
    const failures: Array<{ contentId: string; code: string; unit?: string }> =
      [];
    for (const draft of drafts) {
      const v = data(draft);
      // A reviewed, replaced or copied draft keeps what it has; a copy carries its original's creative (R76).
      if (
        v.status !== "draft" ||
        v.supersededBy ||
        v.sharedFrom ||
        v.type !== "social"
      )
        continue;
      const mission = v.missionId
        ? data(await entity(tx, scope, "missions", v.missionId))
        : null;
      const template = creativeTemplateOf(mission);
      if (!mission || !template) continue;
      // Copy the review sends back or refuses gets no creative; a bare host is the owner's (R49).
      if (
        creativeCopyProblems(v.creativeCopy, TEMPLATE_COPY_LIMITS[template], {
          cta: mission.targetAction,
        }).some((code) => code !== "LINK_UNVERIFIED")
      )
        continue;
      const unit =
        creative.artPer === "run" ? RUN_UNIT : String(mission.briefKey);
      try {
        const brief = postBrief(kit, creative, {
          proposal: storedCreativeBrief(mission.creativeBrief),
          content: briefContent(v),
          template,
          formats: await channelFormats(
            tx,
            scope,
            postChannels(run, v.channel, mission.plannedSlotAt),
            kit.config,
          ),
        });
        const art = drawsArt(brief) ? unitArtFor(arts, unit) : null;
        if (drawsArt(brief) && !art) {
          // Art the budget refused never comes; any other is still to come.
          const code = refused.get(unit);
          if (code) failures.push({ contentId: draft.id, code, unit });
          continue;
        }
        const copy = creativeCopyOf(v.creativeCopy);
        const key = hash({
          artSha256: art ? assetSha(art) : null,
          copy,
          template: brief.template,
          variant: brief.variant,
          formats: brief.formats,
          brand,
        });
        if (await composedBefore(tx, scope, draft.id, key)) continue;
        todo.push({
          key,
          plan: await checkedPlan(tx, scope, {
            kit,
            content: draft,
            brief,
            copy,
            options: {
              logoPlacement: kit.config.logoPlacement,
              textScale: "m",
            },
            variantFixed: false,
            art,
            products: shownProducts(brief, kit.products),
          }),
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failures.push({ contentId: draft.id, code: error.code });
      }
    }
    return {
      todo,
      failures,
      rightsSource,
      assignmentId: assignment.id,
      // The owner whose assignment confirmation carries the consent.
      approvedBy: String(d.confirmation?.userId ?? ""),
      maxArtCorrections: kit.config.maxArtCorrections,
    };
  });
  if (!plan) return { composed, failed, error: null };
  for (const { contentId, ...failure } of plan.failures) {
    await recordFailure(scope, contentId, failure);
    failed.push({ contentId, code: failure.code });
  }
  for (const { key, plan: creativePlan } of plan.todo) {
    const contentId = creativePlan.content.id;
    let result: ComposedCreative;
    try {
      // No paid art here: the attempts are spent, so only free corrections run.
      result = await composePlan(
        scope,
        creativePlan,
        plan.maxArtCorrections,
        {},
      );
    } catch (error) {
      const code = errorCode(error);
      // Logo bytes that are not the approved ones stop the run's creatives.
      if (code === "BRAND_ASSET_INTEGRITY_FAILED")
        return { composed, failed, error: code };
      await recordFailure(scope, contentId, {
        code: CREATIVE_RENDER_FAILED,
        error: code,
        key,
      });
      failed.push({ contentId, code: CREATIVE_RENDER_FAILED });
      continue;
    }
    try {
      const saved = await inScope(scope, async (tx) => {
        await lockRun(tx, scope, runId);
        // The consent, the profile, every component and the post still hold.
        imageRightsSource(
          await entity(tx, scope, "assignments", plan.assignmentId),
        );
        await assertSourcesHold(tx, scope, creativePlan);
        const content = await assertContentHolds(
          tx,
          scope,
          creativePlan.content,
        );
        if (await composedBefore(tx, scope, contentId, key)) return null;
        const row = await storeComposed(tx, scope, {
          content,
          plan: creativePlan,
          composed: result,
          approvedBy: plan.approvedBy,
          record: { assignmentRunId: runId, composeKey: key },
          boundTo: { runId },
          rightsSource: plan.rightsSource,
        });
        const v = data(content);
        // A stored creative ends an earlier failure, attached or not.
        if (v.creativeFailure) {
          const { creativeFailure: _failure, ...rest } = v;
          await update(tx, scope, content, rest);
        }
        // A scheduled draft or a channel without media keeps its text alone; the review names it.
        if (!(await attachRefusal(tx, scope, contentId, v)))
          await attachCreativeInTx(tx, scope, row.id, { mode: "run" });
        return row.id;
      });
      if (saved) composed.push(saved);
    } catch (error) {
      const code = errorCode(error);
      // A changed source stops this run's creatives; those stored stay.
      if (SOURCE_CHANGES.includes(code))
        return { composed, failed, error: code };
      // Only this draft goes without: its cause is recorded for the owner
      // (a removed draft has nothing to record it on).
      await recordFailure(scope, contentId, { code, key }).catch((failure) => {
        if (!(failure instanceof DomainError)) throw failure;
      });
      failed.push({ contentId, code });
    }
  }
  return { composed, failed, error: null };
}

/** The format of a channel's own rendition: its first in the brand kit's settings. */
async function channelFormat(tx: DbTx, scope: Scope, channel: string) {
  const profileRow = await currentMarketingProfile(tx, scope);
  const profile = profileRow
    ? marketingProfile.safeParse(profileRow.data)
    : null;
  const config = profile?.success ? resolveCreativeConfig(profile.data) : null;
  const rules = await resolveChannelRules(tx, scope, channel, "social", true);
  return formatsForChannel(
    rules.providerIdentifier,
    config?.formatsByChannel,
  )[0]!;
}

/** A creative of this project, or null when it no longer exists. */
const creativeOrNull = (tx: DbTx, scope: Scope, id: unknown) =>
  typeof id === "string"
    ? findCreative(tx, scope, id).catch((error) => {
        if (error instanceof DomainError) return null;
        throw error;
      })
    : Promise.resolve(null);

/**
 * The creative problem of an assignment run's draft, or null when it carries
 * a creative of its current image copy in its channel's format whose checks
 * passed. A shared run's copy (R76) carries its original's creative.
 * `CREATIVE_QA_FAILED` when its checks or vision review left it for the
 * owner (read from `qa`, not the status, R5a); `CREATIVE_RENDER_FAILED`
 * when composing it failed; `CREATIVE_MEDIA_REFUSED` when it exists but the
 * draft's channel cannot carry an image; else `CREATIVE_MISSING`.
 */
export async function creativeProblem(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  v: Record<string, any>,
): Promise<string | null> {
  const post = String(v.sharedFrom?.contentId ?? contentId);
  const copy = copyOf(v.creativeCopy);
  const own = await creativeOrNull(tx, scope, v.creativeId);
  if (own && copy) {
    const record = data(own) as CreativeRecord;
    const format = await channelFormat(tx, scope, String(v.channel));
    const rendition = record.renditions.find((r) => r.format === format);
    if (
      record.contentId === post &&
      !["superseded", "needs_rights"].includes(record.status) &&
      rendition !== undefined &&
      v.assetId === rendition.assetId &&
      hash(record.copy) === hash(copy)
    )
      return record.qa.verdict === "needs_owner" ||
        failedBlockers(record.qa.checks).length
        ? CREATIVE_QA_FAILED
        : null;
  }
  if (v.creativeFailure?.code === CREATIVE_RENDER_FAILED)
    return CREATIVE_RENDER_FAILED;
  const latest = await latestCreativeOfContent(tx, scope, post);
  if (
    latest &&
    copy &&
    hash((data(latest) as CreativeRecord).copy) === hash(copy) &&
    (await mediaRefusal(tx, scope, v))
  )
    return CREATIVE_MEDIA_REFUSED;
  return CREATIVE_MISSING;
}

/**
 * Puts its original's creative on a fresh copy of a shared text (R76) in
 * the copy's own channel format, when the copy does not carry it yet and its
 * channel can carry an image (the original's own channel may have refused
 * it). Returns whether it attached.
 */
export async function attachOwnCreative(
  tx: DbTx,
  scope: Scope,
  row: EntityRow,
) {
  const v = data(row);
  const original = v.sharedFrom?.contentId;
  const copy = copyOf(v.creativeCopy);
  if (typeof original !== "string" || !copy) return false;
  const latest = await latestCreativeOfContent(tx, scope, original);
  if (!latest) return false;
  const record = data(latest) as CreativeRecord;
  if (record.status === "needs_rights" || hash(record.copy) !== hash(copy))
    return false;
  const format = await channelFormat(tx, scope, String(v.channel));
  const rendition = record.renditions.find((r) => r.format === format);
  if (
    !rendition ||
    (v.assetId === rendition.assetId && v.creativeId === latest.id) ||
    (await mediaRefusal(tx, scope, v))
  )
    return false;
  const { imageSkipped: _skipped, ...rest } = v;
  await update(tx, scope, row, {
    ...rest,
    assetId: rendition.assetId,
    creativeId: latest.id,
  });
  await audit(tx, scope, "assignment.image_attached", row.id, {
    assignmentRunId: v.assignmentRunId,
    assetId: rendition.assetId,
    creativeId: latest.id,
  });
  return true;
}
