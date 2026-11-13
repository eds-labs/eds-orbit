import { createHash } from "node:crypto";
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import {
  renderRasterTemplate,
  templateLabelLayout,
} from "../../../../../../packages/creative/src/index.ts";
import {
  aiImageLabelsEnabled,
  labelFinalImage,
} from "../../../platform/provenance/image-provenance.ts";
import {
  assetAiOrigin,
  composableAsset,
  labeledAssetFields,
} from "./ai-labels.ts";
import { assetBytes } from "../../assets.ts";
import {
  connectionStatus,
  driveContent,
} from "../../../platform/connections/google-drive.ts";
import { markSyncFailed, saveGeneratedAsset } from "./drive-assets.ts";
import { currentMarketingProfile } from "./marketing-profile.ts";
import {
  create,
  data,
  DomainError,
  entity,
  publicEntity,
} from "../../../shared.ts";

const inputSchema = z
  .object({
    title: z.string().min(1).max(500),
    subtitle: z.string().max(500).optional(),
    format: z.enum(["square", "landscape", "portrait", "story"]),
    logoAssetId: z.uuid().optional(),
    visualAssetId: z.uuid().optional(),
    saveToDrive: z.boolean().optional(),
    channel: z
      .enum(["Social", "Ads", "Blog", "Website", "Campaigns", "Other"])
      .optional(),
  })
  .strict();

export async function renderProjectAsset(scope: Scope, raw: unknown) {
  const input = inputSchema.parse(raw);
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const profile = await currentMarketingProfile(tx, scope);
      if (!profile) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
      const parsed = marketingProfile.parse(profile.data);
      const logoId = input.logoAssetId ?? parsed.visualIdentity.logoAssetId;
      const logo = logoId ? await entity(tx, scope, "assets", logoId) : null;
      // ADR 0028: a labelled visual is drawn from its unlabelled source, or
      // refused (409 AI_LABELED_COMPONENT), so the render carries one label.
      const visual = input.visualAssetId
        ? await composableAsset(
            tx,
            scope,
            await entity(tx, scope, "assets", input.visualAssetId),
          )
        : null;
      for (const [row, isLogo] of [
        [logo, true],
        [visual, false],
      ] as const) {
        if (!row) continue;
        const value = data(row);
        if (
          value.usageApproved !== true ||
          value.assetStatus !== "approved" ||
          // A composed assignment banner is bound to its post (R78).
          value.boundTo ||
          (isLogo
            ? !["logo", "original_logo"].includes(String(value.type))
            : ["logo", "original_logo"].includes(String(value.type)))
        )
          throw new DomainError(
            isLogo
              ? "APPROVED_LOGO_ASSET_REQUIRED"
              : "APPROVED_VISUAL_ASSET_REQUIRED",
            409,
          );
      }
      return {
        profileVersion: profile.version,
        profileData: parsed,
        logo,
        visual,
        logoId,
      };
    },
  );
  async function imageData(row: typeof prepared.logo) {
    if (!row || data(row).type === "original_logo") return undefined;
    const value = data(row);
    const content =
      value.driveFileId && !value.base64
        ? await driveContent(scope, value.driveFileId, {
            md5Checksum: value.md5Checksum,
            modifiedTime: value.driveModifiedTime,
          })
        : assetBytes(value);
    if (!["image/png", "image/jpeg", "image/webp"].includes(content.mime))
      throw new DomainError("BRAND_IMAGE_FORMAT_UNSUPPORTED", 415);
    return {
      uri: `data:${content.mime};base64,${content.bytes.toString("base64")}`,
      hash: createHash("sha256").update(content.bytes).digest("hex"),
    };
  }
  const [logoContent, visualContent] = await Promise.all([
    imageData(prepared.logo),
    imageData(prepared.visual),
  ]);
  const templateInput = {
    ...input,
    brandName: prepared.profileData.productName,
    logoApproved: data(prepared.logo).usageApproved === true,
    logoDataUri: logoContent?.uri,
    logoHash: logoContent?.hash ?? data(prepared.logo).sha256,
    visualDataUri: visualContent?.uri,
    visualHash: visualContent?.hash,
    palette: prepared.profileData.visualIdentity,
  };
  const result = await renderRasterTemplate(templateInput);
  if (result.status === "blocked_asset") return result;
  const { bytes, ...metadata } = result;
  const driveEnabled =
    input.saveToDrive !== false && (await connectionStatus(scope)).enabled;
  const saved = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const profile = await currentMarketingProfile(tx, scope);
    if (!profile || profile.version !== prepared.profileVersion)
      throw new DomainError("MARKETING_PROFILE_CHANGED", 409);
    for (const original of [prepared.logo, prepared.visual]) {
      if (!original) continue;
      const current = await entity(tx, scope, "assets", original.id);
      if (
        current.version !== original.version ||
        data(current).usageApproved !== true ||
        data(current).assetStatus !== "approved"
      )
        throw new DomainError("BRAND_ASSET_CHANGED", 409);
    }
    // ADR 0028: a render over AI art carries the label (clear of the logo,
    // brand name, copy and CTA) before it is stored; errors store nothing.
    const origin =
      aiImageLabelsEnabled() && prepared.visual
        ? await assetAiOrigin(tx, scope, data(prepared.visual))
        : null;
    const labeled = origin
      ? (
          await labelFinalImage(tx, scope, {
            bytes,
            origin: "ai_generated",
            composite: true,
            ...templateLabelLayout(templateInput),
            subject: {
              module: "marketing",
              kind: "template_render",
              id: prepared.visual!.id,
            },
            createdBy: scope.userId,
            parentSha256: createHash("sha256").update(bytes).digest("hex"),
            componentSha256s: [visualContent?.hash, logoContent?.hash].filter(
              (value): value is string => typeof value === "string",
            ),
          })
        ).result
      : null;
    return await create(tx, scope, "assets", {
      ...metadata,
      ...(labeled
        ? {
            contentHash: labeled.sha256,
            ...labeledAssetFields(labeled, "ai_generated"),
          }
        : {}),
      type: "generated_artwork",
      name: input.title,
      base64: (labeled?.bytes ?? bytes).toString("base64"),
      source: "template",
      sourceType: "TEMPLATE_GENERATED",
      usageApproved: true,
      assetStatus: "approved",
      approvedBy: scope.userId,
      brandAssetId: prepared.logoId,
      // The visual drawn: a labelled visual's unlabelled source (ADR 0028).
      visualAssetId: prepared.visual?.id ?? input.visualAssetId,
      profileVersion: prepared.profileVersion,
      channel: input.channel ?? "Other",
      driveSyncStatus: driveEnabled ? "PENDING" : "LOCAL_ONLY",
      validUses: ["social", "blog", "newsletter", "ad"],
    });
  });
  if (driveEnabled) {
    try {
      return publicEntity(
        await saveGeneratedAsset(scope, saved.id, input.channel ?? "Other"),
      );
    } catch {
      return publicEntity(await markSyncFailed(scope, saved.id));
    }
  }
  return publicEntity(saved);
}
