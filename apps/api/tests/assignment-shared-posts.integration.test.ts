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
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { preflight } from "../src/modules/policy.ts";
import { releaseAssignmentDraft } from "../src/modules/agents/owner-release.ts";
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
      expect(copy.agentReview).toEqual(original.agentReview);
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
});
