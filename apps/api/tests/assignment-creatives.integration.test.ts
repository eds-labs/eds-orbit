import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model, image and Postiz call is a mock; nothing here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
type ArtKind = "good" | "tiny_subject";
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  requests: [] as any[],
  replies: [] as Array<(request: any) => Reply | Promise<Reply>>,
  // The fixture art the image model returns for its n-th call (1-based).
  artKind: (_call: number): "good" | "tiny_subject" => "good",
  // Runs between a run creative's composition and its save.
  afterCompose: null as null | (() => Promise<void>),
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
// The run's composition with a hook between composing and saving.
vi.mock(
  "../src/modules/marketing/creative/pipeline.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/modules/marketing/creative/pipeline.ts")
      >();
    return {
      ...actual,
      composePlan: async (...args: Parameters<typeof actual.composePlan>) => {
        const composed = await actual.composePlan(...args);
        await provider.afterCompose?.();
        return composed;
      },
    };
  },
);
// The strategy's channel history sync reads an empty Postiz.
vi.mock("../../../packages/connectors/src/index.ts", async (original) => ({
  ...(await original<
    typeof import("../../../packages/connectors/src/index.ts")
  >()),
  createPostizClient: () => ({ listPosts: async () => [] }),
}));
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  CREATIVE_FORMATS,
  TEMPLATE_COPY_LIMITS,
} from "../../../packages/creative/src/index.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
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
import {
  assignmentHash,
  setAssignmentStatus,
} from "../src/modules/agents/assignments.ts";
import { agentReviewAccepted } from "../src/modules/agents/agent-review.ts";
import { CREATIVES } from "../src/modules/marketing/creative/store.ts";
import { composeRunCreatives } from "../src/modules/marketing/creative/assignment.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";
import { addBrandKit } from "./support/package-creative.ts";
import {
  assignmentRun,
  BLOG,
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
// The strategy's art plan of every post (fictional, no real brand).
const CREATIVE_BRIEF = {
  keyMessage: "Product teams keep their week in one calm place",
  imageKind: "scene",
  motif: "A bright, tidy desk with a ceramic mug and a notebook by a window",
  setting: "A quiet studio in soft morning light",
  template: "lifestyle",
  mood: "calm and focused",
};
// The image copy the copywriter writes; Orbit sets the CTA to the mission's.
const IMAGE_COPY = {
  eyebrow: "Beta access",
  headline: "Beta access is open",
  subline: "Product teams can join the beta today.",
  cta: "Join now!",
};
/** A Postiz channel whose provider Orbit has no rules for. */
const UNKNOWN = "unknown-int";
const ONE_SLOT = {
  rhythm: "daily",
  weekdays: [],
  times: ["10:00"],
  leadMinutes: 360,
};

/**
 * Assignments with creatives (Creative Studio, Task 14): art per post or run
 * from the strategy's creative brief, a branded rendition per channel format
 * composed after the drafts exist, bounded art corrections inside the run's
 * budget, and a review that leaves weak creatives to the owner.
 */
describe.skipIf(!enabled)("Assignment creatives", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
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
  const creativeAssignment = (changes: Record<string, unknown> = {}) =>
    h.makeAssignment({
      channels: [X],
      image: true,
      creative: { artPer: "post", imageKind: "auto" },
      delivery: "postiz_draft",
      ...changes,
    });
  /** Plans the run with a creative brief per slot and writes the texts, then the art. */
  const drafted = async (
    briefChanges: (index: number) => Record<string, unknown> = () => ({}),
    channel?: string,
    beforeVisual?: () => Promise<void>,
  ) => {
    const planned = await h.planWithBriefs((slots) =>
      slots
        .filter((slot) => !channel || slot.channel === channel)
        .map((slot, index) =>
          h.brief(slot, { creative: CREATIVE_BRIEF, ...briefChanges(index) }),
        ),
    );
    for (const role of ["copywriter", "visual"]) {
      if (role === "visual") await beforeVisual?.();
      for (const step of (await h.rows("agent_tasks")).filter(
        (t) => t.role === role,
      ))
        await runAgentTask(h.worker(), step.id);
    }
    return { review: await h.task("review"), ...planned };
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
  const resume = async (assignmentId: string) => {
    await h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignmentId, "paused"),
    );
    return h.run((tx) =>
      setAssignmentStatus(tx, project.owner, assignmentId, "active"),
    );
  };
  const arts = async () =>
    (await h.rows("assets")).filter((a) => a.creativeArt === true);

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    process.env.ORBIT_CREATIVE_STUDIO = "true";
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    provider.requests = [];
    provider.replies = [];
    provider.artKind = () => "good";
    provider.afterCompose = null;
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      const revision = contract.revision;
      const draft = generated(
        revision ? `${revision.previousBody} Revised.` : `${BODY} (${topic})`,
      );
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
          ...(contract.creative
            ? {
                creative: {
                  ...IMAGE_COPY,
                  // A figure the image cannot back, fixed by the revision.
                  ...(topic.includes("FIGURE") && !revision
                    ? { headline: "Save 30% on beta access" }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    const image = async (params: any) => {
      const [width, height] = String(params.size).split("x").map(Number);
      const kind: ArtKind = provider.artKind(
        provider.generateImage.mock.calls.length,
      );
      const art = await fixtureArt(kind, "lumora", {
        width: width!,
        height: height!,
      });
      return {
        bytes: art.bytes,
        model: IMAGE_MODEL,
        size: params.size,
        quality: "medium",
        background: "opaque",
        usage: null,
      };
    };
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
    // The fictional Lumora Home brand kit; lifestyle is the first template
    // left enabled, and Telegram takes a square.
    await addBrandKit(project, {
      templates: {
        product_showcase: { enabled: false },
        feature_highlight: { enabled: false },
        problem_solution: { enabled: false },
      },
      formatsByChannel: { telegram: ["square"] },
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    delete process.env.ORBIT_CREATIVE_STUDIO;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("refuses creative with banner", async () => {
    const assignment = await creativeAssignment({
      banner: { template: "brand_landscape" },
    });
    await expect(resume(assignment.id)).rejects.toThrow("CREATIVE_AND_BANNER");
    // Nor without the image consent, nor for anything but social posts.
    const withoutImage = await creativeAssignment({ image: false });
    await expect(resume(withoutImage.id)).rejects.toThrow(
      "CREATIVE_NEEDS_IMAGE",
    );
    const blog = await creativeAssignment({
      contentType: "blog",
      channels: [BLOG],
      delivery: "publish",
    });
    await expect(resume(blog.id)).rejects.toThrow("CREATIVE_SOCIAL_ONLY");
  });

  it("refuses creative without a logo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assignment = await creativeAssignment({ schedule: ONE_SLOT });
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
    // The visual step refuses before any image is generated or paid.
    expect(await h.task("visual")).toMatchObject({
      status: "failed",
      errorCode: "CREATIVE_LOGO_REQUIRED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    await expect(resume(assignment.id)).rejects.toThrow(
      "CREATIVE_LOGO_REQUIRED",
    );
  });

  it("refuses creative while the flag is off", async () => {
    const assignment = await creativeAssignment({ schedule: ONE_SLOT });
    process.env.ORBIT_CREATIVE_STUDIO = "false";
    await drafted();
    expect(await h.task("visual")).toMatchObject({
      status: "failed",
      errorCode: "CREATIVE_STUDIO_DISABLED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    // Off, the strategy and the copywriter see nothing of the creative (CS-D6).
    for (const contract of contracts()) {
      expect(contract).not.toHaveProperty("creative");
      expect(contract).not.toHaveProperty("copyCraft");
    }
    for (const mission of await h.rows("missions")) {
      expect(mission).not.toHaveProperty("creativeTemplate");
      expect(mission).not.toHaveProperty("creativeBrief");
    }
    await expect(resume(assignment.id)).rejects.toThrow(
      "CREATIVE_STUDIO_DISABLED",
    );
  });

  /** Sets the project's opt-in to automatic creatives (R65) on the stored profile. */
  const optIn = (enabled: boolean) =>
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
              ...value.visualIdentity,
              creative: { ...value.visualIdentity.creative, enabled },
            },
          },
        },
      });
    });

  // R65: the switch alone changes nothing automatic; the project opts in.
  it("refuses creative while the project has not opted in", async () => {
    const assignment = await creativeAssignment({ schedule: ONE_SLOT });
    await optIn(false);
    await drafted();
    expect(await h.task("visual")).toMatchObject({
      status: "failed",
      errorCode: "CREATIVE_STUDIO_NOT_ENABLED_FOR_PROJECT",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    for (const contract of contracts()) {
      expect(contract).not.toHaveProperty("creative");
      expect(contract).not.toHaveProperty("copyCraft");
    }
    for (const mission of await h.rows("missions")) {
      expect(mission).not.toHaveProperty("creativeTemplate");
      expect(mission).not.toHaveProperty("creativeBrief");
    }
    await expect(resume(assignment.id)).rejects.toThrow(
      "CREATIVE_STUDIO_NOT_ENABLED_FOR_PROJECT",
    );
  });

  it("writes drafts as with the switch off while the project has not opted in", async () => {
    await h.makeAssignment({
      channels: [X],
      image: false,
      delivery: "postiz_draft",
      schedule: ONE_SLOT,
    });
    await optIn(false);
    await drafted();
    expect(provider.generate).toHaveBeenCalled();
    for (const [params] of provider.generate.mock.calls) {
      expect(params).not.toHaveProperty("copyCraft");
      expect(params).not.toHaveProperty("creative");
    }
    for (const contract of contracts()) {
      expect(contract).not.toHaveProperty("copyCraft");
      expect(contract).not.toHaveProperty("creative");
    }
    for (const draft of await contents()) {
      expect(draft).not.toHaveProperty("copyCraft");
      expect(draft).not.toHaveProperty("coreMessage");
    }
  });

  it("asks for copy craft once the project opted in", async () => {
    await h.makeAssignment({
      channels: [X],
      image: false,
      delivery: "postiz_draft",
      schedule: ONE_SLOT,
    });
    await drafted();
    expect(provider.generate).toHaveBeenCalled();
    for (const [params] of provider.generate.mock.calls)
      expect(params).toMatchObject({ copyCraft: true });
    for (const contract of contracts()) expect(contract.copyCraft).toBe(true);
  });

  it("keeps legacy confirmations", async () => {
    const legacy = {
      name: "Two posts a day",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X],
      topicFrame: "Short updates about beta access for product teams",
      tone: "Calm and concrete",
      image: true,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
    };
    // Without `creative` the hash covers exactly the fields it covered before.
    expect(assignmentHash(legacy)).toBe(hash(legacy));
    expect(assignmentHash({ ...legacy, creative: undefined })).toBe(
      assignmentHash(legacy),
    );
    expect(
      assignmentHash({
        ...legacy,
        creative: { artPer: "post", imageKind: "auto" },
      }),
    ).not.toBe(assignmentHash(legacy));
    // An assignment confirmed before still resumes under its confirmation.
    const row = await h.makeAssignment({ image: true });
    expect(data(await resume(row.id)).status).toBe("active");
  });

  it("art per post", async () => {
    await linkBot();
    await creativeAssignment();
    const { review, runId } = await drafted((index) => ({
      topic: index === 0 ? "Beta access for teams" : "SECOND beta access",
    }));
    // One art per post, from its creative brief, as an approved run asset.
    expect(provider.generateImage).toHaveBeenCalledTimes(2);
    for (const [request] of provider.generateImage.mock.calls) {
      expect(request.prompt).toContain(CREATIVE_BRIEF.motif);
      expect(request.prompt).toContain(
        "No text, no letters, no logos and no identifiable persons",
      );
    }
    const art = await arts();
    expect(art).toHaveLength(2);
    for (const row of art)
      expect(row).toMatchObject({
        usageApproved: true,
        assetStatus: "approved",
        assignmentRunId: runId,
        creativeArtFailed: [],
      });
    expect(new Set(art.map((row) => row.creativeUnit)).size).toBe(2);
    // The copywriter wrote image copy for the template the art was made for.
    for (const contract of contracts())
      expect(contract.creative).toEqual({
        template: "lifestyle",
        limits: TEMPLATE_COPY_LIMITS.lifestyle,
      });
    for (const mission of await h.rows("missions"))
      expect(mission).toMatchObject({
        creativeTemplate: "lifestyle",
        creativeBrief: CREATIVE_BRIEF,
      });
    // Each draft carries its own rendition in its channel's format, never the raw art.
    const drafts = await contents();
    expect(drafts).toHaveLength(2);
    const creatives = await h.rows(CREATIVES);
    expect(creatives).toHaveLength(2);
    const assets = await h.rows("assets");
    for (const draft of drafts) {
      expect(art.map((row) => row.id)).not.toContain(draft.assetId);
      const rendition = assets.find((a) => a.id === draft.assetId)!;
      expect(rendition).toMatchObject({
        type: "generated_artwork",
        sourceType: "TEMPLATE_GENERATED",
        usageApproved: true,
        assetStatus: "approved",
        approvedBy: project.owner.userId,
        creativeFormat: "landscape",
        width: CREATIVE_FORMATS.landscape.width,
        height: CREATIVE_FORMATS.landscape.height,
        boundTo: {
          creativeId: draft.creativeId,
          contentId: draft.id,
          runId,
        },
      });
      const creative = creatives.find((c) => c.id === draft.creativeId)!;
      expect(creative).toMatchObject({
        status: "attached",
        contentId: draft.id,
        assignmentRunId: runId,
        template: "lifestyle",
        copy: draft.creativeCopy,
        composeKey: expect.any(String),
      });
      expect(creative.qa.verdict).not.toBe("needs_owner");
      expect(draft.creativeCopy).toEqual({ ...IMAGE_COPY, cta: "Learn more" });
    }
    expect(new Set(creatives.map((c) => c.components.artAssetId)).size).toBe(2);
    // Composing again changes nothing: one creative and rendition per draft.
    const bound = async () =>
      (await h.rows("assets")).filter((a) => a.boundTo?.creativeId).length;
    expect(await bound()).toBe(2);
    expect(await composeRunCreatives(project.owner, runId)).toEqual({
      composed: [],
      failed: [],
      error: null,
    });
    expect(await h.rows(CREATIVES)).toHaveLength(2);
    expect(await bound()).toBe(2);
    expect((await contents()).map((c) => c.assetId)).toEqual(
      drafts.map((c) => c.assetId),
    );

    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    // The review model sees the image copy, core message and hook as data.
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    for (const draft of shown)
      expect(draft).toMatchObject({
        creativeCopy: { ...IMAGE_COPY, cta: "Learn more" },
        coreMessage: expect.any(String),
        hook: expect.any(String),
      });
    for (const draft of await contents()) {
      expect(draft.status).toBe("reviewed");
      expect(draft.agentReview.creativeHash).toBe(hash(draft.creativeCopy));
    }
    // Approved creatives become Postiz drafts as before; no publication.
    expect(await h.rows("postiz_drafts")).toHaveLength(2);
    expect(await h.rows("publications")).toEqual([]);
    expect(provider.generateImage).toHaveBeenCalledTimes(2);
  });

  it("bounded correction on bad art", async () => {
    provider.artKind = () => "tiny_subject";
    await linkBot();
    await creativeAssignment({ schedule: ONE_SLOT });
    const { review } = await drafted();
    // The art and one correction (maxArtCorrections 1), nothing more.
    expect(provider.generateImage).toHaveBeenCalledTimes(2);
    const [first, second] = provider.generateImage.mock.calls.map(
      ([request]) => request.prompt as string,
    );
    expect(second).not.toBe(first);
    const art = await arts();
    expect(art).toHaveLength(2);
    // Both fail their art checks; the second asked for the planned correction.
    for (const row of art)
      expect(row.creativeArtFailed.length).toBeGreaterThan(0);
    const corrected = art.filter((row) => row.creativeArtCorrection);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.generationId).toMatch(/:c1$/);
    // The draft carries the creative with its findings for the review.
    const [draft] = await contents();
    const [creative] = await h.rows(CREATIVES);
    expect(draft!.creativeId).toBe(creative!.id);
    expect(creative!.qa.verdict).toBe("needs_owner");
    // Composed from the art with fewer failed blockers, the first on a tie.
    const uncorrected = art.find((row) => !row.creativeArtCorrection)!;
    expect(creative!.components.artAssetId).toBe(
      corrected[0]!.creativeArtFailed.length <
        uncorrected.creativeArtFailed.length
        ? corrected[0]!.id
        : uncorrected.id,
    );
    await runAgentTask(h.worker(), review.id);
    const [left] = await contents();
    expect(left!.status).toBe("needs_review");
    expect(left!.agentReviewDecision).toMatchObject({
      verdict: "needs_owner",
      deterministicProblems: ["CREATIVE_QA_FAILED"],
    });
    // The model never saw it; nothing is scheduled or handed to Postiz.
    expect(provider.requests).toEqual([]);
    expect(await h.rows("publications")).toEqual([]);
    expect(await h.rows("postiz_drafts")).toEqual([]);
    expect(provider.generateImage).toHaveBeenCalledTimes(2);
  });

  it("agent authority does not cover creatives", async () => {
    await linkBot();
    await creativeAssignment({ schedule: ONE_SLOT, delivery: "publish" });
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const [draft] = await contents();
    // Approved by the agent, but waiting for the owner: nothing is scheduled (CS-D7).
    expect(draft!.agentReview.creativeHash).toBe(hash(draft!.creativeCopy));
    expect(draft!.status).toBe("needs_review");
    expect(
      await h.run((tx) => agentReviewAccepted(tx, project.owner, draft!)),
    ).toBe(false);
    expect(await h.rows("publications")).toEqual([]);
    // As a Postiz draft the same review stands, for exactly this image copy.
    const asDraft: Record<string, any> = {
      ...draft!,
      delivery: "postiz_draft",
    };
    expect(
      await h.run((tx) => agentReviewAccepted(tx, project.owner, asDraft)),
    ).toBe(true);
    expect(
      await h.run((tx) =>
        agentReviewAccepted(tx, project.owner, {
          ...asDraft,
          creativeCopy: { ...asDraft.creativeCopy, headline: "Another line" },
        }),
      ),
    ).toBe(false);
  });

  // M3: a vision review that could never run would leave every draft of the
  // run for the owner (CREATIVE_QA_FAILED): refused before anything is paid.
  it("refuses a vision review whose logo may not go to a provider", async () => {
    const logoId = await h.run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      const value = profile.data as Record<string, any>;
      const identity = value.visualIdentity;
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: {
          data: {
            ...value,
            visualIdentity: {
              ...identity,
              creative: { ...identity.creative, visualReview: true },
            },
          },
        },
      });
      return identity.logoAssetId as string;
    });
    const assignment = await creativeAssignment({ schedule: ONE_SLOT });
    await drafted();
    expect(await h.task("visual")).toMatchObject({
      status: "failed",
      errorCode: "VISION_REVIEW_PROVIDER_USE_REQUIRED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    await expect(resume(assignment.id)).rejects.toThrow(
      "VISION_REVIEW_PROVIDER_USE_REQUIRED",
    );
    // With the owner's provider use on the logo it may run.
    await h.run(async (tx) => {
      const logo = await entity(tx, project.owner, "assets", logoId);
      await update(tx, project.owner, logo, {
        ...data(logo),
        providerUse: true,
      });
    });
    expect(data(await resume(assignment.id)).status).toBe("active");
  });

  it("runs the optional vision review before the model review", async () => {
    await linkBot();
    // Vision review on; the logo may go to a provider (R28), the art is Orbit's own.
    await h.run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      const value = profile.data as Record<string, any>;
      const identity = value.visualIdentity;
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: {
          data: {
            ...value,
            visualIdentity: {
              ...identity,
              creative: { ...identity.creative, visualReview: true },
            },
          },
          version: { increment: 1 },
        },
      });
      const logo = await entity(
        tx,
        project.owner,
        "assets",
        identity.logoAssetId,
      );
      await update(tx, project.owner, logo, {
        ...data(logo),
        providerUse: true,
      });
    });
    await creativeAssignment();
    const { review } = await drafted((index) => ({
      topic: index === 0 ? "Beta access for teams" : "SECOND beta access",
    }));
    const scores = {
      subject: 4,
      balance: 4,
      legibility: 5,
      brandFit: 4,
      messageFit: 4,
      channelFit: 4,
      value: 4,
    };
    // The first creative fails the rubric, the second passes it.
    provider.replies.push(
      () => ({
        output: [
          message({
            scores: { ...scores, legibility: 2 },
            issues: [{ kind: "layout", note: "The subline is hard to read." }],
          }),
        ],
      }),
      () => ({ output: [message({ scores, issues: [] })] }),
      approveAll,
    );
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    // Two vision calls with the rendition, then the model sees only the passing draft.
    expect(provider.requests).toHaveLength(3);
    for (const request of provider.requests.slice(0, 2))
      expect(request.input[0].content[1].type).toBe("input_image");
    const drafts = await contents();
    const left = drafts.filter((c) => c.status === "needs_review");
    const approved = drafts.filter((c) => c.status === "reviewed");
    expect(left).toHaveLength(1);
    expect(approved).toHaveLength(1);
    expect(left[0]!.agentReviewDecision).toMatchObject({
      verdict: "needs_owner",
      deterministicProblems: ["CREATIVE_QA_FAILED"],
    });
    expect(
      JSON.parse(provider.requests[2].input[0].content).drafts.map(
        (d: Record<string, any>) => d.contentId,
      ),
    ).toEqual([approved[0]!.id]);
    const creatives = await h.rows(CREATIVES);
    expect(
      creatives.find((c) => c.contentId === left[0]!.id)!.qa,
    ).toMatchObject({
      verdict: "needs_owner",
      vision: { verdict: "needs_correction" },
    });
    // The vision calls were paid from the run's budget.
    const runKey = `assignment-run:${left[0]!.assignmentRunId}`;
    const budgetRun = (await h.rows("budget_runs")).find(
      (row) => row.runKey === runKey,
    )!;
    const reservationIds = creatives.flatMap((c) => c.cost.reservationIds);
    expect(reservationIds).toHaveLength(2);
    for (const id of reservationIds)
      expect(budgetRun.reservationIds).toContain(id);
  });

  it("composes again only when what a creative shows changed", async () => {
    await creativeAssignment({ schedule: ONE_SLOT });
    const { runId } = await drafted();
    const [before] = await h.rows(CREATIVES);
    // A new profile version changes the brand key: the draft is composed
    // again and the new creative replaces the old one on it.
    await h.run((tx) =>
      tx.projectMarketingProfile.updateMany({
        where: { projectId: project.owner.projectId },
        data: { version: { increment: 1 } },
      }),
    );
    const again = await composeRunCreatives(project.owner, runId);
    expect(again.composed).toHaveLength(1);
    expect(again.error).toBeNull();
    const creatives = await h.rows(CREATIVES);
    const old = creatives.find((c) => c.id === before!.id)!;
    const fresh = creatives.find((c) => c.id === again.composed[0])!;
    expect(old.status).toBe("superseded");
    expect(fresh.status).toBe("attached");
    expect(fresh.composeKey).not.toBe(old.composeKey);
    const [draft] = await contents();
    expect(draft!.creativeId).toBe(fresh.id);
    const assets = await h.rows("assets");
    expect(
      assets.find((a) => a.id === old.renditions[0].assetId)!.assetStatus,
    ).toBe("outdated");
    // No new art: composing is free.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
  });

  it("records why a creative could not be saved on its draft", async () => {
    await creativeAssignment({ schedule: ONE_SLOT });
    // The draft moves to another channel between composing and saving.
    provider.afterCompose = async () => {
      provider.afterCompose = null;
      await h.run(async (tx) => {
        const [row] = await list(tx, project.owner, "content");
        await update(tx, project.owner, row!, {
          ...data(row!),
          channel: TELEGRAM,
        });
      });
    };
    await drafted();
    const visual = await h.task("visual");
    expect(visual.output.creativeFailures).toEqual([
      { contentId: expect.any(String), code: "CONTENT_CHANGED" },
    ]);
    const [draft] = await contents();
    expect(draft!.creativeFailure).toMatchObject({ code: "CONTENT_CHANGED" });
    expect(await h.rows(CREATIVES)).toEqual([]);
  });

  it("budget bounds art", async () => {
    // A run pool of 80,000 micros: one image at the 50,000 ceiling.
    await creativeAssignment({ monthlyBudgetMicros: 30 * 80_000 });
    await drafted((index) => ({
      topic: index === 0 ? "Beta access for teams" : "SECOND beta access",
    }));
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const visual = await h.task("visual");
    expect(visual.status).toBe("done");
    expect(visual.output.skippedUnits).toEqual([
      { unit: expect.any(String), code: "AGENT_LIMIT" },
    ]);
    const drafts = await contents();
    expect(drafts).toHaveLength(2);
    const [composed, refused] = drafts;
    expect(composed!.creativeId).toEqual(expect.any(String));
    expect(refused!.assetId).toBeUndefined();
    expect(refused!.creativeFailure).toMatchObject({
      code: "AGENT_LIMIT",
      unit: visual.output.skippedUnits[0].unit,
    });
    expect(await h.rows(CREATIVES)).toHaveLength(1);
  });

  it("carries the creative template to a revision (previousCreative)", async () => {
    await linkBot();
    await creativeAssignment({ schedule: ONE_SLOT });
    const { review } = await drafted(() => ({ topic: "FIGURE on the image" }));
    // Copy with a figure gets no creative: the copy is the review's to fix.
    const [original] = await contents();
    expect(original!.creativeCopy.headline).toBe("Save 30% on beta access");
    expect(original!.assetId).toBeUndefined();
    expect(await h.rows(CREATIVES)).toEqual([]);
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const revisionContract = contracts().find((c) => c.revision)!;
    expect(revisionContract.creative).toEqual({
      template: "lifestyle",
      limits: TEMPLATE_COPY_LIMITS.lifestyle,
    });
    expect(revisionContract.revision.previousCreative).toEqual(
      original!.creativeCopy,
    );
    const missions = await h.rows("missions");
    const revisionMission = missions.find((m) => m.revisionOf)!;
    expect(revisionMission).toMatchObject({
      creativeTemplate: "lifestyle",
      creativeBrief: CREATIVE_BRIEF,
    });
    // The revision's creative is composed over the same art and approved.
    const all = await contents();
    const replaced = all.find((c) => c.id === original!.id)!;
    const revised = all.find((c) => c.id === replaced.supersededBy)!;
    expect(revised.creativeCopy.headline).toBe(IMAGE_COPY.headline);
    const [creative] = await h.rows(CREATIVES);
    expect(creative).toMatchObject({
      contentId: revised.id,
      status: "attached",
    });
    expect(revised.creativeId).toBe(creative!.id);
    expect(revised.status).toBe("reviewed");
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
  });

  it("carries one creative per slot to every channel of a shared slot", async () => {
    await linkBot();
    await creativeAssignment({
      schedule: ONE_SLOT,
      channels: [X, TELEGRAM],
      sharedAcrossChannels: true,
    });
    const { review } = await drafted(() => ({}), TELEGRAM);
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    expect(drafts.map((c) => c.channel).sort()).toEqual([TELEGRAM, X].sort());
    // One creative for the slot, in every format of its channels.
    const creatives = await h.rows(CREATIVES);
    expect(creatives).toHaveLength(1);
    const [creative] = creatives;
    expect(
      creative!.renditions.map((r: Record<string, any>) => r.format),
    ).toEqual(["square", "landscape"]);
    for (const draft of drafts) {
      expect(draft.status).toBe("reviewed");
      expect(draft.creativeId).toBe(creative!.id);
      // Each channel carries the rendition in its own format.
      expect(draft.assetId).toBe(
        creative!.renditions.find(
          (r: Record<string, any>) =>
            r.format === (draft.channel === TELEGRAM ? "square" : "landscape"),
        ).assetId,
      );
    }
    expect(await h.rows("postiz_drafts")).toHaveLength(2);
  });

  it("composes each draft in its own channel's format and leaves a channel without media to the owner", async () => {
    await linkBot();
    // A channel whose provider Orbit does not know: square, and no media.
    await h.run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      const d = data(connector);
      await update(tx, project.owner, connector, {
        ...d,
        channels: [
          ...d.channels,
          {
            id: UNKNOWN,
            name: "Synthetic unknown",
            identifier: "synthetic-network",
            disabled: false,
          },
        ],
        assignedIntegrationIds: [...d.assignedIntegrationIds, UNKNOWN],
      });
    });
    await h.setPolicy({ channels: [X, TELEGRAM, UNKNOWN] });
    await creativeAssignment({
      schedule: ONE_SLOT,
      channels: [X, TELEGRAM, UNKNOWN],
    });
    // An earlier render failure on the unknown channel's draft is stale once a creative is stored.
    const { review } = await drafted(undefined, undefined, () =>
      h.run(async (tx) => {
        const row = (await list(tx, project.owner, "content")).find(
          (c) => data(c).channel === UNKNOWN,
        )!;
        await update(tx, project.owner, row, {
          ...data(row),
          creativeFailure: { code: "CREATIVE_RENDER_FAILED", key: "stale" },
        });
      }),
    );
    expect(provider.generateImage).toHaveBeenCalledTimes(3);
    const assets = await h.rows("assets");
    const creatives = await h.rows(CREATIVES);
    expect(creatives).toHaveLength(3);
    const drafts = await contents();
    const byChannel = (channel: string) =>
      drafts.find((c) => c.channel === channel)!;
    for (const [channel, format] of [
      [X, "landscape"],
      [TELEGRAM, "square"],
    ] as const) {
      const rendition = assets.find(
        (a) => a.id === byChannel(channel).assetId,
      )!;
      expect(rendition).toMatchObject({
        creativeFormat: format,
        width: CREATIVE_FORMATS[format].width,
        height: CREATIVE_FORMATS[format].height,
      });
    }
    // Composed in its square format, but its channel cannot carry an image.
    const unknown = byChannel(UNKNOWN);
    expect(unknown.assetId).toBeUndefined();
    expect(unknown).not.toHaveProperty("creativeFailure");
    const stored = creatives.find((c) => c.contentId === unknown.id)!;
    expect(stored.status).not.toBe("attached");
    expect(stored.renditions.map((r: Record<string, any>) => r.format)).toEqual(
      ["square"],
    );
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const after = await contents();
    const left = after.find((c) => c.id === unknown.id)!;
    expect(left.status).toBe("needs_review");
    expect(left.agentReviewDecision.deterministicProblems).toContain(
      "CREATIVE_MEDIA_REFUSED",
    );
    expect(left.agentReviewDecision.deterministicProblems).not.toContain(
      "CREATIVE_RENDER_FAILED",
    );
    for (const channel of [X, TELEGRAM])
      expect(after.find((c) => c.channel === channel)!.status).toBe("reviewed");
  });
});
