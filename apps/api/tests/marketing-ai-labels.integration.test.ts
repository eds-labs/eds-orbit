import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeDatabase,
  db,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { generateImage } from "../../../packages/ai/src/index.ts";
import {
  readImageProvenance,
  sha256Hex,
  verifyAiLabel,
  type RelBox,
} from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import {
  imageProvenance,
  labelFinalImage,
} from "../src/platform/provenance/image-provenance.ts";
import { generateProjectImage } from "../src/modules/marketing/brand/image-generation.ts";
import { renderProjectAsset } from "../src/modules/marketing/brand/render-asset.ts";
import {
  assetAiOrigin,
  ensureLabeledAsset,
} from "../src/modules/marketing/brand/ai-labels.ts";
import { produceCreative } from "../src/modules/marketing/creative/pipeline.ts";
import { attachRunImage } from "../src/modules/marketing/agents/specialists/visual.ts";
import { attachPackageImage } from "../src/modules/marketing/agents/package-image.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/marketing/agents/content-packages.ts";
import { preflight } from "../src/modules/marketing/policy/policy.ts";
import { exportAssetContent } from "../src/modules/marketing/pipeline/content-export.ts";
import { sendDraftHandoff } from "../src/modules/marketing/publishing/postiz-draft.ts";
import { preparePostizVerification } from "../src/modules/marketing/publishing/postiz-verification.ts";
import { createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { runImageJob } from "../src/modules/image-requests.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

// Nothing in this file may reach a real provider.
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

// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(
  new URL("../../../packages/creative/package.json", import.meta.url),
)("sharp") as Sharp;

/** A channel id no connector knows: no channel rules, so the square format. */
const UNRULED = "unruled-ai-label-int";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};

/** A PNG with an embedded C2PA manifest store (a `caBX` chunk) naming an AI source. */
function withC2pa(png: Buffer) {
  const type = Buffer.from("caBX", "latin1");
  const payload = Buffer.from(
    "jumbc2pa synthetic manifest store trainedAlgorithmicMedia",
    "latin1",
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0);
  const iend = png.length - 12;
  return Buffer.concat([
    png.subarray(0, iend),
    length,
    type,
    payload,
    crc,
    png.subarray(iend),
  ]);
}

/** Pixels that differ between two equally sized images outside a box (with a small margin). */
async function differingOutside(a: Buffer, b: Buffer, box: RelBox) {
  const [ra, rb] = await Promise.all(
    [a, b].map((bytes) =>
      sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  const { width, height } = ra!.info;
  expect(rb!.info).toMatchObject({ width, height });
  const x0 = Math.floor(box.x * width) - 2;
  const y0 = Math.floor(box.y * height) - 2;
  const x1 = Math.ceil((box.x + box.w) * width) + 2;
  const y1 = Math.ceil((box.y + box.h) * height) + 2;
  let differing = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = (y * width + x) * 4;
      if (
        ra!.data[i] !== rb!.data[i] ||
        ra!.data[i + 1] !== rb!.data[i + 1] ||
        ra!.data[i + 2] !== rb!.data[i + 2] ||
        ra!.data[i + 3] !== rb!.data[i + 3]
      )
        differing++;
    }
  return differing;
}

// ADR 0028 in Marketing: labels at creation, the derivative of raw art on a
// post, and the gate on every outbound path.
describe.skipIf(!enabled)("Marketing AI image labels (ADR 0028)", () => {
  type Project = Awaited<ReturnType<typeof createPackageProject>>;
  let p: Project;
  let artPng: Buffer;
  /** Distinct bytes (the central record follows the exact bytes): a slightly brighter art. */
  const variant = (step: number) =>
    sharp(artPng)
      .modulate({ brightness: 1 + step * 0.02 })
      .png()
      .toBuffer();
  const saved = {
    labels: process.env.ORBIT_AI_IMAGE_LABELS,
    studio: process.env.ORBIT_CREATIVE_STUDIO,
    packages: process.env.ORBIT_CONTENT_PACKAGES,
  };
  const ids = {} as Record<"logo" | "aiArt" | "upload", string>;
  const setLabels = (on: boolean) => {
    process.env.ORBIT_AI_IMAGE_LABELS = on ? "true" : "false";
  };
  const runIn = <T>(work: (tx: DbTx) => Promise<T>, project = p) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const asset = (id: string, project = p) =>
    runIn((tx) => entity(tx, project.owner, "assets", id), project);
  const bytesOf = (row: { data: unknown }) =>
    Buffer.from(String(data(row).base64), "base64");
  /** An approved raster asset; `extra` marks it, e.g. as Orbit's generated art. */
  const addAsset = (
    type: string,
    bytes: Buffer,
    extra: Record<string, unknown> = {},
    project = p,
  ) =>
    runIn(async (tx) => {
      const row = await create(tx, project.owner, "assets", {
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
        ...extra,
      });
      return row.id;
    }, project);
  /** Orbit's generated artwork as stored before ADR 0028 (no provenance fields). */
  const legacyAiArt = (extra: Record<string, unknown> = {}, project = p) =>
    addAsset(
      "generated_artwork",
      artPng,
      {
        source: "OpenAI Images API",
        provider: "openai",
        license: "AI-generated asset; owner rights and brand review required",
        ...extra,
      },
      project,
    );
  const newContent = (fields: Record<string, unknown> = {}, project = p) =>
    runIn(async (tx) => {
      const evidence = await create(tx, project.owner, "evidence", {
        status: "ready",
        purpose: "public",
        facts: [],
        items: [],
      });
      return create(tx, project.owner, "content", {
        title: "Evenings feel softer",
        body: `Evenings feel softer in warm light ${randomUUID()}.`,
        type: "social",
        channel: UNRULED,
        status: "reviewed",
        evidenceId: evidence.id,
        claims: [],
        ...fields,
      });
    }, project);
  const produceWithArt = async (artAssetId: string) => {
    const mission = await runIn((tx) =>
      create(tx, p.owner, "missions", {
        title: "Autumn evenings",
        status: "active",
        targetAction: "Shop the collection",
      }),
    );
    return produceCreative(p.editor, {
      contentId: (await newContent({ missionId: mission.id })).id,
      template: "lifestyle",
      copy: COPY,
      artAssetId,
    });
  };
  const blockersOf = async (contentId: string) =>
    (await runIn((tx) => preflight(tx, p.owner, contentId, { test: true })))
      .blockers;

  beforeAll(async () => {
    process.env.ORBIT_CREATIVE_STUDIO = "true";
    p = await createPackageProject({ name: "Synthetic AI labels" });
    const lumora = await demoBrand("lumora");
    artPng = (await fixtureArt("good", "lumora")).bytes;
    ids.logo = await addAsset("logo", lumora.logos[0]!.bytes);
    // An upload with its own bytes: never recorded as AI.
    ids.upload = await addAsset(
      "photo",
      await sharp(artPng).flop().png().toBuffer(),
    );
    ids.aiArt = await legacyAiArt();
    await runIn(async (tx) => {
      await tx.projectMarketingProfile.updateMany({
        where: {
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
        },
        data: {
          data: lumoraProfile({ logoAssetId: ids.logo }) as any,
          version: { increment: 1 },
        },
      });
    });
  });
  afterEach(() => {
    for (const [key, value] of [
      ["ORBIT_AI_IMAGE_LABELS", saved.labels],
      ["ORBIT_CONTENT_PACKAGES", saved.packages],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    process.env.ORBIT_CREATIVE_STUDIO = "true";
  });
  afterAll(async () => {
    if (saved.studio === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
    else process.env.ORBIT_CREATIVE_STUDIO = saved.studio;
    await p?.cleanup();
    await closeDatabase();
  });

  it("decides which assets are AI images, also those stored before ADR 0028", async () => {
    await runIn(async (tx) => {
      const origin = (id: string) =>
        entity(tx, p.owner, "assets", id).then((row) =>
          assetAiOrigin(tx, p.owner, data(row)),
        );
      expect(await origin(ids.aiArt)).toBe("ai_generated");
      expect(await origin(ids.upload)).toBeNull();
      expect(await origin(ids.logo)).toBeNull();
      expect(
        await assetAiOrigin(tx, p.owner, {
          provider: "openai",
          referenceCount: 2,
        }),
      ).toBe("ai_substantially_modified");
      // A creative over AI art and a banner over an AI background are composites.
      expect(
        await assetAiOrigin(tx, p.owner, {
          rightsSource: { components: [{ role: "art", assetId: ids.aiArt }] },
        }),
      ).toBe("ai_generated");
      expect(
        await assetAiOrigin(tx, p.owner, {
          rightsSource: { components: [{ role: "art", assetId: ids.upload }] },
        }),
      ).toBeNull();
      expect(
        await assetAiOrigin(tx, p.owner, { visualAssetId: ids.aiArt }),
      ).toBe("ai_generated");
    });
  });

  it("records raw generated art as unlabeled source and keeps the provider's C2PA manifest", async () => {
    setLabels(true);
    const generatedPng = await variant(1);
    const provider = vi.fn(
      async (request: Parameters<typeof generateImage>[0]) => ({
        bytes: withC2pa(generatedPng),
        model: IMAGE_MODEL,
        size: request.size,
        quality: request.quality,
        background: request.background,
        usage: null,
      }),
    ) as unknown as typeof generateImage;
    const generated = await generateProjectImage(
      p.owner,
      {
        requestId: randomUUID(),
        name: "Synthetic generated art",
        prompt: "A calm abstract artwork of soft evening light, no text.",
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        validUses: ["social"],
        confirmPromptMayBeSentToOpenAI: true,
        confirmMaximumCostMicros: IMAGE_MAX,
        saveToDrive: false,
      },
      provider,
    );
    const d = data(generated);
    expect(d.aiProvenance).toEqual({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      digitalSourceType: "trainedAlgorithmicMedia",
    });
    expect(d.aiLabel).toBeUndefined();
    const stored = bytesOf(generated);
    // Normalizing strips the manifest from the stored bytes; the record keeps it.
    expect((await readImageProvenance(stored)).c2pa).toBeNull();
    const record = await runIn((tx) => imageProvenance(tx, p.owner, d.sha256));
    expect(record).toMatchObject({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      labelBox: null,
      subjectModule: "marketing",
      subjectId: generated.id,
      embedded: { c2pa: { present: true, declaresAi: true }, declaresAi: true },
    });
    expect(record!.c2paManifest?.toString("latin1")).toContain("c2pa");

    // Off, the asset is stored exactly as before: no field, no record.
    const offPng = await variant(2);
    setLabels(false);
    const off = await generateProjectImage(
      p.owner,
      {
        requestId: randomUUID(),
        name: "Synthetic generated art off",
        prompt: "A calm abstract artwork of soft morning light, no text.",
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        validUses: ["social"],
        confirmPromptMayBeSentToOpenAI: true,
        confirmMaximumCostMicros: IMAGE_MAX,
        saveToDrive: false,
      },
      vi.fn(async () => ({
        bytes: offPng,
        model: IMAGE_MODEL,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        usage: null,
      })) as unknown as typeof generateImage,
    );
    expect(data(off)).not.toHaveProperty("aiProvenance");
    expect(
      await runIn((tx) => imageProvenance(tx, p.owner, data(off).sha256)),
    ).toBeNull();
  });

  it("labels a creative over AI art before it is stored; off it is stored exactly as composed", async () => {
    setLabels(false);
    const plain = await produceWithArt(ids.aiArt);
    setLabels(true);
    const labeled = await produceWithArt(ids.aiArt);
    expect(plain.renditions).toHaveLength(labeled.renditions.length);
    for (const [i, rendition] of labeled.renditions.entries()) {
      const before = plain.renditions[i]!;
      const row = await asset(rendition.assetId);
      const d = data(row);
      const bytes = bytesOf(row);
      // The rendition record names the stored, labelled bytes.
      expect(rendition.sha256).toBe(d.sha256);
      expect(sha256Hex(bytes)).toBe(d.sha256);
      expect(rendition.bytes).toBe(bytes.length);
      expect(d.aiLabel).toMatchObject({ text: "KI erstellt", version: 1 });
      expect(d.aiProvenance).toMatchObject({
        origin: "ai_generated",
        labelState: "labeled",
        digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
      });
      expect((await verifyAiLabel(bytes, d.aiLabel.box)).ok).toBe(true);
      const xmp = (await readImageProvenance(bytes)).xmp;
      expect(xmp.digitalSourceType).toBe(
        "compositeWithTrainedAlgorithmicMedia",
      );
      const record = await runIn((tx) =>
        imageProvenance(tx, p.owner, d.sha256),
      );
      expect(record).toMatchObject({
        origin: "ai_generated",
        labelState: "labeled",
        labelBox: d.aiLabel.box,
        // The parent is the unlabelled composition, which the flag-off run stored.
        parentSha256: before.sha256,
      });
      expect(record!.componentSha256s).toContain(sha256Hex(artPng));
      // Only the label's corner changed: logo, copy and art elsewhere are untouched.
      const plainRow = await asset(before.assetId);
      expect(
        await differingOutside(bytesOf(plainRow), bytes, d.aiLabel.box),
      ).toBe(0);
      // Off: no label, no provenance fields, the composer's exact bytes.
      const pd = data(plainRow);
      expect(pd).not.toHaveProperty("aiLabel");
      expect(pd).not.toHaveProperty("aiProvenance");
      expect(sha256Hex(bytesOf(plainRow))).toBe(before.sha256);
      expect(
        Object.keys(d).filter((k) => !["aiLabel", "aiProvenance"].includes(k)),
      ).toEqual(Object.keys(pd));
      expect(
        await runIn((tx) => imageProvenance(tx, p.owner, before.sha256)),
      ).toBeNull();
    }
  });

  it("gives a creative over uploaded art no label", async () => {
    setLabels(true);
    const creative = await produceWithArt(ids.upload);
    for (const rendition of creative.renditions) {
      const d = data(await asset(rendition.assetId));
      expect(d).not.toHaveProperty("aiLabel");
      expect(d).not.toHaveProperty("aiProvenance");
      expect(
        await runIn((tx) => imageProvenance(tx, p.owner, rendition.sha256)),
      ).toBeNull();
    }
  });

  it("labels a template render over AI art", async () => {
    setLabels(true);
    const rendered = (await renderProjectAsset(p.owner, {
      title: "Evenings feel softer",
      subtitle: "Warm light for calm rooms",
      format: "square",
      visualAssetId: ids.aiArt,
      saveToDrive: false,
    })) as { id: string };
    const row = await asset(rendered.id);
    const d = data(row);
    expect(d.aiLabel).toMatchObject({ text: "KI erstellt" });
    expect((await verifyAiLabel(bytesOf(row), d.aiLabel.box)).ok).toBe(true);
    expect(sha256Hex(bytesOf(row))).toBe(d.sha256);
  });

  it("composes from the unlabelled source of a labelled art or visual, and refuses other labelled images", async () => {
    setLabels(true);
    const sourceArt = await variant(13);
    const sourceId = await legacyAiArt({
      base64: sourceArt.toString("base64"),
      sha256: sha256Hex(sourceArt),
      bytes: sourceArt.length,
    });
    const derivative = await runIn(async (tx) =>
      ensureLabeledAsset(
        tx,
        p.owner,
        await entity(tx, p.owner, "assets", sourceId),
        p.owner.userId,
      ),
    );
    // A creative over the labelled derivative draws the source: one label only.
    const creative = await produceWithArt(derivative.id);
    for (const rendition of creative.renditions) {
      const d = data(await asset(rendition.assetId));
      const art = d.rightsSource.components.find(
        (c: { role: string }) => c.role === "art",
      );
      expect(art).toMatchObject({ assetId: sourceId, sha256: sha256Hex(sourceArt) });
      expect(d.aiLabel).toMatchObject({ text: "KI erstellt" });
      const record = await runIn((tx) => imageProvenance(tx, p.owner, d.sha256));
      expect(record!.componentSha256s).toContain(sha256Hex(sourceArt));
      expect(record!.componentSha256s).not.toContain(data(derivative).sha256);
    }
    // A template render over the derivative draws the source as well.
    const rendered = (await renderProjectAsset(p.owner, {
      title: "Evenings feel softer",
      format: "square",
      visualAssetId: derivative.id,
      saveToDrive: false,
    })) as { id: string };
    expect(data(await asset(rendered.id))).toMatchObject({ visualAssetId: sourceId });

    // A labelled image without an unlabelled source asset (here: a labelled
    // template render, and labelled bytes recorded on their own) is refused.
    const labelledBytes = (
      await runIn((tx) =>
        labelFinalImage(tx, p.owner, {
          bytes: sourceArt,
          origin: "ai_generated",
          subject: { module: "marketing", kind: "asset", id: "synthetic" },
          createdBy: p.owner.userId,
        }),
      )
    ).result;
    const orphanSource = await variant(14);
    const orphan = (
      await runIn((tx) =>
        labelFinalImage(tx, p.owner, {
          bytes: orphanSource,
          origin: "ai_generated",
          subject: { module: "marketing", kind: "asset", id: "synthetic" },
          createdBy: p.owner.userId,
        }),
      )
    ).result;
    const orphanId = await addAsset("photo", orphan.bytes);
    await expect(produceWithArt(rendered.id)).rejects.toMatchObject({
      code: "AI_LABELED_COMPONENT",
      status: 409,
    });
    await expect(produceWithArt(orphanId)).rejects.toMatchObject({
      code: "AI_LABELED_COMPONENT",
      status: 409,
    });
    await expect(
      renderProjectAsset(p.owner, {
        title: "Evenings feel softer",
        format: "square",
        visualAssetId: orphanId,
        saveToDrive: false,
      }),
    ).rejects.toMatchObject({ code: "AI_LABELED_COMPONENT", status: 409 });
    // Labelled bytes whose recorded parent is an available unlabelled asset
    // compose from that asset (the source's own labelled bytes, stored again).
    const viaRecordId = await addAsset("photo", labelledBytes.bytes);
    const viaRecord = await produceWithArt(viaRecordId);
    const drawn = data(await asset(viaRecord.renditions[0]!.assetId)).rightsSource.components.find(
      (c: { role: string }) => c.role === "art",
    );
    expect(drawn.assetId).toBe(sourceId);
    // Off, a labelled art is used as it is.
    setLabels(false);
    const off = await produceWithArt(orphanId);
    const offArt = data(await asset(off.renditions[0]!.assetId)).rightsSource.components.find(
      (c: { role: string }) => c.role === "art",
    );
    expect(offArt.assetId).toBe(orphanId);
  });

  it("puts a raw run image on drafts as one labelled derivative", async () => {
    setLabels(true);
    const runId = randomUUID();
    const rawId = await legacyAiArt({ assignmentRunId: runId });
    const drafts = await Promise.all(
      [0, 1].map(() =>
        newContent({ type: "blog", status: "draft", assignmentRunId: runId }),
      ),
    );
    const first = await runIn((tx) => attachRunImage(tx, p.owner, runId));
    expect(first.attached).toHaveLength(2);
    const derivatives = () =>
      runIn((tx) =>
        tx.entity.findMany({
          where: {
            projectId: p.owner.projectId,
            kind: "assets",
            data: { path: ["labeledFrom"], equals: rawId },
          },
        }),
      );
    const [derivative] = await derivatives();
    expect(derivative).toBeDefined();
    const d = data(derivative!);
    expect(d).toMatchObject({
      labeledFrom: rawId,
      labeledFromSha256: sha256Hex(artPng),
      usageApproved: true,
      assetStatus: "approved",
      boundTo: { labeledFrom: rawId },
      aiProvenance: { origin: "ai_generated", labelState: "labeled" },
    });
    // Run and generation lookups keep finding only the source.
    expect(d).not.toHaveProperty("assignmentRunId");
    expect((await verifyAiLabel(bytesOf(derivative!), d.aiLabel.box)).ok).toBe(
      true,
    );
    for (const draft of drafts)
      expect(
        data(await runIn((tx) => entity(tx, p.owner, "content", draft.id)))
          .assetId,
      ).toBe(derivative!.id);
    // Again: no second derivative, no second label.
    const again = await runIn((tx) => attachRunImage(tx, p.owner, runId));
    expect(again.attached).toHaveLength(2);
    expect(await derivatives()).toHaveLength(1);
    const labeledRecords = await runIn((tx) =>
      tx.imageProvenance.count({
        where: {
          projectId: p.owner.projectId,
          parentSha256: sha256Hex(artPng),
          labelState: "labeled",
        },
      }),
    );
    expect(labeledRecords).toBe(1);
    // The source itself stays as it was (ADR 0028 §5).
    expect(data(await asset(rawId))).not.toHaveProperty("aiLabel");
  });

  it("puts the package image on a draft as its labelled derivative, once", async () => {
    setLabels(true);
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    process.env.ORBIT_CREATIVE_STUDIO = "false";
    const project = await createPackageProject({
      name: "Synthetic AI label package",
    });
    try {
      const { owner } = project;
      const run = <T>(work: (tx: DbTx) => Promise<T>) => runIn(work, project);
      const thread = await createConversation(owner);
      const { package: pkg, actionRequest } = await requestContentPackage(
        owner,
        thread.id,
        {
          goal: "Announce that beta access is open",
          channels: [X, TELEGRAM],
          factKeys: ["beta.access"],
          imageBrief:
            "A calm abstract artwork of an open door made of soft light, no text.",
        },
      );
      await run((tx) =>
        decideActionRequest(tx, owner, actionRequest.id, {
          version: actionRequest.version,
          packageHash: data(actionRequest).packageHash,
          decision: "approve",
        }),
      );
      const steps = data(
        await run((tx) => entity(tx, owner, "content_packages", pkg.id)),
      ).steps as Array<Record<string, any>>;
      await run(async (tx) => {
        for (const step of steps.filter((s) => s.kind === "copy"))
          await deterministicDraft(tx, owner, step.missionId, step.jobId);
      });
      const imageRequestId = steps.find((s) => s.kind === "image")!
        .actionRequestId as string;
      const imageJob = (await run((tx) => list(tx, owner, "jobs"))).find(
        (job) => data(job).resourceId === imageRequestId,
      )!;
      const worker: Scope = { ...owner, userId: "worker", role: "owner" };
      await runImageJob(
        worker,
        owner.userId,
        imageRequestId,
        imageJob.id,
        (async () => ({
          bytes: artPng,
          model: IMAGE_MODEL,
          size: "1024x1024",
          quality: "medium",
          background: "opaque",
          usage: null,
        })) as never,
      );
      await run((tx) => sweepProject(tx, worker));
      const snapshot = () =>
        run(async (tx) =>
          packageSnapshot(
            tx,
            owner,
            await entity(tx, owner, "content_packages", pkg.id),
          ),
        );
      const imageId = (await snapshot()).image!.assetId!;
      expect(data(await asset(imageId, project)).aiProvenance).toMatchObject({
        labelState: "unlabeled_source",
      });
      await run(async (tx) => {
        const row = await entity(tx, owner, "assets", imageId);
        await update(tx, owner, row, {
          ...data(row),
          assetStatus: "approved",
          usageApproved: true,
        });
      });
      await attachPackageImage(owner, pkg.id, { deliverableKeys: [X] });
      const draft = (await snapshot()).deliverables.find((d) => d.key === X)!;
      const attachedId = draft.content!.assetId as string;
      expect(attachedId).not.toBe(imageId);
      const derivative = data(await asset(attachedId, project));
      expect(derivative).toMatchObject({ labeledFrom: imageId });
      expect(
        (
          await verifyAiLabel(
            Buffer.from(derivative.base64, "base64"),
            derivative.aiLabel.box,
          )
        ).ok,
      ).toBe(true);
      // The draft still counts as carrying the package image (shown with the studio on).
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      expect(
        (await snapshot()).deliverables.find((d) => d.key === X)!.content,
      ).toMatchObject({ carriesPackageImage: true });
      process.env.ORBIT_CREATIVE_STUDIO = "false";
      await attachPackageImage(owner, pkg.id, { deliverableKeys: [X] });
      const after = (await snapshot()).deliverables.find((d) => d.key === X)!;
      expect(after.content!.version).toBe(draft.content!.version);
      const count = await run((tx) =>
        tx.entity.count({
          where: {
            projectId: owner.projectId,
            kind: "assets",
            data: { path: ["labeledFrom"], equals: imageId },
          },
        }),
      );
      expect(count).toBe(1);
    } finally {
      await project.cleanup();
    }
  });

  it("creates one labelled derivative when two runs label the same source at once", async () => {
    setLabels(true);
    const art = await variant(11);
    const id = await legacyAiArt({
      base64: art.toString("base64"),
      sha256: sha256Hex(art),
      bytes: art.length,
    });
    // Plain transactions without the project lock that `scoped` takes, so
    // only ensureLabeledAsset's own lock keeps the two runs apart.
    const label = () =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.workspace_id',${p.owner.workspaceId},true)`;
          await tx.$executeRaw`SELECT set_config('app.project_id',${p.owner.projectId},true)`;
          return ensureLabeledAsset(
            tx,
            p.owner,
            await entity(tx, p.owner, "assets", id),
            p.owner.userId,
          );
        },
        { maxWait: 10000, timeout: 30000 },
      );
    const [first, second] = await Promise.all([label(), label()]);
    expect(first.id).toBe(second.id);
    const count = await runIn((tx) =>
      tx.entity.count({
        where: {
          projectId: p.owner.projectId,
          kind: "assets",
          data: { path: ["labeledFrom"], equals: id },
        },
      }),
    );
    expect(count).toBe(1);
  });

  it("blocks an unlabelled AI image in preflight and passes a labelled or uploaded one", async () => {
    const legacyId = await legacyAiArt();
    const legacy = await newContent({ channel: X, assetId: legacyId });
    const upload = await newContent({ channel: X, assetId: ids.upload });
    setLabels(false);
    expect(await blockersOf(legacy.id)).not.toContain("AI_LABEL_MISSING");
    setLabels(true);
    expect(await blockersOf(legacy.id)).toContain("AI_LABEL_MISSING");
    const uploadBlockers = await blockersOf(upload.id);
    expect(uploadBlockers).not.toContain("AI_LABEL_MISSING");
    expect(uploadBlockers).not.toContain("AI_LABEL_INVALID");
    const derivative = await runIn(async (tx) =>
      ensureLabeledAsset(
        tx,
        p.owner,
        await entity(tx, p.owner, "assets", legacyId),
        p.owner.userId,
      ),
    );
    const labeled = await newContent({ channel: X, assetId: derivative.id });
    const labeledBlockers = await blockersOf(labeled.id);
    expect(labeledBlockers).not.toContain("AI_LABEL_MISSING");
    expect(labeledBlockers).not.toContain("AI_LABEL_INVALID");
    expect(labeledBlockers).not.toContain("ASSET_NOT_APPROVED_OR_UNSUPPORTED");
    // A creative over AI art stored before the switch is blocked, too.
    setLabels(false);
    const old = await produceWithArt(ids.aiArt);
    setLabels(true);
    const oldPost = await newContent({
      channel: X,
      assetId: old.renditions[0]!.assetId,
    });
    expect(await blockersOf(oldPost.id)).toContain("AI_LABEL_MISSING");
    // A derivative whose source lost its approval no longer counts.
    await runIn(async (tx) => {
      const row = await entity(tx, p.owner, "assets", legacyId);
      await update(tx, p.owner, row, {
        ...data(row),
        assetStatus: "outdated",
        usageApproved: false,
      });
    });
    expect(await blockersOf(labeled.id)).toContain(
      "ASSET_NOT_APPROVED_OR_UNSUPPORTED",
    );
  });

  it("refuses to export an unlabelled AI image for publishing and keeps the audit record", async () => {
    setLabels(true);
    const legacyId = await legacyAiArt();
    const legacy = data(await asset(legacyId));
    await expect(
      exportAssetContent(p.owner, legacy, undefined, {
        publish: "marketing.postiz",
      }),
    ).rejects.toMatchObject({ code: "AI_LABEL_MISSING", status: 409 });
    const audits = await runIn((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: p.owner.projectId,
          action: "image.ai_label.blocked",
          resourceId: legacy.sha256,
        },
      }),
    );
    // Committed in the gate's own transaction although the export threw.
    expect(audits.map((row) => row.metadata)).toContainEqual(
      expect.objectContaining({
        code: "AI_LABEL_MISSING",
        context: "marketing.postiz",
      }),
    );
    // An owner-internal preview reads without the gate; off, nothing is checked.
    expect(await exportAssetContent(p.owner, legacy)).not.toBeNull();
    setLabels(false);
    expect(
      await exportAssetContent(p.owner, legacy, undefined, {
        publish: "marketing.postiz",
      }),
    ).not.toBeNull();
  });

  it("blocks in preflight without an audit record; the publish gate audits its block", async () => {
    setLabels(true);
    // Own bytes, so no other test's audit record matches.
    const art = await variant(7);
    const id = await legacyAiArt({
      base64: art.toString("base64"),
      sha256: sha256Hex(art),
      bytes: art.length,
    });
    const post = await newContent({ channel: X, assetId: id });
    const blocked = () =>
      runIn((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: p.owner.projectId,
            action: "image.ai_label.blocked",
            resourceId: sha256Hex(art),
          },
        }),
      );
    // Preflight also runs for UI previews: it informs, it does not audit.
    expect(await blockersOf(post.id)).toContain("AI_LABEL_MISSING");
    expect(await blockersOf(post.id)).toContain("AI_LABEL_MISSING");
    expect(await blocked()).toHaveLength(0);
    // The outbound gate on the same bytes keeps its audit record.
    await expect(
      exportAssetContent(p.owner, data(await asset(id)), undefined, {
        publish: "marketing.postiz",
      }),
    ).rejects.toMatchObject({ code: "AI_LABEL_MISSING", status: 409 });
    expect((await blocked()).map((row) => row.metadata)).toEqual([
      expect.objectContaining({
        code: "AI_LABEL_MISSING",
        context: "marketing.postiz",
      }),
    ]);
  });

  it("refuses a Postiz test post with an unlabelled AI image and keeps the audit record", async () => {
    setLabels(true);
    const instance = process.env.PUBLISHER_INSTANCE_ID;
    process.env.PUBLISHER_INSTANCE_ID = "synthetic-instance";
    try {
      // Own bytes, so no other test's audit record matches.
      const art = await variant(9);
      const id = await legacyAiArt({
        base64: art.toString("base64"),
        sha256: sha256Hex(art),
        bytes: art.length,
      });
      const connector = (await runIn((tx) => list(tx, p.owner, "connectors"))).find(
        (row) => data(row).provider === "postiz",
      )!;
      await expect(
        preparePostizVerification(p.owner, {
          connectorId: connector.id,
          integrationId: X,
          confirmSandboxAccount: true,
          assetId: id,
        }),
      ).rejects.toMatchObject({ code: "AI_LABEL_MISSING", status: 409 });
      const audits = await runIn((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: p.owner.projectId,
            action: "image.ai_label.blocked",
            resourceId: sha256Hex(art),
          },
        }),
      );
      // Committed in the gate's own transaction although the preparation rolled back.
      expect(audits.map((row) => row.metadata)).toEqual([
        expect.objectContaining({
          code: "AI_LABEL_MISSING",
          context: "marketing.postiz_verification",
        }),
      ]);
      expect(
        (await runIn((tx) => list(tx, p.owner, "connector_verifications"))).length,
      ).toBe(0);
    } finally {
      if (instance === undefined) delete process.env.PUBLISHER_INSTANCE_ID;
      else process.env.PUBLISHER_INSTANCE_ID = instance;
    }
  });

  it("stops a Postiz or Social handoff of an unlabelled AI image before anything is uploaded", async () => {
    setLabels(true);
    const legacyId = await legacyAiArt();
    const legacy = data(await asset(legacyId));
    const derivative = await runIn(async (tx) =>
      ensureLabeledAsset(
        tx,
        p.owner,
        await entity(tx, p.owner, "assets", legacyId),
        p.owner.userId,
      ),
    );
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
    const handoff = async (
      assetData: Record<string, any>,
      socialAccountId?: string,
    ) => {
      const content = await newContent({ channel: X });
      const row = await runIn((tx) =>
        create(tx, p.owner, "postiz_drafts", {
          contentId: content.id,
          contentVersion: content.version,
          status: "sending",
        }),
      );
      return sendDraftHandoff(
        p.owner,
        row.id,
        {
          baseUrl: "https://postiz.example.invalid",
          token: "synthetic-token",
          integrationId: X,
          identifier: "x",
          text: "Evenings feel softer.",
          asset: assetData,
          date: new Date(Date.now() + 3600000).toISOString(),
          ...(socialAccountId ? { socialAccountId } : {}),
        },
        deps,
        // Even with the image fallback, a label refusal never drops the image.
        { imageFallback: true },
      );
    };
    const refused = await handoff(legacy);
    expect(data(refused)).toMatchObject({
      status: "failed",
      error: "AI_LABEL_MISSING",
    });
    expect(uploads).toEqual([]);
    expect(posts).toEqual([]);
    const social = await handoff(legacy, randomUUID());
    expect(data(social)).toMatchObject({
      status: "failed",
      error: "AI_LABEL_MISSING",
    });
    expect(
      await runIn((tx) =>
        tx.socialPost.count({ where: { projectId: p.owner.projectId } }),
      ),
    ).toBe(0);
    // The labelled derivative goes through with its labelled bytes.
    const sent = await handoff(data(derivative));
    expect(data(sent)).toMatchObject({
      status: "accepted",
      withoutImage: false,
    });
    expect(uploads).toHaveLength(1);
    expect(sha256Hex(uploads[0]!)).toBe(data(derivative).sha256);
    expect(posts).toHaveLength(1);
  });
});
