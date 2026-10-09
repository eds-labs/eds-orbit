import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list } from "../src/shared.ts";
import {
  channelHistory,
  channelPostsNear,
  externalChannelPosts,
  htmlToText,
  syncChannelPosts,
} from "../src/modules/agents/channel-posts.ts";
import { chatTools } from "../src/modules/agents/tools/index.ts";
import { recentChannelPosts } from "../src/modules/generation.ts";
import { preflight } from "../src/modules/policy.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const DAY = 86_400_000;

describe("Postiz post text", () => {
  it("strips HTML to plain text", () => {
    expect(
      htmlToText(
        "<p>Beta &amp; access</p><p>is&nbsp;<b>open</b> &#8211; &#x1F680;<br/>today</p><script>alert(1)</script>",
      ),
    ).toBe("Beta & access is open – \u{1F680} today");
    expect(htmlToText("  plain\n\ntext  ")).toBe("plain text");
    // Decoded entities are text, never decoded a second time.
    expect(htmlToText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
});

describe.skipIf(!enabled)("Channel history from Postiz", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const now = new Date();
  const hoursAgo = (hours: number) =>
    new Date(now.valueOf() - hours * 3_600_000).toISOString();
  const hoursAhead = (hours: number) => hoursAgo(-hours);
  const remote = (
    id: string,
    channel: string,
    content: string,
    publishDate: string,
    state = "PUBLISHED",
  ) => ({ id, state, publishDate, integration: { id: channel }, content });
  // Like Postiz, a request returns only the posts inside its date range.
  const fake = (posts: ReturnType<typeof remote>[]) => ({
    listPosts: vi.fn(async (range: { startDate: string; endDate: string }) =>
      posts.filter(
        (post) =>
          post.publishDate >= range.startDate &&
          post.publishDate <= range.endDate,
      ),
    ),
  });
  const stored = () =>
    run(async (tx) =>
      (await list(tx, project.owner, "channel_posts")).map((row) => data(row)),
    );
  const reset = () =>
    run(async (tx) => {
      await tx.entity.deleteMany({
        where: {
          projectId: project.owner.projectId,
          kind: { in: ["channel_posts", "channel_post_sync"] },
        },
      });
    });

  beforeAll(async () => {
    project = await createPackageProject();
    await run(async (tx) => {
      const content = await create(tx, project.owner, "content", {
        title: "Beta is open",
        body: "Beta access is open for product teams.",
        type: "social",
        channel: X,
        status: "reviewed",
      });
      await create(tx, project.owner, "publications", {
        contentId: content.id,
        channel: X,
        status: "published",
        remoteId: "orbit-remote-1",
      });
    });
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("stores external and Orbit posts once per remote ID", async () => {
    await reset();
    const client = fake([
      remote(
        "ext-1",
        X,
        "<p>Our ChatGPT job: shipping &amp; learning</p>",
        hoursAgo(30),
      ),
      remote("orbit-remote-1", X, "Beta access is open.", hoursAgo(20)),
      remote("other-channel", "unassigned-int", "Not ours.", hoursAgo(5)),
      remote("queued", X, "Scheduled by ChatGPT.", hoursAhead(5), "QUEUE"),
      remote("failed", X, "Never went out.", hoursAgo(2), "ERROR"),
      remote("draft", X, "Only a draft.", hoursAhead(6), "DRAFT"),
    ]);
    expect(
      await syncChannelPosts(project.owner, client, now, { force: true }),
    ).toMatchObject({ stored: 3 });
    // The same remote IDs again update the rows instead of adding new ones.
    await syncChannelPosts(project.owner, client, now, { force: true });
    const rows = await stored();
    // Published and queued posts are kept; ERROR and DRAFT posts are not.
    expect(rows.map((row) => row.remoteId).sort()).toEqual([
      "ext-1",
      "orbit-remote-1",
      "queued",
    ]);
    expect(rows.find((row) => row.remoteId === "queued")).toMatchObject({
      source: "external",
      state: "QUEUE",
      publishedAt: hoursAhead(5),
    });
    expect(rows.find((row) => row.remoteId === "ext-1")).toMatchObject({
      channel: X,
      source: "external",
      state: "PUBLISHED",
      text: "Our ChatGPT job: shipping & learning",
      publishedAt: hoursAgo(30),
      syncedAt: now.toISOString(),
    });
    expect(rows.find((row) => row.remoteId === "orbit-remote-1")).toMatchObject(
      { channel: X, source: "orbit", text: "Beta access is open." },
    );
    // Three requests of at most 31 days (Postiz allows 30 per hour): 60 days back and 14 ahead.
    expect(client.listPosts).toHaveBeenCalledTimes(6);
    const ranges = client.listPosts.mock.calls
      .slice(0, 3)
      .map(([range]) => [
        (Date.parse(range.startDate) - now.valueOf()) / DAY,
        (Date.parse(range.endDate) - now.valueOf()) / DAY,
      ]);
    expect(ranges).toEqual([
      [-60, -30],
      [-30, 0],
      [0, 14],
    ]);
  });

  it("removes a queued post that Postiz no longer returns", async () => {
    await reset();
    const queued = remote("queued", X, "Scheduled.", hoursAhead(5), "QUEUE");
    const old = remote("old", X, "Posted.", hoursAgo(50));
    await syncChannelPosts(project.owner, fake([queued, old]), now, {
      force: true,
    });
    expect((await stored()).map((row) => row.remoteId).sort()).toEqual([
      "old",
      "queued",
    ]);
    // Deleted in Postiz: gone.
    await syncChannelPosts(project.owner, fake([old]), now, { force: true });
    expect((await stored()).map((row) => row.remoteId)).toEqual(["old"]);
    // A queued post that failed is no longer a plan either.
    await syncChannelPosts(
      project.owner,
      fake([{ ...queued, state: "ERROR" }, old]),
      now,
      { force: true },
    );
    expect((await stored()).map((row) => row.remoteId)).toEqual(["old"]);
    // A queued post that was sent becomes published.
    await syncChannelPosts(project.owner, fake([queued]), now, { force: true });
    await syncChannelPosts(
      project.owner,
      fake([{ ...queued, state: "PUBLISHED" }]),
      now,
      { force: true },
    );
    expect(
      (await stored()).find((row) => row.remoteId === "queued"),
    ).toMatchObject({ state: "PUBLISHED" });
  });

  it("skips a sync within the hour", async () => {
    await reset();
    const client = fake([remote("ext-1", X, "First.", hoursAgo(3))]);
    expect(await syncChannelPosts(project.owner, client, now)).toMatchObject({
      stored: 1,
    });
    const later = new Date(now.valueOf() + 30 * 60_000);
    expect(await syncChannelPosts(project.owner, client, later)).toEqual({
      stored: 0,
      skipped: true,
    });
    expect(client.listPosts).toHaveBeenCalledTimes(3);
    await syncChannelPosts(project.owner, client, later, { force: true });
    expect(client.listPosts).toHaveBeenCalledTimes(6);
    await syncChannelPosts(
      project.owner,
      client,
      new Date(now.valueOf() + 91 * 60_000),
    );
    expect(client.listPosts).toHaveBeenCalledTimes(9);
  });

  it("keeps the hour gate when the provider fails and drops posts older than 60 days", async () => {
    await reset();
    await run((tx) =>
      create(tx, project.owner, "channel_posts", {
        channel: X,
        remoteId: "ancient",
        publishedAt: new Date(now.valueOf() - 61 * DAY).toISOString(),
        text: "Too old.",
        source: "external",
        syncedAt: hoursAgo(100),
      }),
    );
    const broken = {
      listPosts: vi.fn(async () => {
        throw new Error("PROVIDER_DOWN");
      }),
    };
    await expect(
      syncChannelPosts(project.owner, broken, now),
    ).rejects.toThrow();
    // A failed sync still counts: the Postiz limit is 30 requests per hour.
    expect(
      await syncChannelPosts(
        project.owner,
        fake([]),
        new Date(now.valueOf() + 60_000),
      ),
    ).toEqual({ stored: 0, skipped: true });
    expect(
      await syncChannelPosts(project.owner, fake([]), now, { force: true }),
    ).toMatchObject({ stored: 0 });
    expect(await stored()).toEqual([]);
  });

  it("reads nothing when no Postiz channel is assigned", async () => {
    const empty = await createPackageProject();
    try {
      await scoped(
        empty.owner.workspaceId,
        empty.owner.projectId,
        async (tx) => {
          const [connector] = await tx.entity.findMany({
            where: { projectId: empty.owner.projectId, kind: "connectors" },
          });
          await tx.entity.update({
            where: { id: connector!.id },
            data: { data: { ...data(connector), assignedIntegrationIds: [] } },
          });
        },
      );
      const client = fake([]);
      expect(await syncChannelPosts(empty.owner, client, now)).toEqual({
        stored: 0,
        skipped: true,
      });
      expect(client.listPosts).not.toHaveBeenCalled();
    } finally {
      await empty.cleanup();
    }
  });

  it("shows recent posts per channel with source and date", async () => {
    await reset();
    await syncChannelPosts(
      project.owner,
      fake([
        remote("ext-1", X, "External older.", hoursAgo(40)),
        remote("orbit-remote-1", X, "Orbit newer.", hoursAgo(10)),
        remote("tg-1", TELEGRAM, "Telegram post.", hoursAgo(12)),
        remote("q-1", X, "Scheduled one.", hoursAhead(3), "QUEUE"),
      ]),
      now,
      { force: true },
    );
    const all = await run((tx) =>
      channelHistory(tx, project.owner, { channels: null, perChannel: null }),
    );
    expect(all.channels).toEqual([
      {
        channelId: X,
        posts: [
          {
            source: "external",
            status: "scheduled",
            publishedAt: hoursAhead(3),
            text: "Scheduled one.",
          },
          {
            source: "orbit",
            status: "published",
            publishedAt: hoursAgo(10),
            text: "Orbit newer.",
          },
          {
            source: "external",
            status: "published",
            publishedAt: hoursAgo(40),
            text: "External older.",
          },
        ],
      },
      {
        channelId: TELEGRAM,
        posts: [
          {
            source: "external",
            status: "published",
            publishedAt: hoursAgo(12),
            text: "Telegram post.",
          },
        ],
      },
    ]);
    const one = await run((tx) =>
      channelHistory(tx, project.owner, { channels: [X], perChannel: 1 }),
    );
    expect(one.channels).toHaveLength(1);
    expect(one.channels[0]!.posts).toHaveLength(1);
    expect(all.lastSyncAt).toBe(now.toISOString());
  });

  it("offers channel_history as a deferred read tool for agents", async () => {
    await reset();
    await syncChannelPosts(
      project.owner,
      fake([remote("ext-1", X, "External.", hoursAgo(40))]),
      now,
      { force: true },
    );
    const tool = chatTools.find((entry) => entry.name === "channel_history")!;
    expect(tool).toMatchObject({
      risk: "R0_read",
      feature: "agents",
      deferLoading: true,
      roles: ["viewer", "editor", "owner"],
    });
    // With a credential on file a sync would claim the marker first; the tool must not.
    const staleAttempt = hoursAgo(5);
    await run(async (tx) => {
      const [connector] = await tx.entity.findMany({
        where: { projectId: project.owner.projectId, kind: "connectors" },
      });
      await tx.entity.update({
        where: { id: connector!.id },
        data: {
          data: {
            ...data(connector),
            baseUrl: "https://postiz.example",
            encryptedCredential: "a.b.c",
          },
        },
      });
      const [marker] = await list(tx, project.owner, "channel_post_sync");
      await tx.entity.update({
        where: { id: marker!.id },
        data: { data: { ...data(marker), attemptedAt: staleAttempt } },
      });
    });
    const result = await tool.execute(
      {
        scope: project.viewer,
        runId: "r",
        conversationId: "c",
        callIndex: 1,
      },
      { channels: null, perChannel: null },
    );
    expect((result.output as any).channels[0].posts[0]).toMatchObject({
      source: "external",
      text: "External.",
    });
    expect((result.output as any).lastSyncAt).toBe(staleAttempt);
    expect(
      await run(async (tx) =>
        data((await list(tx, project.owner, "channel_post_sync"))[0]),
      ),
    ).toMatchObject({ attemptedAt: staleAttempt, status: "ok" });
  });

  it("refuses an Orbit draft identical to an external post of the same channel", async () => {
    await reset();
    const body = "Beta access is open for product teams!";
    const draft = (channel: string, text: string) =>
      run(async (tx) => {
        const evidence = await create(tx, project.owner, "evidence", {
          status: "ready",
          purpose: "public",
          facts: [],
          items: [],
        });
        return create(tx, project.owner, "content", {
          title: "Duplicate check",
          body: text,
          type: "social",
          channel,
          status: "reviewed",
          synthetic: true,
          evidenceId: evidence.id,
          claims: [],
        });
      });
    const blockers = async (id: string) =>
      (await run((tx) => preflight(tx, project.owner, id, { test: true })))
        .blockers;
    await syncChannelPosts(
      project.owner,
      fake([
        remote("ext-dup", X, `<p>${body.toUpperCase()}</p>`, hoursAgo(48)),
        remote(
          "ext-old",
          TELEGRAM,
          "Ancient news about beta.",
          hoursAgo(24 * 9),
        ),
        remote(
          "ext-queued",
          X,
          "Scheduled by a ChatGPT job.",
          hoursAhead(12),
          "QUEUE",
        ),
      ]),
      now,
      { force: true },
    );
    // Same text, different case and punctuation, same channel.
    expect(
      await blockers((await draft(X, body.replace("!", "."))).id),
    ).toContain("DUPLICATE_CONTENT");
    // A post already queued in Postiz counts as well.
    expect(
      await blockers((await draft(X, "Scheduled by a ChatGPT job")).id),
    ).toContain("DUPLICATE_CONTENT");
    // Another channel, different text, and a post older than seven days do not block.
    expect(await blockers((await draft(TELEGRAM, body)).id)).not.toContain(
      "DUPLICATE_CONTENT",
    );
    expect(
      await blockers((await draft(X, "A different announcement.")).id),
    ).not.toContain("DUPLICATE_CONTENT");
    expect(
      await blockers((await draft(TELEGRAM, "Ancient news about beta.")).id),
    ).not.toContain("DUPLICATE_CONTENT");
  });

  it("loads only the channel's posts within the window for the duplicate check (M5)", async () => {
    await reset();
    const stored = (
      remoteId: string,
      channel: string,
      text: string,
      publishedAt: string,
    ) =>
      run((tx) =>
        create(tx, project.owner, "channel_posts", {
          channel,
          remoteId,
          publishedAt,
          state: "PUBLISHED",
          text,
          source: "external",
          syncedAt: now.toISOString(),
        }),
      );
    await stored("near-x", X, "Same words.", hoursAgo(24));
    await stored("edge-x", X, "Same words.", hoursAgo(24 * 7 + 1));
    await stored("far-x", X, "Same words.", hoursAgo(24 * 30));
    await stored("ahead-x", X, "Same words.", hoursAhead(24 * 30));
    await stored("near-tg", TELEGRAM, "Same words.", hoursAgo(24));
    // Records the rows every entity query returns.
    const loaded: Array<Record<string, any>> = [];
    const spied = (tx: DbTx) =>
      new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "entity")
            return typeof value === "function" ? value.bind(target) : value;
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method);
              if (method !== "findMany") return fn.bind(delegate);
              return async (args: unknown) => {
                const rows = await fn.call(delegate, args);
                loaded.push(...rows.map((row: { data: unknown }) => data(row)));
                return rows;
              };
            },
          });
        },
      });
    const near = await run((tx) =>
      channelPostsNear(spied(tx), project.owner, X, now.valueOf(), 7),
    );
    expect(near.map((post) => post.remoteId)).toEqual(["near-x"]);
    // Nothing of another channel or outside the window is even loaded.
    expect(loaded.map((post) => post.remoteId)).toEqual(["near-x"]);
  });

  it("gives the copywriter the external posts around a slot", async () => {
    await reset();
    await syncChannelPosts(
      project.owner,
      fake([
        remote("ext-1", X, "External beta teaser.", hoursAgo(20)),
        remote("orbit-remote-1", X, "Orbit beta post.", hoursAgo(10)),
        remote("tg-1", TELEGRAM, "Other channel.", hoursAgo(10)),
        remote("ext-old", X, "Far in the past.", hoursAgo(24 * 20)),
      ]),
      now,
      { force: true },
    );
    // Orbit posts are already part of the content history, so only external ones are added.
    expect(
      await run((tx) =>
        externalChannelPosts(tx, project.owner, X, now.valueOf()),
      ),
    ).toEqual([
      {
        at: now.valueOf() - 20 * 3_600_000,
        title: "External post",
        claims: ["External beta teaser."],
      },
    ]);
    // The autopilot contract lists them next to Orbit's own drafts.
    expect(
      await run((tx) =>
        recentChannelPosts(tx, project.owner, "mission", X, now.valueOf()),
      ),
    ).toContainEqual({
      title: "External post",
      claims: ["External beta teaser."],
    });
  });
});
