import { scoped } from "../../../../packages/db/src/index.ts";
import { sha256Hex } from "../../../../packages/creative/src/index.ts";
import { demoBrand } from "../../../../packages/creative/fixtures/demo-brands.ts";
import { marketingProfile } from "../../../../packages/schemas/src/index.ts";
import { create } from "../../src/shared.ts";
import { lumoraProfile } from "./creative-profile.ts";
import type { createPackageProject } from "./package-project.ts";

type Project = Awaited<ReturnType<typeof createPackageProject>>;

/** Short image copy that fits every template's limits. */
export const PACKAGE_CREATIVE_COPY = {
  eyebrow: "Beta access",
  headline: "Beta access is open",
  subline: "Product teams can join the beta today.",
  cta: "Learn more",
};

/**
 * Adds the fictional "Lumora Home" brand kit to a package project: an
 * approved primary logo asset and the brand's visual identity, next to the
 * profile the project already has (its official link and CTAs stay). `creative`
 * replaces the brand kit's creative settings. Call it before a package is
 * requested: the profile version is part of the package plan.
 */
export async function addBrandKit(
  project: Project,
  creative: Record<string, unknown> = {},
) {
  const { owner } = project;
  const bytes = (await demoBrand("lumora")).logos[0]!.bytes;
  return scoped(owner.workspaceId, owner.projectId, async (tx) => {
    const logo = await create(tx, owner, "assets", {
      name: "Synthetic logo",
      type: "logo",
      mime: "image/png",
      base64: bytes.toString("base64"),
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      source: "Synthetic fixture",
      license: "Synthetic rights fixture",
      validUses: ["brand", "social"],
      usageApproved: true,
      assetStatus: "approved",
      providerUse: false,
      driveSyncStatus: "LOCAL_ONLY",
    });
    const where = {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
    };
    const current = await tx.projectMarketingProfile.findFirstOrThrow({
      where,
    });
    const { visualIdentity } = lumoraProfile({
      logoAssetId: logo.id,
      creative,
    });
    const profile = marketingProfile.parse({
      ...(current.data as object),
      visualIdentity,
    });
    await tx.projectMarketingProfile.updateMany({
      where,
      data: { data: profile as any, version: { increment: 1 } },
    });
    return logo;
  });
}
