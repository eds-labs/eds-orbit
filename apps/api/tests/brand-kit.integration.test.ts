import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity } from "../src/shared.ts";
import { marketingActions } from "../src/modules/marketing/actions.ts";
import { mergeProfile } from "../src/modules/marketing/brand/configuration-section.ts";
import { configurationChange } from "../src/platform/configuration/configuration.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const brandKit = {
  logos: {} as Record<string, string>,
  productAssetIds: [] as string[],
  imagery: {
    kind: "illustration",
    mood: "calm, precise, optimistic",
    subjects: "Dashboards, teams at a table",
    avoid: ["Stock handshake photos"],
  },
  typography: { headingWeight: 800, headingCase: "upper" },
  forbiddenDesigns: ["Text over busy photos"],
  creative: {
    templates: {
      lifestyle: { enabled: true, variant: "text_side" },
      tips: { enabled: false },
    },
    formatsByChannel: { x: ["landscape"], instagram: ["feed_portrait"] },
    logoPlacement: "top_right",
    ctaStyle: "outline",
    maxArtCorrections: 2,
    visualReview: true,
  },
};

describe("brand kit stays out of partial MCP changes", () => {
  it("keeps brand kit fields a partial change does not name", () => {
    const stored = {
      productName: "Kestrel Analytics",
      visualIdentity: { primaryColor: "#112233", ...brandKit },
    };
    const merged = mergeProfile(stored, {
      visualIdentity: { primaryColor: "#445566" },
    }) as { visualIdentity: Record<string, unknown> };
    expect(merged.visualIdentity).toEqual({
      ...stored.visualIdentity,
      primaryColor: "#445566",
    });
  });

  it("does not offer the creative settings (maps, replaced as a whole) to MCP changes", () => {
    const change = (visualIdentity: Record<string, unknown>) =>
      configurationChange.safeParse({
        expectedVersion: 1,
        changes: { marketing: { visualIdentity } },
      }).success;
    expect(change({ imagery: brandKit.imagery })).toBe(true);
    expect(change({ typography: brandKit.typography })).toBe(true);
    expect(change({ creative: { ctaStyle: "pill" } })).toBe(false);
  });
});

describe.skipIf(!enabled)(
  "Brand kit, screenshot assets and provider use",
  () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let a: Awaited<ReturnType<typeof createPackageProject>>;
    let b: Awaited<ReturnType<typeof createPackageProject>>;
    let png: Buffer;
    const origin = () => process.env.APP_ORIGIN!;
    const people = {} as Record<
      "owner" | "editor",
      { id: string; cookie: string }
    >;
    const runIn = <T>(
      project: Awaited<ReturnType<typeof createPackageProject>>,
      work: (tx: DbTx) => Promise<T>,
    ) => scoped(project.owner.workspaceId, project.owner.projectId, work);
    const request = (
      who: keyof typeof people,
      project: typeof a,
      method: "GET" | "POST" | "PUT",
      path: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: `/api/projects/${project.owner.projectId}/${path}`,
        headers: { origin: origin(), cookie: people[who].cookie },
        ...(payload === undefined ? {} : { payload: payload as any }),
      });
    /** An asset row as the owner's rights decision leaves it. */
    const asset = (
      project: typeof a,
      type: string,
      changes: Record<string, unknown> = {},
    ) =>
      runIn(project, (tx) =>
        create(tx, project.owner, "assets", {
          name: `Synthetic ${type}`,
          type,
          mime: "image/png",
          base64: png.toString("base64"),
          sha256: randomBytes(32).toString("hex"),
          usageApproved: true,
          assetStatus: "approved",
          ...changes,
        }),
      );
    const profileOf = async (project: typeof a) =>
      (await request("owner", project, "GET", "marketing-profile")).json() as {
        version: number;
        data: Record<string, any>;
      };
    /** Saves the project's profile with the given visual identity. */
    const saveProfile = async (
      project: typeof a,
      visualIdentity: Record<string, unknown>,
    ) => {
      const current = await profileOf(project);
      return request("owner", project, "PUT", "marketing-profile", {
        ...current.data,
        visualIdentity,
        expectedVersion: current.version,
      });
    };
    const setStatus = (
      who: keyof typeof people,
      project: typeof a,
      row: { id: string; version: number },
      changes: Record<string, unknown>,
    ) =>
      request(who, project, "POST", "actions/asset-status", {
        assetId: row.id,
        version: row.version,
        ...changes,
      });
    const approve = { assetStatus: "approved", confirmUsageRights: true };

    beforeAll(async () => {
      app = await buildServer();
      const auth = makeAuth();
      const password = randomBytes(24).toString("base64url");
      for (const role of ["owner", "editor"] as const) {
        const email = `${randomUUID()}@example.invalid`;
        const signedUp = await auth.api.signUpEmail({
          body: { email, name: `Synthetic brand kit ${role}`, password },
        });
        const r = await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          headers: { origin: origin() },
          payload: { email, password },
        });
        expect(r.statusCode).toBe(200);
        const cookies = r.headers["set-cookie"];
        people[role] = {
          id: signedUp.user.id,
          cookie: (Array.isArray(cookies) ? cookies : [cookies])
            .map((c) => c!.split(";")[0])
            .join("; "),
        };
      }
      a = await createPackageProject();
      b = await createPackageProject();
      // The owner owns both projects; the editor only edits project A.
      for (const [project, role, who] of [
        [a, "owner", "owner"],
        [b, "owner", "owner"],
        [a, "editor", "editor"],
      ] as const) {
        await authDb.workspaceMember.create({
          data: {
            workspaceId: project.owner.workspaceId,
            userId: people[who].id,
            role: "viewer",
          },
        });
        await authDb.projectMember.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            userId: people[who].id,
            role,
          },
        });
      }
      const rendered = await renderRasterTemplate({
        format: "square",
        logoApproved: true,
        title: "Synthetic screenshot",
      });
      if (rendered.status !== "rendered")
        throw new Error("FIXTURE_RENDER_FAILED");
      png = rendered.bytes;
    });
    afterAll(async () => {
      await a?.cleanup();
      await b?.cleanup();
      await authDb.user.deleteMany({
        where: { id: { in: Object.values(people).map((p) => p.id) } },
      });
      await app?.close();
      await closeDatabase();
    });

    describe("uploads", () => {
      it("accepts screenshots and product images, still unapproved and without provider use", async () => {
        for (const type of ["screenshot", "product"]) {
          const r = await request("owner", a, "POST", "assets/upload", {
            name: `Synthetic ${type}`,
            type,
            mime: "image/png",
            base64: png.toString("base64"),
            source: "Synthetic fixture",
            license: "Synthetic rights fixture",
            validUses: ["social"],
            confirmRightsInformation: true,
          });
          expect([type, r.statusCode]).toEqual([type, 201]);
          expect(r.json().data).toMatchObject({
            type,
            assetStatus: "reference",
            usageApproved: false,
            mime: "image/png",
          });
          expect(r.json().data.providerUse ?? false).toBe(false);
        }
      });

      it("still refuses an unknown type", async () => {
        const r = await request("owner", a, "POST", "assets/upload", {
          name: "Synthetic video",
          type: "video",
          mime: "image/png",
          base64: png.toString("base64"),
          source: "Synthetic fixture",
          license: "Synthetic rights fixture",
          validUses: ["social"],
          confirmRightsInformation: true,
        });
        expect(r.statusCode).toBe(400);
      });
    });

    describe("profile references", () => {
      it("takes logos and product images of the project that are approved", async () => {
        const [logo, mark, screenshot, product, photo] = await Promise.all([
          asset(a, "logo"),
          asset(a, "logo", { mime: "image/webp" }),
          asset(a, "screenshot"),
          asset(a, "product"),
          asset(a, "photo"),
        ]);
        const r = await saveProfile(a, {
          ...brandKit,
          logoAssetId: logo.id,
          logos: { onDark: logo.id, mark: mark.id },
          productAssetIds: [screenshot.id, product.id, photo.id],
        });
        expect(r.statusCode).toBe(200);
      });

      it("saves a full profile with the brand kit fields unchanged (Review Focus 1)", async () => {
        const [logo, screenshot] = await Promise.all([
          asset(a, "logo"),
          asset(a, "screenshot"),
        ]);
        const visualIdentity = {
          primaryColor: "#112233",
          secondaryColor: "#334455",
          accentColor: "#55AAFF",
          backgroundColor: "#F0F4F8",
          surfaceColor: "#FFFFFF",
          textColor: "#101820",
          headingFont: "Inter",
          bodyFont: "Arial",
          designRules: ["Use clean geometric forms."],
          logoAssetId: logo.id,
          ...brandKit,
          logos: { secondary: logo.id },
          productAssetIds: [screenshot.id],
        };
        const before = await profileOf(a);
        const saved = await saveProfile(a, visualIdentity);
        expect(saved.statusCode).toBe(200);
        expect(saved.json().version).toBe(before.version + 1);
        expect(saved.json().data.visualIdentity).toEqual(visualIdentity);
        // The stored current profile and the new version row hold the same.
        const current = await profileOf(a);
        expect(current.version).toBe(before.version + 1);
        expect(current.data.visualIdentity).toEqual(visualIdentity);
        const versionRow = await runIn(a, (tx) =>
          tx.projectMarketingProfileVersion.findFirstOrThrow({
            where: {
              projectId: a.owner.projectId,
              version: before.version + 1,
            },
          }),
        );
        expect((versionRow.data as any).visualIdentity).toEqual(visualIdentity);
        // Saving the same profile again (an editor that shows no brand kit field
        // sends the stored identity back) keeps every field.
        const again = await request("owner", a, "PUT", "marketing-profile", {
          ...current.data,
          expectedVersion: current.version,
        });
        expect(again.statusCode).toBe(200);
        expect(again.json().data.visualIdentity).toEqual(visualIdentity);
      });

      it("refuses another project's logo as not found", async () => {
        const foreign = await asset(a, "logo");
        for (const visualIdentity of [
          { logos: { onDark: foreign.id } },
          { logos: { secondary: foreign.id, mark: foreign.id } },
          { productAssetIds: [foreign.id] },
        ]) {
          const r = await saveProfile(b, visualIdentity);
          expect([visualIdentity, r.statusCode, r.json().error.code]).toEqual([
            visualIdentity,
            404,
            "NOT_FOUND",
          ]);
        }
        // The same ids in the project that owns them are fine.
        expect(
          (await saveProfile(a, { logos: { onDark: foreign.id } })).statusCode,
        ).toBe(200);
      });

      it("refuses another project's screenshot as not found", async () => {
        const foreign = await asset(a, "screenshot");
        const r = await saveProfile(b, { productAssetIds: [foreign.id] });
        expect([r.statusCode, r.json().error.code]).toEqual([404, "NOT_FOUND"]);
      });

      it("refuses product images that are not approved screenshots, products or photos", async () => {
        const refused = await Promise.all([
          asset(a, "screenshot", {
            usageApproved: false,
            assetStatus: "reference",
          }),
          asset(a, "screenshot", { usageApproved: false }),
          asset(a, "screenshot", { assetStatus: "outdated" }),
          asset(a, "logo"),
          asset(a, "background"),
          asset(a, "banner"),
        ]);
        for (const row of refused) {
          const r = await saveProfile(a, { productAssetIds: [row.id] });
          expect([
            data(row).type,
            data(row).assetStatus,
            r.statusCode,
            r.json().error.code,
          ]).toEqual([
            data(row).type,
            data(row).assetStatus,
            409,
            "APPROVED_PRODUCT_ASSET_REQUIRED",
          ]);
        }
        // One bad id among good ones still refuses the whole profile.
        const good = await asset(a, "product");
        const r = await saveProfile(a, {
          productAssetIds: [good.id, refused[0]!.id],
        });
        expect(r.json().error.code).toBe("APPROVED_PRODUCT_ASSET_REQUIRED");
      });

      it("refuses logos that are not approved raster logos with a hash", async () => {
        const refused = await Promise.all([
          asset(a, "logo", { usageApproved: false, assetStatus: "reference" }),
          asset(a, "logo", { usageApproved: false }),
          asset(a, "logo", { assetStatus: "outdated" }),
          asset(a, "logo", { sha256: undefined }),
          asset(a, "logo", { mime: "image/svg+xml" }),
          asset(a, "logo", { mime: undefined }),
          asset(a, "photo"),
          asset(a, "screenshot"),
          asset(a, "original_logo"),
        ]);
        for (const row of refused)
          for (const slot of ["secondary", "onDark", "onLight", "mark"]) {
            const r = await saveProfile(a, { logos: { [slot]: row.id } });
            expect([
              data(row).type,
              slot,
              r.statusCode,
              r.json().error.code,
            ]).toEqual([
              data(row).type,
              slot,
              409,
              "APPROVED_LOGO_ASSET_REQUIRED",
            ]);
          }
      });

      it("keeps checking the primary logo as before", async () => {
        const photo = await asset(a, "photo");
        const r = await saveProfile(a, { logoAssetId: photo.id });
        expect([r.statusCode, r.json().error.code]).toEqual([
          409,
          "APPROVED_LOGO_ASSET_REQUIRED",
        ]);
      });
    });

    describe("provider use", () => {
      it("starts without provider use and lets only an owner set it", async () => {
        const row = await asset(a, "screenshot");
        expect(data(row).providerUse ?? false).toBe(false);

        // An editor is refused by the action (owner-only) ...
        const viaRoute = await setStatus("editor", a, row, {
          ...approve,
          providerUse: true,
        });
        expect(viaRoute.statusCode).toBe(403);
        // ... and the handler refuses the flag on its own account (OWNER_REQUIRED).
        const handler = marketingActions["asset-status"]!;
        if (handler.transaction !== "shared")
          throw new Error("SHARED_EXPECTED");
        const editorScope = {
          ...a.owner,
          userId: people.editor.id,
          role: "editor" as const,
        };
        await expect(
          runIn(a, (tx) =>
            handler.run(tx, {
              scope: editorScope,
              input: {
                assetId: row.id,
                version: row.version,
                ...approve,
                providerUse: true,
              },
              config: {} as any,
              auth: {} as any,
            }),
          ),
        ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
        // Not even the value it already has may be sent by a non-owner.
        await expect(
          runIn(a, (tx) =>
            handler.run(tx, {
              scope: editorScope,
              input: {
                assetId: row.id,
                version: row.version,
                ...approve,
                providerUse: false,
              },
              config: {} as any,
              auth: {} as any,
            }),
          ),
        ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
        const unchanged = await runIn(a, (tx) =>
          entity(tx, a.owner, "assets", row.id),
        );
        expect(unchanged.version).toBe(row.version);
        expect(data(unchanged).providerUse ?? false).toBe(false);

        // The owner stores it and the audit trail records the change.
        const set = await setStatus("owner", a, row, {
          ...approve,
          providerUse: true,
        });
        expect(set.statusCode).toBe(200);
        expect(set.json().data).toMatchObject({
          assetStatus: "approved",
          usageApproved: true,
          providerUse: true,
        });
        const stored = await runIn(a, (tx) =>
          entity(tx, a.owner, "assets", row.id),
        );
        expect(data(stored).providerUse).toBe(true);
        const events = await runIn(a, (tx) =>
          tx.auditEvent.findMany({
            where: { resourceId: row.id, action: "asset.provider_use_update" },
          }),
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.actorId).toBe(people.owner.id);
        expect(events[0]!.metadata).toEqual({ from: false, to: true });
      });

      it("keeps the flag when the status is approved again without it, and records only real changes", async () => {
        const row = await asset(a, "product");
        const first = await setStatus("owner", a, row, {
          ...approve,
          providerUse: true,
        });
        const again = await setStatus(
          "owner",
          a,
          { id: row.id, version: first.json().version },
          approve,
        );
        expect(again.statusCode).toBe(200);
        expect(again.json().data.providerUse).toBe(true);
        const same = await setStatus(
          "owner",
          a,
          { id: row.id, version: again.json().version },
          { ...approve, providerUse: true },
        );
        expect(same.json().data.providerUse).toBe(true);
        const events = await runIn(a, (tx) =>
          tx.auditEvent.findMany({
            where: { resourceId: row.id, action: "asset.provider_use_update" },
          }),
        );
        expect(events).toHaveLength(1);
      });

      it("resets provider use when the asset becomes outdated or loses its approval", async () => {
        for (const assetStatus of ["outdated", "reference"]) {
          const row = await asset(a, "screenshot");
          const granted = await setStatus("owner", a, row, {
            ...approve,
            providerUse: true,
          });
          expect(granted.json().data.providerUse).toBe(true);
          const next = await setStatus(
            "owner",
            a,
            { id: row.id, version: granted.json().version },
            { assetStatus },
          );
          expect([assetStatus, next.statusCode]).toEqual([assetStatus, 200]);
          expect(next.json().data).toMatchObject({
            assetStatus,
            usageApproved: false,
            providerUse: false,
          });
          const events = await runIn(a, (tx) =>
            tx.auditEvent.findMany({
              where: {
                resourceId: row.id,
                action: "asset.provider_use_update",
              },
              orderBy: { createdAt: "asc" },
            }),
          );
          expect(events.map((e) => e.metadata)).toEqual([
            { from: false, to: true },
            { from: true, to: false },
          ]);
          // Approving it again is a new rights decision: the grant does not return.
          const back = await setStatus(
            "owner",
            a,
            { id: row.id, version: next.json().version },
            approve,
          );
          expect(back.json().data.providerUse).toBe(false);
        }
      });

      it("refuses provider use on an asset that is not approved", async () => {
        const row = await asset(a, "screenshot", {
          usageApproved: false,
          assetStatus: "reference",
        });
        for (const assetStatus of ["reference", "outdated"]) {
          const r = await setStatus("owner", a, row, {
            assetStatus,
            providerUse: true,
          });
          expect([assetStatus, r.statusCode, r.json().error.code]).toEqual([
            assetStatus,
            409,
            "ASSET_NOT_APPROVED",
          ]);
        }
      });

      it("keeps the existing status rules", async () => {
        const row = await asset(a, "screenshot", {
          usageApproved: false,
          assetStatus: "reference",
        });
        const noConfirmation = await setStatus("owner", a, row, {
          assetStatus: "approved",
          providerUse: true,
        });
        expect(noConfirmation.json().error.code).toBe(
          "ASSET_RIGHTS_CONFIRMATION_REQUIRED",
        );
        const stale = await setStatus(
          "owner",
          a,
          { id: row.id, version: row.version + 5 },
          approve,
        );
        expect(stale.json().error.code).toBe("VERSION_CONFLICT");
        const foreign = await setStatus(
          "owner",
          b,
          { id: row.id, version: row.version },
          approve,
        );
        expect([foreign.statusCode, foreign.json().error.code]).toEqual([
          404,
          "NOT_FOUND",
        ]);
        const plain = await setStatus("owner", a, row, approve);
        expect(plain.statusCode).toBe(200);
        expect(plain.json().data.providerUse ?? false).toBe(false);
      });
    });
  },
);
