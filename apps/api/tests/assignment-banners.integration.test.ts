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
  replies: [] as Array<(request: any) => Reply | Promise<Reply>>,
  // Runs between a banner's plan and its save (after rendering), or fails a render.
  beforeRender: null as null | ((input: any) => Promise<void>),
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
      const reply = await next(request);
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
// The banner renderer with a hook, to change sources mid-compose or fail one render.
vi.mock("../../../packages/creative/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/creative/src/index.ts")
    >();
  return {
    ...actual,
    renderRasterBanner: async (input: any) => {
      await provider.beforeRender?.(input);
      return actual.renderRasterBanner(input);
    },
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
  attachRunImage,
  composeRunBanners,
  hasOwnBanner,
} from "../src/modules/agents/specialists/visual.ts";
import { assetTools } from "../src/modules/asset-tools.ts";
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

// The copywriter writes the mission CTA ("Learn more.") on the button.
const BANNER = {
  headline1: "Start free.",
  headline2: "Build your workflow.",
  subline: "Markets. Paper trading. Bots.",
  button: "Learn more",
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
  let other: Buffer;
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
    const second = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Other synthetic fixture",
    });
    if (second.status !== "rendered") throw new Error("FIXTURE_RENDER_FAILED");
    other = second.bytes;
  });
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    provider.requests = [];
    provider.replies = [];
    provider.beforeRender = null;
    bannerFor = () => BANNER;
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      const draft = generated(`${BODY} (${topic})`);
      // A revision keeps the previous banner unless the instruction concerns it.
      const revision = contract.revision;
      const banner =
        revision?.previousBanner &&
        !String(revision.instruction).startsWith("Fix the banner copy")
          ? revision.previousBanner
          : bannerFor(topic, Boolean(revision));
      return params.banner
        ? {
            ...draft,
            output: {
              ...draft.output,
              banner,
              ...(revision
                ? { body: `${revision.previousBody} Revised.` }
                : {}),
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

  it("sends back a banner that states what no fact backs once, naming the word, and rejects it if it stays", async () => {
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
    // The model only ever sees the clean slot's text.
    expect(provider.requests).toHaveLength(1);
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    expect(shown.map((draft: any) => draft.banner)).toEqual([BANNER]);
    // One revision without the model, naming what to remove.
    const [revision] = contracts().filter((c) => c.revision);
    expect(revision.revision.instruction).toMatch(
      /^Fix the banner copy: remove /,
    );
    expect(revision.revision.instruction).toContain('"10"');
    expect(revision.revision.instruction).toContain('"%"');
    expect(revision.revision.previousBanner).toEqual({
      ...BANNER,
      headline1: "Earn 10% daily.",
    });
    const drafts = await contents();
    const claimed = drafts.filter(
      (c) => c.banner.headline1 !== BANNER.headline1,
    );
    // The original was replaced; the revision still carries the claim and is rejected.
    expect(claimed.map((c) => c.agentReviewDecision.round).sort()).toEqual([
      1, 2,
    ]);
    const second = claimed.find((c) => c.agentReviewDecision.round === 2)!;
    expect(second.status).toBe("rejected");
    expect(second.agentReviewDecision).toMatchObject({
      verdict: "reject",
      deterministicProblems: ["BANNER_UNSUPPORTED_CLAIM"],
    });
    // Copy with a claim gets no banner composed at all.
    for (const draft of claimed) expect(draft.assetId).toBeUndefined();
    expect(
      (await h.rows("assets"))
        .filter((a) => a.bannerKey)
        .map((a) => a.bannerText),
    ).toEqual([BANNER]);
    // Only the clean slot goes, on both channels.
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
      /^Fix the banner copy: shorten it to fit/,
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

  // Production uLiquid, 2026-10-17 (run f610945b): the button "Explore
  // Desk" competed with the mission CTA and the review rejected the post.
  it("sets the banner button to the mission CTA, whatever the copywriter wrote", async () => {
    await linkBot();
    await shared();
    bannerFor = () => ({ ...BANNER, button: "Explore Desk" });
    const { review } = await drafted();
    const written = await contents();
    expect(written.length).toBeGreaterThan(0);
    for (const draft of written) expect(draft.banner.button).toBe("Learn more");
    const banners = (await h.rows("assets")).filter((a) => a.bannerKey);
    for (const composed of banners)
      expect(composed.bannerText.button).toBe("Learn more");
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    for (const draft of shown) expect(draft.banner.button).toBe("Learn more");
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

  /** Changes an asset row (a new version), or revokes its approval. */
  const touch = (assetId: string, changes: Record<string, unknown> = {}) =>
    h.run(async (tx) => {
      const row = await entity(tx, project.owner, "assets", assetId);
      await update(tx, project.owner, row, {
        ...data(row),
        note: "changed",
        ...changes,
      });
    });
  /** Puts other image bytes behind an asset id (a semantic change). */
  const replaceBytes = (assetId: string, bytes = other) =>
    touch(assetId, {
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  const backgroundOf = async () =>
    (await h.rows("assets")).find((a) => a.bannerBackground === true)!;
  const bannersOf = async () =>
    (await h.rows("assets")).filter((a) => a.bannerKey);
  /** Plans the run with distinct copy per slot and runs the copywriter only. */
  const written = async () => {
    bannerFor = (topic) =>
      topic.includes("SECOND")
        ? { ...BANNER, headline1: "Plan ahead." }
        : BANNER;
    const planned = await h.planWithBriefs((slots) =>
      slots
        .filter((slot) => slot.channel === TELEGRAM)
        .map((slot, index) =>
          h.brief(slot, {
            topic: index === 0 ? "Beta access for teams" : "SECOND beta",
          }),
        ),
    );
    await runAgentTask(h.worker(), (await h.task("copywriter")).id);
    return planned;
  };

  it("keeps the banner through a revision of the body only (previousBanner)", async () => {
    await linkBot();
    await shared();
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "PILOT beta access" : "Beta access for teams",
    }));
    const composed = (await bannersOf()).length;
    provider.replies.push(
      (request) => ({
        output: [
          message({
            decisions: JSON.parse(request.input[0].content).drafts.map(
              (draft: Record<string, any>) =>
                String(draft.brief?.topic).includes("PILOT")
                  ? {
                      contentId: draft.contentId,
                      verdict: "revise",
                      reasons: ["Name the pilot."],
                      revisionInstructions: "Mention the pilot.",
                    }
                  : {
                      contentId: draft.contentId,
                      verdict: "approve",
                      reasons: [],
                      revisionInstructions: null,
                    },
            ),
          }),
        ],
      }),
      approveAll,
    );
    await runAgentTask(h.worker(), review.id);
    const [revision] = contracts().filter((c) => c.revision);
    expect(revision.revision).toMatchObject({
      instruction: "Mention the pilot.",
      previousBanner: BANNER,
    });
    const live = (await contents()).filter((c) => c.status === "reviewed");
    expect(live).toHaveLength(4);
    expect(live.filter((c) => c.body.endsWith("Revised."))).toHaveLength(2);
    for (const draft of live) expect(draft.banner).toEqual(BANNER);
    // The same copy keeps the same banner: nothing new was composed.
    expect((await bannersOf()).length).toBe(composed);
  });

  it("lets the agent's approval of a banner stand in only for Postiz drafts, not for publishing (R79)", async () => {
    await linkBot();
    await shared({ delivery: "publish" });
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    // Approved by the agent, but waiting for the owner: nothing is scheduled.
    for (const draft of drafts) {
      expect(draft.agentReview.bannerHash).toBe(hash(draft.banner));
      expect(draft.status).toBe("needs_review");
      expect(
        await h.run((tx) => agentReviewAccepted(tx, project.owner, draft)),
      ).toBe(false);
    }
    expect(await h.rows("publications")).toEqual([]);
    // The same draft as a Postiz draft delivery is accepted.
    expect(
      await h.run((tx) =>
        agentReviewAccepted(tx, project.owner, {
          ...drafts[0]!,
          delivery: "postiz_draft",
        }),
      ),
    ).toBe(true);
  });

  it("composes no banner when the background or logo bytes change between plan and save", async () => {
    await linkBot();
    await shared();
    const { runId } = await written();
    // The background's bytes are replaced while the first banner renders.
    provider.beforeRender = async () => {
      provider.beforeRender = null;
      await replaceBytes((await backgroundOf()).id);
    };
    await runAgentTask(h.worker(), (await h.task("visual")).id);
    expect((await h.task("visual")).output).toMatchObject({
      bannerError: "BRAND_ASSET_CHANGED",
    });
    expect(await bannersOf()).toEqual([]);
    // The logo's bytes are replaced while the next compose renders.
    provider.beforeRender = async () => {
      provider.beforeRender = null;
      await replaceBytes(logoId);
    };
    expect(await composeRunBanners(h.worker(), runId)).toMatchObject({
      composed: [],
      error: "BRAND_ASSET_CHANGED",
    });
    expect(await bannersOf()).toEqual([]);
    // Unchanged sources compose and attach both slots' banners.
    expect((await composeRunBanners(h.worker(), runId)).composed).toHaveLength(
      2,
    );
    await h.run((tx) => attachRunImage(tx, project.owner, runId));
    const [draft] = await contents();
    const own = () => h.run((tx) => hasOwnBanner(tx, project.owner, draft!));
    expect(await own()).toBe(true);
    // A revoked background takes the banner away; approving it again restores it.
    await touch((await backgroundOf()).id, { assetStatus: "reference" });
    expect(await own()).toBe(false);
    await expect(composeRunBanners(h.worker(), runId)).rejects.toThrow(
      "ASSET_RIGHTS_REQUIRED",
    );
    await touch((await backgroundOf()).id, { assetStatus: "approved" });
    expect(await own()).toBe(true);
    // Other bytes behind the same background id end it.
    await replaceBytes((await backgroundOf()).id, png);
    expect(await own()).toBe(false);
  });

  it("keeps banners valid across Drive syncs of the background and logo", async () => {
    await linkBot();
    await shared();
    const { runId } = await written();
    // The background is synced to Drive while the first banner renders (a new version, same bytes).
    provider.beforeRender = async () => {
      provider.beforeRender = null;
      await touch((await backgroundOf()).id, {
        driveSyncStatus: "SYNCED",
        driveFileId: "synthetic-drive-file",
      });
    };
    await runAgentTask(h.worker(), (await h.task("visual")).id);
    const visual = await h.task("visual");
    expect(visual.output.bannerError).toBeUndefined();
    const banners = await bannersOf();
    expect(banners).toHaveLength(2);
    for (const draft of await contents())
      expect(banners.map((b) => b.id)).toContain(draft.assetId);
    // A failed sync and a retry change nothing either.
    await touch((await backgroundOf()).id, { driveSyncStatus: "FAILED" });
    await touch(logoId, { driveSyncStatus: "FAILED" });
    expect((await composeRunBanners(h.worker(), runId)).composed).toEqual([]);
    for (const draft of await contents())
      expect(await h.run((tx) => hasOwnBanner(tx, project.owner, draft))).toBe(
        true,
      );
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), (await h.task("review")).id);
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    for (const draft of drafts) expect(draft.status).toBe("reviewed");
  });

  it("stops the run's banners when the logo bytes fail their check", async () => {
    await linkBot();
    await shared();
    const { runId } = await written();
    await runAgentTask(h.worker(), (await h.task("visual")).id);
    const before = await bannersOf();
    await h.run((tx) =>
      tx.entity.deleteMany({
        where: { id: { in: before.map((banner) => banner.id) } },
      }),
    );
    provider.beforeRender = async () => {
      throw new Error("BRAND_ASSET_INTEGRITY_FAILED");
    };
    expect(await composeRunBanners(h.worker(), runId)).toEqual({
      composed: [],
      failed: [],
      error: "BRAND_ASSET_INTEGRITY_FAILED",
    });
    // Nothing is recorded on the drafts: it is the run's problem, not theirs.
    for (const draft of await contents())
      expect(draft).not.toHaveProperty("bannerFailure");
  });

  it("replaces a draft's banner that is no longer its own with the current one", async () => {
    await linkBot();
    await shared();
    const { runId } = await drafted();
    const before = new Map((await contents()).map((c) => [c.id, c.assetId]));
    await replaceBytes(logoId);
    // One new banner per copy (both slots share one copy here).
    expect((await composeRunBanners(h.worker(), runId)).composed).toHaveLength(
      new Set(before.values()).size,
    );
    await h.run((tx) => attachRunImage(tx, project.owner, runId));
    for (const draft of await contents()) {
      expect(draft.assetId).not.toBe(before.get(draft.id));
      expect(await h.run((tx) => hasOwnBanner(tx, project.owner, draft))).toBe(
        true,
      );
    }
  });

  it("binds a banner to its draft's copy and keeps it out of the asset library", async () => {
    await linkBot();
    await shared();
    await drafted();
    const [draft] = await contents();
    expect(await h.run((tx) => hasOwnBanner(tx, project.owner, draft!))).toBe(
      true,
    );
    expect(
      await h.run((tx) =>
        hasOwnBanner(tx, project.owner, {
          ...draft!,
          banner: { ...BANNER, headline2: "Another text." },
        }),
      ),
    ).toBe(false);
    const banners = await bannersOf();
    for (const banner of banners) {
      expect(banner.boundTo).toEqual({
        runId: draft!.assignmentRunId,
        contentId: expect.any(String),
      });
      expect(banner.approvedBy).toBe(project.owner.userId);
      expect(banner.rightsSource.backgroundVersion).toEqual(expect.any(Number));
    }
    const listed = (await assetTools.list(project.owner)).map((a) => a.id);
    for (const banner of banners) expect(listed).not.toContain(banner.id);
    await expect(assetTools.get(project.owner, banners[0]!.id)).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("stores one banner per copy when composers run at the same time", async () => {
    await linkBot();
    await shared();
    const { runId } = await drafted();
    const before = await bannersOf();
    await h.run((tx) =>
      tx.entity.deleteMany({
        where: { id: { in: before.map((banner) => banner.id) } },
      }),
    );
    await Promise.all([
      composeRunBanners(h.worker(), runId),
      composeRunBanners(h.worker(), runId),
      composeRunBanners(h.worker(), runId),
    ]);
    const after = await bannersOf();
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((banner) => banner.bannerKey)).size).toBe(
      after.length,
    );
  });

  it("leaves only the slot whose banner failed to render for the owner", async () => {
    await linkBot();
    await shared();
    bannerFor = (topic) =>
      topic.includes("SECOND")
        ? { ...BANNER, headline1: "Plan ahead." }
        : BANNER;
    provider.beforeRender = async (input) => {
      if (input.text.headline1 === "Plan ahead.")
        throw new Error("SYNTHETIC_RENDER_FAILURE");
    };
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "Beta access for teams" : "SECOND beta",
    }));
    const visual = await h.task("visual");
    expect(visual.output.bannerFailures).toHaveLength(1);
    expect(visual.output.bannerError).toBeUndefined();
    const written = await contents();
    const failed = written.find((c) => c.banner.headline1 === "Plan ahead.")!;
    const fine = written.find((c) => c.banner.headline1 === BANNER.headline1)!;
    expect(failed.bannerFailure).toMatchObject({
      code: "BANNER_RENDER_FAILED",
    });
    expect(failed.assetId).toBeUndefined();
    expect(fine.assetId).toEqual(expect.any(String));
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const slotOf = (id: string) =>
      drafts.filter((c) => c.id === id || c.sharedFrom?.contentId === id);
    for (const draft of slotOf(failed.id)) {
      expect(draft.status).toBe("needs_review");
    }
    expect(
      drafts.find((c) => c.id === failed.id)!.agentReviewDecision
        .deterministicProblems,
    ).toEqual(["BANNER_RENDER_FAILED"]);
    for (const draft of slotOf(fine.id)) expect(draft.status).toBe("reviewed");
  });

  it("leaves a failed banner on an Instagram channel for the owner and names only the banner (MEDIA_REQUIRED)", async () => {
    await linkBot();
    // Telegram becomes Instagram, which rejects a post without an image.
    await h.run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        channels: data(connector).channels.map((channel: any) =>
          channel.id === TELEGRAM
            ? { ...channel, identifier: "instagram" }
            : channel,
        ),
      });
    });
    await shared();
    provider.beforeRender = async () => {
      throw new Error("SYNTHETIC_RENDER_FAILURE");
    };
    const { review } = await drafted();
    provider.replies.push(approveAll);
    // Instagram's media rule comes with the Creative Studio (R64); the
    // drafts were written with it off, so only the review sees it.
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const instagram = drafts.filter((c) => c.channel === TELEGRAM);
    expect(instagram).toHaveLength(2);
    for (const draft of instagram) {
      // The banner is the reason; the owner decides, nothing is rejected.
      expect(draft.status).toBe("needs_review");
      expect(draft.agentReviewDecision).toMatchObject({
        verdict: "needs_owner",
        deterministicProblems: ["BANNER_RENDER_FAILED"],
      });
      expect(draft.assetId).toBeUndefined();
    }
  });

  it("leaves a text whose banner changed during the review for the owner", async () => {
    await linkBot();
    await shared();
    const { review } = await drafted();
    provider.replies.push(async (request) => {
      const [target] = await contents();
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", target!.id);
        await update(tx, project.owner, row, {
          ...data(row),
          banner: { ...BANNER, headline2: "Changed text." },
        });
      });
      return approveAll(request);
    });
    await runAgentTask(h.worker(), review.id);
    const [changed] = await contents();
    expect(changed!.status).toBe("needs_review");
    expect(changed!.agentReviewDecision.deterministicProblems).toEqual([
      "AGENT_REVIEW_TEXT_CHANGED",
    ]);
    expect(changed).not.toHaveProperty("agentReview");
  });

  it("keeps the banner on the channels that can carry it when the strictest one cannot", async () => {
    await linkBot();
    await shared();
    // A 1,100-character text: too long for Telegram's caption, fine as a Telegram text and on X.
    provider.generate.mockImplementation(async (params: any) => {
      const topic = String(JSON.parse(params.goal).brief?.topic ?? "");
      const draft = generated(
        `${BODY} (${topic}) ${"Product teams plan their week here. ".repeat(30)}`.trim(),
      );
      return { ...draft, output: { ...draft.output, banner: BANNER } };
    });
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    const [banner] = await bannersOf();
    for (const draft of drafts.filter((c) => c.channel === TELEGRAM)) {
      // Held back on its own channel only: its text was approved for X.
      expect(draft.status).toBe("needs_review");
      expect(draft.agentReviewDecision).toMatchObject({
        deterministicProblems: ["BANNER_MEDIA_REFUSED"],
        textApproved: true,
      });
      expect(draft.assetId).toBeUndefined();
    }
    for (const draft of drafts.filter((c) => c.channel === X)) {
      expect(draft.agentReviewDecision.deterministicProblems).toEqual([]);
      expect(draft.status).toBe("reviewed");
      expect(draft.assetId).toBe(banner!.id);
    }
    expect(
      (await h.rows("postiz_drafts")).map((row) => row.integrationId),
    ).toEqual([X, X]);
  });

  it("refuses a banner whose product name or link domain cannot fit", async () => {
    const assignment = await shared();
    await h.run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: {
          data: {
            ...(profile.data as Record<string, any>),
            productName: "A very long product name that no banner can hold",
          },
        },
      });
    });
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    await expect(
      h.run((tx) =>
        setAssignmentStatus(tx, project.owner, assignment.id, "active"),
      ),
    ).rejects.toThrow("BANNER_BRAND_OVERFLOW");
  });

  it("refuses a banner when the policy allows none of the official links", async () => {
    const assignment = await shared();
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignment.id, "paused"),
    );
    await h.setPolicy({ allowedOrigins: [] });
    await expect(
      h.run((tx) =>
        setAssignmentStatus(tx, project.owner, assignment.id, "active"),
      ),
    ).rejects.toThrow("BANNER_LINK_NOT_ALLOWED");
  });
});
