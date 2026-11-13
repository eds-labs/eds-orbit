import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End to end (ADR 0028): the marketing agent generates art, Creative Studio
// composes the post image, the central processing labels it, the media
// library keeps it, Social sends it and the exports keep the label. Only the
// image/model provider (packages/ai) and the network (Social's fetch) are
// fakes; everything else is the real code on the test database.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  liveIndex: false,
  replies: [] as Array<(request: any) => Reply>,
  // Negative case only: drops the AI label blockers from preflight's answer.
  forcePastAiLabelPreflight: false,
}));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    generateImage: provider.generateImage,
    generateImageWithReferences: provider.generateImageWithReferences,
    respond: vi.fn(async (request: any) => {
      const next = provider.replies.shift();
      if (!next) throw new Error("NO_RECORDED_REPLY");
      const reply = next(request);
      return {
        output: reply.output,
        usage: {
          model: request.route.model,
          inputTokens: 100,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
          costMicros: reply.costMicros ?? 7,
        },
        responseId: "resp_review",
      };
    }),
  };
});
// A live post needs an evaluated live index, which is outside this file's scope.
vi.mock("../../../packages/knowledge/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/knowledge/src/index.ts")
    >();
  return {
    ...actual,
    validateActiveIndexEvaluation: async (
      ...args: Parameters<typeof actual.validateActiveIndexEvaluation>
    ) =>
      provider.liveIndex
        ? { valid: true, reasons: [] }
        : actual.validateActiveIndexEvaluation(...args),
  };
});
// The negative case forces a post past preflight to prove the gates behind
// it: only preflight's call of the label check (context
// "marketing.preflight") answers "no blocker" while forced. The outbound
// gates call the module's own check (internal binding), never this wrapper.
// (Wrapping `preflight` itself does not work: policy.ts sits in an import
// cycle with workflow.ts, which keeps the original binding.)
vi.mock("../src/modules/marketing/brand/ai-labels.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/modules/marketing/brand/ai-labels.ts")
    >();
  return {
    ...actual,
    aiLabelBlocker: async (...args: Parameters<typeof actual.aiLabelBlocker>) =>
      provider.forcePastAiLabelPreflight && args[4] === "marketing.preflight"
        ? null
        : actual.aiLabelBlocker(...args),
  };
});
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import {
  findC2pa,
  readImageProvenance,
  sha256Hex,
  verifyAiLabel,
  type RelBox,
} from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { assetBytes } from "../src/modules/assets.ts";
import {
  imageProvenance,
  labelFinalImage,
} from "../src/platform/provenance/image-provenance.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { attachRunImage } from "../src/modules/marketing/agents/specialists/visual.ts";
import { composeRunCreatives } from "../src/modules/marketing/creative/assignment.ts";
import { releaseAssignmentDraft } from "../src/modules/marketing/agents/owner-release.ts";
import {
  dispatchPublication,
  syncSocialHolds,
} from "../src/modules/marketing/publishing/publisher.ts";
import { exportContentBundle } from "../src/modules/marketing/pipeline/content-export.ts";
import { preflight } from "../src/modules/marketing/policy/policy.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { DISPATCH, dispatchJob } from "../src/modules/social/dispatch/jobs.ts";
import { mediaContent } from "../src/modules/social/media/library.ts";
import { servePublicMedia } from "../src/modules/social/media/public-url.ts";
import { forcePublishingBackend } from "./support/marketing-backend.ts";
import { addBrandKit } from "./support/package-creative.ts";
import { createPackageProject, IMAGE_MODEL } from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(
  new URL("../../../packages/creative/package.json", import.meta.url),
)("sharp") as Sharp;

const MINUTE = 60_000;
const BODY = "Beta access is open for product teams. Learn more.";
const LABEL = "KI erstellt";
const IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const PAGE_ID = "481516234200";
const IG_USER_ID = "17841400000000042";
const CREATIVE_BRIEF = {
  keyMessage: "Product teams keep their week in one calm place",
  imageKind: "scene",
  motif: "A bright, tidy desk with a ceramic mug and a notebook by a window",
  setting: "A quiet studio in soft morning light",
  template: "lifestyle",
  mood: "calm and focused",
};
const IMAGE_COPY = {
  eyebrow: "Beta access",
  headline: "Beta access is open",
  subline: "Product teams can join the beta today.",
  cta: "Join now!",
};
/** One post a day at 18:30 local, prepared at 08:00 (the FamilyPlan target). */
const DAILY_SCHEDULE = {
  rhythm: "daily",
  weekdays: [],
  times: ["18:30"],
  leadMinutes: 630,
};
/** The C2PA manifest store the fake provider embeds, like OpenAI does. */
const C2PA_PAYLOAD = Buffer.from(
  "jumbc2pa synthetic OpenAI manifest store trainedAlgorithmicMedia",
  "latin1",
);

/** A PNG with an embedded C2PA manifest store (`caBX` chunk with a correct CRC) before IEND. */
function withC2pa(png: Buffer) {
  const type = Buffer.from("caBX", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(C2PA_PAYLOAD.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, C2PA_PAYLOAD])) >>> 0);
  const iend = png.length - 12;
  return Buffer.concat([
    png.subarray(0, iend),
    length,
    type,
    C2PA_PAYLOAD,
    crc,
    png.subarray(iend),
  ]);
}

/** A recorded review answer that approves every shown draft. */
const approveAll = (request: any): Reply => ({
  output: [
    message({
      decisions: JSON.parse(request.input[0].content).drafts.map(
        (draft: Record<string, any>) => ({
          contentId: draft.contentId,
          verdict: "approve",
          reasons: [],
          revisionInstructions: null,
        }),
      ),
    }),
  ],
});

/** Tomorrow 08:00 UTC: after the run is due and before the 18:30 Berlin slot. */
const tomorrowMorning = () => {
  const today = new Date();
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + 1,
      8,
    ),
  );
};

/** The raw XMP packet of an image (empty when none). */
async function rawXmp(bytes: Buffer | Uint8Array) {
  const meta = await sharp(Buffer.from(bytes)).metadata();
  return meta.xmp ? meta.xmp.toString("utf8") : "";
}

/** The label is legible at its box and the XMP names it and the IPTC source type. */
async function expectLabelled(
  bytes: Buffer | Uint8Array,
  box: RelBox,
  where: string,
) {
  const buffer = Buffer.from(bytes);
  const check = await verifyAiLabel(buffer, box);
  expect(check.ok, `${where}: ${JSON.stringify(check)}`).toBe(true);
  const xmp = await rawXmp(buffer);
  expect(xmp, where).toContain(`orbit:aiLabel="${LABEL}"`);
  expect(xmp, where).toMatch(
    /Iptc4xmpExt:DigitalSourceType="http:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/(compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia)"/,
  );
  const read = await readImageProvenance(buffer);
  expect(read.xmp.label?.text, where).toBe(LABEL);
  expect(read.declaresAi, where).toBe(true);
  return read;
}

/**
 * A FamilyPlan-like project on the Social backend: a Facebook Page and an
 * Instagram account connected natively (`social:<accountId>` channels, with
 * credentials in the vault so delivery is real), policy `assisted`, the
 * Lumora brand kit with automatic creatives, and a daily assignment at 18:30
 * with one generated art per run, delivery `publish`, approval `human_each`.
 */
async function dailyProject() {
  const project = await createPackageProject({ name: "Synthetic AI label e2e" });
  const h = assignmentRun(project, tomorrowMorning());
  const { owner } = project;
  await h.run((tx) =>
    tx.projectModule.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        moduleId: "social",
        enabled: true,
        moduleVersion: "0.1.0",
        changedBy: owner.userId,
      },
    }),
  );
  const connect = async (
    platform: "facebook" | "instagram",
    externalId: string,
    handle: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { accountId } = await saveConnectedAccount(owner, {
      platform,
      externalId,
      handle,
      displayName: handle,
      secret: JSON.stringify({ pageToken: "synthetic-page-token" }),
      config: {
        metaUserId: "7",
        pageId: PAGE_ID,
        appConnectionId: randomUUID(),
        ...extra,
      },
    });
    await h.run((tx) =>
      tx.socialAccount.update({
        where: { id: accountId },
        data: { capability: "write_verified" },
      }),
    );
    return accountId;
  };
  const accounts = {
    facebook: await connect("facebook", PAGE_ID, "synthetic.facebook"),
    instagram: await connect("instagram", IG_USER_ID, "synthetic.instagram", {
      igUserId: IG_USER_ID,
    }),
  };
  const channels = [
    `social:${accounts.facebook}`,
    `social:${accounts.instagram}`,
  ];
  await h.setPolicy({
    mode: "assisted",
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2027-12-31T00:00:00.000Z",
    channels,
    contentTypes: ["social"],
    maxPerDay: 2,
    minIntervalMinutes: 120,
  });
  await h.run((tx) => forcePublishingBackend(tx, owner, "social"));
  await addBrandKit(project);
  const assignment = await h.makeAssignment({
    channels,
    schedule: DAILY_SCHEDULE,
    image: true,
    creative: { artPer: "run", imageKind: "auto" },
    delivery: "publish",
    approvalMode: "human_each",
  });
  const contents = async () =>
    (await h.rows("content")).sort(
      (a, b) => channels.indexOf(a.channel) - channels.indexOf(b.channel),
    );
  /** Plans the run, then the copywriters and the visual step write texts and art (the marketing agent). */
  const drafted = async () => {
    const planned = await h.planWithBriefs((slots) =>
      slots.map((slot) => h.brief(slot, { creative: CREATIVE_BRIEF })),
    );
    for (const role of ["copywriter", "visual"])
      for (const step of (await h.rows("agent_tasks")).filter(
        (t) => t.role === role,
      ))
        await runAgentTask(h.worker(), step.id);
    return planned;
  };
  const reviewed = async () => {
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), (await h.task("review")).id);
  };
  const release = (draft: Record<string, any>) =>
    h.run((tx) => releaseAssignmentDraft(tx, owner, draft.id, draft.version));
  return {
    project,
    h,
    assignment,
    accounts,
    channels,
    contents,
    drafted,
    reviewed,
    release,
  };
}

/** Live mode: the hand-off to Social and the delivery are real (a test publication never reaches a platform). */
function liveSocialEnv() {
  vi.stubEnv("EXECUTION_MODE", "live");
  vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
  vi.stubEnv("ORBIT_SOCIAL_PLATFORMS", "facebook,instagram");
  vi.stubEnv("ORBIT_FILES", "true");
  vi.stubEnv("FILES_BACKEND", "database");
  vi.stubEnv("FILES_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  // Instagram fetches media by a signed public URL.
  vi.stubEnv("ORBIT_SOCIAL_MEDIA_PUBLIC", "true");
  vi.stubEnv("ORBIT_PUBLIC_INGRESS", "true");
  provider.liveIndex = true;
}

describe.skipIf(!enabled)("AI image label end to end (ADR 0028)", () => {
  let daily: Awaited<ReturnType<typeof dailyProject>> | undefined;
  type Call = {
    method: string;
    url: string;
    image?: Buffer;
    imageUrl?: string;
    served?: Buffer;
  };
  let calls: Call[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  /** A fake Meta Graph API for the Page (photos + feed) and Instagram (container flow). */
  const fakeMeta = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = String(init.method ?? "GET").toUpperCase();
    const call: Call = { method, url: u.toString() };
    calls.push(call);
    if (init.body instanceof FormData) {
      const file = [...init.body.values()].find(
        (v): v is File => typeof v !== "string",
      );
      if (file) call.image = Buffer.from(await file.arrayBuffer());
    } else if (typeof init.body === "string" && init.body) {
      const raw = init.body;
      const fields: Record<string, unknown> = raw.startsWith("{")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      if (typeof fields.image_url === "string") call.imageUrl = fields.image_url;
    }
    const imageUrl = call.imageUrl ?? u.searchParams.get("image_url");
    if (imageUrl) {
      // Instagram fetches the image by its public URL, as the platform would.
      call.imageUrl = imageUrl;
      const served = await servePublicMedia(imageUrl.split("/").pop()!);
      call.served = Buffer.from(served.bytes);
    }
    const path = u.pathname;
    if (path.endsWith(`/${PAGE_ID}/photos`)) return json({ id: "photo-1" });
    if (path.endsWith(`/${PAGE_ID}/feed`))
      return json({ id: `${PAGE_ID}_1`, permalink_url: "https://www.facebook.com/p/1" });
    if (path.endsWith("/content_publishing_limit"))
      return json({
        data: [{ config: { quota_total: 50, quota_duration: 86400 }, quota_usage: 0 }],
      });
    if (method === "POST" && path.endsWith(`/${IG_USER_ID}/media`))
      return json({ id: "container-1" });
    if (method === "GET" && path.endsWith("/container-1"))
      return json({ id: "container-1", status_code: "FINISHED" });
    if (method === "POST" && path.endsWith(`/${IG_USER_ID}/media_publish`))
      return json({ id: "ig-media-1" });
    if (method === "GET" && path.endsWith("/ig-media-1"))
      return json({ id: "ig-media-1", permalink: "https://www.instagram.com/p/1/" });
    return new Response("{}", { status: 404 });
  };

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_CREATIVE_STUDIO = "true";
    process.env.ORBIT_SOCIAL = "true";
    vi.stubEnv("ORBIT_AI_IMAGE_LABELS", "true");
    provider.replies = [];
    provider.liveIndex = false;
    provider.forcePastAiLabelPreflight = false;
    calls = [];
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      const draft = generated(`${BODY} (${topic})`);
      return {
        ...draft,
        output: {
          ...draft.output,
          ...(contract.copyCraft
            ? {
                coreMessage: "Product teams keep their work in one place.",
                hook: "Beta access is open for product teams.",
              }
            : {}),
          ...(contract.creative ? { creative: IMAGE_COPY } : {}),
        },
      };
    });
    // The image provider: fixture art carrying an embedded C2PA manifest, like OpenAI's output.
    const image = async (params: any) => {
      const [width, height] = String(params.size).split("x").map(Number);
      const art = await fixtureArt("good", "lumora", {
        width: width!,
        height: height!,
      });
      return {
        bytes: withC2pa(art.bytes),
        model: IMAGE_MODEL,
        size: params.size,
        quality: "medium",
        background: "opaque",
        usage: null,
      };
    };
    provider.generateImage.mockReset().mockImplementation(image);
    provider.generateImageWithReferences.mockReset().mockImplementation(image);
    registerAgentSpecialists();
    setSocialFetchForTests(fakeMeta as never);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setSocialFetchForTests(null);
    for (const key of ["ORBIT_AGENTS", "ORBIT_CREATIVE_STUDIO", "ORBIT_SOCIAL"])
      delete process.env[key];
    provider.forcePastAiLabelPreflight = false;
    await daily?.project.cleanup();
    daily = undefined;
  });
  afterAll(() => closeDatabase());

  it("labels generated art once, keeps the label through the library, Social delivery and every export", async () => {
    liveSocialEnv();
    daily = await dailyProject();
    const { h, project, channels, accounts } = daily;
    const { owner } = project;
    const run = <T>(work: (tx: DbTx) => Promise<T>) => h.run(work);
    const record = (sha: string) => run((tx) => imageProvenance(tx, owner, sha));
    const provenanceCount = () =>
      run((tx) => tx.imageProvenance.count({ where: { projectId: owner.projectId } }));
    const assetRow = (id: string) => run((tx) => entity(tx, owner, "assets", id));

    // 1. The marketing agent generates the image (visual step of the run).
    const { runId } = await daily.drafted();
    const providerCalls =
      provider.generateImage.mock.calls.length +
      provider.generateImageWithReferences.mock.calls.length;
    expect(providerCalls).toBe(1);
    const visual = await h.task("visual");
    expect(visual.status).toBe("done");

    // 2. Orbit recognises the AI origin of the raw art and keeps the provider's C2PA manifest.
    const assets = await h.rows("assets");
    const raws = assets.filter((a) => a.creativeArt === true);
    expect(raws).toHaveLength(1);
    const raw = raws[0]!;
    expect(raw).toMatchObject({ provider: "openai", type: "generated_artwork" });
    expect(raw.aiProvenance).toEqual({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      digitalSourceType: "trainedAlgorithmicMedia",
    });
    expect(raw).not.toHaveProperty("aiLabel");
    const rawBytes = Buffer.from(String(raw.base64), "base64");
    expect(sha256Hex(rawBytes)).toBe(raw.sha256);
    // Normalizing strips the manifest from the stored art; the record keeps it.
    expect((await readImageProvenance(rawBytes)).c2pa).toBeNull();
    const rawRecord = await record(raw.sha256);
    const providerManifest = findC2pa(
      withC2pa((await fixtureArt("good", "lumora", { width: 8, height: 8 })).bytes),
    )!;
    expect(rawRecord).toMatchObject({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      labelBox: null,
      digitalSourceType: "trainedAlgorithmicMedia",
      subjectModule: "marketing",
      subjectKind: "asset",
      subjectId: raw.id,
      embedded: {
        declaresAi: true,
        c2pa: {
          present: true,
          declaresAi: true,
          sha256: providerManifest.sha256,
          size: C2PA_PAYLOAD.length,
        },
      },
    });
    expect(rawRecord!.c2paManifest?.equals(C2PA_PAYLOAD)).toBe(true);

    // 3. The central processing labelled the finished creative on each draft.
    const drafts = await daily.contents();
    expect(drafts.map((d) => d.channel)).toEqual(channels);
    const finished = new Map<string, { sha256: string; box: RelBox; bytes: Buffer }>();
    for (const draft of drafts) {
      expect(draft.assetId).toEqual(expect.any(String));
      expect(draft.assetId).not.toBe(raw.id);
      const row = await assetRow(draft.assetId);
      const d = data(row);
      expect(d.aiLabel).toMatchObject({ text: LABEL, version: 1 });
      expect(d.aiProvenance).toMatchObject({
        origin: "ai_generated",
        labelState: "labeled",
        digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
      });
      // 4 (Marketing side). The labelled asset is persisted with the labelled bytes' hash.
      const { bytes } = assetBytes(d);
      expect(sha256Hex(bytes)).toBe(d.sha256);
      const read = await expectLabelled(bytes, d.aiLabel.box, `creative ${draft.channel}`);
      expect(read.xmp.digitalSourceType).toBe("compositeWithTrainedAlgorithmicMedia");
      const labelled = await record(d.sha256);
      expect(labelled).toMatchObject({
        origin: "ai_generated",
        labelState: "labeled",
        labelVersion: 1,
        labelBox: d.aiLabel.box,
        digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
        subjectModule: "marketing",
        subjectKind: "creative",
      });
      // Linked back: parent is the unlabelled composition, the raw art is a component.
      expect(labelled!.parentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(labelled!.parentSha256).not.toBe(d.sha256);
      expect(labelled!.componentSha256s).toContain(raw.sha256);
      finished.set(draft.id, { sha256: d.sha256, box: d.aiLabel.box, bytes });
    }

    // Re-running the compose/attach steps and the labelling itself adds nothing.
    const assetCount = (await h.rows("assets")).length;
    const recordCount = await provenanceCount();
    await composeRunCreatives(h.worker(), runId);
    await run((tx) => attachRunImage(tx, h.worker(), runId));
    expect((await h.rows("assets")).length).toBe(assetCount);
    expect(await provenanceCount()).toBe(recordCount);
    for (const draft of await daily.contents()) {
      const before = drafts.find((d) => d.id === draft.id)!;
      expect(draft.assetId).toBe(before.assetId);
      const { sha256, box, bytes } = finished.get(draft.id)!;
      const labelled = (await record(sha256))!;
      const again = await run((tx) =>
        labelFinalImage(tx, owner, {
          bytes,
          origin: "ai_generated",
          composite: true,
          subject: {
            module: labelled.subjectModule,
            kind: labelled.subjectKind,
            id: labelled.subjectId,
          },
          createdBy: owner.userId,
          parentSha256: labelled.parentSha256!,
          componentSha256s: labelled.componentSha256s,
        }),
      );
      // Returned unchanged: no second label drawn, the same record.
      expect(again.result.sha256).toBe(sha256);
      expect(again.result.bytes.equals(bytes)).toBe(true);
      expect(again.result.label.box).toEqual(box);
      expect(again.provenance.id).toBe(labelled.id);
    }
    expect((await h.rows("assets")).length).toBe(assetCount);
    expect(await provenanceCount()).toBe(recordCount);

    // 5. The owner releases the reviewed drafts; at the slot Marketing hands them to Social.
    await daily.reviewed();
    const reviewed = await daily.contents();
    expect(reviewed.map((d) => d.status)).toEqual(["needs_review", "needs_review"]);
    for (const draft of reviewed) {
      const checked = await run((tx) =>
        preflight(tx, owner, draft.id, { test: false }),
      );
      expect(checked.blockers).not.toContain("AI_LABEL_MISSING");
      expect(checked.blockers).not.toContain("AI_LABEL_INVALID");
      await daily.release(draft);
    }
    const pubs = await h.rows("publications");
    expect(pubs).toHaveLength(2);
    expect(pubs.every((p) => p.test === false)).toBe(true);
    const slot = new Date(pubs[0]!.scheduledAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slot.valueOf() + MINUTE));
    for (const pub of pubs) await dispatchPublication(owner, pub.id);
    expect((await h.rows("publications")).map((p) => p.status)).toEqual([
      "scheduled_remote",
      "scheduled_remote",
    ]);

    // 4 (Social side). The Social library holds the labelled image with records for both renditions.
    const social = await run(async (tx) => ({
      media: await tx.socialPostMedia.findMany({ where: { projectId: owner.projectId } }),
      library: await tx.socialMediaAsset.findMany({ where: { projectId: owner.projectId } }),
      variants: await tx.socialPostVariant.findMany({ where: { projectId: owner.projectId } }),
      posts: await tx.socialPost.findMany({ where: { projectId: owner.projectId } }),
    }));
    expect(social.posts).toHaveLength(2);
    expect(social.media).toHaveLength(2);
    const handedOver = new Map<string, { assetId: string; box: RelBox }>();
    for (const pub of pubs) {
      const marketing = finished.get(pub.contentId)!;
      const post = social.posts.find((p) => p.originId === pub.id)!;
      expect(post).toBeDefined();
      const variant = social.variants.find((v) => v.postId === post.id)!;
      expect(variant.accountId).toBe(
        pub.channel === channels[0] ? accounts.facebook : accounts.instagram,
      );
      const medium = social.media.find((m) => m.variantId === variant.id)!;
      const asset = social.library.find((a) => a.fileId === medium.fileId)!;
      // The post references the library image of exactly that labelled original.
      expect(asset).toBeDefined();
      expect(medium.sha256).toBe(asset.sha256);
      const jpeg = await run((tx) => tx.file.findUniqueOrThrow({ where: { id: asset.jpegFileId } }));
      const [original, rendition] = [await record(asset.sha256), await record(jpeg.sha256)];
      for (const row of [original, rendition])
        expect(row).toMatchObject({
          origin: "ai_generated",
          labelState: "labeled",
          labelVersion: 1,
          labelBox: marketing.box,
          parentSha256: marketing.sha256,
          subjectModule: "social",
          subjectKind: "media",
          subjectId: asset.id,
        });
      handedOver.set(pub.id, { assetId: asset.id, box: marketing.box });
    }

    // 5 (delivery). Social's dispatch job creates the deliveries; the platforms get labelled bytes.
    const worker = h.worker();
    const dispatchJobs = (await h.rows("jobs")).filter((j) => j.topic === DISPATCH);
    expect(dispatchJobs).toHaveLength(2);
    for (const job of dispatchJobs)
      await (dispatchJob.handler as (ctx: unknown) => Promise<unknown>)({ scope: worker, job });
    const socialPubs = await run((tx) =>
      tx.socialPublication.findMany({ where: { projectId: owner.projectId } }),
    );
    expect(socialPubs).toHaveLength(2);
    for (const pub of socialPubs)
      expect(await deliverPublication(worker, pub.id)).toEqual({
        status: "succeeded",
        errorCode: null,
      });
    const delivered = await run((tx) =>
      tx.socialPublication.findMany({ where: { projectId: owner.projectId } }),
    );
    expect(delivered.map((p) => p.status)).toEqual(["published", "published"]);
    const facebookPub = pubs.find((p) => p.channel === channels[0])!;
    const instagramPub = pubs.find((p) => p.channel === channels[1])!;
    // Facebook: the multipart photo upload carries the stored Social original, labelled.
    const photo = calls.find((c) => c.url.includes(`/${PAGE_ID}/photos`))!;
    expect(photo?.image).toBeDefined();
    const fbAsset = social.library.find((a) => a.id === handedOver.get(facebookPub.id)!.assetId)!;
    expect(sha256Hex(photo.image!)).toBe(fbAsset.sha256);
    await expectLabelled(photo.image!, handedOver.get(facebookPub.id)!.box, "sent to Facebook");
    // Instagram: the container names the public media URL; the bytes it serves are labelled.
    const container = calls.find(
      (c) => c.method === "POST" && c.url.includes(`/${IG_USER_ID}/media`) && !c.url.includes("media_publish"),
    )!;
    expect(container?.served).toBeDefined();
    const igAsset = social.library.find((a) => a.id === handedOver.get(instagramPub.id)!.assetId)!;
    const igJpeg = await run((tx) => tx.file.findUniqueOrThrow({ where: { id: igAsset.jpegFileId } }));
    expect(sha256Hex(container.served!)).toBe(igJpeg.sha256);
    await expectLabelled(container.served!, handedOver.get(instagramPub.id)!.box, "public URL for Instagram");
    expect(calls.filter((c) => c.url.endsWith("/media_publish"))).toHaveLength(1);

    // 6. Exports keep the label: Social's media content route and Marketing's bundle export.
    for (const { assetId, box } of handedOver.values())
      for (const rendition of ["original", "jpeg"] as const) {
        const { bytes } = await mediaContent(owner, assetId, rendition);
        await expectLabelled(bytes, box, `Social media content ${rendition}`);
      }
    for (const draft of reviewed) {
      const { sha256, box } = finished.get(draft.id)!;
      const bundle = await exportContentBundle(owner, draft.id);
      const file = bundle.files.find((f) => f.path === "assets/creative.png")!;
      expect(file).toBeDefined();
      expect(file.sha256).toBe(sha256);
      await expectLabelled(Buffer.from(file.content, "base64"), box, "content bundle export");
    }
  }, 120_000);

  /**
   * A reviewed Facebook draft of the daily run that carries an AI image
   * stored before the flag (Orbit's generated artwork: provider openai, no
   * label, no provenance fields) instead of its labelled creative.
   */
  async function legacyDraft() {
    daily = await dailyProject();
    const { h, project, channels } = daily;
    const { owner } = project;
    await daily.drafted();
    const legacyBytes = (
      await fixtureArt("good", "lumora", { width: 1080, height: 1350 })
    ).bytes;
    const legacy = await h.run((tx) =>
      create(tx, owner, "assets", {
        name: "Synthetic legacy generated art",
        type: "generated_artwork",
        mime: "image/png",
        base64: legacyBytes.toString("base64"),
        sha256: sha256Hex(legacyBytes),
        bytes: legacyBytes.length,
        width: 1080,
        height: 1350,
        source: "OpenAI Images API",
        provider: "openai",
        license: "AI-generated asset; owner rights and brand review required",
        validUses: ["social"],
        usageApproved: true,
        assetStatus: "approved",
        providerUse: false,
        driveSyncStatus: "LOCAL_ONLY",
      }),
    );
    expect(data(legacy)).not.toHaveProperty("aiLabel");
    expect(data(legacy)).not.toHaveProperty("aiProvenance");
    const facebook = (await daily.contents()).find(
      (d) => d.channel === channels[0],
    )!;
    await h.run(async (tx) => {
      const row = await entity(tx, owner, "content", facebook.id);
      await update(tx, owner, row, { ...data(row), assetId: legacy.id });
    });
    await daily.reviewed();
    const draft = (await daily.contents()).find((d) => d.id === facebook.id)!;
    expect(draft.assetId).toBe(legacy.id);
    return { draft, legacySha: sha256Hex(legacyBytes) };
  }
  const socialCounts = () =>
    daily!.h.run(async (tx) => {
      const where = { projectId: daily!.project.owner.projectId };
      return {
        posts: await tx.socialPost.count({ where }),
        library: await tx.socialMediaAsset.count({ where }),
        publications: await tx.socialPublication.count({ where }),
      };
    });

  it("blocks a legacy unlabelled AI image at preflight and, forced past it, at the hand-off before any platform call", async () => {
    liveSocialEnv();
    const { draft, legacySha } = await legacyDraft();
    const { h, project } = daily!;
    const { owner } = project;
    // The review leaves it for the owner; preflight names the missing label.
    expect(draft.status).toBe("needs_review");
    const checked = await h.run((tx) =>
      preflight(tx, owner, draft.id, { test: false }),
    );
    expect(checked.blockers).toContain("AI_LABEL_MISSING");
    expect(checked.allowed).toBe(false);
    await expect(daily!.release(draft)).rejects.toThrow(/AI_LABEL_MISSING/);
    expect(await h.rows("publications")).toHaveLength(0);

    // Forced past preflight: the hand-off's own gate refuses the bytes before Social gets them.
    provider.forcePastAiLabelPreflight = true;
    await daily!.release(draft);
    const [pub] = await h.rows("publications");
    expect(pub).toMatchObject({
      contentId: draft.id,
      test: false,
      status: "intent_created",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(new Date(pub!.scheduledAt).valueOf() + MINUTE));
    await dispatchPublication(owner, pub!.id);
    const after = (await h.rows("publications")).find((p) => p.id === pub!.id)!;
    expect(after).toMatchObject({ status: "failed", reason: "AI_LABEL_MISSING" });
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: owner.projectId,
          action: "image.ai_label.blocked",
          resourceId: legacySha,
        },
      }),
    );
    expect(audits.map((a) => a.metadata)).toContainEqual(
      expect.objectContaining({
        code: "AI_LABEL_MISSING",
        context: "marketing.social_handoff",
      }),
    );
    // Nothing reached Social or a platform: no post, no library image, no delivery, no fetch.
    expect(await socialCounts()).toEqual({ posts: 0, library: 0, publications: 0 });
    expect(
      (await h.rows("jobs")).filter((j) => j.topic === DISPATCH),
    ).toHaveLength(0);
    expect(calls).toHaveLength(0);
  }, 120_000);

  it("stops a legacy AI image that Social already holds from before the flag at the slot, before any platform call", async () => {
    liveSocialEnv();
    // Before the switch: released and announced in Social without any gate.
    vi.stubEnv("ORBIT_AI_IMAGE_LABELS", "false");
    const { draft } = await legacyDraft();
    const { h, project } = daily!;
    const { owner } = project;
    await daily!.release(draft);
    await syncSocialHolds(h.worker());
    const [pub] = await h.rows("publications");
    expect(pub).toMatchObject({
      status: "intent_created",
      socialHold: { state: "held" },
    });
    expect(await socialCounts()).toMatchObject({ posts: 1, library: 1, publications: 0 });
    // The flag goes on; at the slot the final preflight blocks the hand-off.
    vi.stubEnv("ORBIT_AI_IMAGE_LABELS", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(new Date(pub!.scheduledAt).valueOf() + MINUTE));
    await dispatchPublication(owner, pub!.id);
    const after = (await h.rows("publications")).find((p) => p.id === pub!.id)!;
    expect(after.status).toBe("blocked_dependency");
    expect(after.blockers).toEqual(["AI_LABEL_MISSING"]);
    // The held announcement is taken back; nothing is dispatched or sent.
    await syncSocialHolds(h.worker());
    const posts = await h.run((tx) =>
      tx.socialPost.findMany({ where: { projectId: owner.projectId } }),
    );
    expect(posts.map((p) => p.status)).toEqual(["canceled"]);
    expect(await socialCounts()).toMatchObject({ publications: 0 });
    expect(
      (await h.rows("jobs")).filter((j) => j.topic === DISPATCH),
    ).toHaveLength(0);
    expect(calls).toHaveLength(0);
  }, 120_000);
});
