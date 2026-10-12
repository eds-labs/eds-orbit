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
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { preflight } from "../src/modules/policy.ts";
import { releaseAssignmentDraft } from "../src/modules/agents/owner-release.ts";
import { reviewStep } from "../src/modules/agents/specialists/review.ts";
import { runProblems } from "../src/modules/agents/assignment-runs.ts";
import { sendNotification } from "../src/modules/agents/notification-sender.ts";
import { planDailyReport } from "../src/modules/agents/notifications.ts";
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
  tomorrowMorning,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BODY = "Beta access is open for product teams. Learn more.";
const FILLER =
  " Product teams can start with a small pilot and grow from there.";
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

/** A recorded review answer: one verdict per shown draft. */
const decideAll =
  (
    decide: (draft: Record<string, any>) => {
      verdict: "approve" | "revise" | "reject";
      revisionInstructions?: string | null;
      reasons?: string[];
    },
  ) =>
  (request: any): Reply => ({
    output: [
      message({
        decisions: JSON.parse(request.input[0].content).drafts.map(
          (draft: Record<string, any>) => ({
            contentId: draft.contentId,
            reasons: [],
            revisionInstructions: null,
            ...decide(draft),
          }),
        ),
      }),
    ],
  });

/**
 * One post per slot across channels (R76) and the assignment format (R77):
 * one brief and one text per slot, written for the strictest channel,
 * reviewed once and delivered unchanged on every channel of the slot.
 */
describe.skipIf(!enabled)("Shared assignment posts and format", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  let png: Buffer;
  const contents = async () =>
    (await h.rows("content")).sort((a, b) =>
      `${a.scheduledAt}${a.channel}`.localeCompare(
        `${b.scheduledAt}${b.channel}`,
      ),
    );
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));
  const notices = async (kind: string) =>
    (await h.rows("jobs")).filter((job) =>
      String(job.idempotencyKey ?? "").startsWith(`notify:${kind}:`),
    );
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
  const shared = (changes: Record<string, unknown> = {}) =>
    h.makeAssignment({
      channels: [X, TELEGRAM],
      sharedAcrossChannels: true,
      ...changes,
    });
  /** Plans the run with one brief per slot group (on Telegram, the strictest channel) and writes the texts and the image. */
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
  const blockers = async (contentId: string) => {
    const content = await h.run((tx) =>
      entity(tx, project.owner, "content", contentId),
    );
    return (
      await h.run((tx) =>
        preflight(tx, project.owner, contentId, {
          test: true,
          at: new Date(data(content).scheduledAt),
          ignoreApproval: true,
        }),
      )
    ).blockers;
  };

  beforeAll(async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
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
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      return generated(`${BODY} (${String(contract.brief?.topic ?? "")})`);
    });
    const image = async () => ({
      bytes: png,
      model: IMAGE_MODEL,
      size: "1024x1024",
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
    // X long posts (4,000 characters) make Telegram with an image (1,024) the strictest channel.
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
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("plans one copywriter, groups each time's slots and keeps one slot per channel", async () => {
    await shared({ image: true });
    const { runId, slots } = await h.planWithBriefs(() => []);
    const [runRow] = await h.rows("assignment_runs");
    expect(runRow).toMatchObject({ id: runId, sharedAcrossChannels: true });
    expect(
      (runRow!.steps as Array<{ key: string }>).map((step) => step.key),
    ).toEqual([
      "analytics",
      "research",
      "strategy",
      "copywriter",
      "visual",
      "review",
    ]);
    // Two times, two channels: four slots, grouped by their requested time.
    expect(slots).toHaveLength(4);
    for (const slot of slots as Array<Record<string, any>>)
      expect(slot.groupAt).toBe(slot.at);
    expect(new Set(slots.map((slot: any) => slot.groupAt)).size).toBe(2);
  });

  it("asks the strategy for one brief per slot group with its channels and the format", async () => {
    const format = {
      minChars: 600,
      maxChars: 900,
      hashtags: { min: 2, max: 3 },
      paragraphs: true,
      cta: OFFICIAL_URL,
    };
    await shared({ image: true, format });
    await h.run((tx) =>
      planAssignmentRuns(tx, project.owner, tomorrowMorning()),
    );
    for (const role of ["analytics", "research"]) {
      const found = await h.task(role);
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", found.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "failed",
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    const [runRow] = await h.rows("assignment_runs");
    const all = runRow!.slots as Array<{ channel: string; at: string }>;
    const xFirst = all.find((slot) => slot.channel === X)!;
    provider.replies.push((request) => {
      const slots = JSON.parse(request.input[0].content).run.slots;
      return {
        output: [
          message({
            briefs: [
              ...slots.map((slot: any) => h.brief(slot)),
              // Not a slot the strategy was given: dropped.
              h.brief(xFirst),
            ],
          }),
        ],
      };
    });
    await runAgentTask(h.worker(), (await h.task("strategy")).id);
    const strategy = await h.task("strategy");
    expect(strategy.status).toBe("done");
    const input = JSON.parse(provider.requests[0].input[0].content);
    // One slot per time, on Telegram (strictest with an image), naming both channels.
    expect(input.run.sharedAcrossChannels).toBe(true);
    expect(input.run.slots).toEqual(
      [...new Set(all.map((slot) => slot.at))].map((at) => ({
        channel: TELEGRAM,
        at,
        sharedChannels: [X, TELEGRAM],
      })),
    );
    expect(input.assignment).toMatchObject({
      sharedAcrossChannels: true,
      format,
    });
    expect(provider.requests[0].instructions).toContain("sharedChannels");
    expect(provider.requests[0].instructions).toContain("assignment.format");
    expect(strategy.output.briefs).toHaveLength(2);
    expect(strategy.output.briefs.map((b: any) => b.channel)).toEqual([
      TELEGRAM,
      TELEGRAM,
    ]);
    expect(strategy.output.uncovered).toEqual([]);
    expect(strategy.output.dropped).toEqual([
      expect.objectContaining({ channel: X, code: "AGENT_UNKNOWN_SLOT" }),
    ]);
    // The one copywriter step takes both briefs.
    expect(
      (await h.rows("agent_tasks"))
        .filter((t) => t.role === "copywriter")
        .map((t) => t.stepKey),
    ).toEqual(["copywriter"]);
  });

  it("writes one text per slot, reviews it once and books it as identical Postiz drafts on every channel", async () => {
    await linkBot();
    await shared({ image: true, delivery: "postiz_draft" });
    const { review, runId, slots } = await drafted();
    // One generation per slot, for Telegram's caption limit, naming every channel of the slot.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    for (const contract of contracts()) {
      expect(contract.channel).toBe(TELEGRAM);
      expect(contract.channelConstraints.characterLimit).toBe(1024);
      expect(contract.sharedChannels).toEqual(
        expect.arrayContaining([
          {
            channel: TELEGRAM,
            providerIdentifier: "telegram",
            characterLimit: 1024,
          },
          { channel: X, providerIdentifier: "x", characterLimit: 4000 },
        ]),
      );
    }
    expect((await contents()).map((c) => c.channel)).toEqual([
      TELEGRAM,
      TELEGRAM,
    ]);

    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    // One review call for the run, showing each slot's text once with every channel it goes to.
    expect(provider.requests).toHaveLength(1);
    const shown = JSON.parse(provider.requests[0].input[0].content).drafts;
    expect(shown).toHaveLength(2);
    for (const draft of shown) {
      expect(draft.channel).toBe(TELEGRAM);
      expect(draft.sharedChannels).toEqual([TELEGRAM, X]);
    }

    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    const [image] = await h.rows("assets");
    for (const at of new Set(drafts.map((c) => c.scheduledAt))) {
      const pair = drafts.filter((c) => c.scheduledAt === at);
      expect(pair.map((c) => c.channel).sort()).toEqual([TELEGRAM, X].sort());
      const [original, copy] = [
        pair.find((c) => c.channel === TELEGRAM)!,
        pair.find((c) => c.channel === X)!,
      ];
      // Same text, title, claims and image on both channels.
      expect(copy.body).toBe(original.body);
      expect(copy.title).toBe(original.title);
      expect(copy.claims).toEqual(original.claims);
      expect(copy.assetId).toBe(image!.id);
      expect(original.assetId).toBe(image!.id);
      expect(copy.sharedFrom).toEqual({
        contentId: original.id,
        contentVersion: expect.any(Number),
        bodyHash: hash(original.body),
      });
      // The copy carries the review of exactly this text and passes on its own channel.
      expect(copy.status).toBe("reviewed");
      expect(copy.agentReview).toEqual({
        ...original.agentReview,
        checkedAt: expect.any(String),
      });
      expect(copy.agentReview.bodyHash).toBe(hash(copy.body));
      expect(copy.missionId).not.toBe(original.missionId);
      // Identical text on another channel is no duplicate.
      expect(await blockers(copy.id)).toEqual(
        expect.not.arrayContaining([
          "DUPLICATE_CONTENT",
          "CLAIM_OVERLAP_DUPLICATE",
        ]),
      );
      expect(await blockers(original.id)).toEqual(
        expect.not.arrayContaining([
          "DUPLICATE_CONTENT",
          "CLAIM_OVERLAP_DUPLICATE",
        ]),
      );
    }
    // Four Postiz drafts, one per channel and slot, and every slot stays held.
    const handoffs = await h.rows("postiz_drafts");
    expect(handoffs).toHaveLength(4);
    expect(
      handoffs.map((row) => `${row.integrationId}@${row.slotAt}`).sort(),
    ).toEqual(slots.map((slot) => `${slot.channel}@${slot.at}`).sort());
    const byContent = new Map(drafts.map((c) => [c.id, c]));
    for (const row of handoffs)
      expect(byContent.get(row.contentId)!.channel).toBe(row.integrationId);
    const [runRow] = await h.rows("assignment_runs");
    expect(runRow!.id).toBe(runId);
    expect(runRow!.slots).toHaveLength(4);
    for (const slot of runRow!.slots as Array<Record<string, any>>) {
      expect(slot.postizDraftId).toEqual(expect.any(String));
      expect(slot.releasedAt).toBeUndefined();
    }
    expect(await h.rows("publications")).toEqual([]);
  });

  it("publishes the shared text as one publication per channel with its veto window", async () => {
    await linkBot();
    await shared({ image: true });
    const { review, slots } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const publications = await h.rows("publications");
    expect(publications).toHaveLength(4);
    const drafts = await contents();
    const byContent = new Map(drafts.map((c) => [c.id, c]));
    for (const at of new Set(slots.map((slot) => slot.at))) {
      const pair = publications.filter((p) => p.scheduledAt === at);
      expect(pair).toHaveLength(2);
      const texts = pair.map((p) => byContent.get(p.contentId)!);
      expect(texts.map((c) => c.channel).sort()).toEqual([TELEGRAM, X].sort());
      expect(texts[0]!.body).toBe(texts[1]!.body);
      expect(texts[0]!.assetId).toBe(texts[1]!.assetId);
      for (const p of pair) expect(p.vetoDeadline).toEqual(expect.any(String));
    }
    const [runRow] = await h.rows("assignment_runs");
    for (const slot of runRow!.slots as Array<Record<string, any>>)
      expect(slot.publicationId).toEqual(expect.any(String));
  });

  it("drops only the channel whose own checks fail; the other channels go", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    const first = slots.find((slot) => slot.channel === X)!;
    // A calendar block on X at the first slot.
    await h.run((tx) =>
      create(tx, project.owner, "calendar_blocks", {
        status: "active",
        channels: [X],
        startAt: new Date(Date.parse(first.at) - 60000).toISOString(),
        endAt: new Date(Date.parse(first.at) + 60000).toISOString(),
        reason: "Synthetic block",
      }),
    );
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const blocked = drafts.find(
      (c) => c.channel === X && c.scheduledAt === first.at,
    )!;
    expect(blocked.status).toBe("rejected");
    expect(blocked.agentReviewDecision).toMatchObject({
      verdict: "reject",
      deterministicProblems: expect.arrayContaining(["MANUAL_CALENDAR_BLOCK"]),
      sharedFrom: expect.any(String),
    });
    expect(blocked).not.toHaveProperty("agentReview");
    expect(
      (await notices("rejected")).map((job) => job.idempotencyKey),
    ).toEqual([`notify:rejected:${blocked.id}:${review.id}`]);
    // Three drafts go: Telegram at both times and X at the second.
    const handoffs = await h.rows("postiz_drafts");
    expect(
      handoffs.map((row) => `${row.integrationId}@${row.slotAt}`).sort(),
    ).toEqual(
      slots
        .filter((slot) => slot !== first)
        .map((slot) => `${slot.channel}@${slot.at}`)
        .sort(),
    );
    // The blocked channel's slot is given back, the others stay held.
    const [runRow] = await h.rows("assignment_runs");
    const runSlots = runRow!.slots as Array<Record<string, any>>;
    expect(
      runSlots.find((s) => s.channel === X && s.at === first.at),
    ).toMatchObject({ releaseReason: "NO_APPROVED_DRAFT" });
    expect(runSlots.filter((s) => s.postizDraftId)).toHaveLength(3);
  });

  it("leaves every channel's copy for the owner when the agent's approval does not count", async () => {
    // Authority off: the drafts wait for the owner's release, per channel.
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    expect(drafts).toHaveLength(4);
    expect(drafts.map((c) => c.status)).toEqual(Array(4).fill("needs_review"));
    expect(await h.rows("postiz_drafts")).toEqual([]);
    // One notice per draft that waits for the owner.
    expect(await notices("needs_owner")).toHaveLength(4);
    const copy = drafts.find((c) => c.channel === X)!;
    const released = await h.run((tx) =>
      releaseAssignmentDraft(tx, project.owner, copy.id, copy.version),
    );
    expect(released).toMatchObject({
      result: "released",
      delivery: "postiz_draft",
      scheduledAt: slots.find(
        (slot) => slot.channel === X && slot.at === copy.scheduledAt,
      )!.at,
    });
    const [handoff] = await h.rows("postiz_drafts");
    expect(handoff).toMatchObject({ contentId: copy.id, integrationId: X });
  });

  it("still catches a real repeat of a recent post on one channel", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    const first = slots.find((slot) => slot.channel === TELEGRAM)!;
    const repeated = (await contents()).find(
      (c) => c.scheduledAt === first.at,
    )!;
    // X already published exactly this text yesterday (another tool's post).
    await h.run((tx) =>
      create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: "external-repeat",
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
        state: "PUBLISHED",
        text: repeated.body,
        source: "external",
        syncedAt: new Date().toISOString(),
      }),
    );
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const copy = drafts.find(
      (c) => c.channel === X && c.scheduledAt === first.at,
    )!;
    expect(copy.status).toBe("rejected");
    expect(copy.agentReviewDecision.deterministicProblems).toContain(
      "DUPLICATE_CONTENT",
    );
    // Telegram has not posted it: its draft goes, as do both posts of the second slot.
    expect(drafts.find((c) => c.id === repeated.id)!.status).toBe("reviewed");
    expect(await h.rows("postiz_drafts")).toHaveLength(3);
  });

  it("writes to the format, revises a draft that misses it once and rejects it if it still does", async () => {
    await linkBot();
    const format = {
      minChars: 120,
      maxChars: 200,
      hashtags: { min: 2, max: 3 },
      paragraphs: true,
      cta: OFFICIAL_URL,
    };
    await shared({ format, delivery: "postiz_draft" });
    // The first slot's texts stay too short; the second slot's lack hashtags until revised.
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      const topic = String(contract.brief?.topic ?? "");
      if (topic.includes("SHORT")) return generated(`${BODY} (short)`);
      const body = `${BODY}${FILLER}\n\nTeams in the beta share what works.`;
      return generated(contract.revision ? `${body}\n\n#beta #teams` : body);
    });
    const { review, slots } = await drafted((index) => ({
      topic: index === 0 ? "SHORT beta access" : "Beta access for teams",
    }));
    // The prompt carries length, hashtags, paragraphs and the format's link.
    expect(contracts()).toHaveLength(2);
    for (const contract of contracts()) {
      expect(contract.format).toEqual(format);
      expect(contract.channelConstraints.appendedTargetUrl).toBe(OFFICIAL_URL);
    }
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const done = await h.task("review");
    expect(done.status).toBe("done");

    // Both drafts were revised once without a model call, with what to change.
    const revisions = contracts().filter((contract) => contract.revision);
    expect(revisions).toHaveLength(2);
    const short = revisions.find((c) => c.brief.topic.includes("SHORT"))!;
    expect(short.revision.instruction).toContain("120 to 200 characters");
    expect(short.revision.instruction).toContain("2 to 3 hashtags");
    const tags = revisions.find((c) => !c.brief.topic.includes("SHORT"))!;
    expect(tags.revision.instruction).not.toContain("characters long");
    expect(tags.revision.instruction).toContain("2 to 3 hashtags");
    // Only the revision that fits the format reached the model, in round 2.
    expect(provider.requests).toHaveLength(1);
    expect(
      JSON.parse(provider.requests[0].input[0].content).drafts.map(
        (draft: any) => draft.body,
      ),
    ).toEqual([expect.stringContaining("#beta #teams")]);
    expect(done.output.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 1,
          verdict: "revise",
          deterministicProblems: ["FORMAT_LENGTH", "FORMAT_HASHTAGS"],
        }),
        expect.objectContaining({
          round: 1,
          verdict: "revise",
          deterministicProblems: ["FORMAT_HASHTAGS"],
        }),
        expect.objectContaining({
          round: 2,
          verdict: "reject",
          deterministicProblems: ["FORMAT_LENGTH", "FORMAT_HASHTAGS"],
        }),
        expect.objectContaining({ round: 2, verdict: "approve" }),
      ]),
    );
    // The short slot is dropped; the revised slot goes on both channels.
    const live = (await contents()).filter((c) => c.status === "reviewed");
    expect(live.map((c) => c.channel).sort()).toEqual([TELEGRAM, X].sort());
    expect(live[0]!.body).toBe(live[1]!.body);
    expect(live[0]!.body).toContain("#beta #teams");
    const second = slots.filter((slot) => slot.at === live[0]!.scheduledAt);
    expect(
      (await h.rows("postiz_drafts"))
        .map((row) => `${row.integrationId}@${row.slotAt}`)
        .sort(),
    ).toEqual(second.map((slot) => `${slot.channel}@${slot.at}`).sort());
  });
  // ---- Fix round: every channel of a shared slot, formats against channel limits ----

  /** The text of one notification job as a fake Telegram receives it. */
  const telegramText = async (jobId: string) => {
    const calls: Array<{ method: string; body: Record<string, any> }> = [];
    const fetch = async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        method: String(url).split("/").pop()!,
        body: JSON.parse(String(init.body ?? "{}")),
      });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: calls.length } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await sendNotification(h.worker(), jobId, {
      fetch,
      sleep: async () => {},
    });
    return calls
      .filter((call) => call.method.startsWith("send"))
      .map((call) => String(call.body.text ?? call.body.caption ?? ""))
      .join("\n");
  };
  const block = (channel: string, at: string) =>
    h.run((tx) =>
      create(tx, project.owner, "calendar_blocks", {
        status: "active",
        channels: [channel],
        startAt: new Date(Date.parse(at) - 60000).toISOString(),
        endAt: new Date(Date.parse(at) + 60000).toISOString(),
        reason: "Synthetic block",
      }),
    );
  /** Runs the review task's handler again, as a worker restart would. */
  const reviewAgain = async (taskId: string) => {
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "agent_tasks", taskId);
      await update(tx, project.owner, row, { ...data(row), status: "running" });
    });
    const task = (await h.rows("agent_tasks")).find((t) => t.id === taskId)!;
    return reviewStep(h.worker(), task as any);
  };

  it("copies the text for every channel when a revision fails for the provider (I1)", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    provider.generate.mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      if (contract.revision) throw new Error("synthetic provider outage");
      return generated(`${BODY} (${String(contract.brief?.topic ?? "")})`);
    });
    provider.replies.push(
      decideAll(() => ({
        verdict: "revise",
        revisionInstructions: "Lead with the team benefit.",
      })),
    );
    await runAgentTask(h.worker(), review.id);
    expect((await h.task("review")).status).toBe("done");
    const drafts = await contents();
    // Two originals left for the owner after the failed revision, and their copies.
    expect(drafts).toHaveLength(4);
    expect(drafts.map((c) => c.status)).toEqual(Array(4).fill("needs_review"));
    for (const original of drafts.filter((c) => c.channel === TELEGRAM)) {
      expect(original.agentReviewDecision).toMatchObject({
        verdict: "needs_owner",
        revisionError: "MODEL_OUTCOME_OR_COST_UNKNOWN",
      });
      const copy = drafts.find((c) => c.sharedFrom?.contentId === original.id)!;
      expect(copy.channel).toBe(X);
      expect(copy.body).toBe(original.body);
      expect(copy.agentReviewDecision).toMatchObject({
        verdict: "needs_owner",
        sharedFrom: original.id,
      });
    }
    // Every channel's slot still waits for the owner's release.
    const [runRow] = await h.rows("assignment_runs");
    expect(
      (runRow!.slots as Array<Record<string, any>>).filter(
        (slot) => slot.releasedAt,
      ),
    ).toEqual([]);
    expect(runRow!.slots).toHaveLength(slots.length);
  });

  it("lets the text go on when only the strictest channel fails its checks (I2)", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    const first = slots.find((slot) => slot.channel === TELEGRAM)!;
    // Telegram (the strictest channel, which the text was written for) is blocked at the first slot.
    await block(TELEGRAM, first.at);
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    // The model judged both texts, also the one whose own channel is blocked.
    expect(provider.requests).toHaveLength(1);
    expect(
      JSON.parse(provider.requests[0].input[0].content).drafts,
    ).toHaveLength(2);
    const drafts = await contents();
    const original = drafts.find(
      (c) => c.channel === TELEGRAM && c.scheduledAt === first.at,
    )!;
    expect(original.status).toBe("rejected");
    expect(original.agentReviewDecision).toMatchObject({
      verdict: "reject",
      deterministicProblems: ["MANUAL_CALENDAR_BLOCK"],
      channelProblems: ["MANUAL_CALENDAR_BLOCK"],
      textApproved: true,
    });
    expect(original).not.toHaveProperty("agentReview");
    // X still gets the post of that slot, approved for exactly that text.
    const copy = drafts.find((c) => c.sharedFrom?.contentId === original.id)!;
    expect(copy.channel).toBe(X);
    expect(copy.status).toBe("reviewed");
    expect(copy.agentReview.bodyHash).toBe(hash(original.body));
    expect(
      (await h.rows("postiz_drafts"))
        .map((row) => `${row.integrationId}@${row.slotAt}`)
        .sort(),
    ).toEqual(
      slots
        .filter((slot) => slot !== first)
        .map((slot) => `${slot.channel}@${slot.at}`)
        .sort(),
    );
    // One rejection notice: for Telegram only.
    const rejected = await notices("rejected");
    expect(rejected.map((job) => job.idempotencyKey)).toEqual([
      `notify:rejected:${original.id}:${review.id}`,
    ]);
    expect(await telegramText(rejected[0]!.id)).toContain(
      "Kanal: Synthetic Telegram",
    );
  });

  it("names every channel of the slot when a text is dropped (I3)", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    // The first slot's brief names a fact that is no longer usable: the copywriter drops it.
    const { review, runId, slots } = await drafted((index) =>
      index === 0 ? { factKeys: ["launch.deadline"] } : {},
    );
    const first = slots.find((slot) => slot.channel === TELEGRAM)!;
    const second = slots.find(
      (slot) => slot.channel === TELEGRAM && slot !== first,
    )!;
    // The model rejects the second slot's text.
    provider.replies.push(
      decideAll(() => ({ verdict: "reject", reasons: ["Off tone"] })),
    );
    await runAgentTask(h.worker(), review.id);
    const problems = await h.run(async (tx) =>
      runProblems(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", runId),
      ),
    );
    expect(
      problems.dropped
        .map((entry) => `${entry.channel}@${entry.slotAt}:${entry.code}`)
        .sort(),
    ).toEqual(
      slots
        .filter((slot) => (slot as any).groupAt === (first as any).groupAt)
        .map((slot) => `${slot.channel}@${slot.at}:FACT_NOT_USABLE`)
        .sort(),
    );
    // The rejected text counts for both channels: in its notice and in the daily report.
    const rejected = await notices("rejected");
    expect(rejected).toHaveLength(1);
    const text = await telegramText(rejected[0]!.id);
    expect(text).toContain("Synthetic Telegram");
    expect(text).toContain("Synthetic X");
    const audit = await h.run((tx) =>
      tx.auditEvent.findFirst({
        where: {
          projectId: project.owner.projectId,
          action: "content.agent_rejected",
        },
      }),
    );
    expect((audit!.metadata as any).channels.sort()).toEqual(
      [TELEGRAM, X].sort(),
    );
    void second;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const evening = new Date();
      evening.setUTCHours(21, 0, 0, 0);
      vi.setSystemTime(evening);
      await h.run((tx) => planDailyReport(tx, project.owner, evening));
    } finally {
      vi.useRealTimers();
    }
    const report = (await notices("daily_report"))[0]!;
    expect(await telegramText(report.id)).toContain("Abgelehnt: 2");
  });

  it("expands the strategy's uncovered slot to every channel of its group (I3)", async () => {
    await shared({});
    await h.run((tx) =>
      planAssignmentRuns(tx, project.owner, tomorrowMorning()),
    );
    for (const role of ["analytics", "research"]) {
      const found = await h.task(role);
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", found.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "failed",
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    const [runRow] = await h.rows("assignment_runs");
    const all = runRow!.slots as Array<{ channel: string; at: string }>;
    const times = [...new Set(all.map((slot) => slot.at))].sort();
    // A brief for the first time only.
    provider.replies.push((request) => ({
      output: [
        message({
          briefs: JSON.parse(request.input[0].content)
            .run.slots.filter((slot: any) => slot.at === times[0])
            .map((slot: any) => h.brief(slot)),
        }),
      ],
    }));
    await runAgentTask(h.worker(), (await h.task("strategy")).id);
    const strategy = await h.task("strategy");
    expect(strategy.output.uncovered.map((s: any) => s.channel).sort()).toEqual(
      [TELEGRAM, X].sort(),
    );
    const problems = await h.run(async (tx) =>
      runProblems(
        tx,
        project.owner,
        await entity(tx, project.owner, "assignment_runs", runRow!.id),
      ),
    );
    expect(
      problems.dropped
        .map((entry) => `${entry.channel}@${entry.slotAt}`)
        .sort(),
    ).toEqual(
      all
        .filter((slot) => slot.at === times[1])
        .map((slot) => `${slot.channel}@${slot.at}`)
        .sort(),
    );
  });

  it("leaves the copy for the owner when the text changed after the model judged it", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review, slots } = await drafted();
    const first = slots.find((slot) => slot.channel === TELEGRAM)!;
    provider.replies.push(async (request) => {
      // The first slot's text changes while the model is answering.
      const target = (await contents()).find(
        (c) => c.channel === TELEGRAM && c.scheduledAt === first.at,
      )!;
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", target.id);
        await update(tx, project.owner, row, {
          ...data(row),
          body: `${data(row).body} Changed.`,
        });
      });
      return approveAll(request);
    });
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const original = drafts.find(
      (c) => c.channel === TELEGRAM && c.scheduledAt === first.at,
    )!;
    const copy = drafts.find((c) => c.sharedFrom?.contentId === original.id)!;
    // Neither carries the approval of a text the model did not see.
    for (const draft of [original, copy]) {
      expect(draft.status).toBe("needs_review");
      expect(draft).not.toHaveProperty("agentReview");
    }
    expect(original.agentReviewDecision.deterministicProblems).toEqual([
      "AGENT_REVIEW_TEXT_CHANGED",
    ]);
    expect(copy.agentReviewDecision.verdict).toBe("needs_owner");
    // The other slot goes on both channels.
    expect(await h.rows("postiz_drafts")).toHaveLength(2);
  });

  it("copies nothing twice when the review task runs again", async () => {
    await linkBot();
    await shared({ delivery: "postiz_draft" });
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const before = await contents();
    expect(before).toHaveLength(4);
    const output = (await reviewAgain(review.id)) as any;
    const after = await contents();
    expect(after.map((c) => c.id).sort()).toEqual(
      before.map((c) => c.id).sort(),
    );
    expect(after.map((c) => c.version)).toEqual(before.map((c) => c.version));
    // No second model call; the copies report their recorded decisions.
    expect(provider.requests).toHaveLength(1);
    expect(
      output.decisions
        .filter((d: any) => d.sharedFrom)
        .map((d: any) => d.verdict),
    ).toEqual(["approve", "approve"]);
  });

  it("rejects a draft that misses the format while the project is paused (stricter)", async () => {
    await linkBot();
    await shared({
      delivery: "postiz_draft",
      format: {
        minChars: 120,
        maxChars: 200,
        hashtags: { min: 2, max: 3 },
        paragraphs: true,
      },
    });
    const { review } = await drafted();
    await h.run((tx) =>
      tx.project.update({
        where: { id: project.owner.projectId },
        data: { paused: true },
      }),
    );
    await runAgentTask(h.worker(), review.id);
    // No revision, no model call, no copy: format problems with a pause reject.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(0);
    const drafts = await contents();
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.status).toBe("rejected");
      expect(draft.agentReviewDecision.deterministicProblems).toEqual(
        expect.arrayContaining(["FORMAT_LENGTH", "PROJECT_PAUSED"]),
      );
    }
  });

  it("drops the image of a copy for a channel without media support (M5)", async () => {
    await linkBot();
    // X becomes a channel Orbit knows no media support for.
    await h.run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors")).find(
        (row) => data(row).provider === "postiz",
      )!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        channels: data(connector).channels.map((channel: any) =>
          channel.id === X
            ? { ...channel, identifier: "unknown-network" }
            : channel,
        ),
      });
    });
    await shared({ image: true, delivery: "postiz_draft" });
    const { review } = await drafted();
    provider.replies.push(approveAll);
    await runAgentTask(h.worker(), review.id);
    const drafts = await contents();
    const [image] = await h.rows("assets");
    for (const original of drafts.filter((c) => c.channel === TELEGRAM)) {
      expect(original.assetId).toBe(image!.id);
      const copy = drafts.find((c) => c.sharedFrom?.contentId === original.id)!;
      expect(copy.assetId).toBeUndefined();
      expect(copy.imageSkipped).toBe("MEDIA_NOT_SUPPORTED");
      expect(copy.body).toBe(original.body);
    }
  });

  it("gives the copywriter the recent posts of every channel of the slot (M6)", async () => {
    await shared({});
    await h.run((tx) =>
      create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: "external-x",
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
        state: "PUBLISHED",
        text: "An X post from another tool about beta teams.",
        source: "external",
        syncedAt: new Date().toISOString(),
      }),
    );
    await drafted();
    for (const contract of contracts())
      expect(JSON.stringify(contract.recentChannelPosts)).toContain(
        "An X post from another tool about beta teams.",
      );
  });
});
