import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { lumoraProfile } from "../../../../tests/support/creative-profile.ts";
import { create } from "../../../shared.ts";

const driveContent = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/connections/google-drive.ts", () => ({
  driveContent,
}));

const { loadCreativeBrand, resolveBrandKit } = await import("./brand-kit.ts");
const { CREATIVES, creativeView, findCreative } = await import("./store.ts");

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// The loader hashes bytes and never decodes them, so any bytes will do.
const png = async (label: string) => Buffer.from(`synthetic ${label} image`);

describe.skipIf(!enabled)("brand kit loader and creative store", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let scope: Scope;
  let other: Scope;
  const run = <T>(
    who: Scope,
    work: Parameters<typeof scoped<T>>[2],
  ): Promise<T> => scoped(who.workspaceId, who.projectId, work);

  async function project(): Promise<Scope> {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic brand kit owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic brand kit",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic brand kit project" },
    });
    return {
      workspaceId: workspace.id,
      projectId: row.id,
      userId,
      role: "owner",
    };
  }
  /** An asset row as the owner's rights decision leaves it. */
  const asset = async (
    who: Scope,
    bytes: Buffer,
    changes: Record<string, unknown> = {},
  ) =>
    (
      await run(who, (tx) =>
        create(tx, who, "assets", {
          name: "Synthetic asset",
          type: "logo",
          mime: "image/png",
          base64: bytes.toString("base64"),
          sha256: sha(bytes),
          usageApproved: true,
          assetStatus: "approved",
          ...changes,
        }),
      )
    ).id;
  const saveProfile = (who: Scope, identity: Record<string, unknown>) =>
    run(who, async (tx) => {
      await tx.projectMarketingProfile.deleteMany({
        where: { projectId: who.projectId },
      });
      return tx.projectMarketingProfile.create({
        data: {
          workspaceId: who.workspaceId,
          projectId: who.projectId,
          version: 1,
          data: lumoraProfile(identity),
        },
      });
    });
  const plan = () => run(scope, (tx) => resolveBrandKit(tx, scope));

  beforeAll(async () => {
    scope = await project();
    other = await project();
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("needs a marketing profile and a primary logo", async () => {
    await expect(plan()).rejects.toMatchObject({
      code: "MARKETING_PROFILE_REQUIRED",
      status: 409,
    });
    await saveProfile(scope, {});
    await expect(plan()).rejects.toMatchObject({
      code: "PRIMARY_LOGO_REQUIRED",
      status: 409,
    });
  });

  it("refuses a logo that is not approved, not a raster logo or not in this project", async () => {
    const bytes = await png("#E8604C");
    const foreign = await asset(other, bytes);
    const cases: Record<string, string> = {
      "not approved": await asset(scope, bytes, { usageApproved: false }),
      outdated: await asset(scope, bytes, { assetStatus: "outdated" }),
      "another type": await asset(scope, bytes, { type: "photo" }),
      "no stored hash": await asset(scope, bytes, { sha256: undefined }),
      "not a raster": await asset(scope, bytes, { mime: "image/svg+xml" }),
      "another project": foreign,
      missing: randomUUID(),
    };
    for (const [name, logoAssetId] of Object.entries(cases)) {
      await saveProfile(scope, { logoAssetId });
      await expect(plan(), name).rejects.toMatchObject({
        code: "APPROVED_LOGO_ASSET_REQUIRED",
        status: 409,
      });
    }
    // Every logo of the kit counts, not only the primary one.
    const primary = await asset(scope, bytes);
    const revoked = await asset(scope, bytes, { usageApproved: false });
    await saveProfile(scope, {
      logoAssetId: primary,
      logos: { onDark: revoked },
    });
    await expect(plan()).rejects.toMatchObject({
      code: "APPROVED_LOGO_ASSET_REQUIRED",
    });
  });

  it("reads the approved logos by role, the usable product images and the settings", async () => {
    const light = await png("#E8604C");
    const dark = await png("#FFF4E8");
    const primary = await asset(scope, light);
    const onDark = await asset(scope, dark);
    const screenshot = await asset(scope, light, { type: "screenshot" });
    const product = await asset(scope, dark, { type: "product" });
    const photo = await asset(scope, dark, { type: "photo" });
    const unapproved = await asset(scope, light, {
      type: "screenshot",
      usageApproved: false,
    });
    const wrongType = await asset(scope, light, { type: "background" });
    const vector = await asset(scope, light, {
      type: "product",
      mime: "image/svg+xml",
    });
    const saved = await saveProfile(scope, {
      logoAssetId: primary,
      logos: { onDark, mark: primary },
      productAssetIds: [
        screenshot,
        unapproved,
        product,
        wrongType,
        randomUUID(),
        vector,
        photo,
      ],
      creative: { ctaStyle: "outline", maxArtCorrections: 2 },
    });
    const kit = await plan();
    expect(kit.profileId).toBe(saved.id);
    expect(kit.profileVersion).toBe(1);
    expect(kit.profile.productName).toBe("Lumora Home");
    expect(Object.keys(kit.logos).sort()).toEqual([
      "mark",
      "onDark",
      "primary",
    ]);
    expect(kit.logos.primary!.id).toBe(primary);
    expect(kit.logos.mark!.id).toBe(primary);
    expect(kit.logos.onDark!.id).toBe(onDark);
    // Product images that are not approved raster screenshots, products or photos stay out.
    expect(kit.products.map((row) => row.id)).toEqual([
      screenshot,
      product,
      photo,
    ]);
    expect(kit.config).toMatchObject({
      ctaStyle: "outline",
      maxArtCorrections: 2,
    });
  });

  it("loads the brand with every logo's exact bytes and lowercase hash", async () => {
    const light = await png("#E8604C");
    const dark = await png("#2B1B17");
    const primary = await asset(scope, light);
    const onLight = await asset(scope, dark);
    await saveProfile(scope, {
      logoAssetId: primary,
      logos: { onLight },
      typography: { headingWeight: 800, headingCase: "upper" },
      creative: { ctaStyle: "none" },
    });
    const kit = await plan();
    const brand = await loadCreativeBrand(scope, kit);
    expect(brand.brandName).toBe("Lumora Home");
    expect(brand.palette).toEqual({
      primaryColor: "#E8604C",
      secondaryColor: "#8C3B2C",
      accentColor: "#F6B26B",
      backgroundColor: "#FFF4E8",
      surfaceColor: "#FFFFFF",
      textColor: "#2B1B17",
      headingFont: "Inter",
      bodyFont: "Inter",
    });
    expect(brand.typography).toEqual({
      headingWeight: 800,
      headingCase: "upper",
    });
    expect(brand.ctaStyle).toBe("none");
    const byRole = Object.fromEntries(brand.logos.map((l) => [l.role, l]));
    expect(Object.keys(byRole).sort()).toEqual(["onLight", "primary"]);
    expect(byRole.primary!.bytes.equals(light)).toBe(true);
    expect(byRole.primary!.sha256).toBe(sha(light));
    expect(byRole.onLight!.bytes.equals(dark)).toBe(true);
    expect(byRole.onLight!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses bold headings without case change when the kit sets no typography", async () => {
    const primary = await asset(scope, await png("#E8604C"));
    await saveProfile(scope, { logoAssetId: primary });
    const brand = await loadCreativeBrand(scope, await plan());
    expect(brand.typography).toEqual({
      headingWeight: 700,
      headingCase: "none",
    });
    expect(brand.ctaStyle).toBe("pill");
  });

  it("refuses logo bytes that are not the approved ones", async () => {
    const bytes = await png("#E8604C");
    const primary = await asset(scope, bytes);
    await saveProfile(scope, { logoAssetId: primary });
    const kit = await plan();
    // The stored copy changed after approval.
    const changed = (await png("#000000")).toString("base64");
    await run(scope, (tx) =>
      tx.entity.update({
        where: { id: primary },
        data: {
          data: {
            ...(kit.logos.primary!.data as object),
            base64: changed,
          },
        },
      }),
    );
    await expect(loadCreativeBrand(scope, await plan())).rejects.toMatchObject({
      code: "ASSET_INTEGRITY_FAILED",
    });
    // A Drive file whose bytes differ from the hash approved for it.
    const drive = await asset(scope, bytes, {
      base64: undefined,
      driveFileId: "drive-logo",
      md5Checksum: "abc",
    });
    await saveProfile(scope, { logoAssetId: drive });
    driveContent.mockResolvedValue({
      bytes: await png("#123456"),
      mime: "image/png",
    });
    await expect(loadCreativeBrand(scope, await plan())).rejects.toMatchObject({
      code: "BRAND_ASSET_INTEGRITY_FAILED",
      status: 409,
    });
    driveContent.mockResolvedValue({ bytes, mime: "image/png" });
    const [logo] = (await loadCreativeBrand(scope, await plan())).logos;
    expect(logo!.sha256).toBe(sha(bytes));
  });

  it("finds a creative of this project only", async () => {
    const made = await run(scope, (tx) =>
      create(tx, scope, CREATIVES, {
        profileVersion: 1,
        status: "composed",
        renditions: [],
      }),
    );
    const notCreative = await run(scope, (tx) =>
      create(tx, scope, "assets", { name: "Not a creative" }),
    );
    const found = await run(scope, (tx) => findCreative(tx, scope, made.id));
    expect(creativeView(found, scope)).toMatchObject({
      id: made.id,
      status: "composed",
    });
    for (const [who, id] of [
      [other, made.id],
      [scope, notCreative.id],
      [scope, randomUUID()],
      [scope, "not-a-uuid"],
    ] as const)
      await expect(
        run(who, (tx) => findCreative(tx, who, id)),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
