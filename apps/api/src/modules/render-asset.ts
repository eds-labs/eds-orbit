import { createHash } from "node:crypto";
import { z } from "zod";
import { scoped } from "../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../packages/schemas/src/index.ts";
import { renderRasterTemplate } from "../../../../packages/creative/src/index.ts";
import { assetBytes } from "./assets.ts";
import {
  driveContent,
  connectionStatus,
  saveGeneratedAsset,
  markSyncFailed,
} from "./google-drive.ts";
import { currentMarketingProfile } from "./marketing-profile.ts";
import { create, data, DomainError, entity, publicEntity } from "../shared.ts";

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
      const visual = input.visualAssetId
        ? await entity(tx, scope, "assets", input.visualAssetId)
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
  const result = await renderRasterTemplate({
    ...input,
    brandName: prepared.profileData.productName,
    logoApproved: data(prepared.logo).usageApproved === true,
    logoDataUri: logoContent?.uri,
    logoHash: logoContent?.hash ?? data(prepared.logo).sha256,
    visualDataUri: visualContent?.uri,
    visualHash: visualContent?.hash,
    palette: prepared.profileData.visualIdentity,
  });
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
    return await create(tx, scope, "assets", {
      ...metadata,
      type: "generated_artwork",
      name: input.title,
      base64: bytes.toString("base64"),
      source: "template",
      sourceType: "TEMPLATE_GENERATED",
      usageApproved: true,
      assetStatus: "approved",
      approvedBy: scope.userId,
      brandAssetId: prepared.logoId,
      visualAssetId: input.visualAssetId,
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
