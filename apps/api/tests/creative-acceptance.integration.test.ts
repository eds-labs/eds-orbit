import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { generateImage } from "../../../packages/ai/src/index.ts";
import {
  composeCreative,
  relativeLuminance,
  sha256Hex,
  type ComposeResult,
} from "../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  type DemoBrandName,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, encrypt, entity, list, update } from "../src/shared.ts";
import { marketingActions } from "../src/modules/marketing/actions.ts";
import {
  attachCreative,
  produceCreative,
  recomposeCreative,
  regenerateCreativeArt,
  type PipelineDeps,
} from "../src/modules/marketing/creative/pipeline.ts";
import type { CreativeView } from "../src/modules/marketing/creative/store.ts";
import { handoffPostizDraft } from "../src/modules/marketing/publishing/postiz-draft.ts";
import { exportAssetContent } from "../src/modules/marketing/pipeline/content-export.ts";
import { createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { requestContentPackage } from "../src/modules/agents/content-packages.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

// Acceptance tests A–E of the Creative Studio (spec §12) for the fictional
// demo brands Lumora Home (project A) and Kestrel Analytics (project B).
// Nothing here may reach a real provider: paid art takes an injected
// provider, and the real entry points refuse.
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImage: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImageWithReferences: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const COPY: Record<DemoBrandName, Record<string, string>> = {
  lumora: {
    eyebrow: "New this autumn",
    headline: "Evenings feel softer in warm light",
    subline:
      "Lamps, throws and textures that turn any room into a calm retreat.",
    cta: "Shop the collection",
  },
  kestrel: {
    eyebrow: "Weekly insight",
    headline: "See every metric that moves your team",
    subline:
      "Dashboards that update themselves, so Monday starts with answers.",
    cta: "Start free trial",
  },
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
const PALETTE_KEYS = [
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "backgroundColor",
  "surfaceColor",
  "textColor",
] as const;
const ALL_FORMATS = ["feed_portrait", "square", "story", "landscape"];
/** Telegram posts get all four formats (test B); X keeps its landscape default. */
const CREATIVE_SETTINGS = {
  formatsByChannel: { telegram: ALL_FORMATS },
  maxArtCorrections: 1,
};
const CONFIRM = {
  confirmMaximumCostMicros: IMAGE_MAX,
  confirmPromptMayBeSentToProvider: true as const,
};

type Project = Awaited<ReturnType<typeof createPackageProject>>;
type Asset = { id: string; version: number; sha256: string };
type BrandSetup = {
  project: Project;
  name: DemoBrandName;
  logo: Asset;
  goodArt: Asset;
  screenshot: Asset;
  identity: Record<string, any>;
};

const runIn = <T>(project: Project, work: (tx: DbTx) => Promise<T>) =>
  scoped(project.owner.workspaceId, project.owner.projectId, work);

/** An approved raster asset, stored as the upload route stores one. */
const addAsset = (project: Project, type: string, bytes: Buffer) =>
  runIn(project, async (tx): Promise<Asset> => {
    const sha256 = sha256Hex(bytes);
    const row = await create(tx, project.owner, "assets", {
      name: `Synthetic ${type}`,
      type,
      mime: "image/png",
      base64: bytes.toString("base64"),
      sha256,
      bytes: bytes.length,
      source: "Synthetic fixture",
      license: "Synthetic rights fixture",
      validUses: ["brand", "social"],
      usageApproved: true,
      assetStatus: "approved",
      providerUse: false,
      driveSyncStatus: "LOCAL_ONLY",
    });
    return { id: row.id, version: row.version, sha256 };
  });

/** The owner's rights decision through the asset status action. */
const approveAsset = (project: Project, id: string) =>
  runIn(project, async (tx) => {
    const handler = marketingActions["asset-status"]!;
    if (handler.transaction !== "shared") throw new Error("SHARED_EXPECTED");
    const row = await entity(tx, project.owner, "assets", id);
    return handler.run(tx, {
      scope: project.owner,
      input: {
        assetId: id,
        version: row.version,
        assetStatus: "approved",
        confirmUsageRights: true,
      },
      config: {} as any,
      auth: {} as any,
    });
  });

/**
 * Gives a package project the brand kit of a demo brand: its logo, good art
 * and screenshot as approved assets, and the visual identity in the profile
 * (the rest of the profile stays as the package project made it).
 */
async function brandProject(
  project: Project,
  name: DemoBrandName,
): Promise<BrandSetup> {
  const brand = await demoBrand(name);
  const logo = await addAsset(project, "logo", brand.logos[0]!.bytes);
  const goodArt = await addAsset(
    project,
    "photo",
    (await fixtureArt("good", name, { width: 1536, height: 1024 })).bytes,
  );
  const screenshot = await addAsset(
    project,
    "screenshot",
    (await fixtureScreenshot(name)).bytes,
  );
  const identity =
    name === "lumora"
      ? (lumoraProfile().visualIdentity as Record<string, any>)
      : KESTREL_IDENTITY;
  await runIn(project, async (tx) => {
    const row = await tx.projectMarketingProfile.findFirstOrThrow({
      where: { projectId: project.owner.projectId },
    });
    await tx.projectMarketingProfile.updateMany({
      where: {
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
      },
      data: {
        data: {
          ...(row.data as Record<string, unknown>),
          productName: name === "lumora" ? "Lumora Home" : "Kestrel Analytics",
          visualIdentity: {
            ...identity,
            logoAssetId: logo.id,
            creative: CREATIVE_SETTINGS,
          },
        } as any,
        version: { increment: 1 },
      },
    });
  });
  return { project, name, logo, goodArt, screenshot, identity };
}

/** A reviewed social post of a mission, on `channel`. */
const newContent = (project: Project, channel = X) =>
  runIn(project, async (tx) => {
    const mission = await create(tx, project.owner, "missions", {
      title: "Acceptance",
      status: "active",
      targetAction: "Learn more",
    });
    const evidence = await create(tx, project.owner, "evidence", {
      status: "ready",
      purpose: "public",
      facts: [],
      items: [],
    });
    return create(tx, project.owner, "content", {
      title: "Acceptance post",
      body: "A synthetic post for the acceptance tests. Learn more.",
      type: "social",
      channel,
      status: "reviewed",
      missionId: mission.id,
      evidenceId: evidence.id,
      claims: [],
    });
  });

/** The composer, recording every composition it draws. */
function recordingComposer() {
  const results: ComposeResult[] = [];
  const compose: NonNullable<PipelineDeps["compose"]> = async (input) => {
    const result = await composeCreative(input);
    results.push(result);
    return result;
  };
  /** The composition behind a stored rendition (same bytes). */
  const drawn = (rendition: { sha256: string }) => {
    const found = results.find((r) => r.sha256 === rendition.sha256);
    if (!found) throw new Error("RENDITION_NOT_COMPOSED_HERE");
    return found;
  };
  return { compose, results, drawn };
}

const publicationsOf = (project: Project, contentId: string) =>
  runIn(project, async (tx) =>
    (await list(tx, project.owner, "publications")).filter(
      (row) => data(row).contentId === contentId,
    ),
  );

afterAll(async () => {
  await closeDatabase();
});

describe.skipIf(!enabled)(
  "Creative Studio acceptance A–D (Lumora Home, Kestrel Analytics)",
  () => {
    const flag = process.env.ORBIT_CREATIVE_STUDIO;
    let lumora: BrandSetup;
    let kestrel: BrandSetup;

    beforeAll(async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      lumora = await brandProject(await createPackageProject(), "lumora");
      kestrel = await brandProject(await createPackageProject(), "kestrel");
    });
    afterAll(async () => {
      if (flag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
      else process.env.ORBIT_CREATIVE_STUDIO = flag;
      await lumora?.project.cleanup();
      await kestrel?.project.cleanup();
    });

    const produceLifestyle = async (setup: BrandSetup, deps: PipelineDeps) =>
      produceCreative(
        setup.project.editor,
        {
          contentId: (await newContent(setup.project)).id,
          template: "lifestyle",
          copy: COPY[setup.name] as any,
          artAssetId: setup.goodArt.id,
        },
        deps,
      );

    it("A: lifestyle from good art carries the brand's logo, colours and copy", async () => {
      for (const setup of [lumora, kestrel]) {
        const recorder = recordingComposer();
        const creative = await produceLifestyle(setup, recorder);
        expect(creative).toMatchObject({
          status: "composed",
          template: "lifestyle",
          copy: COPY[setup.name],
          components: {
            artAssetId: setup.goodArt.id,
            logo: { assetId: setup.logo.id, sha256: setup.logo.sha256 },
          },
          qa: { verdict: "pass" },
        });
        expect(creative.qa.checks.filter((c) => !c.passed)).toEqual([]);
        // X draws landscape; every copy field is on the image.
        expect(creative.renditions.map((r) => r.format)).toEqual(["landscape"]);
        const result = recorder.drawn(creative.renditions[0]!);
        const logo = result.layers.find((l) => l.kind === "logo")!;
        expect(logo.sourceSha256).toBe(setup.logo.sha256);
        for (const kind of ["eyebrow", "headline", "subline", "cta"])
          expect(
            result.layers.some((l) => l.kind === kind),
            `${setup.name} ${kind}`,
          ).toBe(true);
        // The CTA is a pill in the brand's primary colour.
        expect(result.ctaStyleApplied).toBe("pill");
        expect(result.backdrops.cta!.p10).toBeCloseTo(
          relativeLuminance(setup.identity.primaryColor!),
          6,
        );
        // The stored rendition is exactly what was composed.
        const stored = await runIn(setup.project, async (tx) =>
          data(
            await entity(
              tx,
              setup.project.owner,
              "assets",
              creative.renditions[0]!.assetId,
            ),
          ),
        );
        expect(
          createHash("sha256")
            .update(Buffer.from(stored.base64, "base64"))
            .digest("hex"),
        ).toBe(result.sha256);
      }
    });

    it("B: feature_highlight from the screenshot in all four formats", async () => {
      for (const setup of [lumora, kestrel]) {
        const recorder = recordingComposer();
        const creative = await produceCreative(
          setup.project.editor,
          {
            contentId: (await newContent(setup.project, TELEGRAM)).id,
            template: "feature_highlight",
            copy: COPY[setup.name] as any,
            artAssetId: setup.goodArt.id,
            productAssetIds: [setup.screenshot.id],
          },
          recorder,
        );
        expect(creative.components.products).toEqual([
          { assetId: setup.screenshot.id, sha256: setup.screenshot.sha256 },
        ]);
        expect(creative.renditions.map((r) => r.format).sort()).toEqual(
          [...ALL_FORMATS].sort(),
        );
        expect(
          creative.renditions.map((r) => [r.format, r.width, r.height]),
        ).toEqual(
          expect.arrayContaining([
            ["feed_portrait", 1080, 1350],
            ["square", 1080, 1080],
            ["story", 1080, 1920],
            ["landscape", 1200, 630],
          ]),
        );
        const integrity = creative.qa.checks.filter(
          (c) => c.code === "SCREENSHOT_INTEGRITY",
        );
        expect(integrity).toHaveLength(4);
        expect(integrity.every((c) => c.passed)).toBe(true);
        // Each rendition shows the approved screenshot bytes, scaled only.
        for (const rendition of creative.renditions) {
          const product = recorder
            .drawn(rendition)
            .layers.find((l) => l.kind === "product")!;
          expect(product.sourceSha256).toBe(setup.screenshot.sha256);
        }
      }
    });

    it("C: weak art is found, corrected once at most and left to the owner", async () => {
      const { project } = lumora;
      const tiny = await addAsset(
        project,
        "photo",
        (await fixtureArt("tiny_subject", "lumora")).bytes,
      );
      const flat = await addAsset(
        project,
        "photo",
        (await fixtureArt("flat", "lumora")).bytes,
      );
      const failedCodes = (creative: CreativeView) =>
        creative.qa.checks.filter((c) => !c.passed).map((c) => c.code);

      const flatCreative = await produceCreative(project.editor, {
        contentId: (await newContent(project)).id,
        template: "lifestyle",
        copy: COPY.lumora as any,
        artAssetId: flat.id,
      });
      expect(flatCreative.status).toBe("needs_owner");
      expect(failedCodes(flatCreative)).toContain("EMPTY_AREA_EXCESSIVE");

      const content = await newContent(project);
      const creative = await produceCreative(project.editor, {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY.lumora as any,
        artAssetId: tiny.id,
      });
      expect(creative.status).toBe("needs_owner");
      expect(failedCodes(creative)).toContain("SUBJECT_TOO_SMALL");

      // The owner pays for one corrected image; the model again draws a tiny subject.
      const generate = vi.fn(
        async (request: Parameters<typeof generateImage>[0]) => {
          const [width, height] = String(request.size).split("x").map(Number);
          return {
            bytes: (
              await fixtureArt("tiny_subject", "lumora", {
                width: width!,
                height: height!,
              })
            ).bytes,
            model: "gpt-image-2.5-flare",
            size: request.size,
            quality: request.quality,
            background: request.background,
            usage: null,
          };
        },
      ) as unknown as typeof generateImage & ReturnType<typeof vi.fn>;
      const regenerated = await regenerateCreativeArt(
        project.owner,
        creative.id,
        CONFIRM,
        { generate },
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(
        (generate.mock.calls[0]![0] as { prompt: string }).prompt,
      ).toContain("make the main subject larger");
      const attempts = regenerated.corrections.filter((c) => c.kind === "art");
      expect(attempts).toHaveLength(CREATIVE_SETTINGS.maxArtCorrections);
      expect(regenerated.status).toBe("needs_rights");
      // The owner approves the new art; it is still weak, so it stays theirs.
      await approveAsset(project, regenerated.components.artAssetId!);
      const recomposed = await recomposeCreative(
        project.editor,
        creative.id,
        {},
      );
      expect(recomposed.status).toBe("needs_owner");
      expect(failedCodes(recomposed)).toContain("SUBJECT_TOO_SMALL");
      // The correction is bounded: no second paid attempt.
      await expect(
        regenerateCreativeArt(project.owner, creative.id, CONFIRM, {
          generate,
        }),
      ).rejects.toMatchObject({ code: "ART_CORRECTION_LIMIT", status: 409 });
      expect(generate).toHaveBeenCalledTimes(1);
      // Nothing reaches the post or a publication without the owner.
      await expect(
        attachCreative(project.editor, creative.id, {}),
      ).rejects.toMatchObject({ code: "CREATIVE_QA_FAILED", status: 409 });
      const after = await runIn(project, (tx) =>
        entity(tx, project.owner, "content", content.id),
      );
      expect(data(after).assetId).toBeUndefined();
      expect(await publicationsOf(project, content.id)).toEqual([]);
    });

    it("D: another project's ids are refused and brand data never mixes", async () => {
      const recorder = {
        lumora: recordingComposer(),
        kestrel: recordingComposer(),
      };
      const mine = await produceLifestyle(lumora, recorder.lumora);
      const theirs = await produceLifestyle(kestrel, recorder.kestrel);
      const kestrelContent = await newContent(kestrel.project);
      const b = kestrel.project.editor;
      // Kestrel naming Lumora's art, screenshot, logo, post or creative learns nothing.
      for (const request of [
        { contentId: kestrelContent.id, artAssetId: lumora.goodArt.id },
        { contentId: kestrelContent.id, artAssetId: lumora.logo.id },
        {
          contentId: kestrelContent.id,
          template: "feature_highlight" as const,
          productAssetIds: [lumora.screenshot.id],
        },
        { contentId: mine.contentId! },
      ])
        await expect(
          produceCreative(b, { copy: COPY.kestrel as any, ...request }),
        ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        recomposeCreative(b, mine.id, { variant: "text_top" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(attachCreative(b, mine.id, {})).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
      // Each creative is drawn from its own brand kit only.
      expect(theirs.components.logo).toEqual({
        assetId: kestrel.logo.id,
        sha256: kestrel.logo.sha256,
      });
      const palette = (setup: BrandSetup) =>
        new Set(PALETTE_KEYS.map((key) => setup.identity[key]!.toUpperCase()));
      const own = { lumora: palette(lumora), kestrel: palette(kestrel) };
      const colours = (results: ComposeResult[]) =>
        results.flatMap((r) =>
          r.layers.flatMap((l) => (l.color ? [l.color.toUpperCase()] : [])),
        );
      const onlyIn = (a: Set<string>, b: Set<string>) =>
        [...a].filter((c) => !b.has(c));
      const kestrelColours = colours(recorder.kestrel.results);
      const lumoraColours = colours(recorder.lumora.results);
      expect(kestrelColours.length).toBeGreaterThan(0);
      expect(lumoraColours.length).toBeGreaterThan(0);
      for (const colour of onlyIn(own.lumora, own.kestrel))
        expect(kestrelColours).not.toContain(colour);
      for (const colour of onlyIn(own.kestrel, own.lumora))
        expect(lumoraColours).not.toContain(colour);
      // Each brand's own palette does reach its creative.
      expect(lumoraColours).toContain(lumora.identity.textColor!.toUpperCase());
    });
  },
);

describe.skipIf(!enabled)(
  "Creative Studio acceptance E: approvals still gate creative content",
  () => {
    const flag = process.env.ORBIT_CREATIVE_STUDIO;
    const owner = { id: "", cookie: "" };
    let app: Awaited<ReturnType<typeof buildServer>>;
    let lumora: BrandSetup;
    const origin = () => process.env.APP_ORIGIN!;
    const project = () => lumora.project;
    const action = (name: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${project().owner.projectId}/actions/${name}`,
        headers: { origin: origin(), cookie: owner.cookie },
        payload: payload as any,
      });

    /** A reviewed X draft of an approved content package (as package-schedule tests make one). */
    const packageDraft = async () => {
      const { editor } = project();
      const thread = await createConversation(editor);
      const { package: pkg, actionRequest } = await requestContentPackage(
        editor,
        thread.id,
        {
          goal: `Announce beta access ${randomUUID().slice(0, 8)}`,
          channels: [X],
          factKeys: ["beta.access"],
        },
      );
      await runIn(project(), (tx) =>
        decideActionRequest(tx, editor, actionRequest.id, {
          version: actionRequest.version,
          packageHash: data(actionRequest).packageHash,
          decision: "approve",
        }),
      );
      const worker: Scope = {
        ...project().owner,
        userId: "worker",
        role: "owner",
      };
      await runIn(project(), async (tx) => {
        for (const mission of (
          await list(tx, project().owner, "missions")
        ).filter((m) => data(m).packageId === pkg.id)) {
          const job = (await list(tx, project().owner, "jobs")).find(
            (row) => data(row).resourceId === mission.id,
          )!;
          await deterministicDraft(tx, project().owner, mission.id, job.id);
        }
      });
      await runIn(project(), (tx) => sweepProject(tx, worker));
      return runIn(project(), async (tx) =>
        (await list(tx, project().owner, "content")).find(
          (row) =>
            data(row).channel === X &&
            data(row).type === "social" &&
            typeof data(row).missionId === "string",
        )!,
      );
    };

    beforeAll(async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      app = await buildServer();
      lumora = await brandProject(await createPackageProject(), "lumora");
      // A signed-in owner for the action routes.
      const auth = makeAuth();
      const password = randomBytes(24).toString("base64url");
      const email = `${randomUUID()}@example.invalid`;
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: "Synthetic acceptance owner", password },
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
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project().owner.workspaceId,
          userId: owner.id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project().owner.workspaceId,
          projectId: project().owner.projectId,
          userId: owner.id,
          role: "owner",
        },
      });
      // The Postiz connection the draft handoff uses (no real request leaves).
      await runIn(project(), async (tx) => {
        const connector = (await list(tx, project().owner, "connectors"))[0]!;
        await update(tx, project().owner, connector, {
          ...data(connector),
          baseUrl: "https://postiz.example.invalid",
          encryptedCredential: encrypt(
            "synthetic-token",
            process.env.CREDENTIAL_KEY!,
          ),
        });
      });
    });
    afterAll(async () => {
      if (flag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
      else process.env.ORBIT_CREATIVE_STUDIO = flag;
      delete process.env.ORBIT_CONTENT_PACKAGES;
      vi.unstubAllEnvs();
      await lumora?.project.cleanup();
      await authDb.user.deleteMany({ where: { id: owner.id } });
      await app?.close();
    });

    it("E: an attached creative needs the existing approvals before it leaves Orbit", async () => {
      const made = await packageDraft();
      expect(data(made).status).toBe("reviewed");
      // A campaign post Postiz may take: the package fixture's drafts are synthetic.
      const draft = await runIn(project(), (tx) =>
        update(tx, project().owner, made, { ...data(made), synthetic: false }),
      );
      expect(await publicationsOf(project(), draft.id)).toEqual([]);
      // The mission's test publishing right, as the owner's schedule decision
      // grants it (package-schedule.ts; tested there).
      await runIn(project(), async (tx) => {
        const mission = await entity(
          tx,
          project().owner,
          "missions",
          data(draft).missionId,
        );
        await update(tx, project().owner, mission, {
          ...data(mission),
          allowedActions: [
            ...new Set([
              ...(data(mission).allowedActions ?? []),
              "publish_test",
            ]),
          ],
        });
      });
      // Assisted mode: every post needs the owner's approval of its exact package.
      await runIn(project(), async (tx) => {
        const policy = (await list(tx, project().owner, "policies")).find(
          (row) => data(row).active === true,
        )!;
        await update(tx, project().owner, policy, {
          ...data(policy),
          mode: "assisted",
        });
      });
      const preflight = async () => {
        const r = await action("preflight", { contentId: draft.id });
        expect(r.statusCode).toBe(200);
        return r.json() as {
          allowed: boolean;
          blockers: string[];
          packageHash: string;
          contentVersion: number;
        };
      };
      // The owner approves the text-only package.
      const textOnly = await preflight();
      expect(textOnly.blockers).toEqual(["APPROVAL_REQUIRED"]);
      expect(
        (
          await action("approve", {
            contentId: draft.id,
            version: textOnly.contentVersion,
            packageHash: textOnly.packageHash,
          })
        ).statusCode,
      ).toBe(200);
      expect((await preflight()).allowed).toBe(true);

      // An editor attaches a creative: the earlier approval does not cover it.
      const creative = await produceCreative(project().editor, {
        contentId: draft.id,
        template: "lifestyle",
        copy: COPY.lumora as any,
        artAssetId: lumora.goodArt.id,
      });
      expect(creative.status).toBe("composed");
      const { assetId } = await attachCreative(
        project().editor,
        creative.id,
        {},
      );
      const withImage = await preflight();
      expect(withImage.packageHash).not.toBe(textOnly.packageHash);
      expect(withImage.allowed).toBe(false);
      expect(withImage.blockers).toContain("APPROVAL_REQUIRED");
      // The rendition itself counts as an approved image (R36).
      expect(withImage.blockers).not.toContain(
        "ASSET_NOT_APPROVED_OR_UNSUPPORTED",
      );

      // Without the approval: publishing and scheduling are refused ...
      const publish = (scheduledAt?: string) =>
        action("publish", {
          contentId: draft.id,
          version: withImage.contentVersion,
          ...(scheduledAt ? { scheduledAt } : {}),
        });
      const refused = await publish();
      expect(refused.statusCode).toBe(409);
      expect(JSON.stringify(refused.json())).toContain("APPROVAL_REQUIRED");
      expect(await publicationsOf(project(), draft.id)).toEqual([]);
      // ... and the Postiz draft handoff is the owner's confirmed decision alone.
      vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
      const uploads: Buffer[] = [];
      const posts: unknown[] = [];
      const deps = {
        createClient: (() => ({
          uploadMedia: async (input: { bytes: Buffer }) => {
            uploads.push(input.bytes);
            return { id: "media-1", path: "https://postiz.example.invalid/m" };
          },
          createPost: async (input: unknown) => {
            posts.push(input);
            return {
              remotePosts: [{ postId: "remote-draft-1", integration: X }],
              state: "accepted",
              requestedType: "draft",
            };
          },
        })) as any,
        readAsset: exportAssetContent,
      };
      const handoff = (scope: Scope, confirm = true) =>
        handoffPostizDraft(
          scope,
          {
            contentId: draft.id,
            version: withImage.contentVersion,
            ...(confirm ? { confirmDraftOnly: true } : {}),
          },
          deps,
        );
      await expect(handoff(project().editor)).rejects.toMatchObject({
        status: 403,
      });
      await expect(handoff(project().owner, false)).rejects.toThrow();
      expect(posts).toEqual([]);

      // After the owner's approval of the package with the image, both proceed (test mode).
      const approved = await action("approve", {
        contentId: draft.id,
        version: withImage.contentVersion,
        packageHash: withImage.packageHash,
      });
      expect(approved.statusCode).toBe(200);
      expect((await preflight()).allowed).toBe(true);
      const published = await publish();
      expect(published.statusCode).toBe(200);
      const [publication] = await publicationsOf(project(), draft.id);
      expect(data(publication!)).toMatchObject({
        packageHash: withImage.packageHash,
      });
      const sent = await handoff(project().owner);
      expect(data(sent).status).toBe("accepted");
      expect(data(sent).assetId).toBe(assetId);
      // The draft carries exactly the attached rendition.
      expect(uploads).toHaveLength(1);
      expect(sha256Hex(uploads[0]!)).toBe(
        creative.renditions.find((r) => r.assetId === assetId)!.sha256,
      );
      expect(posts).toHaveLength(1);
    });
  },
);
