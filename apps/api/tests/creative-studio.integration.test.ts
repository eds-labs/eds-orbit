import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  composeCreative,
  CreativeError,
  encodeWebp,
  type ComposeInput,
} from "../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import {
  attachCreative,
  produceCreative,
  recomposeCreative,
} from "../src/modules/marketing/creative/pipeline.ts";
import {
  CREATIVES,
  findCreative,
} from "../src/modules/marketing/creative/store.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** A Postiz channel id no connector knows: no channel rules, so the square format. */
const UNRULED = "unruled-int";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const KESTREL_IDENTITY = {
  primaryColor: "#0F4C5C",
  secondaryColor: "#082F38",
  accentColor: "#B5E655",
  backgroundColor: "#F2F6F5",
  surfaceColor: "#FFFFFF",
  textColor: "#0B1F24",
  headingFont: "DejaVu Sans",
  bodyFont: "DejaVu Sans",
  designRules: ["Preserve the approved logo unchanged."],
};

describe.skipIf(!enabled)(
  "Creative Studio: produce, recompose and attach with QA",
  () => {
    type Project = Awaited<ReturnType<typeof createPackageProject>>;
    type Asset = { id: string; version: number; sha256: string };
    let app: Awaited<ReturnType<typeof buildServer>>;
    let a: Project;
    let b: Project;
    const flag = process.env.ORBIT_CREATIVE_STUDIO;
    const owner = { id: "", cookie: "" };
    const origin = () => process.env.APP_ORIGIN!;
    const assets = {} as Record<
      | "lumoraLogo"
      | "kestrelLogo"
      | "goodArt"
      | "flatArt"
      | "unapprovedArt"
      | "spareArt",
      Asset
    >;

    const runIn = <T>(project: Project, work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const request = (
      project: Project,
      method: "GET" | "POST" | "PUT",
      path: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: `/api/projects/${project.owner.projectId}/${path}`,
        headers: { origin: origin(), cookie: owner.cookie },
        ...(payload === undefined ? {} : { payload: payload as any }),
      });
    /** Uploads an image through the asset route, as the owner does. */
    const upload = async (
      project: Project,
      type: string,
      bytes: Buffer,
      mime: "image/png" | "image/webp",
    ): Promise<Asset> => {
      const r = await request(project, "POST", "assets/upload", {
        name: `Synthetic ${type}`,
        type,
        mime,
        base64: bytes.toString("base64"),
        source: "Synthetic fixture",
        license: "Synthetic rights fixture",
        validUses: ["brand", "social"],
        confirmRightsInformation: true,
      });
      expect(r.statusCode).toBe(201);
      const row = r.json();
      return { id: row.id, version: row.version, sha256: row.data.sha256 };
    };
    /** The owner's rights decision through the asset status action. */
    const setStatus = async (
      project: Project,
      asset: Asset,
      assetStatus: "approved" | "reference",
    ): Promise<Asset> => {
      const r = await request(project, "POST", "actions/asset-status", {
        assetId: asset.id,
        version: asset.version,
        assetStatus,
        ...(assetStatus === "approved" ? { confirmUsageRights: true } : {}),
      });
      expect(r.statusCode).toBe(200);
      return { ...asset, version: r.json().version };
    };
    const art = async (kind: "good" | "flat", brand: "lumora" | "kestrel") => {
      // WebP keeps the upload under its 1 MB limit; the route stores a PNG.
      const webp = await encodeWebp((await fixtureArt(kind, brand)).bytes);
      expect(webp.length).toBeLessThan(1_000_000);
      return webp;
    };
    const saveProfile = async (
      project: Project,
      productName: string,
      visualIdentity: Record<string, unknown>,
    ) => {
      const current = (
        await request(project, "GET", "marketing-profile")
      ).json();
      const r = await request(project, "PUT", "marketing-profile", {
        ...current.data,
        productName,
        visualIdentity,
        expectedVersion: current.version,
      });
      expect(r.statusCode).toBe(200);
    };
    const lumoraIdentity = (changes: Record<string, unknown> = {}) => ({
      ...lumoraProfile().visualIdentity,
      logoAssetId: assets.lumoraLogo.id,
      ...changes,
    });
    /** A social draft in a mission, with its evidence and an earlier review. */
    const newContent = (
      project: Project,
      changes: Record<string, unknown> = {},
    ) =>
      runIn(project, async (tx) => {
        const mission = await create(tx, project.owner, "missions", {
          title: "Autumn evenings",
          status: "active",
          targetAction: "Shop the collection",
        });
        const evidence = await create(tx, project.owner, "evidence", {
          status: "ready",
          purpose: "public",
          facts: [],
          items: [],
        });
        return create(tx, project.owner, "content", {
          title: "Evenings feel softer",
          body: "Evenings feel softer in warm light. Shop the collection.",
          type: "social",
          channel: UNRULED,
          status: "reviewed",
          missionId: mission.id,
          evidenceId: evidence.id,
          claims: [],
          review: { valid: true, problems: [], earlier: true },
          ...changes,
        });
      });
    const produceGood = (scope: Scope, contentId: string) =>
      produceCreative(scope, {
        contentId,
        template: "lifestyle",
        copy: COPY,
        artAssetId: assets.goodArt.id,
      });
    const assetData = (project: Project, id: string) =>
      runIn(project, async (tx) =>
        data(await entity(tx, project.owner, "assets", id)),
      );
    /** What a refused save must leave unchanged: creatives and composed renditions. */
    const stored = (project: Project) =>
      runIn(project, async (tx) => ({
        creatives: (await list(tx, project.owner, CREATIVES)).length,
        renditions: (await list(tx, project.owner, "assets")).filter(
          (row) => data(row).boundTo?.creativeId,
        ).length,
      }));
    const audits = (project: Project, action: string, resourceId: string) =>
      runIn(project, (tx) =>
        tx.auditEvent.findMany({
          where: { projectId: project.owner.projectId, action, resourceId },
        }),
      );

    beforeAll(async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      app = await buildServer();
      const auth = makeAuth();
      const password = randomBytes(24).toString("base64url");
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: "Synthetic creative owner", password },
      });
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: origin() },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const cookies = r.headers["set-cookie"];
      owner.id = signedUp.user.id;
      owner.cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .map((c) => c!.split(";")[0])
        .join("; ");
      a = await createPackageProject();
      b = await createPackageProject();
      for (const project of [a, b]) {
        await authDb.workspaceMember.create({
          data: {
            workspaceId: project.owner.workspaceId,
            userId: owner.id,
            role: "viewer",
          },
        });
        await authDb.projectMember.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            userId: owner.id,
            role: "owner",
          },
        });
      }
      // Project A: Lumora Home. Project B: Kestrel Analytics.
      const lumora = await demoBrand("lumora");
      const kestrel = await demoBrand("kestrel");
      assets.lumoraLogo = await setStatus(
        a,
        await upload(a, "logo", lumora.logos[0]!.bytes, "image/png"),
        "approved",
      );
      assets.kestrelLogo = await setStatus(
        b,
        await upload(b, "logo", kestrel.logos[0]!.bytes, "image/png"),
        "approved",
      );
      const good = await art("good", "lumora");
      assets.goodArt = await setStatus(
        a,
        await upload(a, "photo", good, "image/webp"),
        "approved",
      );
      assets.spareArt = await setStatus(
        a,
        await upload(a, "photo", good, "image/webp"),
        "approved",
      );
      assets.flatArt = await setStatus(
        a,
        await upload(a, "photo", await art("flat", "lumora"), "image/webp"),
        "approved",
      );
      // Uploaded, never approved.
      assets.unapprovedArt = await upload(
        a,
        "photo",
        await art("good", "kestrel"),
        "image/webp",
      );
      await saveProfile(a, "Lumora Home", lumoraIdentity());
      await saveProfile(b, "Kestrel Analytics", {
        ...KESTREL_IDENTITY,
        logoAssetId: assets.kestrelLogo.id,
      });
    });
    afterAll(async () => {
      if (flag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
      else process.env.ORBIT_CREATIVE_STUDIO = flag;
      await a?.cleanup();
      await b?.cleanup();
      await authDb.user.deleteMany({ where: { id: owner.id } });
      await app?.close();
      await closeDatabase();
    });

    it("composes an approved creative for a channel without rules", async () => {
      const content = await newContent(a);
      const creative = await produceGood(a.editor, content.id);
      expect(creative).toMatchObject({
        contentId: content.id,
        status: "composed",
        template: "lifestyle",
        variant: "text_bottom",
        options: { logoPlacement: "auto", textScale: "m" },
        copy: COPY,
        components: {
          artAssetId: assets.goodArt.id,
          logo: {
            assetId: assets.lumoraLogo.id,
            sha256: assets.lumoraLogo.sha256,
          },
          products: [],
        },
        cost: { reservationIds: [], settledMicros: 0, unknownMicros: 0 },
        qa: { verdict: "pass" },
      });
      expect(creative.qa.checks.filter((c) => !c.passed)).toEqual([]);
      expect(creative.qa.checks.map((c) => c.code)).toEqual(
        expect.arrayContaining(["ASSET_RIGHTS", "SUBJECT_TOO_SMALL"]),
      );
      expect(creative.renditions).toEqual([
        expect.objectContaining({
          format: "square",
          channel: UNRULED,
          width: 1080,
          height: 1080,
          href: `/api/projects/${a.owner.projectId}/assets/${creative.renditions[0]!.assetId}/content`,
        }),
      ]);
      const rendition = creative.renditions[0]!;
      const stored = await assetData(a, rendition.assetId);
      expect(stored).toMatchObject({
        type: "generated_artwork",
        sourceType: "TEMPLATE_GENERATED",
        mime: "image/png",
        usageApproved: true,
        assetStatus: "approved",
        boundTo: { creativeId: creative.id, contentId: content.id },
        validUses: ["social"],
        driveSyncStatus: "LOCAL_ONLY",
        sha256: rendition.sha256,
        width: 1080,
        height: 1080,
        bytes: rendition.bytes,
      });
      const png = Buffer.from(stored.base64, "base64");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        1080, 1080,
      ]);
      // Every component with the id, version and bytes it was composed from.
      expect(stored.rightsSource.components).toEqual(
        expect.arrayContaining([
          {
            role: "logo",
            logoRole: "primary",
            assetId: assets.lumoraLogo.id,
            version: assets.lumoraLogo.version,
            sha256: assets.lumoraLogo.sha256,
          },
          {
            role: "art",
            assetId: assets.goodArt.id,
            version: assets.goodArt.version,
            sha256: assets.goodArt.sha256,
          },
        ]),
      );
      expect(await audits(a, "creative.produced", creative.id)).toHaveLength(1);
    });

    it("refuses another project's assets (Test D)", async () => {
      const mine = await newContent(a);
      const creative = await produceGood(a.editor, mine.id);
      const theirs = await newContent(b);
      // Project B naming A's art, or A's content, learns nothing about them.
      await expect(
        produceCreative(b.editor, {
          contentId: theirs.id,
          copy: COPY,
          artAssetId: assets.goodArt.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        produceCreative(b.editor, { contentId: mine.id, copy: COPY }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        runIn(b, (tx) => findCreative(tx, b.owner, creative.id)),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        recomposeCreative(b.editor, creative.id, { variant: "text_top" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        attachCreative(b.editor, creative.id, {}),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      // B's own creative carries B's logo only.
      const own = await produceCreative(b.editor, {
        contentId: theirs.id,
        template: "tips",
        copy: COPY,
      });
      expect(own.components).toMatchObject({
        logo: {
          assetId: assets.kestrelLogo.id,
          sha256: assets.kestrelLogo.sha256,
        },
        products: [],
      });
      expect(own.components.artAssetId).toBeUndefined();
    });

    it("refuses unapproved art", async () => {
      const content = await newContent(a);
      const before = await stored(a);
      const refusal = produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: assets.unapprovedArt.id,
      });
      await expect(refusal).rejects.toMatchObject({
        code: "ASSET_RIGHTS",
        status: 409,
        detail: {
          assetIds: assets.unapprovedArt.id,
          reasons: "not_approved",
        },
      });
      expect(await stored(a)).toEqual(before);
    });

    it("leaves weak art for the owner (Test C)", async () => {
      const content = await newContent(a);
      const creative = await produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: assets.flatArt.id,
      });
      expect(creative.status).toBe("needs_owner");
      expect(creative.qa.verdict).toBe("needs_owner");
      expect(
        creative.qa.checks.filter((c) => !c.passed).map((c) => c.code),
      ).toContain("EMPTY_AREA_EXCESSIVE");
      // The rendition is there for the owner to look at.
      expect(creative.renditions).toHaveLength(1);
      await expect(
        attachCreative(a.editor, creative.id, {}),
      ).rejects.toMatchObject({ code: "CREATIVE_QA_FAILED", status: 409 });
      // Accepting the findings is the owner's decision.
      await expect(
        attachCreative(a.editor, creative.id, { acceptQaFindings: true }),
      ).rejects.toMatchObject({ status: 403 });
      const after = await runIn(a, (tx) =>
        entity(tx, a.owner, "content", content.id),
      );
      expect(data(after).assetId).toBeUndefined();
      expect(
        (await runIn(a, (tx) => list(tx, a.owner, "publications"))).filter(
          (row) => data(row).contentId === content.id,
        ),
      ).toEqual([]);
    });

    it("owner may accept QA findings", async () => {
      const content = await newContent(a);
      const creative = await produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: assets.flatArt.id,
      });
      expect(creative.status).toBe("needs_owner");
      const attached = await attachCreative(a.owner, creative.id, {
        acceptQaFindings: true,
      });
      expect(attached).toEqual({
        contentId: content.id,
        assetId: creative.renditions[0]!.assetId,
      });
      const [override] = await audits(a, "creative.qa_override", creative.id);
      expect(override).toBeDefined();
      expect(override!.actorId).toBe(a.owner.userId);
      expect((override!.metadata as any).failed).toContain(
        "EMPTY_AREA_EXCESSIVE",
      );
      expect(await audits(a, "creative.attached", creative.id)).toHaveLength(1);
    });

    it("stops when the brand changes meanwhile (Review Focus 5)", async () => {
      const content = await newContent(a);
      const before = await stored(a);
      // Another tab saves the profile while the renditions are composed.
      await expect(
        produceCreative(
          a.editor,
          {
            contentId: content.id,
            template: "lifestyle",
            copy: COPY,
            artAssetId: assets.goodArt.id,
          },
          {
            afterCompose: () =>
              saveProfile(
                a,
                "Lumora Home",
                lumoraIdentity({ primaryColor: "#D9503C" }),
              ),
          },
        ),
      ).rejects.toMatchObject({
        code: "MARKETING_PROFILE_CHANGED",
        status: 409,
      });
      expect(await stored(a)).toEqual(before);
      // The logo's rights decision is taken again meanwhile.
      await expect(
        produceCreative(
          a.editor,
          {
            contentId: content.id,
            template: "lifestyle",
            copy: COPY,
            artAssetId: assets.goodArt.id,
          },
          {
            afterCompose: async () => {
              assets.lumoraLogo = await setStatus(
                a,
                assets.lumoraLogo,
                "approved",
              );
            },
          },
        ),
      ).rejects.toMatchObject({ code: "BRAND_ASSET_CHANGED", status: 409 });
      expect(await stored(a)).toEqual(before);
      // The art is taken back meanwhile.
      await expect(
        produceCreative(
          a.editor,
          {
            contentId: content.id,
            template: "lifestyle",
            copy: COPY,
            artAssetId: assets.spareArt.id,
          },
          {
            afterCompose: async () => {
              assets.spareArt = await setStatus(
                a,
                assets.spareArt,
                "reference",
              );
            },
          },
        ),
      ).rejects.toMatchObject({ code: "BRAND_ASSET_CHANGED", status: 409 });
      expect(await stored(a)).toEqual(before);
    });

    it("refuses a logo that is not its approved bytes, even for the owner (R34)", async () => {
      // A composer whose logo layer carries other bytes than the approved ones.
      const tampered = async (request: ComposeInput) => {
        const result = await composeCreative(request);
        return {
          ...result,
          layers: result.layers.map((layer) =>
            layer.kind === "logo"
              ? { ...layer, sourceSha256: "0".repeat(64) }
              : layer,
          ),
        };
      };
      const content = await newContent(a);
      const before = await stored(a);
      await expect(
        produceCreative(
          a.editor,
          {
            contentId: content.id,
            template: "lifestyle",
            copy: COPY,
            artAssetId: assets.goodArt.id,
          },
          { compose: tampered },
        ),
      ).rejects.toMatchObject({ code: "LOGO_INTEGRITY", status: 409 });
      expect(await stored(a)).toEqual(before);
      const creative = await produceGood(a.editor, content.id);
      await expect(
        recomposeCreative(
          a.editor,
          creative.id,
          { variant: "text_top" },
          { compose: tampered },
        ),
      ).rejects.toMatchObject({ code: "LOGO_INTEGRITY", status: 409 });
      // A stored creative with such a finding is never accepted.
      await runIn(a, async (tx) => {
        const row = await findCreative(tx, a.owner, creative.id);
        await update(tx, a.owner, row, {
          ...data(row),
          status: "needs_owner",
          qa: {
            verdict: "needs_owner",
            checks: [
              ...data(row).qa.checks,
              {
                code: "SCREENSHOT_INTEGRITY",
                passed: false,
                severity: "blocker",
              },
            ],
          },
        });
      });
      await expect(
        attachCreative(a.owner, creative.id, { acceptQaFindings: true }),
      ).rejects.toMatchObject({ code: "SCREENSHOT_INTEGRITY", status: 409 });
      expect(
        data(await runIn(a, (tx) => entity(tx, a.owner, "content", content.id)))
          .assetId,
      ).toBeUndefined();
    });

    it("attaches and resets review", async () => {
      const content = await newContent(a);
      // An approval of the text without the image no longer applies.
      const approval = await runIn(a, (tx) =>
        create(tx, a.owner, "approvals", {
          contentId: content.id,
          status: "approved",
        }),
      );
      const creative = await produceGood(a.editor, content.id);
      const assetId = creative.renditions[0]!.assetId;
      expect(await attachCreative(a.editor, creative.id, {})).toEqual({
        contentId: content.id,
        assetId,
      });
      const after = await runIn(a, (tx) =>
        entity(tx, a.owner, "content", content.id),
      );
      expect(data(after)).toMatchObject({ assetId, creativeId: creative.id });
      // The attach wrote a draft without the earlier review ...
      const versions = await runIn(a, (tx) =>
        tx.entityVersion.findMany({
          where: { entityId: content.id },
          orderBy: { version: "asc" },
        }),
      );
      const reset = versions.find((v) => data(v).assetId === assetId)!;
      expect(data(reset).status).toBe("draft");
      expect(data(reset).review).toBeUndefined();
      // ... and the review ran again, as for a package image.
      expect(after.version).toBe(reset.version + 1);
      expect(data(after).review).toMatchObject({ valid: expect.any(Boolean) });
      expect(data(after).review.earlier).toBeUndefined();
      expect(data(after).reviewedBy).toBe(a.editor.userId);
      expect(
        data(
          await runIn(a, (tx) => entity(tx, a.owner, "approvals", approval.id)),
        ),
      ).toMatchObject({
        status: "blocked_dependency",
        reason: "CONTENT_CHANGED",
      });
      const view = await runIn(a, async (tx) =>
        data(await findCreative(tx, a.owner, creative.id)),
      );
      expect(view.status).toBe("attached");
      expect(await audits(a, "creative.attached", creative.id)).toHaveLength(1);
      expect(await audits(a, "creative.qa_override", creative.id)).toEqual([]);
    });

    it("recomposes without new art", async () => {
      const content = await newContent(a);
      const creative = await produceGood(a.editor, content.id);
      const recomposed = await recomposeCreative(a.editor, creative.id, {
        variant: "text_top",
      });
      expect(recomposed).toMatchObject({
        id: creative.id,
        variant: "text_top",
        status: "composed",
        components: { artAssetId: assets.goodArt.id },
        cost: { settledMicros: 0, reservationIds: [] },
      });
      expect(recomposed.version).toBeGreaterThan(creative.version);
      const [before] = creative.renditions;
      const [now] = recomposed.renditions;
      expect(now!.format).toBe("square");
      expect(now!.assetId).not.toBe(before!.assetId);
      expect(await assetData(a, before!.assetId)).toMatchObject({
        assetStatus: "outdated",
      });
      expect(await assetData(a, now!.assetId)).toMatchObject({
        assetStatus: "approved",
        boundTo: { creativeId: creative.id, contentId: content.id },
      });
      expect(await audits(a, "creative.recomposed", creative.id)).toHaveLength(
        1,
      );
    });

    it("keeps the attached rendition until the next attach (R5)", async () => {
      const content = await newContent(a);
      const creative = await produceGood(a.editor, content.id);
      const first = creative.renditions[0]!.assetId;
      await attachCreative(a.editor, creative.id, {});
      const recomposed = await recomposeCreative(a.editor, creative.id, {
        options: { logoPlacement: "top_right" },
      });
      expect(recomposed.status).toBe("composed");
      const second = recomposed.renditions[0]!.assetId;
      // The post still carries the attached, approved rendition.
      expect(
        data(
          await runIn(a, (tx) => entity(tx, a.owner, "content", content.id)),
        ),
      ).toMatchObject({ assetId: first });
      expect(await assetData(a, first)).toMatchObject({
        assetStatus: "approved",
      });
      await attachCreative(a.editor, creative.id, {});
      expect(
        data(
          await runIn(a, (tx) => entity(tx, a.owner, "content", content.id)),
        ),
      ).toMatchObject({ assetId: second });
      expect(await assetData(a, first)).toMatchObject({
        assetStatus: "outdated",
      });
    });

    it("needs a social post with creative copy", async () => {
      const blog = await newContent(a, { type: "blog" });
      await expect(
        produceCreative(a.editor, { contentId: blog.id, copy: COPY }),
      ).rejects.toMatchObject({ code: "CREATIVE_SOCIAL_ONLY", status: 409 });
      const plain = await newContent(a);
      await expect(
        produceCreative(a.editor, {
          contentId: plain.id,
          artAssetId: assets.goodArt.id,
        }),
      ).rejects.toMatchObject({ code: "CREATIVE_COPY_REQUIRED", status: 409 });
      // The copywriter's creative copy on the post is used when none is sent,
      // stored with its non-empty layers only (R37).
      const stored = { headline: COPY.headline, cta: COPY.cta };
      const written = await newContent(a, { creativeCopy: stored });
      expect(
        (
          await produceCreative(a.editor, {
            contentId: written.id,
            template: "lifestyle",
            artAssetId: assets.goodArt.id,
          })
        ).copy,
      ).toEqual(stored);
      // Empty layers of a sent copy are left out; a blank headline is no copy.
      expect(
        (
          await produceCreative(a.editor, {
            contentId: written.id,
            template: "lifestyle",
            copy: { ...COPY, eyebrow: "", subline: "" },
            artAssetId: assets.goodArt.id,
          })
        ).copy,
      ).toEqual({ headline: COPY.headline, cta: COPY.cta });
      await expect(
        produceCreative(a.editor, {
          contentId: written.id,
          copy: { headline: "  " },
          artAssetId: assets.goodArt.id,
        }),
      ).rejects.toMatchObject({ code: "CREATIVE_COPY_REQUIRED", status: 409 });
    });

    it("stores the variant drawn and keeps a person's variant fixed", async () => {
      const content = await newContent(a);
      const overflowOn = (variant: string) => async (request: ComposeInput) => {
        if (request.variant === variant)
          throw new CreativeError("TEXT_OVERFLOW");
        return composeCreative(request);
      };
      // The starting variant does not fit: a free correction draws text_top.
      const corrected = await produceCreative(
        a.editor,
        {
          contentId: content.id,
          template: "lifestyle",
          copy: COPY,
          artAssetId: assets.goodArt.id,
        },
        { compose: overflowOn("text_bottom") },
      );
      expect(corrected).toMatchObject({
        variant: "text_top",
        brief: { variant: "text_bottom" },
        variantFixed: false,
      });
      expect(corrected.renditions[0]).toMatchObject({ variant: "text_top" });
      // A person's variant is never switched, also on a later recompose.
      const chosen = await produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        variant: "text_top",
        copy: COPY,
        artAssetId: assets.goodArt.id,
      });
      expect(chosen).toMatchObject({ variant: "text_top", variantFixed: true });
      await expect(
        recomposeCreative(
          a.editor,
          chosen.id,
          { options: { logoPlacement: "top_right" } },
          { compose: overflowOn("text_top") },
        ),
      ).rejects.toMatchObject({ code: "TEXT_OVERFLOW", status: 409 });
      // A new template without a variant is the studio's choice again.
      expect(
        await recomposeCreative(a.editor, chosen.id, { template: "tips" }),
      ).toMatchObject({ template: "tips", variantFixed: false });
    });

    it("re-checks the kept art and refuses art without its SHA-256", async () => {
      const own = await setStatus(
        a,
        await upload(a, "photo", await art("good", "lumora"), "image/webp"),
        "approved",
      );
      const content = await newContent(a);
      const creative = await produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: own.id,
      });
      expect(creative.components.artSha256).toBe(own.sha256);
      // The art's bytes are replaced meanwhile (as a re-import would).
      const flat = await assetData(a, assets.flatArt.id);
      await runIn(a, async (tx) => {
        const row = await entity(tx, a.owner, "assets", own.id);
        await update(tx, a.owner, row, {
          ...data(row),
          base64: flat.base64,
          sha256: flat.sha256,
        });
      });
      await expect(
        recomposeCreative(a.editor, creative.id, { variant: "text_top" }),
      ).rejects.toMatchObject({ code: "BRAND_ASSET_CHANGED", status: 409 });
      // An approved art whose bytes carry no SHA-256 is never drawn.
      const { sha256: _sha256, ...good } = await assetData(
        a,
        assets.goodArt.id,
      );
      const unhashed = await runIn(a, (tx) =>
        create(tx, a.owner, "assets", good),
      );
      await expect(
        produceCreative(a.editor, {
          contentId: content.id,
          template: "lifestyle",
          copy: COPY,
          artAssetId: unhashed.id,
        }),
      ).rejects.toMatchObject({
        code: "ASSET_RIGHTS",
        status: 409,
        detail: { assetIds: unhashed.id, reasons: "no_sha256" },
      });
    });

    it("attaches only for the current brand and an unchanged post", async () => {
      const content = await newContent(a);
      const before = await stored(a);
      // The post moves to another channel while the renditions are composed.
      await expect(
        produceCreative(
          a.editor,
          {
            contentId: content.id,
            template: "lifestyle",
            copy: COPY,
            artAssetId: assets.goodArt.id,
          },
          {
            afterCompose: async () => {
              await runIn(a, async (tx) => {
                const row = await entity(tx, a.owner, "content", content.id);
                await update(tx, a.owner, row, {
                  ...data(row),
                  channel: "x-int",
                });
              });
            },
          },
        ),
      ).rejects.toMatchObject({ code: "CONTENT_CHANGED", status: 409 });
      expect(await stored(a)).toEqual(before);
      // The profile's logo is replaced after the creative was made.
      const other = await newContent(a);
      const creative = await produceGood(a.editor, other.id);
      const lumora = await demoBrand("lumora");
      const newLogo = await setStatus(
        a,
        await upload(a, "logo", lumora.logos[1]!.bytes, "image/png"),
        "approved",
      );
      await saveProfile(
        a,
        "Lumora Home",
        lumoraIdentity({ logoAssetId: newLogo.id }),
      );
      try {
        await expect(
          attachCreative(a.editor, creative.id, {}),
        ).rejects.toMatchObject({ code: "BRAND_ASSET_CHANGED", status: 409 });
      } finally {
        await saveProfile(a, "Lumora Home", lumoraIdentity());
      }
      // Back to the logo it was made with, it attaches.
      expect(await attachCreative(a.editor, creative.id, {})).toMatchObject({
        contentId: other.id,
      });
    });

    it("refuses an attach whose component lost its rights, or whose post or creative was replaced", async () => {
      const own = await setStatus(
        a,
        await upload(a, "photo", await art("good", "lumora"), "image/webp"),
        "approved",
      );
      const content = await newContent(a);
      const revoked = await produceCreative(a.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: own.id,
      });
      await setStatus(a, own, "reference");
      await expect(
        attachCreative(a.editor, revoked.id, {}),
      ).rejects.toMatchObject({
        code: "ASSET_RIGHTS",
        status: 409,
        detail: { assetIds: own.id, reasons: "not_approved" },
      });
      // A creative another one replaced on the post cannot come back.
      const first = await produceGood(a.editor, content.id);
      const second = await produceGood(a.editor, content.id);
      await attachCreative(a.editor, first.id, {});
      await attachCreative(a.editor, second.id, {});
      const replaced = await runIn(a, async (tx) =>
        data(await findCreative(tx, a.owner, first.id)),
      );
      expect(replaced.status).toBe("superseded");
      expect(await assetData(a, first.renditions[0]!.assetId)).toMatchObject({
        assetStatus: "outdated",
      });
      await expect(
        attachCreative(a.editor, first.id, {}),
      ).rejects.toMatchObject({ code: "CREATIVE_NOT_ATTACHABLE", status: 409 });
      // A post replaced by a newer version takes no image.
      const old = await newContent(a);
      const creative = await produceGood(a.editor, old.id);
      await runIn(a, async (tx) => {
        const row = await entity(tx, a.owner, "content", old.id);
        await update(tx, a.owner, row, {
          ...data(row),
          supersededBy: randomUUID(),
        });
      });
      await expect(
        attachCreative(a.editor, creative.id, {}),
      ).rejects.toMatchObject({ code: "DRAFT_SUPERSEDED", status: 409 });
    });

    it("viewer cannot produce", async () => {
      const content = await newContent(a);
      await expect(produceGood(a.viewer, content.id)).rejects.toMatchObject({
        status: 403,
      });
      const creative = await produceGood(a.editor, content.id);
      await expect(
        recomposeCreative(a.viewer, creative.id, { variant: "text_top" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        attachCreative(a.viewer, creative.id, {}),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("does nothing while the flag is off", async () => {
      const content = await newContent(a);
      process.env.ORBIT_CREATIVE_STUDIO = "false";
      try {
        await expect(produceGood(a.editor, content.id)).rejects.toMatchObject({
          code: "NOT_FOUND",
          status: 404,
        });
      } finally {
        process.env.ORBIT_CREATIVE_STUDIO = "true";
      }
    });
  },
);
