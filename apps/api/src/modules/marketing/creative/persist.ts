import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type {
  CreativeCheck,
  CreativeCopy,
  LogoPlacement,
  RasterSource,
  TextScale,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  update,
} from "../../../shared.ts";
import { currentMarketingProfile } from "../brand/marketing-profile.ts";
import type { BrandKitPlan, EntityRow } from "./brand-kit.ts";
import type { ResolvedBrief } from "./brief.ts";
import { assetSha, projectAssets } from "./components.ts";
import { creativeRefusal, CreativeRightsError } from "./quality.ts";
import type { CompositionOutcome } from "./renditions.ts";
import { CREATIVES, type CreativeRecord } from "./store.ts";

// Saving a creative (R35): the re-check of its sources, the rendition assets
// and the record's composition fields, shared by the manual studio,
// assignment runs and content packages, so every flow stores one shape.

/** What a creative is composed from, as planned in one transaction. */
export type CreativePlan = {
  kit: BrandKitPlan;
  brief: ResolvedBrief;
  copy: CreativeCopy;
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  /** A person chose the variant: corrections never switch it (R31). */
  variantFixed: boolean;
  art: EntityRow | null;
  /** The product shown (at most one), or none. */
  products: EntityRow[];
  /**
   * The passed `ASSET_RIGHTS` check of the components; its detail's
   * `pendingAssetIds` names new art that waits for the owner's rights
   * decision (`awaitsArtRights`).
   */
  rights: CreativeCheck;
  /**
   * The image copy's wording findings (R66: a figure or status word, a
   * promise or prohibited wording, a bare host), failed blockers the owner
   * decides on; none when the copy passed.
   */
  copyChecks?: CreativeCheck[];
};

/**
 * The plan's art is Orbit's new art awaiting the owner's rights decision:
 * the renditions are stored as unapproved references and the creative
 * `needs_rights` until the owner approves the art and recomposes.
 */
export const awaitsArtRights = (plan: Pick<CreativePlan, "rights">) =>
  Boolean(plan.rights.detail?.pendingAssetIds);

/** The composition of a plan and the component bytes it was drawn from. */
export type ComposedCreative = {
  outcome: CompositionOutcome;
  art?: RasterSource;
  products: RasterSource[];
};

/** Every component whose state the save depends on: all brand kit logos, art, products. */
export const sourceRows = (
  plan: Pick<CreativePlan, "kit" | "art" | "products">,
): EntityRow[] => [
  ...Object.values(plan.kit.logos).filter((row): row is EntityRow => !!row),
  ...(plan.art ? [plan.art] : []),
  ...plan.products,
];

/**
 * The save's re-check (Review Focus 5), in the save transaction: the
 * profile version and every component's version and SHA-256 are as planned,
 * else `MARKETING_PROFILE_CHANGED` / `BRAND_ASSET_CHANGED` (409) and nothing
 * is stored.
 */
export async function assertSourcesHold(
  tx: DbTx,
  scope: Scope,
  plan: Pick<CreativePlan, "kit" | "art" | "products">,
): Promise<void> {
  const profile = await currentMarketingProfile(tx, scope);
  if (!profile || profile.version !== plan.kit.profileVersion)
    throw new DomainError("MARKETING_PROFILE_CHANGED", 409);
  const rows = sourceRows(plan);
  const current = await projectAssets(
    tx,
    scope,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    const now = current.get(row.id);
    if (!now || now.version !== row.version || assetSha(now) !== assetSha(row))
      throw new DomainError("BRAND_ASSET_CHANGED", 409);
  }
}

/**
 * The post as stored now, still with the channel and type the formats were
 * planned for (`CONTENT_CHANGED`, 409); a removed post is `NOT_FOUND`.
 */
export async function assertContentHolds(
  tx: DbTx,
  scope: Scope,
  planned: EntityRow,
): Promise<EntityRow> {
  const content = await entity(tx, scope, "content", planned.id);
  const [now, then] = [data(content), data(planned)];
  if (now.channel !== then.channel || now.type !== then.type)
    throw new DomainError("CONTENT_CHANGED", 409);
  return content;
}

/**
 * A refused composition (R34) is never stored, whoever saves it: neither one
 * whose plan failed its rights check (R46; callers that skip the pipeline's
 * own plan check, such as assignment runs and packages, still get the
 * refusal) nor one with an integrity finding.
 */
function assertNotRefused(
  plan: Pick<CreativePlan, "rights">,
  composed: ComposedCreative,
) {
  if (plan.rights.code !== "ASSET_RIGHTS" || !plan.rights.passed)
    throw new CreativeRightsError(plan.rights.detail ?? {});
  const refused = creativeRefusal(composed.outcome.failed);
  if (refused) throw new DomainError(refused, 409);
}

/**
 * Stores each rendition as an approved `generated_artwork` asset bound to
 * its creative and post (kept out of the library and pickers), whose rights
 * source records every drawn component's id, version and SHA-256 (the logo
 * with the role it was drawn as). `boundTo` and `rightsSource` take a flow's
 * own fields (an assignment run, a consent) next to Orbit's, which win.
 * `approvedBy` is who stands for the rights: the person composing, or for
 * an assignment run the owner whose confirmation carries the consent. Art
 * awaiting the owner's rights decision makes every rendition an unapproved
 * reference (`awaitsArtRights`). A refused composition (R34, R46) throws its
 * code (409) and stores nothing.
 */
export async function saveRenditions(
  tx: DbTx,
  scope: Scope,
  input: {
    creativeId: string;
    contentId: string;
    /** The post's channel (integration id) the renditions are for. */
    channel?: string;
    /** The post's title, for the assets' names. */
    title: string;
    plan: CreativePlan;
    composed: ComposedCreative;
    /** Who stands for the rights decision: the person, or the consenting owner. */
    approvedBy: string;
    boundTo?: Record<string, string>;
    rightsSource?: Record<string, unknown>;
  },
): Promise<CreativeRecord["renditions"]> {
  const { plan, composed } = input;
  assertNotRefused(plan, composed);
  // Renditions count as approved only once every component is (spec §8).
  const approval = awaitsArtRights(plan)
    ? { usageApproved: false, assetStatus: "reference" }
    : {
        usageApproved: true,
        assetStatus: "approved",
        approvedBy: input.approvedBy,
      };
  const component = (
    role: string,
    row: EntityRow,
    sha256: string,
    extra: Record<string, string> = {},
  ) => ({ role, ...extra, assetId: row.id, version: row.version, sha256 });
  const renditions: CreativeRecord["renditions"] = [];
  for (const { format, variant, result } of composed.outcome.renditions) {
    const drawn = (kind: string) => result.layers.some((l) => l.kind === kind);
    const logo = plan.kit.logos[result.logoRole]!;
    const components = [
      component("logo", logo, assetSha(logo), { logoRole: result.logoRole }),
      ...(plan.art && composed.art && drawn("art")
        ? [component("art", plan.art, composed.art.sha256)]
        : []),
      ...(drawn("product")
        ? plan.products.map((row, i) =>
            component("product", row, composed.products[i]!.sha256),
          )
        : []),
    ];
    const asset = await create(tx, scope, "assets", {
      name: `Creative ${format}: ${input.title}`.slice(0, 160),
      type: "generated_artwork",
      mime: "image/png",
      filename: `creative-${plan.brief.template}-${format}.png`,
      base64: result.png.toString("base64"),
      sha256: result.sha256,
      width: result.width,
      height: result.height,
      bytes: result.png.length,
      source: "template",
      sourceType: "TEMPLATE_GENERATED",
      ...approval,
      license:
        "Composed by Orbit from approved brand assets; rights follow its components",
      rightsSource: {
        ...input.rightsSource,
        profileVersion: plan.kit.profileVersion,
        components,
      },
      // Bound to its creative and post: not in the asset library or pickers.
      boundTo: {
        ...input.boundTo,
        creativeId: input.creativeId,
        contentId: input.contentId,
      },
      creativeFormat: format,
      creativeVariant: variant,
      profileVersion: plan.kit.profileVersion,
      renderer: result.renderer,
      channel: "Social",
      validUses: ["social"],
      driveSyncStatus: "LOCAL_ONLY",
    });
    renditions.push({
      format,
      variant,
      ...(input.channel !== undefined && { channel: input.channel }),
      assetId: asset.id,
      width: result.width,
      height: result.height,
      bytes: result.png.length,
      sha256: result.sha256,
    });
  }
  return renditions;
}

/**
 * The composition part of a creative record: the brief, the variant drawn in
 * the first format (the brief keeps the one asked for), whether a person
 * fixed it, the components with their bytes and the QA. `needs_rights` while
 * the art awaits the owner's rights decision, else `composed` without a
 * failed blocker and `needs_owner` with one; a refusal (R34, R46) throws its
 * code.
 */
export function composedFields(
  plan: CreativePlan,
  composed: ComposedCreative,
): Omit<
  CreativeRecord,
  | "contentId"
  | "assignmentRunId"
  | "packageId"
  | "renditions"
  | "corrections"
  | "cost"
> {
  assertNotRefused(plan, composed);
  const { outcome } = composed;
  const first = outcome.renditions[0]!;
  const logo = plan.kit.logos[first.result.logoRole]!;
  return {
    profileVersion: plan.kit.profileVersion,
    brief: plan.brief,
    template: plan.brief.template,
    variant: first.variant,
    variantFixed: plan.variantFixed,
    options: plan.options,
    copy: plan.copy,
    components: {
      ...(plan.art &&
        composed.art && {
          artAssetId: plan.art.id,
          artSha256: composed.art.sha256,
        }),
      logo: { assetId: logo.id, sha256: assetSha(logo) },
      products: plan.products.map((row, i) => ({
        assetId: row.id,
        sha256: composed.products[i]!.sha256,
      })),
    },
    qa: { checks: [plan.rights, ...outcome.checks], verdict: outcome.verdict },
    status: awaitsArtRights(plan)
      ? "needs_rights"
      : outcome.failed.length
        ? "needs_owner"
        : "composed",
  };
}

/** Content-free audit facts of a composition: ids, layout, status and findings, never copy. */
export const auditFacts = (
  record: CreativeRecord,
  outcome: CompositionOutcome,
) => ({
  contentId: record.contentId,
  ...(record.packageId !== undefined && { packageId: record.packageId }),
  ...(record.assignmentRunId !== undefined && {
    assignmentRunId: record.assignmentRunId,
  }),
  template: record.template,
  variant: record.variant,
  status: record.status,
  renditionIds: record.renditions.map((r) => r.assetId),
  failed: outcome.failed,
  corrections: outcome.corrections.length,
});

/**
 * Stores a new creative of a post in the caller's save transaction (R55),
 * the one path of the studio, content packages and assignment runs: the
 * record with its composition (`composedFields`; a refusal throws and stores
 * nothing), its renditions bound to it and the post (`saveRenditions`, with
 * the flow's own `boundTo` and `rightsSource` fields), and the audit
 * `creative.produced`. The caller re-checked the sources and the post
 * first (`assertSourcesHold`, `assertContentHolds`). `record` takes the
 * flow's links (package, run, compose key) and its cost; composing itself is
 * free.
 */
export async function storeComposed(
  tx: DbTx,
  scope: Scope,
  input: {
    /** The post as re-checked in this transaction. */
    content: EntityRow;
    plan: CreativePlan;
    composed: ComposedCreative;
    /** Who stands for the rights decision: the person, or the consenting owner. */
    approvedBy: string;
    record?: Partial<
      Pick<
        CreativeRecord,
        "packageId" | "assignmentRunId" | "composeKey" | "cost"
      >
    >;
    boundTo?: Record<string, string>;
    rightsSource?: Record<string, unknown>;
  },
): Promise<EntityRow> {
  const { content, plan, composed } = input;
  const { cost, ...links } = input.record ?? {};
  const record: CreativeRecord = {
    contentId: content.id,
    ...links,
    ...composedFields(plan, composed),
    renditions: [],
    corrections: composed.outcome.corrections,
    cost: cost ?? { reservationIds: [], settledMicros: 0, unknownMicros: 0 },
  };
  // The renditions are bound to the creative, so it is created first.
  const creative = await create(tx, scope, CREATIVES, record);
  record.renditions = await saveRenditions(tx, scope, {
    creativeId: creative.id,
    contentId: content.id,
    channel: data(content).channel,
    title: String(data(content).title ?? ""),
    plan,
    composed,
    approvedBy: input.approvedBy,
    boundTo: input.boundTo,
    rightsSource: input.rightsSource,
  });
  const saved = await update(tx, scope, creative, record);
  await audit(
    tx,
    scope,
    "creative.produced",
    creative.id,
    auditFacts(record, composed.outcome),
  );
  return saved;
}
