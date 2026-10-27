import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  IMAGE_SIZES,
  type generateImage,
  type respond,
} from "../../../packages/ai/src/index.ts";
import { APIError } from "openai";
import { sha256Hex } from "../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { marketingActions } from "../src/modules/marketing/actions.ts";
import { ART_NEGATIVES } from "../src/modules/marketing/creative/art-direction.ts";
import {
  attachCreative,
  produceCreative,
  recomposeCreative,
  regenerateCreativeArt,
} from "../src/modules/marketing/creative/pipeline.ts";
import {
  CREATIVES,
  findCreative,
  type CreativeRecord,
} from "../src/modules/marketing/creative/store.ts";
import { visionReviewCreative } from "../src/modules/marketing/creative/vision-review.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import { createPackageProject, IMAGE_MAX } from "./support/package-project.ts";

// Nothing in this file may reach a real provider: every paid call takes an
// injected provider, and the real entry points refuse.
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

/** A Postiz channel id no connector knows: no channel rules, so the square format. */
const UNRULED = "unruled-art-int";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const CONFIRM = {
  confirmMaximumCostMicros: IMAGE_MAX,
  confirmPromptMayBeSentToProvider: true as const,
};
const REVIEW_COST = 1234;
const passing = {
  scores: {
    subject: 4,
    balance: 4,
    legibility: 5,
    brandFit: 4,
    messageFit: 4,
    channelFit: 4,
    value: 3,
  },
  issues: [],
};
const failing = {
  scores: { ...passing.scores, legibility: 2 },
  issues: [
    { kind: "layout", note: "The subline sits on a busy part of the art." },
  ],
};

describe.skipIf(!enabled)(
  "Creative Studio: paid art and the vision review",
  () => {
    type Project = Awaited<ReturnType<typeof createPackageProject>>;
    type Asset = { id: string; version: number };
    let p: Project;
    let artPng: Buffer;
    const flag = process.env.ORBIT_CREATIVE_STUDIO;
    const assets = {} as Record<"logo" | "art", Asset>;

    const runIn = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(p.owner.workspaceId, p.owner.projectId, work);
    /** An approved raster asset, stored as the upload route stores one. */
    const addAsset = (type: string, bytes: Buffer) =>
      runIn(async (tx) => {
        const row = await create(tx, p.owner, "assets", {
          name: `Synthetic ${type}`,
          type,
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
        return { id: row.id, version: row.version };
      });
    /** The owner's asset status action (rights and provider use). */
    const setStatus = (
      id: string,
      input: { assetStatus: "approved" | "reference"; providerUse?: boolean },
    ) =>
      runIn(async (tx) => {
        const handler = marketingActions["asset-status"]!;
        if (handler.transaction !== "shared")
          throw new Error("SHARED_EXPECTED");
        const row = await entity(tx, p.owner, "assets", id);
        return handler.run(tx, {
          scope: p.owner,
          input: {
            assetId: id,
            version: row.version,
            ...input,
            ...(input.assetStatus === "approved"
              ? { confirmUsageRights: true }
              : {}),
          },
          config: {} as any,
          auth: {} as any,
        });
      });
    /** Stores the Lumora Home profile with `creative` brand kit settings. */
    const saveProfile = (creative: Record<string, unknown> = {}) =>
      runIn(async (tx) => {
        const profile = lumoraProfile({
          logoAssetId: assets.logo.id,
          creative,
        });
        await tx.projectMarketingProfile.updateMany({
          where: {
            workspaceId: p.owner.workspaceId,
            projectId: p.owner.projectId,
          },
          data: { data: profile as any, version: { increment: 1 } },
        });
      });
    const newContent = () =>
      runIn(async (tx) => {
        const mission = await create(tx, p.owner, "missions", {
          title: "Autumn evenings",
          status: "active",
          targetAction: "Shop the collection",
        });
        const evidence = await create(tx, p.owner, "evidence", {
          status: "ready",
          purpose: "public",
          facts: [],
          items: [],
        });
        return create(tx, p.owner, "content", {
          title: "Evenings feel softer",
          body: "Evenings feel softer in warm light. Shop the collection.",
          type: "social",
          channel: UNRULED,
          status: "reviewed",
          missionId: mission.id,
          evidenceId: evidence.id,
          claims: [],
        });
      });
    /** A creative from the approved art: free, by the editor. */
    const produceFree = async () =>
      produceCreative(p.editor, {
        contentId: (await newContent()).id,
        template: "lifestyle",
        copy: COPY,
        artAssetId: assets.art.id,
      });
    const imageProvider = () =>
      vi.fn(async (request: Parameters<typeof generateImage>[0]) => ({
        bytes: artPng,
        model: "gpt-image-2.5-flare",
        size: request.size,
        quality: request.quality,
        background: request.background,
        usage: null,
      })) as unknown as typeof generateImage & ReturnType<typeof vi.fn>;
    const answering = (answer: unknown) =>
      vi.fn(async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(answer) }],
          },
        ],
        usage: {
          model: "synthetic-model",
          inputTokens: 1200,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 180,
          reasoningTokens: 0,
          costMicros: REVIEW_COST,
        },
        responseId: "synthetic-response",
        truncated: false,
      })) as unknown as typeof respond & ReturnType<typeof vi.fn>;
    const reservations = (prefix: string) =>
      runIn((tx) =>
        tx.budgetReservation.findMany({
          where: {
            projectId: p.owner.projectId,
            key: { startsWith: `${p.owner.projectId}:${prefix}` },
          },
        }),
      );
    const record = (id: string) =>
      runIn(async (tx) => {
        const row = await findCreative(tx, p.owner, id);
        return { version: row.version, ...(data(row) as CreativeRecord) };
      });
    const setDailyBudget = (dailyBudgetMicros: number) =>
      runIn(async (tx) => {
        const [policy] = await list(tx, p.owner, "policies");
        await update(tx, p.owner, policy!, {
          ...data(policy),
          dailyBudgetMicros,
        });
      });

    beforeAll(async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      p = await createPackageProject();
      const lumora = await demoBrand("lumora");
      artPng = (await fixtureArt("good", "lumora")).bytes;
      assets.logo = await addAsset("logo", lumora.logos[0]!.bytes);
      assets.art = await addAsset("photo", artPng);
      await saveProfile();
    });
    afterAll(async () => {
      if (flag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
      else process.env.ORBIT_CREATIVE_STUDIO = flag;
      await p?.cleanup();
      await closeDatabase();
    });

    it("regenerate needs the owner", async () => {
      const creative = await produceFree();
      const generate = imageProvider();
      await expect(
        regenerateCreativeArt(p.editor, creative.id, CONFIRM, { generate }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      // New art for a new creative is the owner's decision, too.
      await expect(
        produceCreative(
          p.editor,
          {
            contentId: (await newContent()).id,
            template: "lifestyle",
            copy: COPY,
            generateArt: CONFIRM,
          },
          { generate },
        ),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      expect(generate).not.toHaveBeenCalled();
    });

    it("regenerate needs the exact ceiling", async () => {
      const creative = await produceFree();
      const generate = imageProvider();
      const before = await reservations("image:");
      await expect(
        regenerateCreativeArt(
          p.owner,
          creative.id,
          { ...CONFIRM, confirmMaximumCostMicros: IMAGE_MAX - 1 },
          { generate },
        ),
      ).rejects.toMatchObject({
        code: "IMAGE_COST_CONFIRMATION_STALE",
        status: 409,
      });
      expect(generate).not.toHaveBeenCalled();
      expect(await reservations("image:")).toHaveLength(before.length);
      expect((await record(creative.id)).version).toBe(creative.version);
    });

    it("regeneration is bounded", async () => {
      const creative = await produceFree();
      const generate = imageProvider();
      const before = (await reservations("image:")).length;
      const regenerated = await regenerateCreativeArt(
        p.owner,
        creative.id,
        { ...CONFIRM, correction: { kind: "subject_larger" } },
        { generate },
      );
      expect(generate).toHaveBeenCalledTimes(1);
      // The correction reached the image model's prompt.
      const request = generate.mock.calls[0]![0] as {
        prompt: string;
        size: string;
      };
      expect(request.prompt).toContain("make the main subject larger");
      expect(request.prompt).toContain(ART_NEGATIVES);
      expect(IMAGE_SIZES).toContain(request.size);
      expect(regenerated.components.artAssetId).not.toBe(assets.art.id);
      expect(regenerated.status).toBe("needs_rights");
      const art = regenerated.corrections.filter((c) => c.kind === "art");
      expect(art).toEqual([
        expect.objectContaining({
          kind: "art",
          reason: "subject_larger",
          costMicros: IMAGE_MAX,
          assetId: regenerated.components.artAssetId,
        }),
      ]);
      expect(regenerated.cost).toMatchObject({
        settledMicros: IMAGE_MAX,
        unknownMicros: 0,
      });
      expect(regenerated.cost.reservationIds).toHaveLength(1);
      const images = await reservations("image:");
      expect(images).toHaveLength(before + 1);
      // maxArtCorrections defaults to 1: no second paid attempt.
      await expect(
        regenerateCreativeArt(p.owner, creative.id, CONFIRM, { generate }),
      ).rejects.toMatchObject({ code: "ART_CORRECTION_LIMIT", status: 409 });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await reservations("image:")).toHaveLength(before + 1);
    });

    it("budget stop happens before the provider", async () => {
      const creative = await produceFree();
      const generate = imageProvider();
      const before = (await reservations("image:")).length;
      const creatives = (await runIn((tx) => list(tx, p.owner, CREATIVES)))
        .length;
      await setDailyBudget(0);
      try {
        await expect(
          regenerateCreativeArt(p.owner, creative.id, CONFIRM, { generate }),
        ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
        await expect(
          produceCreative(
            p.owner,
            {
              contentId: (await newContent()).id,
              template: "lifestyle",
              copy: COPY,
              generateArt: CONFIRM,
            },
            { generate },
          ),
        ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
      } finally {
        await setDailyBudget(10_000_000);
      }
      expect(generate).not.toHaveBeenCalled();
      expect(await reservations("image:")).toHaveLength(before);
      // The refused attempt does not count against the correction limit.
      const after = await record(creative.id);
      expect(after.version).toBe(creative.version);
      expect(after.corrections.filter((c) => c.kind === "art")).toEqual([]);
      expect((await runIn((tx) => list(tx, p.owner, CREATIVES))).length).toBe(
        creatives,
      );
    });

    it("new art waits for rights", async () => {
      const generate = imageProvider();
      const content = await newContent();
      const creative = await produceCreative(
        p.owner,
        {
          contentId: content.id,
          template: "lifestyle",
          copy: COPY,
          generateArt: CONFIRM,
        },
        { generate },
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(creative.status).toBe("needs_rights");
      expect(creative.cost).toMatchObject({
        settledMicros: IMAGE_MAX,
        unknownMicros: 0,
      });
      expect(creative.cost.reservationIds).toHaveLength(1);
      const artId = creative.components.artAssetId!;
      const art = await runIn(async (tx) =>
        data(await entity(tx, p.owner, "assets", artId)),
      );
      expect(art).toMatchObject({
        type: "generated_artwork",
        usageApproved: false,
        assetStatus: "reference",
        validUses: ["social"],
      });
      for (const rendition of creative.renditions) {
        const stored = await runIn(async (tx) =>
          data(await entity(tx, p.owner, "assets", rendition.assetId)),
        );
        expect(stored).toMatchObject({
          usageApproved: false,
          assetStatus: "reference",
          boundTo: { creativeId: creative.id, contentId: content.id },
        });
      }
      // Nothing is attached before the owner decides on the art's rights.
      for (const input of [{}, { acceptQaFindings: true as const }])
        await expect(
          attachCreative(p.owner, creative.id, input),
        ).rejects.toMatchObject({
          code: "CREATIVE_RIGHTS_REQUIRED",
          status: 409,
        });
      // A recomposition before that decision still waits for it.
      const waiting = await recomposeCreative(p.editor, creative.id, {
        options: { textScale: "s" },
      });
      expect(waiting.status).toBe("needs_rights");

      await setStatus(artId, { assetStatus: "approved" });
      const recomposed = await recomposeCreative(p.editor, creative.id, {});
      expect(recomposed.status).toBe("composed");
      const stored = await runIn(async (tx) =>
        data(
          await entity(
            tx,
            p.owner,
            "assets",
            recomposed.renditions[0]!.assetId,
          ),
        ),
      );
      expect(stored).toMatchObject({
        usageApproved: true,
        assetStatus: "approved",
      });
      await expect(attachCreative(p.editor, creative.id, {})).resolves.toEqual({
        contentId: content.id,
        assetId: recomposed.renditions[0]!.assetId,
      });
    });

    it("vision review is off by default", async () => {
      const creative = await produceFree();
      const review = answering(passing);
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({ code: "VISION_REVIEW_DISABLED", status: 409 });
      await saveProfile({ visualReview: true });
      // The logo and art may not be sent to a provider yet.
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({ code: "PROVIDER_USE_REQUIRED", status: 409 });
      await setStatus(assets.logo.id, {
        assetStatus: "approved",
        providerUse: true,
      });
      // The art still lacks provider use.
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({ code: "PROVIDER_USE_REQUIRED", status: 409 });
      await expect(
        visionReviewCreative(p.editor, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      expect(review).not.toHaveBeenCalled();
      expect(await reservations("creative-review:")).toEqual([]);
    });

    it("vision review settles and stores the verdict", async () => {
      await saveProfile({ visualReview: true });
      await setStatus(assets.logo.id, {
        assetStatus: "approved",
        providerUse: true,
      });
      await setStatus(assets.art.id, {
        assetStatus: "approved",
        providerUse: true,
      });

      const good = await produceFree();
      expect(good.status).toBe("composed");
      const pass = answering(passing);
      const passed = await visionReviewCreative(
        p.owner,
        good.id,
        {},
        {
          respond: pass,
        },
      );
      expect(passed.status).toBe("composed");
      expect(passed.qa.vision).toMatchObject({ ...passing, verdict: "pass" });

      const creative = await produceFree();
      const review = answering(failing);
      const reviewed = await visionReviewCreative(
        p.owner,
        creative.id,
        {},
        {
          respond: review,
        },
      );
      expect(review).toHaveBeenCalledTimes(1);
      // The finished rendition goes to the model as an image.
      const call = review.mock.calls[0]![0] as any;
      const image = call.input[0].content.find(
        (part: any) => part.type === "input_image",
      );
      const rendition = await runIn(async (tx) =>
        data(
          await entity(tx, p.owner, "assets", creative.renditions[0]!.assetId),
        ),
      );
      expect(image.image_url).toBe(`data:image/png;base64,${rendition.base64}`);
      expect(call.tools).toEqual([]);
      expect(call.route.maxOutputTokens).toBe(1500);

      expect(reviewed.status).toBe("needs_owner");
      expect(reviewed.qa.verdict).toBe("needs_owner");
      expect(reviewed.qa.vision).toMatchObject({
        ...failing,
        verdict: "needs_correction",
      });
      const [reservation] = await reservations(
        `creative-review:${creative.id}:`,
      );
      expect(reservation).toMatchObject({
        // Keyed on the rendition reviewed (R50).
        key: `${p.owner.projectId}:creative-review:${creative.id}:${creative.renditions[0]!.sha256}`,
        category: "creative_review",
        state: "settled",
        settledMicros: BigInt(REVIEW_COST),
        taskClass: "creative_review",
      });
      expect(reviewed.cost).toMatchObject({ settledMicros: REVIEW_COST });
      expect(reviewed.cost.reservationIds).toEqual([reservation!.id]);
    });

    it("an unknown vision outcome stays counted", async () => {
      await saveProfile({ visualReview: true });
      await setStatus(assets.logo.id, {
        assetStatus: "approved",
        providerUse: true,
      });
      await setStatus(assets.art.id, {
        assetStatus: "approved",
        providerUse: true,
      });
      const creative = await produceFree();
      const review = vi.fn(async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof respond & ReturnType<typeof vi.fn>;
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({ code: "VISION_REVIEW_OUTCOME_UNKNOWN" });
      const [reservation] = await reservations(
        `creative-review:${creative.id}:`,
      );
      expect(reservation).toMatchObject({
        state: "unknown",
        settledMicros: null,
      });
      const after = await record(creative.id);
      expect(after.version).toBe(creative.version);
      expect(after.qa.vision).toBeUndefined();
      // The same rendition is never sent again.
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({
        code: "RESERVATION_ALREADY_USED",
        status: 409,
      });
      expect(review).toHaveBeenCalledTimes(1);
    });

    /** Turns the review on and lets the logo and art go to a provider. */
    const reviewReady = async () => {
      await saveProfile({ visualReview: true });
      for (const id of [assets.logo.id, assets.art.id])
        await setStatus(id, { assetStatus: "approved", providerUse: true });
    };
    const reviewWith = (id: string, answer: unknown) =>
      visionReviewCreative(p.owner, id, {}, { respond: answering(answer) });

    it("a failing vision verdict survives a free recompose (R49)", async () => {
      await reviewReady();
      const creative = await produceFree();
      const failed = await reviewWith(creative.id, failing);
      expect(failed.status).toBe("needs_owner");
      // The same pixels again, and another layout: still the owner's call.
      const same = await recomposeCreative(p.editor, creative.id, {});
      expect(same.renditions[0]!.sha256).toBe(failed.renditions[0]!.sha256);
      const moved = await recomposeCreative(p.editor, creative.id, {
        variant: "text_top",
      });
      for (const view of [same, moved]) {
        expect(view.status).toBe("needs_owner");
        expect(view.qa.verdict).toBe("needs_owner");
        expect(view.qa.vision).toMatchObject({ verdict: "needs_correction" });
      }
      await expect(
        attachCreative(p.editor, creative.id, {}),
      ).rejects.toMatchObject({ code: "CREATIVE_QA_FAILED", status: 409 });
      await expect(
        attachCreative(p.editor, creative.id, { acceptQaFindings: true }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      await expect(
        attachCreative(p.owner, creative.id, { acceptQaFindings: true }),
      ).resolves.toMatchObject({ assetId: moved.renditions[0]!.assetId });
    });

    it("a passing review of the new rendition clears the vision finding (R49)", async () => {
      await reviewReady();
      const creative = await produceFree();
      expect(creative.qa.verdict).toBe("pass");
      await reviewWith(creative.id, failing);
      const moved = await recomposeCreative(p.editor, creative.id, {
        variant: "text_top",
      });
      expect(moved.status).toBe("needs_owner");
      const passed = await reviewWith(creative.id, passing);
      expect(passed.status).toBe("composed");
      expect(passed.qa.verdict).toBe(moved.qa.vision!.compositionVerdict);
      expect(passed.qa.verdict).not.toBe("needs_owner");
      await expect(attachCreative(p.editor, creative.id, {})).resolves.toEqual(
        expect.objectContaining({ assetId: moved.renditions[0]!.assetId }),
      );
    });

    it("an attached creative stays attached with a failing verdict (R5a)", async () => {
      await reviewReady();
      const creative = await produceFree();
      await attachCreative(p.editor, creative.id, {});
      const reviewed = await reviewWith(creative.id, failing);
      expect(reviewed.status).toBe("attached");
      expect(reviewed.qa.verdict).toBe("needs_owner");
    });

    it("a second review of the same rendition is free (R50)", async () => {
      await reviewReady();
      const creative = await produceFree();
      const first = await reviewWith(creative.id, failing);
      const again = answering(passing);
      const second = await visionReviewCreative(
        p.owner,
        creative.id,
        {},
        { respond: again },
      );
      expect(again).not.toHaveBeenCalled();
      expect(second.qa.vision).toEqual(first.qa.vision);
      expect(second.version).toBe(first.version);
      expect(
        await reservations(`creative-review:${creative.id}:`),
      ).toHaveLength(1);
    });

    it("a refused review request costs nothing", async () => {
      await reviewReady();
      const creative = await produceFree();
      const review = vi.fn(async () => {
        throw new APIError(400, { message: "bad image" }, "bad", undefined);
      }) as unknown as typeof respond & ReturnType<typeof vi.fn>;
      await expect(
        visionReviewCreative(p.owner, creative.id, {}, { respond: review }),
      ).rejects.toMatchObject({
        code: "MODEL_REQUEST_NOT_ACCEPTED",
        status: 502,
      });
      const [reservation] = await reservations(
        `creative-review:${creative.id}:`,
      );
      expect(reservation).toMatchObject({
        state: "settled",
        settledMicros: BigInt(0),
      });
      expect((await record(creative.id)).version).toBe(creative.version);
    });

    it("an invalid review answer is paid for and refused", async () => {
      await reviewReady();
      const creative = await produceFree();
      await expect(
        reviewWith(creative.id, { scores: { subject: 9 }, issues: [] }),
      ).rejects.toMatchObject({
        code: "VISION_REVIEW_OUTPUT_INVALID",
        status: 502,
      });
      const [reservation] = await reservations(
        `creative-review:${creative.id}:`,
      );
      expect(reservation).toMatchObject({
        state: "settled",
        settledMicros: BigInt(REVIEW_COST),
      });
      const after = await record(creative.id);
      expect(after.cost).toMatchObject({
        settledMicros: REVIEW_COST,
        reservationIds: [reservation!.id],
      });
      expect(after.qa.vision).toBeUndefined();
      expect(after.status).toBe("composed");
    });
  },
);
