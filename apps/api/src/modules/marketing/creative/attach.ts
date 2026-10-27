import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  failedBlockers,
  formatsForChannel,
  type LogoRole,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { audit, data, DomainError, list, update } from "../../../shared.ts";
import { invalidateContent } from "../pipeline/content-invalidation.ts";
import { reviewContent } from "../pipeline/workflow.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../publishing/channel-rules.ts";
import { resolveBrandKit, type BrandKitPlan } from "./brand-kit.ts";
import {
  assetSha,
  keptAssets,
  outdateRendition,
  projectAssets,
  projectRow,
} from "./components.ts";
import { assertRights, creativeRefusal, rightsCheck } from "./quality.ts";
import { findCreative, type CreativeRecord } from "./store.ts";

// Attaching a creative to its post (spec §11): one path for the manual
// studio, assignment runs and content packages (R35).

// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

type RightsComponent = {
  role: string;
  logoRole?: LogoRole;
  assetId: string;
  sha256: string;
};

/**
 * The rendition still stands on the current brand: it is this creative's
 * approved rendition with its bytes (`CREATIVE_NOT_ATTACHABLE`); every
 * component in its rights source still has its bytes
 * (`BRAND_ASSET_CHANGED`) and its rights (`ASSET_RIGHTS`); and its logo is
 * still the profile's logo for the role it was drawn as, as for banners
 * (`BRAND_ASSET_CHANGED`).
 */
async function assertRenditionHolds(
  tx: DbTx,
  scope: Scope,
  kit: BrandKitPlan,
  creativeId: string,
  rendition: CreativeRecord["renditions"][number],
) {
  const asset = (await projectAssets(tx, scope, [rendition.assetId])).get(
    rendition.assetId,
  );
  const d = data(asset);
  if (
    !asset ||
    d.assetStatus !== "approved" ||
    d.usageApproved !== true ||
    d.boundTo?.creativeId !== creativeId ||
    assetSha(asset) !== rendition.sha256
  )
    throw new DomainError("CREATIVE_NOT_ATTACHABLE", 409);
  const components = (d.rightsSource?.components ?? []) as RightsComponent[];
  const rows = await keptAssets(tx, scope, components);
  assertRights(await rightsCheck(tx, scope, rows, "social"));
  for (const component of components)
    if (
      component.role === "logo" &&
      kit.logos[component.logoRole ?? "primary"]?.id !== component.assetId
    )
      throw new DomainError("BRAND_ASSET_CHANGED", 409);
}

/**
 * What the post carried before an attach: a rendition of one of its
 * creatives becomes `outdated`, another creative of the post `superseded`.
 */
async function retirePrevious(
  tx: DbTx,
  scope: Scope,
  before: Record<string, any>,
  attached: { contentId: string; creativeId: string; assetId: string },
) {
  if (before.assetId && before.assetId !== attached.assetId) {
    const previous = (
      await projectAssets(tx, scope, [String(before.assetId)])
    ).get(String(before.assetId));
    const bound = data(previous).boundTo;
    if (bound?.creativeId && bound.contentId === attached.contentId)
      await outdateRendition(tx, scope, previous);
  }
  if (before.creativeId && before.creativeId !== attached.creativeId) {
    const replaced = await findCreative(
      tx,
      scope,
      String(before.creativeId),
    ).catch((error) => {
      if (error instanceof DomainError) return null;
      throw error;
    });
    if (replaced && data(replaced).status !== "superseded")
      await update(tx, scope, replaced, {
        ...data(replaced),
        status: "superseded",
      });
  }
}

/**
 * How an attach treats the post: `content` for a person in the studio (the
 * content review runs again; only the owner may accept QA findings), `run`
 * for an assignment run (the draft stays a `draft` for the run's agent
 * review, which reports a creative's QA findings as `CREATIVE_QA_FAILED`;
 * nobody accepts findings on the run's behalf).
 */
export type AttachMode = "content" | "run";

/**
 * Attaches a creative to its post in `tx` (spec §11, like
 * `attachPackageImage`; one path for the studio, assignment runs and
 * packages, R35, R42). The caller checked the flag and the writer role.
 *
 * - The rendition in the format of the post's current channel becomes the
 *   post's image (`assetId`, `creativeId`); a post that is no longer social
 *   or whose channel needs another format is `CONTENT_CHANGED`. The post
 *   goes back to `draft` without its review, and approvals and publications
 *   of the old version are blocked. In `content` mode the review runs again.
 * - A `composed` creative is attached. One that `needs_owner` needs the
 *   owner's acceptance of the findings in `content` mode (audited
 *   `creative.qa_override`), and is attached as it is in `run` mode.
 *   Integrity and rights findings are refusals in both (R34), and the
 *   rendition's components and brand are checked again. One whose new art
 *   `needs_rights` waits for the owner to approve the art and recompose.
 * - The post's previous rendition becomes `outdated` and a creative it
 *   replaces `superseded`; this one becomes `attached` (R5). Repeating the
 *   attach changes nothing.
 *
 * Errors: `CREATIVE_QA_FAILED`, `CREATIVE_RIGHTS_REQUIRED`,
 * `CREATIVE_NOT_ATTACHABLE`, `CONTENT_CHANGED`,
 * `DRAFT_SUPERSEDED`, `ALREADY_SCHEDULED`, `CAPTION_TOO_LONG`,
 * `BRAND_ASSET_CHANGED`, `ASSET_RIGHTS`, `LOGO_INTEGRITY`,
 * `SCREENSHOT_INTEGRITY` (409), `OWNER_REQUIRED` (403), `NOT_FOUND` (404),
 * besides the brand kit's own.
 */
export async function attachCreativeInTx(
  tx: DbTx,
  scope: Scope,
  creativeId: string,
  opts: { mode?: AttachMode; acceptQaFindings?: true } = {},
): Promise<{ contentId: string; assetId: string }> {
  const mode = opts.mode ?? "content";
  const row = await findCreative(tx, scope, creativeId);
  const record = data(row) as CreativeRecord;
  const content = await projectRow(tx, scope, "content", record.contentId);
  const v = data(content);
  const kit = await resolveBrandKit(tx, scope);
  // The post as it is now: social, in the format its channel takes (R42).
  const rules = await resolveChannelRules(tx, scope, v.channel, v.type, true);
  const format = formatsForChannel(
    rules.providerIdentifier,
    kit.config.formatsByChannel,
  )[0];
  const rendition = record.renditions.find((r) => r.format === format);
  if (v.type !== "social" || !rendition)
    throw new DomainError("CONTENT_CHANGED", 409);
  const result = { contentId: content.id, assetId: rendition.assetId };
  if (
    record.status === "attached" &&
    v.assetId === rendition.assetId &&
    v.creativeId === row.id
  )
    return result;
  const failed = [...new Set(failedBlockers(record.qa.checks))];
  // Integrity and rights findings are refusals no one accepts (R34).
  const refused = creativeRefusal(failed);
  if (refused) throw new DomainError(refused, 409);
  // Its renditions are unapproved references until the art's rights are.
  if (record.status === "needs_rights")
    throw new DomainError("CREATIVE_RIGHTS_REQUIRED", 409);
  const override = mode === "content" && record.status === "needs_owner";
  if (override) {
    if (opts.acceptQaFindings !== true)
      throw new DomainError("CREATIVE_QA_FAILED", 409);
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  } else if (
    record.status !== "composed" &&
    !(mode === "run" && record.status === "needs_owner")
  )
    throw new DomainError("CREATIVE_NOT_ATTACHABLE", 409);
  if (v.supersededBy) throw new DomainError("DRAFT_SUPERSEDED", 409);
  await assertRenditionHolds(tx, scope, kit, row.id, rendition);
  if (
    (await list(tx, scope, "publications")).some(
      (publication) =>
        data(publication).contentId === content.id &&
        !INACTIVE_PUBLICATION.includes(data(publication).status),
    )
  )
    throw new DomainError("ALREADY_SCHEDULED", 409);
  // Telegram sends text with media as a caption with a smaller limit.
  if (channelLimitExceeded(String(v.body ?? ""), v.targetUrl, rules))
    throw new DomainError("CAPTION_TOO_LONG", 409);
  const { review: _review, ...rest } = v;
  const attached = await update(tx, scope, content, {
    ...rest,
    assetId: rendition.assetId,
    creativeId: row.id,
    status: "draft",
  });
  await invalidateContent(tx, scope, content.id);
  // A run's agent review reviews the draft next (R42).
  if (mode === "content")
    await reviewContent(tx, scope, attached.id, attached.version);
  await retirePrevious(tx, scope, v, { ...result, creativeId: row.id });
  await update(tx, scope, row, { ...record, status: "attached" });
  if (override)
    await audit(tx, scope, "creative.qa_override", row.id, {
      contentId: content.id,
      failed,
    });
  await audit(tx, scope, "creative.attached", row.id, {
    contentId: content.id,
    assetId: rendition.assetId,
    format: rendition.format,
    mode,
  });
  return result;
}
