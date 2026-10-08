import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list } from "../src/shared.ts";
import {
  channelHistory,
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
  const remote = (
    id: string,
    channel: string,
    content: string,
    publishDate: string,
    state = "PUBLISHED",
  ) => ({ id, state, publishDate, integration: { id: channel }, content });
  const fake = (posts: ReturnType<typeof remote>[]) => ({
    listPosts: vi.fn(
      async (_range: { startDate: string; endDate: string }) => posts,
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
      remote("queued", X, "Not posted yet.", hoursAgo(1), "QUEUE"),
      remote("failed", X, "Never went out.", hoursAgo(2), "ERROR"),
    ]);
    expect(
      await syncChannelPosts(project.owner, client, now, { force: true }),
    ).toMatchObject({ stored: 2 });
    // The same remote IDs again update the rows instead of adding new ones.
    await syncChannelPosts(project.owner, client, now, { force: true });
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.remoteId === "ext-1")).toMatchObject({
      channel: X,
      source: "external",
      text: "Our ChatGPT job: shipping & learning",
      publishedAt: hoursAgo(30),
      syncedAt: now.toISOString(),
    });
    expect(rows.find((row) => row.remoteId === "orbit-remote-1")).toMatchObject(
      { channel: X, source: "orbit", text: "Beta access is open." },
    );
    // One request covers the whole 60 days (Postiz allows 30 per hour).
    expect(client.listPosts).toHaveBeenCalledTimes(2);
    const range = client.listPosts.mock.calls[0]![0];
    expect(Date.parse(range.endDate)).toBe(now.valueOf());
    expect(now.valueOf() - Date.parse(range.startDate)).toBe(60 * DAY);
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
    expect(client.listPosts).toHaveBeenCalledTimes(1);
    await syncChannelPosts(project.owner, client, later, { force: true });
    expect(client.listPosts).toHaveBeenCalledTimes(2);
    await syncChannelPosts(
      project.owner,
      client,
      new Date(now.valueOf() + 91 * 60_000),
    );
    expect(client.listPosts).toHaveBeenCalledTimes(3);
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
          { source: "orbit", publishedAt: hoursAgo(10), text: "Orbit newer." },
          {
            source: "external",
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
    const result = await tool.execute(
      {
        scope: project.viewer,
        runId: "r",
        conversationId: "c",
        callIndex: 1,
      },
      { channels: null, perChannel: null },
    );
    // The project has no Postiz credential, so the refresh is skipped silently.
    expect((result.output as any).channels[0].posts[0]).toMatchObject({
      source: "external",
      text: "External.",
    });
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
      ]),
      now,
      { force: true },
    );
    // Same text, different case and punctuation, same channel.
    expect(
      await blockers((await draft(X, body.replace("!", "."))).id),
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
