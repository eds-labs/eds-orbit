import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_FORMATS,
  CREATIVE_TEMPLATE_IDS,
  DEFAULT_CHANNEL_FORMATS,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  variantsFor,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  approvedOperation,
  readOperation,
} from "../../../platform/tasks/operation-tools.ts";
import {
  PROJECT_READ,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { data, DomainError } from "../../../shared.ts";
import { isApprovedAsset, isRasterMime } from "../brand/asset-rules.ts";
import { currentImageTerms } from "../brand/image-generation.ts";
import { currentMarketingProfile } from "../brand/marketing-profile.ts";
import { resolveBrandKit } from "./brand-kit.ts";
import { ART_ASSET_TYPES, projectRow } from "./components.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  CREATIVE_PREVIEWS,
  findPreview,
  PREVIEW_BUDGET_MAX,
  previewCeiling,
  previewImage,
  previewInput,
  previewResult,
  previewStatus,
  previewTerms,
  queuePreview,
  type PreviewInput,
} from "./preview.ts";

// The Creative Studio over MCP and the assistant: read the brand kit and
// what it can make, propose one internal preview (owner approval with its
// exact image ceiling and art prompt), and read its progress and result with
// the image. Listed only while ORBIT_CREATIVE_STUDIO is on.

const shared = { module: "marketing", feature: "creative_studio" as const };

/** The action type of a preview proposal (operation-tools: `<module>.mcp.<name>`). */
export const PREVIEW_ACTION = "marketing.mcp.marketing_creative_preview_create";

/** Approved raster assets of `types`, newest first, metadata only (at most 20). */
async function approvedAssets(
  tx: DbTx,
  scope: Scope,
  types: readonly string[],
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      OR: types.map((type) => ({ data: { path: ["type"], equals: type } })),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    rows
      .filter(
        (row) => isApprovedAsset(data(row)) && isRasterMime(data(row).mime),
      )
      // Renditions are bound to their creative: never an art to pick.
      .filter((row) => !data(row).boundTo)
      .slice(0, 20)
      .map((row) => ({
        assetId: row.id,
        name: String(data(row).name ?? ""),
        type: String(data(row).type),
        width: data(row).width ?? null,
        height: data(row).height ?? null,
      }))
  );
}

/** Why the brand kit cannot compose now, or null. */
async function brandKitState(tx: DbTx, scope: Scope) {
  try {
    return { kit: await resolveBrandKit(tx, scope), problem: null };
  } catch (error) {
    if (error instanceof DomainError) return { kit: null, problem: error.code };
    throw error;
  }
}

/** The image route's terms now, or why there is none. */
async function imageState(tx: DbTx, scope: Scope) {
  try {
    const { imageConfig } = await currentImageTerms(tx, scope);
    return {
      configured: true,
      model: imageConfig.model,
      maxCostMicrosPerImage: imageConfig.maxCostMicrosPerImage,
      problem: null,
    };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      configured: false,
      model: null,
      maxCostMicrosPerImage: null,
      problem: error.code,
    };
  }
}

async function creativeOptions(tx: DbTx, scope: Scope) {
  const profile = await currentMarketingProfile(tx, scope);
  const identity = (data(profile)?.visualIdentity ?? {}) as Record<string, any>;
  const { kit, problem } = await brandKitState(tx, scope);
  const primary = kit?.logos.primary ?? null;
  const formatsByChannel = {
    ...DEFAULT_CHANNEL_FORMATS,
    ...(kit?.config.formatsByChannel ?? {}),
  };
  return {
    brandKit: {
      ready: kit !== null,
      problem,
      profileVersion: kit?.profileVersion ?? profile?.version ?? null,
      productName: kit?.profile.productName ?? null,
      // The profile's configured primary logo (visualIdentity.logoAssetId); only it is drawn as primary.
      primaryLogo: {
        assetId: identity.logoAssetId ?? null,
        usable: Boolean(primary),
        mime: primary ? data(primary).mime : null,
        width: primary ? (data(primary).width ?? null) : null,
        height: primary ? (data(primary).height ?? null) : null,
      },
      logos: Object.fromEntries(
        Object.entries(kit?.logos ?? {}).map(([role, row]) => [role, row!.id]),
      ),
      palette: kit
        ? {
            primary: identity.primaryColor,
            secondary: identity.secondaryColor,
            accent: identity.accentColor,
            background: identity.backgroundColor,
            text: identity.textColor,
            headingFont: identity.headingFont,
            bodyFont: identity.bodyFont,
          }
        : null,
      productAssetIds: (kit?.products ?? []).map((row) => row.id),
      enabledTemplates: kit?.config.enabledTemplates ?? [],
      logoPlacement: kit?.config.logoPlacement ?? null,
    },
    artAssets: await approvedAssets(tx, scope, ART_ASSET_TYPES),
    templates: CREATIVE_TEMPLATE_IDS.map((id) => ({
      id,
      art: TEMPLATE_NEEDS[id].art,
      product: TEMPLATE_NEEDS[id].product,
      copyLimits: TEMPLATE_COPY_LIMITS[id],
      variants: Object.fromEntries(
        CREATIVE_FORMAT_IDS.map((format) => [format, variantsFor(id, format)]),
      ),
    })),
    formats: CREATIVE_FORMAT_IDS.map((id) => ({
      id,
      width: CREATIVE_FORMATS[id].width,
      height: CREATIVE_FORMATS[id].height,
    })),
    formatsByChannel,
    defaultFormat: "square",
    image: await imageState(tx, scope),
    previewBudgetMaxMicros: PREVIEW_BUDGET_MAX,
  };
}

const previewRef = z
  .object({
    previewId: z.uuid().optional(),
    // The proposal's id, before its approval names a preview.
    actionRequestId: z.uuid().optional(),
  })
  .strict();

/**
 * The status of a preview, or of its proposal while it waits: pending is
 * `awaiting_approval`, a rejected or expired proposal `blocked`.
 */
async function statusOf(
  tx: DbTx,
  scope: Scope,
  ref: z.infer<typeof previewRef>,
) {
  if (Boolean(ref.previewId) === Boolean(ref.actionRequestId))
    throw new DomainError("INVALID_PREVIEW_REFERENCE", 400);
  if (ref.previewId)
    return previewStatus(await findPreview(tx, scope, ref.previewId));
  const request = await projectRow(
    tx,
    scope,
    "action_requests",
    ref.actionRequestId,
  );
  const d = data(request);
  if (d.actionType !== PREVIEW_ACTION) throw new DomainError("NOT_FOUND", 404);
  const previewId = d.executionResult?.previewId;
  if (d.status === "consumed" && typeof previewId === "string")
    return previewStatus(await findPreview(tx, scope, previewId));
  const pending = d.status === "pending" || d.status === "active";
  return {
    previewId: null,
    actionRequestId: request.id,
    status: pending ? "awaiting_approval" : "blocked",
    phase: "queued",
    progress: 0,
    createdAt: request.createdAt.toISOString(),
    startedAt: null,
    completedAt: null,
    errorCode: pending ? null : `APPROVAL_${String(d.status).toUpperCase()}`,
    blockers: [],
    costMicros: 0,
    unknownCostMicros: 0,
    maxBudgetMicros: null,
    creativeId: null,
    published: false,
  };
}

/** The terms the owner approves; checked again on approval (`PREVIEW_STALE`). */
type Terms = Awaited<ReturnType<typeof previewTerms>>;

export const creativeReads = [
  readOperation({
    ...shared,
    name: "marketing_creative_options",
    description:
      "Read the project's Creative Studio brand kit and what it can make: the configured primary logo (visualIdentity.logoAssetId) and whether it is usable, logo roles, palette and fonts, approved product and art assets (metadata only), templates with copy limits and variants, output formats with pixel sizes (feed_portrait is 1080x1350, 4:5), the format per channel, and the image cost per generated art.",
    permission: PROJECT_READ,
    input: z.object({}).strict(),
    run: (tx, scope) => creativeOptions(tx, scope),
  }),
  readOperation({
    ...shared,
    name: "marketing_creative_preview_status",
    description:
      "Status of one internal creative preview by previewId, or of its proposal by actionRequestId: awaiting_approval, queued, running, completed, failed or blocked, with phase, progress, error code, blockers and cost (USD millionths). A preview is never published.",
    permission: PROJECT_READ,
    input: previewRef,
    run: (tx, scope, args) => statusOf(tx, scope, args),
  }),
  readOperation({
    ...shared,
    name: "marketing_creative_preview_result",
    description:
      "The finished internal creative preview: post text, image copy, the rendered image (attached as image content; orbitUrl needs an Orbit sign-in), format and pixel size, template, brand kit profile version and the logo asset drawn, art and product asset ids, QA checks, rights state, duplicate posts and cost. Never published, scheduled or sent to Postiz.",
    permission: PROJECT_READ,
    input: z.object({ previewId: z.uuid() }).strict(),
    run: (tx, scope, args) => previewResult(tx, scope, args.previewId),
    images: (tx, scope, result) => previewImage(tx, scope, result),
  }),
];

export const creativeWrites = [
  approvedOperation({
    ...shared,
    name: "marketing_creative_preview_create",
    description:
      "Propose one internal creative preview: Orbit composes a finished brand image (the configured original logo, brand colours and fonts, template, the channel's or the chosen format) with the post text and image copy you provide, runs its QA and stores it in Orbit only. art: generate (one paid image, owner only), asset (an approved art asset) or none. maxBudgetMicros caps this preview (USD millionths); the project's AI spending policy still applies. Creates no assignment, package, schedule, publication or Postiz draft; its approval is not a publishing approval. Track it with marketing_creative_preview_status.",
    permission: PROJECT_WRITE,
    proposable: creativeStudioEnabled,
    input: previewInput,
    summary: (args: PreviewInput) => ({
      channel: args.channel,
      format: args.format ?? null,
      template: args.template ?? null,
      art: args.art,
      maxBudgetMicros: args.maxBudgetMicros,
    }),
    validate: async (tx, scope, args) => {
      await previewTerms(tx, scope, args);
    },
    approvalContext: (tx, scope, args) => previewTerms(tx, scope, args),
    revalidateContext: async (tx, scope, args, saved) => {
      const now = await previewTerms(tx, scope, args);
      const then = saved as Terms | undefined;
      if (
        !then ||
        now.profileVersion !== then.profileVersion ||
        now.ceilingMicros !== then.ceilingMicros ||
        now.artPrompt !== then.artPrompt
      )
        throw new DomainError("PREVIEW_STALE", 409);
    },
    spendCeiling: (tx, scope, args) =>
      previewCeiling(tx, scope, previewInput.parse(args)),
    run: (tx, scope, args) => queuePreview(tx, scope, args),
    executionResult: async (tx, scope, saved) => {
      if (typeof saved?.previewId !== "string") return saved;
      const row = await tx.entity.findFirst({
        where: {
          id: saved.previewId,
          kind: CREATIVE_PREVIEWS,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      return row ? previewStatus(row) : saved;
    },
  }),
];
