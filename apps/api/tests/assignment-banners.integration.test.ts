import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model, image and Postiz call is a mock; nothing here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  requests: [] as any[],
  replies: [] as Array<(request: any) => Reply>,
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
      provider.requests.push(structuredClone(request));
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
        responseId: `resp_${provider.requests.length}`,
      };
    }),
  };
});
// The strategy's channel history sync reads an empty Postiz.
vi.mock("../../../packages/connectors/src/index.ts", async (original) => ({
  ...(await original<
    typeof import("../../../packages/connectors/src/index.ts")
  >()),
  createPostizClient: () => ({ listPosts: async () => [] }),
}));
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import {
  create,
  data,
  encrypt,
  entity,
  hash,
  list,
  update,
} from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { startReadySteps } from "../src/modules/agents/assignment-runs.ts";
import { setAssignmentStatus } from "../src/modules/agents/assignments.ts";
import { agentReviewAccepted } from "../src/modules/agents/agent-review.ts";
import {
  BANNER_TEXT_LIMITS,
  DEFAULT_BANNER_STYLE,
} from "../src/modules/agents/banner.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  OFFICIAL_URL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";
import {
  assignmentRun,
  embedded,
  generated,
  message,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
// Synthetic token in Telegram's shape; nothing is sent to Telegram here.
const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0123456";

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

const BANNER = {
  headline1: "Start free.",
  headline2: "Build your workflow.",
  subline: "Markets. Paper trading. Bots.",
  button: "Explore Desk",
};
const FOOTER = new URL(OFFICIAL_URL).hostname;

/**
 * Banners in the brand style (R78): one generated background per run, one
 * banner per slot composed over it with the approved logo and the
 * copywriter's reviewed banner copy, the same banner on every channel of a
 * shared slot.
 */
describe.skipIf(!enabled)("Assignment banners in the brand style", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let png: Buffer;
  let logoId: string;
  // Banner copy per brief topic; the default is BANNER.
  let bannerFor: (topic: string, revision: boolean) => Record<string, string>;
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      `${a.scheduledAt}${a.channel}`.localeCompare(
        `${b.scheduledAt}${b.channel}`,
      ),
    );
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));
  const linkBot = () =>
    h.run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status: "linked",
        encryptedToken: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
        chatId: "4711",
        telegramUserId: "4711",
        linkedUserId: project.owner.userId,
        linkedAt: new Date().toISOString(),
      }),
    );
  const banner = { template: "brand_landscape" };
  const shared = (changes: Record<string, unknown> = {}) =>
    h.makeAssignment({
      channels: [X, TELEGRAM],
      sharedAcrossChannels: true,
      image: true,
      banner,
      delivery: "postiz_draft",
      ...changes,
    });
  const setLogo = (assetId: string | undefined) =>
    h.run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      const value = profile.data as Record<string, any>;
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: {
          data: {
            ...value,
            visualIdentity: {
              ...(value.visualIdentity ?? {}),
              ...(assetId ? { logoAssetId: assetId } : {}),
            },
          },
        },
      });
    });
  /** Plans the run with one brief per slot group (Telegram) and writes the texts and the background. */
  const drafted = async (
    briefChanges: (index: number) => Record<string, unknown> = () => ({}),
  ) => {
    const planned = await h.planWithBriefs((slots) =>
      slots
        .filter((slot) => slot.channel === TELEGRAM)
        .map((slot, index) => h.brief(slot, briefChanges(index))),
    );
    for (const role of ["copywriter", "visual"])
      for (const step of (await h.rows("agent_tasks")).filter(
        (t) => t.role === role,
      ))
        await runAgentTask(h.worker(), step.id);
    return { review: await h.task("review"), ...planned };
  };
  const pngSize = (base64: string) => {
    const bytes = Buffer.from(base64, "base64");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };
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

  beforeAll(async () => {
    const rendered = await renderRasterTemplate({
      format: "landscape",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    png = rendered.bytes;
  });
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    provider.requests = [];
    provider.replies = [];
    bannerFor = () => BANNER;
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      const draft = generated(`${BODY} (${topic})`);
      return params.banner
        ? {
            ...draft,
            output: {
              ...draft.output,
              banner: bannerFor(topic, Boolean(contract.revision)),
            },
          }
        : draft;
    });
    const image = async (params: any) => ({
      bytes: png,
      model: IMAGE_MODEL,
      size: params.size,
      quality: "medium",
      background: "opaque",
      usage: null,
    });
    provider.generateImage.mockReset().mockImplementation(image);
    provider.generateImageWithReferences.mockReset().mockImplementation(image);
    project = await createPackageProject();
    h = assignmentRun(project);
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X, TELEGRAM],
      contentTypes: ["social"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    await h.run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        xLongPostIntegrationIds: [X],
        baseUrl: "https://postiz.example.invalid",
        encryptedCredential: encrypt(
          "synthetic-token",
          process.env.CREDENTIAL_KEY!,
        ),
      });
    });
    // The profile's approved logo (an upload, never generated).
    const logo = await h.run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Synthetic logo",
        type: "logo",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
      }),
    );
    logoId = logo.id;
    await setLogo(logoId);
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("generates one background per run and composes one banner per slot, the same on every channel of the slot", async () => {
    await linkBot();
    const assignment = await shared();
    const second = { ...BANNER, headline1: "Plan ahead." };
    bannerFor = (topic) => (topic.includes("SECOND") ? second : BANNER);
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "Beta access for teams" : "SECOND beta access",
    }));
    // One landscape background in the banner style: art only.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const imageRequest = provider.generateImage.mock.calls[0]![0];
    expect(imageRequest.size).toBe("1536x1024");
    expect(imageRequest.prompt).toContain(DEFAULT_BANNER_STYLE);
    expect(imageRequest.prompt).toContain(
      "No text, no letters, no logos and no identifiable persons",
    );
    // The copywriter writes banner copy for each slot.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    for (const call of provider.generate.mock.calls)
      expect(call[0].banner).toBe(true);
    for (const contract of contracts())
      expect(contract.banner).toEqual({
        template: "brand_landscape",
        limits: BANNER_TEXT_LIMITS,
      });
    const assets = await h.rows("assets");
    const background = assets.find((a) => a.bannerBackground === true)!;
    expect(background).toMatchObject({
      usageApproved: true,
      assignmentRunId: expect.any(String),
      providerSize: "1536x1024",
    });
    const banners = assets.filter((a) => a.bannerKey);
    expect(banners).toHaveLength(2);
    for (const composed of banners) {
      expect(composed).toMatchObject({
        type: "generated_artwork",
        mime: "image/png",
        width: 1600,
        height: 900,
        template: "brand_landscape",
        usageApproved: true,
        assetStatus: "approved",
        sourceType: "TEMPLATE_GENERATED",
        brandAssetId: logoId,
        visualAssetId: background.id,
        rightsSource: {
          assignmentId: assignment.id,
          confirmationHash: expect.any(String),
          backgroundAssetId: background.id,
          logoAssetId: logoId,
          logoVersion: expect.any(Number),
        },
      });
      expect(pngSize(composed.base64)).toEqual([1600, 900]);
      expect(
        createHash("sha256")
          .update(Buffer.from(composed.base64, "base64"))
          .digest("hex"),
      ).toBe(composed.sha256);
    }
    // Each slot's draft carries its own banner; no draft carries the background.
    const written = await contents();
    expect(written.map((c) => c.assetId).sort()).toEqual(
      banners.map((b) => b.id).sort(),
    );
    expect(written.map((c) => c.banner)).toEqual([BANNER, second]);
    expect(banners.map((b) => b.bannerText)).toEqual(
      expect.arrayContaining([BANNER, second]),
    );

    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    // The review model sees the banner copy with each draft.
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    expect(shown.map((draft: any) => draft.banner)).toEqual([BANNER, second]);
    expect(provider.requests[0].instructions).not.toContain("banner");
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    for (const at of new Set(drafts.map((c) => c.scheduledAt))) {
      const pair = drafts.filter((c) => c.scheduledAt === at);
      expect(pair.map((c) => c.channel).sort()).toEqual([TELEGRAM, X].sort());
      expect(pair[0]!.assetId).toBe(pair[1]!.assetId);
      expect(banners.map((b) => b.id)).toContain(pair[0]!.assetId);
      expect(pair[0]!.banner).toEqual(pair[1]!.banner);
      for (const draft of pair) {
        expect(draft.status).toBe("reviewed");
        expect(draft.agentReview.bannerHash).toBe(hash(draft.banner));
      }
    }
    // Both slots' banners differ: one per slot.
    expect(new Set(drafts.map((c) => c.assetId)).size).toBe(2);
    expect(await h.rows("postiz_drafts")).toHaveLength(4);
    // No further image call: the banners are composed, not generated.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
  });

  it("rejects a draft whose banner states what no fact backs; the review model never sees it", async () => {
    await linkBot();
    await shared();
    bannerFor = (topic) =>
      topic.includes("CLAIM")
        ? { ...BANNER, headline1: "Earn 10% daily." }
        : BANNER;
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "CLAIM beta access" : "Beta access for teams",
    }));
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    expect(shown).toHaveLength(1);
    expect(shown[0].banner).toEqual(BANNER);
    const drafts = await contents();
    const claimed = drafts.find(
      (c) => c.banner.headline1 !== BANNER.headline1,
    )!;
    expect(claimed.status).toBe("rejected");
    expect(claimed.agentReviewDecision).toMatchObject({
      verdict: "reject",
      deterministicProblems: ["BANNER_UNSUPPORTED_CLAIM"],
    });
    // Copy with a claim gets no banner composed at all.
    expect(claimed.assetId).toBeUndefined();
    expect(
      (await h.rows("assets"))
        .filter((a) => a.bannerKey)
        .map((a) => a.bannerText),
    ).toEqual([BANNER]);
    // No revision for a claim: only the clean slot goes, on both channels.
    expect(contracts().filter((c) => c.revision)).toEqual([]);
    expect(
      drafts
        .filter((c) => c.status === "reviewed")
        .map((c) => c.channel)
        .sort(),
    ).toEqual([TELEGRAM, X].sort());
  });

  it("revises banner copy that does not fit once, without the model, and composes the revision's banner", async () => {
    await linkBot();
    await shared();
    bannerFor = (topic, revision) =>
      topic.includes("LONG") && !revision
        ? {
            ...BANNER,
            headline2: "Build every single workflow you can imagine.",
          }
        : BANNER;
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "LONG beta access" : "Beta access for teams",
    }));
    // The long copy got no banner yet: it does not fit the template.
    expect((await h.rows("assets")).filter((a) => a.bannerKey)).toHaveLength(1);
    provider.replies.push(approveAll, approveAll);
    await runAgentTask(h.worker(), review.id);
    const done = await h.task("review");
    expect(done.status).toBe("done");
    const [revision] = contracts().filter((c) => c.revision);
    expect(revision.revision.instruction).toMatch(
      /^Shorten the banner text so it fits the banner/,
    );
    expect(done.output.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 1,
          verdict: "revise",
          deterministicProblems: ["BANNER_TEXT_OVERFLOW"],
        }),
        expect.objectContaining({ round: 2, verdict: "approve" }),
      ]),
    );
    const live = (await contents()).filter((c) => c.status === "reviewed");
    expect(live).toHaveLength(4);
    for (const draft of live) expect(draft.banner).toEqual(BANNER);
    // The revision's banner was composed over the same background.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const assets = await h.rows("assets");
    const ids = new Set(live.map((c) => c.assetId));
    for (const id of ids)
      expect(assets.find((a) => a.id === id)!.bannerKey).toEqual(
        expect.any(String),
      );
  });

  it("binds the agent review to the banner copy", async () => {
    await linkBot();
    await shared();
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const [approved] = (await contents()).filter(
      (c) => c.status === "reviewed",
    );
    expect(
      await h.run((tx) => agentReviewAccepted(tx, project.owner, approved!)),
    ).toBe(true);
    for (const changed of [
      { ...approved, banner: { ...BANNER, headline1: "Start now." } },
      { ...approved, banner: undefined },
    ])
      expect(
        await h.run((tx) => agentReviewAccepted(tx, project.owner, changed)),
      ).toBe(false);
  });

  it("composes only with the approved logo: no logo, no background and no cost", async () => {
    const assignment = await shared();
    await setLogo(undefined);
    await h.run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      const value = profile.data as Record<string, any>;
      const { logoAssetId: _logo, ...visual } = value.visualIdentity;
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: { data: { ...value, visualIdentity: visual } },
      });
    });
    await drafted();
    const visual = await h.task("visual");
    expect(visual).toMatchObject({
      status: "failed",
      errorCode: "BANNER_LOGO_REQUIRED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    // Resuming the assignment asks for the logo too.
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    await expect(
      h.run((tx) =>
        setAssignmentStatus(tx, project.owner, assignment.id, "active"),
      ),
    ).rejects.toThrow("BANNER_LOGO_REQUIRED");
  });

  it("leaves an assignment without a banner exactly as before", async () => {
    await linkBot();
    await shared({ banner: undefined });
    const { review } = await drafted();
    for (const call of provider.generate.mock.calls)
      expect("banner" in call[0]).toBe(false);
    for (const contract of contracts())
      expect(contract).not.toHaveProperty("banner");
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const imageRequest = provider.generateImage.mock.calls[0]![0];
    expect(imageRequest.size).toBe("1024x1024");
    expect(imageRequest.prompt).not.toContain(DEFAULT_BANNER_STYLE);
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    for (const draft of shown) expect(draft).not.toHaveProperty("banner");
    const assets = await h.rows("assets");
    expect(assets.filter((a) => a.bannerKey || a.bannerBackground)).toEqual([]);
    const [image] = assets.filter((a) => a.assignmentRunId);
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    for (const draft of drafts) {
      expect(draft.assetId).toBe(image!.id);
      expect(draft).not.toHaveProperty("banner");
      expect(draft.agentReview).not.toHaveProperty("bannerHash");
    }
    expect(FOOTER).toBe("example.invalid");
  });
});
