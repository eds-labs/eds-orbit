import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model, image and Social call is a mock or a database row; nothing
// here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  // A live post needs an evaluated live index, which is outside this file's scope.
  liveIndex: false,
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
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import { create, data, list, update } from "../src/shared.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { strategySpecialist } from "../src/modules/marketing/agents/specialists/strategy.ts";
import { marketingHistory, reserveTopic } from "../src/modules/marketing/agents/novelty.ts";
import { releaseAssignmentDraft } from "../src/modules/marketing/agents/owner-release.ts";
import { draftsAwaitingOwner } from "../src/modules/marketing/agents/assignment-overview.ts";
import {
  nextAssignmentRunAt,
  planAssignmentRuns,
} from "../src/modules/marketing/agents/assignment-runs.ts";
import {
  dispatchPublication,
  reconcilePublication,
} from "../src/modules/marketing/publishing/publisher.ts";
import { forcePublishingBackend } from "./support/marketing-backend.ts";
import { addBrandKit } from "./support/package-creative.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
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
const MINUTE = 60000;
const FACEBOOK = "fb-int";
const INSTAGRAM = "ig-int";
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
/** The target configuration: one post a day at 18:30 local, prepared at 08:00. */
const DAILY_SCHEDULE = {
  rhythm: "daily",
  weekdays: [],
  times: ["18:30"],
  leadMinutes: 630,
};

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

/** Tomorrow 08:00 UTC: after the run is due (06:00/07:00 UTC) and before the 18:30 Berlin slot. */
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

/**
 * The target configuration (FamilyPlan-like): a project on the Social
 * backend with a Facebook and an Instagram account mapped to two channels,
 * policy `assisted`, and the assignment `daily` at 18:30 with a 630 minute
 * lead, delivery `publish`, approval `human_each` and one art per run.
 * `morning` is the planner's clock for runs that are planned.
 */
async function dailyProject(
  morning = tomorrowMorning(),
  options: { native?: boolean } = {},
) {
  const project = await createPackageProject();
  const h = assignmentRun(project, morning);
  const { owner } = project;
  await h.setPolicy({
    mode: "assisted",
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2027-12-31T00:00:00.000Z",
    channels: [FACEBOOK, INSTAGRAM],
    contentTypes: ["social"],
    maxPerDay: 2,
    minIntervalMinutes: 120,
  });
  // The Facebook and Instagram channels Marketing knows, each mapped to a Social account.
  const accounts = await h.run(async (tx) => {
    const connector = (await list(tx, owner, "connectors")).find(
      (row) => data(row).provider === "postiz",
    )!;
    const d = data(connector);
    await update(tx, owner, connector, {
      ...d,
      channels: [
        ...d.channels,
        {
          id: FACEBOOK,
          name: "Synthetic Facebook",
          identifier: "facebook",
          disabled: false,
        },
        {
          id: INSTAGRAM,
          name: "Synthetic Instagram",
          identifier: "instagram",
          disabled: false,
        },
      ],
      assignedIntegrationIds: [
        ...d.assignedIntegrationIds,
        FACEBOOK,
        INSTAGRAM,
      ],
    });
    await tx.projectModule.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        moduleId: "social",
        enabled: true,
        moduleVersion: "0.1.0",
        changedBy: owner.userId,
      },
    });
    const account = (platform: string, channel: string, handle: string) =>
      tx.socialAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          connectionId: randomUUID(),
          platform,
          externalId: `${platform}-4242`,
          handle,
          displayName: handle,
          capability: "write_verified",
          // A native project names the account itself (`social:<accountId>`).
          ...(options.native ? {} : { legacyPostizIntegrationId: channel }),
          createdBy: owner.userId,
        },
      });
    return {
      facebook: await account("facebook", FACEBOOK, "synthetic.facebook"),
      instagram: await account("instagram", INSTAGRAM, "synthetic.instagram"),
    };
  });
  await h.run((tx) => forcePublishingBackend(tx, owner, "social"));
  const channels = options.native
    ? [`social:${accounts.facebook.id}`, `social:${accounts.instagram.id}`]
    : [FACEBOOK, INSTAGRAM];
  if (options.native) await h.setPolicy({ channels });
  // Lumora brand kit: the project opts in to automatic creatives; both
  // channels take the default 1080x1350 feed portrait.
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
    (await h.rows("content")).sort((a, b) =>
      channels.indexOf(a.channel) - channels.indexOf(b.channel),
    );
  const publications = () => h.rows("publications");
  const socialPosts = () =>
    h.run((tx) =>
      tx.socialPost.findMany({ where: { projectId: owner.projectId } }),
    );
  /** Plans the run with a brief and creative brief per slot, then writes texts and art; the review is left to run. */
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
  /** The run's review with every draft approved by the (mocked) review model. */
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
    publications,
    socialPosts,
    drafted,
    reviewed,
    release,
  };
}

/** Pins what the daily social automation relies on, so later tasks cannot break it unnoticed. */
/** Live-mode environment so the hand-off to Social is real (a test publication never reaches Social). */
function liveSocialEnv() {
  vi.stubEnv("EXECUTION_MODE", "live");
  vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
  vi.stubEnv("ORBIT_SOCIAL_PLATFORMS", "facebook,instagram");
  // The media hand-off stores the rendition as a platform file.
  vi.stubEnv("ORBIT_FILES", "true");
  vi.stubEnv("FILES_BACKEND", "database");
  vi.stubEnv("FILES_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  // Instagram fetches media by a signed public URL.
  vi.stubEnv("ORBIT_SOCIAL_MEDIA_PUBLIC", "true");
  vi.stubEnv("ORBIT_PUBLIC_INGRESS", "true");
  provider.liveIndex = true;
}

describe.skipIf(!enabled)("Daily social automation baseline", () => {
  let daily: Awaited<ReturnType<typeof dailyProject>>;

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_CREATIVE_STUDIO = "true";
    process.env.ORBIT_SOCIAL = "true";
    provider.replies = [];
    provider.liveIndex = false;
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
    const image = async (params: any) => {
      const [width, height] = String(params.size).split("x").map(Number);
      const art = await fixtureArt("good", "lumora", {
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
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const key of [
      "ORBIT_AGENTS",
      "ORBIT_AGENT_REVIEW_AUTHORITY",
      "ORBIT_CREATIVE_STUDIO",
      "ORBIT_SOCIAL",
      "ORBIT_SOCIAL_PLATFORMS",
      "ORBIT_SOCIAL_MEDIA_PUBLIC",
      "ORBIT_PUBLIC_INGRESS",
      "EXECUTION_MODE",
      "ENABLE_EXTERNAL_WRITES",
    ])
      delete process.env[key];
    await daily?.project.cleanup();
  });
  afterAll(() => closeDatabase());

  /** A run planned at `now`: its slots and the day's earliest run time as seen one minute before. */
  const planAt = async (now: Date) => {
    daily = await dailyProject(now);
    const { h, project, assignment } = daily;
    const row = await h.run((tx) => list(tx, project.owner, "assignments"));
    const timezone = "Europe/Berlin";
    const due = await h.run((tx) =>
      nextAssignmentRunAt(
        tx,
        project.owner,
        row.find((r) => r.id === assignment.id)!,
        timezone,
        new Date(now.valueOf() - MINUTE),
      ),
    );
    await h.run((tx) => planAssignmentRuns(tx, project.owner, now));
    const [run] = await h.rows("assignment_runs");
    return { due, run: run! };
  };

  it("plans the run at 08:00 Berlin for an 18:30 slot in winter and summer time", async () => {
    // Winter: 08:00 CET is 07:00Z, 18:30 CET is 17:30Z.
    const winter = await planAt(new Date("2026-01-15T07:00:00Z"));
    expect(winter.due?.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(winter.run.slots[0].at).toBe("2026-01-15T17:30:00.000Z");
    expect(winter.run.date).toBe("2026-01-15");
    await daily.project.cleanup();
    // Summer: 08:00 CEST is 06:00Z, 18:30 CEST is 16:30Z.
    const summer = await planAt(new Date("2026-07-15T06:00:00Z"));
    expect(summer.due?.toISOString()).toBe("2026-07-15T06:00:00.000Z");
    expect(summer.run.slots[0].at).toBe("2026-07-15T16:30:00.000Z");
    expect(summer.run.date).toBe("2026-07-15");
  });

  it("keeps 08:00 and 18:30 local on both DST switch days", async () => {
    // Spring forward 2026-03-29: CEST from 01:00Z.
    const spring = await planAt(new Date("2026-03-29T06:00:00Z"));
    expect(spring.due?.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(spring.run.date).toBe("2026-03-29");
    expect(spring.run.slots[0].at).toBe("2026-03-29T16:30:00.000Z");
    await daily.project.cleanup();
    // Fall back 2026-10-25: CET from 01:00Z.
    const autumn = await planAt(new Date("2026-10-25T07:00:00Z"));
    expect(autumn.due?.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(autumn.run.date).toBe("2026-10-25");
    expect(autumn.run.slots[0].at).toBe("2026-10-25T17:30:00.000Z");
  });

  it("a creative run renders a 1080x1350 rendition per channel", async () => {
    daily = await dailyProject();
    const { h, contents } = daily;
    await daily.drafted();
    // One art for the run (artPer run), not one per post.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const drafts = await contents();
    expect(drafts.map((d) => d.channel)).toEqual([FACEBOOK, INSTAGRAM]);
    const assets = await h.rows("assets");
    for (const draft of drafts) {
      const rendition = assets.find((a) => a.id === draft.assetId)!;
      expect(rendition).toMatchObject({
        creativeFormat: "feed_portrait",
        width: 1080,
        height: 1350,
      });
    }
  });

  it("human_each leaves both drafts for the owner and creates no publication", async () => {
    // Even with the agent's review authority on and a linked bot.
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    daily = await dailyProject();
    const { h, project, publications, reviewed } = daily;
    await h.connectTelegram();
    await daily.drafted();
    await reviewed();
    expect((await h.task("review")).status).toBe("done");
    const waiting = await h.run((tx) => draftsAwaitingOwner(tx, project.owner));
    expect(waiting).toHaveLength(2);
    expect(waiting.map((item) => item.channel).sort()).toEqual([
      FACEBOOK,
      INSTAGRAM,
    ]);
    expect(await publications()).toEqual([]);
  });

  it("a failed image skips review and delivers nothing", async () => {
    provider.generateImage
      .mockReset()
      .mockRejectedValue(new Error("IMAGE_PROVIDER_DOWN"));
    provider.generateImageWithReferences
      .mockReset()
      .mockRejectedValue(new Error("IMAGE_PROVIDER_DOWN"));
    daily = await dailyProject();
    const { h, project, publications } = daily;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await daily.drafted();
    expect((await h.task("visual")).status).toBe("failed");
    const [run] = await h.rows("assignment_runs");
    // Observed: the run is "partial", not "failed" (the failed visual step, with
    // analytics and research failed by the harness, leaves it partial). What
    // matters for delivery is that review is skipped.
    expect(run!.status).toBe("partial");
    expect(run!.steps.find((s: any) => s.key === "review")?.status).toBe(
      "skipped",
    );
    expect(await h.run((tx) => draftsAwaitingOwner(tx, project.owner))).toEqual(
      [],
    );
    expect(await publications()).toEqual([]);
  });

  it("a redelivered publication job makes one Social post", async () => {
    liveSocialEnv();
    daily = await dailyProject();
    const { project, contents, publications, socialPosts, reviewed, release } =
      daily;
    await daily.drafted();
    await reviewed();
    const drafts = await contents();
    expect(drafts.map((d) => d.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
    for (const draft of drafts) await release(draft);
    const pubs = await publications();
    expect(pubs).toHaveLength(2);
    const slot = new Date(pubs[0]!.scheduledAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slot.valueOf() + MINUTE));
    for (const pub of pubs) await dispatchPublication(project.owner, pub.id);
    expect((await publications()).map((p) => p.status)).toEqual([
      "scheduled_remote",
      "scheduled_remote",
    ]);
    expect(await socialPosts()).toHaveLength(2);
    // The queue delivers the job again: nothing new is handed over.
    for (const pub of pubs) await dispatchPublication(project.owner, pub.id);
    expect(await socialPosts()).toHaveLength(2);
  });

  async function releasedAt(minutesAfterSlot: number) {
    liveSocialEnv();
    daily = await dailyProject();
    await daily.drafted();
    await daily.reviewed();
    for (const draft of await daily.contents()) await daily.release(draft);
    const pubs = await daily.publications();
    expect(pubs).toHaveLength(2);
    const slot = new Date(pubs[0]!.scheduledAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slot.valueOf() + minutesAfterSlot * MINUTE));
    return pubs;
  }

  it("a publication job 31 minutes after the slot is blocked with SLOT_EXPIRED", async () => {
    const pubs = await releasedAt(31);
    for (const pub of pubs)
      await dispatchPublication(daily.project.owner, pub.id);
    const after = await daily.publications();
    expect(after.map((p) => p.status)).toEqual([
      "blocked_dependency",
      "blocked_dependency",
    ]);
    for (const p of after) expect(p.blockers).toEqual(["SLOT_EXPIRED"]);
    expect(await daily.socialPosts()).toHaveLength(0);
    const open = (await daily.h.rows("exceptions")).filter(
      (x) => x.code === "PUBLISH_PREFLIGHT_BLOCKED" && x.status === "open",
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.resourceIds).toEqual(
      expect.arrayContaining(pubs.map((p) => p.id)),
    );
  });

  it("a publication job 29 minutes after the slot still goes out", async () => {
    const pubs = await releasedAt(29);
    for (const pub of pubs)
      await dispatchPublication(daily.project.owner, pub.id);
    expect((await daily.publications()).map((p) => p.status)).toEqual([
      "scheduled_remote",
      "scheduled_remote",
    ]);
    expect(await daily.socialPosts()).toHaveLength(2);
  });

  it("an assignment on social: channels is released and handed to Social at the slot", async () => {
    liveSocialEnv();
    daily = await dailyProject(tomorrowMorning(), { native: true });
    const { project, accounts, channels, contents, publications, socialPosts, reviewed, release } =
      daily;
    await daily.drafted();
    await reviewed();
    const drafts = await contents();
    expect(drafts.map((d) => d.channel)).toEqual(channels);
    for (const draft of drafts) await release(draft);
    const pubs = await publications();
    expect(pubs).toHaveLength(2);
    const slot = new Date(pubs[0]!.scheduledAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slot.valueOf() + MINUTE));
    for (const pub of pubs) await dispatchPublication(project.owner, pub.id);
    expect((await publications()).map((p) => p.status)).toEqual([
      "scheduled_remote",
      "scheduled_remote",
    ]);
    // One Social post per account, handed over once.
    const posts = await socialPosts();
    expect(posts).toHaveLength(2);
    const variants = await daily.h.run((tx) =>
      tx.socialPostVariant.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    expect(variants.map((v) => v.accountId).sort()).toEqual(
      [accounts.facebook.id, accounts.instagram.id].sort(),
    );
    // Social publishes; Marketing reconciles the permalink.
    await daily.h.run(async (tx) => {
      for (const variant of variants)
        await tx.socialPublication.create({
          data: {
            id: randomUUID(),
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            variantId: variant.id,
            accountId: variant.accountId,
            idempotencyKey: randomUUID(),
            status: "published",
            externalPostId: `ext-${variant.id}`,
            permalink: `https://example.test/${variant.id}`,
            publishedAt: new Date(),
          },
        });
      await tx.socialPost.updateMany({
        where: { projectId: project.owner.projectId },
        data: { status: "published" },
      });
    });
    for (const pub of pubs) await reconcilePublication(project.owner, pub.id);
    const done = await publications();
    expect(done.map((p) => p.status)).toEqual(["published", "published"]);
    for (const p of done) expect(String(p.releaseUrl ?? "")).toContain("https://example.test/");
  });

  it("the strategy input of a 30-day assignment carries 30 days of history, recentTopics and a Social-native post", async () => {
    daily = await dailyProject(tomorrowMorning(), { native: true });
    const { h, project, accounts, channels } = daily;
    const { owner } = project;
    const day = 86_400_000;
    // A native post by hand on Facebook 20 days ago, beyond the 14-day default.
    await h.run(async (tx) => {
      const id = randomUUID();
      const variantId = randomUUID();
      await tx.socialPost.create({
        data: {
          id,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          status: "published",
          baseText: "Hand-written native post about onboarding",
          baseMedia: [],
          scheduleTimezone: "UTC",
          createdBy: owner.userId,
        },
      });
      await tx.socialPostVariant.create({
        data: {
          id: variantId,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          postId: id,
          accountId: accounts.facebook.id,
          body: "Hand-written native post about onboarding",
          contentHash: "a".repeat(64),
        },
      });
      await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          variantId,
          accountId: accounts.facebook.id,
          idempotencyKey: randomUUID(),
          status: "published",
          publishedAt: new Date(Date.now() - 20 * day),
        },
      });
      await reserveTopic(tx, owner, {
        channel: channels[0]!,
        identity: { topic: "Onboarding", angle: "First week", pillar: "Education" },
        ownerKey: "history:test",
        holdDays: 30,
      });
    });
    const prepare = async (changes: Record<string, unknown>) => {
      const assignment = await h.makeAssignment({ channels, ...changes });
      const prepared = await h.run((tx) =>
        strategySpecialist.prepareInput!(tx, owner, {
          assignment: data(assignment),
          run: { slots: [] },
        }),
      );
      return prepared.input as any;
    };
    const long = await prepare({ historyDays: 30 });
    expect(long.channelHistory.days).toBe(30);
    expect(
      long.channelHistory.channels.flatMap((c: any) => c.posts).map((p: any) => p.text),
    ).toContain("Hand-written native post about onboarding");
    expect(long.recentTopics).toEqual([
      expect.objectContaining({
        channel: channels[0],
        topic: "Onboarding",
        angle: "First week",
        pillar: "Education",
      }),
    ]);
    const short = await prepare({});
    expect(short.channelHistory.days).toBe(14);
    expect(
      short.channelHistory.channels.flatMap((c: any) => c.posts).map((p: any) => p.text),
    ).not.toContain("Hand-written native post about onboarding");
    expect(strategySpecialist.instructions).toMatch(/recentTopics/);
  });

  it("native Social posts survive a busy Orbit history in the history and the strategy input", async () => {
    daily = await dailyProject(tomorrowMorning(), { native: true });
    const { h, project, accounts, channels } = daily;
    const { owner } = project;
    await h.run(async (tx) => {
      for (const [account, channel, name] of [
        [accounts.facebook, channels[0]!, "Facebook"],
        [accounts.instagram, channels[1]!, "Instagram"],
      ] as const) {
        for (let i = 0; i < 10; i++)
          await create(tx, owner, "content", {
            channel,
            title: `Busy ${name} ${i}`,
            body: `Busy ${name} draft ${i}`,
            status: "needs_review",
          });
        const id = randomUUID();
        const variantId = randomUUID();
        await tx.socialPost.create({
          data: {
            id,
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            status: "published",
            baseText: `Native ${name} post`,
            baseMedia: [],
            scheduleTimezone: "UTC",
            createdBy: owner.userId,
          },
        });
        await tx.socialPostVariant.create({
          data: {
            id: variantId,
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            postId: id,
            accountId: account.id,
            body: `Native ${name} post`,
            contentHash: "a".repeat(64),
          },
        });
        await tx.socialPublication.create({
          data: {
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            variantId,
            accountId: account.id,
            idempotencyKey: randomUUID(),
            status: "published",
            publishedAt: new Date(Date.now() - 3 * 86_400_000),
          },
        });
      }
    });
    const history = await h.run((tx) =>
      marketingHistory(tx, owner, channels),
    );
    expect(
      history.items
        .filter((i) => i.recordKind === "social_posts")
        .map((i) => i.text)
        .sort(),
    ).toEqual(["Native Facebook post", "Native Instagram post"]);
    const assignment = await h.makeAssignment({ channels });
    const prepared = await h.run((tx) =>
      strategySpecialist.prepareInput!(tx, owner, {
        assignment: data(assignment),
        run: { slots: [] },
      }),
    );
    const texts = (prepared.input as any).channelHistory.channels.flatMap(
      (c: any) => c.posts.map((p: any) => p.text),
    );
    expect(texts).toContain("Native Facebook post");
    expect(texts).toContain("Native Instagram post");
    expect((prepared.input as any).channelHistory.social).toEqual({
      coverage: "ok",
    });
  });
});
