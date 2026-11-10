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
  // The next read of an approved image fails like a storage outage.
  exportFails: 0,
}));
vi.mock(
  "../src/modules/marketing/pipeline/content-export.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/modules/marketing/pipeline/content-export.ts")
      >();
    return {
      ...actual,
      exportAssetContent: async (
        ...args: Parameters<typeof actual.exportAssetContent>
      ) => {
        if (provider.exportFails > 0) {
          provider.exportFails--;
          throw new Error("STORAGE_TEMPORARILY_DOWN");
        }
        return actual.exportAssetContent(...args);
      },
    };
  },
);
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
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
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
  syncSocialHolds,
} from "../src/modules/marketing/publishing/publisher.ts";
import { marketingJobs } from "../src/modules/marketing/jobs.ts";
import { marketingHooks } from "../src/modules/marketing/hooks.ts";
import { claimPublication as claimMarketingPublication } from "../src/modules/marketing/pipeline/workflow.ts";
import { assignmentDetail } from "../src/modules/marketing/agents/assignment-detail.ts";
import { calendarItems } from "../src/modules/social/calendar/calendar.ts";
import { getPost, listPosts, updatePost } from "../src/modules/social/posts/posts.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { claimPublication } from "../src/modules/social/dispatch/claim.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { DISPATCH, dispatchJob } from "../src/modules/social/dispatch/jobs.ts";
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
  options: { native?: boolean; shared?: boolean } = {},
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
    // One content package (text and image) for both platforms.
    ...(options.shared ? { sharedAcrossChannels: true } : {}),
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
      slots
        // A shared slot gets one brief, on its strictest channel (Instagram).
        .filter((slot) => !options.shared || slot.channel === channels[1])
        .map((slot) => h.brief(slot, { creative: CREATIVE_BRIEF })),
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
    provider.exportFails = 0;
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

  /**
   * Released drafts handed to Social `minutesAfterSlot` after the slot (the
   * clock stays there) and dispatched by Social's job: the slot and the
   * Social publications.
   */
  async function handedOverAt(minutesAfterSlot: number) {
    const pubs = await releasedAt(minutesAfterSlot);
    const { owner } = daily.project;
    for (const pub of pubs) await dispatchPublication(owner, pub.id);
    expect((await daily.publications()).map((p) => p.status)).toEqual([
      "scheduled_remote",
      "scheduled_remote",
    ]);
    const worker = daily.h.worker();
    for (const job of (await daily.h.rows("jobs")).filter(
      (j) => j.topic === DISPATCH,
    ))
      await (dispatchJob.handler as (ctx: unknown) => Promise<unknown>)({
        scope: worker,
        job,
      });
    const socialPubs = await daily.h.run((tx) =>
      tx.socialPublication.findMany({
        where: { projectId: owner.projectId },
      }),
    );
    expect(socialPubs).toHaveLength(2);
    return { slot: new Date(pubs[0]!.scheduledAt), socialPubs, worker };
  }

  it("Social measures its 30 minutes from the slot: a retry 35 minutes after a hand-off at slot+20 expires unsent", async () => {
    let calls = 0;
    setSocialFetchForTests(async () => {
      calls++;
      return new Response("{}", { status: 500 });
    });
    try {
      const { slot, socialPubs, worker } = await handedOverAt(20);
      for (const pub of socialPubs)
        expect((pub.providerState as any).originSlotAt).toBe(
          slot.toISOString(),
        );
      // A first attempt failed temporarily; its retry is due at slot+34.
      await daily.h.run((tx) =>
        tx.socialPublication.updateMany({
          where: { id: { in: socialPubs.map((p) => p.id) } },
          data: {
            status: "failed",
            retryDisposition: "after-delay",
            nextAttemptAt: new Date(slot.valueOf() + 34 * MINUTE),
            attempts: 1,
          },
        }),
      );
      vi.setSystemTime(new Date(slot.valueOf() + 35 * MINUTE));
      for (const pub of socialPubs)
        expect(await deliverPublication(worker, pub.id)).toEqual({
          status: "succeeded",
          errorCode: "SOCIAL_SLOT_EXPIRED",
        });
      const after = await daily.h.run((tx) =>
        tx.socialPublication.findMany({
          where: { id: { in: socialPubs.map((p) => p.id) } },
        }),
      );
      for (const pub of after)
        expect(pub).toMatchObject({
          status: "failed",
          retryDisposition: "never",
          lastErrorCode: "SOCIAL_SLOT_EXPIRED",
        });
      expect(calls).toBe(0);
    } finally {
      setSocialFetchForTests(null);
    }
  });

  it("Social still sends a hand-off at slot+5 claimed at slot+25", async () => {
    const { slot, socialPubs, worker } = await handedOverAt(5);
    const claimAt = new Date(slot.valueOf() + 25 * MINUTE);
    vi.setSystemTime(claimAt);
    for (const pub of socialPubs) {
      const claim = await scoped(worker.workspaceId, worker.projectId, (tx) =>
        claimPublication(tx, worker, pub.id, claimAt),
      );
      expect(claim.kind).toBe("claimed");
    }
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

  describe("from the owner's release to the Social calendar", () => {
    /** Released drafts of a native run: two publications waiting for the slot. */
    async function released() {
      liveSocialEnv();
      daily = await dailyProject(tomorrowMorning(), { native: true });
      await daily.drafted();
      await daily.reviewed();
      for (const draft of await daily.contents()) await daily.release(draft);
      const pubs = await daily.publications();
      expect(pubs).toHaveLength(2);
      return { pubs, slot: new Date(pubs[0]!.scheduledAt) };
    }
    const atMinutes = (slot: Date, minutes: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(slot.valueOf() + minutes * MINUTE));
    };
    const calendar = (slot: Date) =>
      daily.h.run((tx) =>
        calendarItems(tx, daily.project.owner, {
          from: new Date(slot.valueOf() - 3600000).toISOString(),
          to: new Date(slot.valueOf() + 3600000).toISOString(),
        }),
      );
    const dispatchJobs = async () =>
      (await daily.h.rows("jobs")).filter((j) => j.topic === DISPATCH);

    it("shows a released post in the calendar at once, with account and image, and nothing can send it", async () => {
      const { slot } = await released();
      const { owner } = daily.project;
      await syncSocialHolds(daily.h.worker());
      const posts = await daily.socialPosts();
      expect(posts).toHaveLength(2);
      for (const post of posts) {
        expect(post).toMatchObject({
          origin: "marketing",
          originType: "publication",
          status: "scheduled",
          scheduleMode: "at",
          approvedAt: null,
        });
        expect(post.scheduledAt).toEqual(slot);
      }
      const { items } = await calendar(slot);
      expect(items).toHaveLength(2);
      for (const item of items)
        expect(item).toMatchObject({ origin: "marketing", status: "scheduled", readOnly: true });
      expect(items.flatMap((i) => i.accounts.map((a) => a.platform)).sort()).toEqual(["facebook", "instagram"]);
      // Every view names Marketing's publication behind the held post; its
      // native approval stays "none" (Marketing released it, not Social).
      const pubIds = (await daily.publications()).map((p) => p.id).sort();
      expect(items.map((i) => i.originRef?.id).sort()).toEqual(pubIds);
      for (const item of items) {
        expect(item.originRef).toEqual({ module: "marketing", type: "publication", id: expect.any(String) });
        expect(item.approvalState).toBe("none");
      }
      const listed = await daily.h.run((tx) => listPosts(tx, owner, {}));
      for (const post of listed.items)
        expect(post).toMatchObject({
          originRef: { module: "marketing", type: "publication" },
          approvalState: "none",
          readOnly: true,
        });
      for (const post of posts) {
        const view = await daily.h.run((tx) => getPost(tx, owner, post.id));
        expect(view.originRef).toEqual({ module: "marketing", type: "publication", id: post.originId });
        expect(view.approval).toMatchObject({ state: "none", approvedAt: null, approvedBy: null });
        expect(view.readOnly).toBe(true);
      }
      const media = await daily.h.run((tx) =>
        tx.socialPostMedia.findMany({ where: { projectId: owner.projectId } }),
      );
      expect(media).toHaveLength(2);
      // Announced only: no delivery exists, and Social cannot change it.
      expect(await dispatchJobs()).toHaveLength(0);
      await expect(
        daily.h.run((tx) =>
          updatePost(tx, owner, posts[0]!.id, {
            version: posts[0]!.version,
            baseText: "Changed in Social",
            baseMedia: [],
            variants: [{ accountId: daily.accounts.facebook.id }],
          }),
        ),
      ).rejects.toThrow("SOCIAL_POST_READ_ONLY");
      expect((await daily.publications()).map((p) => p.status)).toEqual([
        "intent_created",
        "intent_created",
      ]);
    });

    it("sends that same post at the slot, keeps it in the calendar, and repeats change nothing", async () => {
      const { pubs, slot } = await released();
      const { owner } = daily.project;
      const worker = daily.h.worker();
      await syncSocialHolds(worker);
      await syncSocialHolds(worker);
      const held = (await daily.socialPosts()).map((p) => p.id).sort();
      expect(held).toHaveLength(2);
      atMinutes(slot, 1);
      for (const pub of pubs) await dispatchPublication(owner, pub.id);
      for (const pub of pubs) await dispatchPublication(owner, pub.id);
      await syncSocialHolds(worker);
      const posts = await daily.socialPosts();
      expect(posts.map((p) => p.id).sort()).toEqual(held);
      for (const post of posts) {
        expect(post).toMatchObject({ status: "scheduled", scheduleMode: "at" });
        expect(post.approvedAt).not.toBeNull();
        expect(post.scheduledAt).toEqual(slot);
        expect(post.packageHash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect((await daily.publications()).map((p) => p.status)).toEqual([
        "scheduled_remote",
        "scheduled_remote",
      ]);
      const jobs = await dispatchJobs();
      expect(jobs).toHaveLength(2);
      for (const job of jobs)
        await (dispatchJob.handler as (ctx: unknown) => Promise<unknown>)({ scope: worker, job });
      const sent = await daily.h.run((tx) =>
        tx.socialPublication.findMany({ where: { projectId: owner.projectId } }),
      );
      expect(sent).toHaveLength(2);
      const { items } = await calendar(slot);
      expect(items).toHaveLength(2);
      for (const item of items) expect(item.status).toBe("publishing");
      // Handed over: the same reference, and the hand-off's approval as before.
      for (const post of posts) {
        const view = await daily.h.run((tx) => getPost(tx, owner, post.id));
        expect(view.originRef).toEqual({ module: "marketing", type: "publication", id: post.originId });
        expect(view.approval).toMatchObject({ state: "approved", approvedAt: expect.any(String) });
      }
    });

    it("takes a held post back when Marketing no longer sends it, and a paused project too", async () => {
      const { pubs } = await released();
      const { owner } = daily.project;
      const worker = daily.h.worker();
      await syncSocialHolds(worker);
      await daily.h.run(async (tx) => {
        const row = (await list(tx, owner, "publications")).find((r) => r.id === pubs[0]!.id)!;
        await update(tx, owner, row, { ...data(row), status: "canceled", reason: "VETOED" });
      });
      await syncSocialHolds(worker);
      const status = async (pubId: string) =>
        (await daily.socialPosts()).find((p) => p.originId === pubId)!.status;
      expect(await status(pubs[0]!.id)).toBe("canceled");
      expect(await status(pubs[1]!.id)).toBe("scheduled");
      await daily.h.run((tx) => marketingHooks.onProjectPause!(tx, owner, {} as never));
      await syncSocialHolds(worker);
      expect(await status(pubs[1]!.id)).toBe("canceled");
      expect(await dispatchJobs()).toHaveLength(0);
    });

    it("gives a claim back after a worker restart: the post goes out once, without a second approval", async () => {
      const { pubs, slot } = await released();
      const { owner } = daily.project;
      const worker = daily.h.worker();
      await syncSocialHolds(worker);
      atMinutes(slot, 1);
      const pubId = pubs[0]!.id;
      const claim = await daily.h.run((tx) => claimMarketingPublication(tx, worker, pubId));
      expect(claim.send).toBe(true);
      const publishing = marketingJobs.find((j) => j.queueClass === "publishing")!;
      await daily.h.run((tx) =>
        publishing.onLeaseExpired!(tx, worker, { resourceId: pubId }),
      );
      const reset = (await daily.publications()).find((p) => p.id === pubId)!;
      expect(reset.status).toBe("intent_created");
      await dispatchPublication(owner, pubId);
      expect((await daily.publications()).find((p) => p.id === pubId)!.status).toBe("scheduled_remote");
      expect(await dispatchJobs()).toHaveLength(1);
    });

    it("retries a temporary failure at the slot and loses nothing", async () => {
      const { pubs, slot } = await released();
      const { owner } = daily.project;
      atMinutes(slot, 1);
      const pubId = pubs[0]!.id;
      provider.exportFails = 1;
      await expect(dispatchPublication(owner, pubId)).rejects.toThrow("SOCIAL_HANDOFF_RETRY");
      expect((await daily.publications()).find((p) => p.id === pubId)).toMatchObject({ status: "intent_created" });
      await dispatchPublication(owner, pubId);
      expect((await daily.publications()).find((p) => p.id === pubId)).toMatchObject({ status: "scheduled_remote" });
      expect(await daily.socialPosts()).toHaveLength(1);
    });

    it("never catches up a slot that passed: the post is blocked and its calendar entry taken back", async () => {
      const { slot } = await released();
      const worker = daily.h.worker();
      await syncSocialHolds(worker);
      atMinutes(slot, 31);
      await syncSocialHolds(worker);
      const after = await daily.publications();
      expect(after.map((p) => p.status)).toEqual(["blocked_dependency", "blocked_dependency"]);
      for (const p of after) expect(p.blockers).toEqual(["SLOT_EXPIRED"]);
      for (const post of await daily.socialPosts()) expect(post.status).toBe("canceled");
      expect(await dispatchJobs()).toHaveLength(0);
    });

    it("records a post Social would refuse before the slot, once", async () => {
      const { pubs } = await released();
      const { owner } = daily.project;
      const worker = daily.h.worker();
      // Instagram without an image: Social refuses it.
      const instagram = pubs.find((p) => p.channel === daily.channels[1])!;
      await daily.h.run(async (tx) => {
        const row = (await list(tx, owner, "content")).find((r) => r.id === instagram.contentId)!;
        const { assetId: _assetId, ...rest } = data(row);
        await update(tx, owner, row, rest);
      });
      await syncSocialHolds(worker);
      const failed = () => daily.publications().then((all) => all.find((p) => p.id === instagram.id)!);
      expect(await failed()).toMatchObject({
        status: "intent_created",
        socialHold: { state: "failed", code: "SOCIAL_VALIDATION_FAILED" },
      });
      const version = await daily.h.run(async (tx) =>
        (await list(tx, owner, "publications")).find((r) => r.id === instagram.id)!.version,
      );
      await syncSocialHolds(worker);
      expect(
        await daily.h.run(async (tx) =>
          (await list(tx, owner, "publications")).find((r) => r.id === instagram.id)!.version,
        ),
      ).toBe(version);
    });

    it("leaves a Postiz project alone and sends a social: channel only through Social", async () => {
      const { pubs, slot } = await released();
      const { owner } = daily.project;
      await daily.h.run((tx) => forcePublishingBackend(tx, owner, "postiz"));
      await syncSocialHolds(daily.h.worker());
      expect(await daily.socialPosts()).toHaveLength(0);
      // A social: channel never reaches the Postiz path, whatever the setting.
      atMinutes(slot, 1);
      await dispatchPublication(owner, pubs[0]!.id);
      expect((await daily.publications()).find((p) => p.id === pubs[0]!.id)!.status).toBe("blocked_dependency");
      expect(await daily.socialPosts()).toHaveLength(0);
    });

    it("does not announce test publications, and nothing exists before the owner's release", async () => {
      daily = await dailyProject();
      await daily.drafted();
      await daily.reviewed();
      await syncSocialHolds(daily.h.worker());
      expect(await daily.socialPosts()).toHaveLength(0);
      for (const draft of await daily.contents()) await daily.release(draft);
      expect((await daily.publications()).every((p) => p.test === true)).toBe(true);
      await syncSocialHolds(daily.h.worker());
      expect(await daily.socialPosts()).toHaveLength(0);
    });

    it("tells the assignment view apart: waiting for hand-off, then scheduled in Social", async () => {
      await released();
      const { owner } = daily.project;
      const states = async () => {
        const detail = await daily.h.run((tx) => assignmentDetail(tx, owner, daily.assignment.id));
        return detail.runs.flatMap((r: any) => r.deliverables.map((d: any) => d.state));
      };
      expect(await states()).toEqual(["handoff_pending", "handoff_pending"]);
      await syncSocialHolds(daily.h.worker());
      expect(await states()).toEqual(["scheduled", "scheduled"]);
    });
  });

  it("a shared Facebook and Instagram run hands one image to Social: both posts use one library asset", async () => {
    liveSocialEnv();
    daily = await dailyProject(tomorrowMorning(), {
      native: true,
      shared: true,
    });
    const { project, channels, contents, publications, socialPosts, reviewed, release } =
      daily;
    await daily.drafted();
    // One art for the run.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    await reviewed();
    const drafts = await contents();
    expect(drafts.map((d) => d.channel)).toEqual(channels);
    // Same text and the same rendition on both platforms.
    expect(new Set(drafts.map((d) => d.body)).size).toBe(1);
    expect(new Set(drafts.map((d) => d.assetId)).size).toBe(1);
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
    const { media, assets } = await daily.h.run(async (tx) => ({
      media: await tx.socialPostMedia.findMany({
        where: { projectId: project.owner.projectId },
      }),
      assets: await tx.socialMediaAsset.findMany({
        where: { projectId: project.owner.projectId },
      }),
    }));
    // One medium per post, both the same library asset (by sha256).
    expect(media).toHaveLength(2);
    expect(assets).toHaveLength(1);
    expect(new Set(media.map((m) => m.sha256))).toEqual(
      new Set([assets[0]!.sha256]),
    );
    expect(new Set(media.map((m) => m.fileId)).size).toBe(1);
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
