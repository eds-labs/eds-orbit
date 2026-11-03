import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { postMetrics, socialMetrics } from "../src/modules/social/analytics/collect.ts";
import { saveSocialSettings, readSocialSettings } from "../src/modules/social/settings.ts";
import { createPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const HOUR = 3_600_000;

/**
 * Collecting post figures (ADR 0020, S8): every six hours, for live
 * publications at most 30 days old, at most 50 provider calls per project
 * and run, least recently read first; X only when the owner allows its paid
 * reads, at most once a day. A failed read affects only that post.
 */
describe.skipIf(!enabled)("social metrics", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let facebook = "";
  let x = "";
  let telegram = "";
  let calls: URL[] = [];
  let fail = new Set<string>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const account = async (platform: "facebook" | "x" | "telegram") => {
    const externalId = String(Math.floor(Math.random() * 1e12));
    const secret =
      platform === "facebook"
        ? { pageToken: "page-token" }
        : platform === "x"
          ? { accessToken: "x-token", refreshToken: null, expiresAt: null, scopes: ["tweet.read"] }
          : { botToken: "1:token" };
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform,
      externalId,
      handle: `@${platform}`,
      displayName: platform,
      secret: JSON.stringify(secret),
      config: platform === "facebook" ? { metaUserId: "7", pageId: externalId } : platform === "telegram" ? { chatId: "-100", botId: 1 } : {},
    });
    return accountId;
  };
  /** A published post on one account, `daysAgo` old, with its platform id. */
  const published = async (accountId: string, externalPostId: string, daysAgo = 1, providerState: object = {}) => {
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: `Post ${externalPostId}`, baseMedia: [], variants: [{ accountId }] }));
    return p.run(async (tx) => {
      const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { postId: post.id } });
      await tx.socialPost.update({ where: { id: post.id }, data: { status: "published" } });
      const id = randomUUID();
      await tx.socialPublication.create({
        data: {
          id,
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          variantId: variant.id,
          accountId,
          idempotencyKey: randomUUID(),
          status: "published",
          externalPostId,
          publishedAt: new Date(Date.now() - daysAgo * 24 * HOUR),
          providerState,
        },
      });
      return { postId: post.id, publicationId: id };
    });
  };
  const rows = (publicationId: string) =>
    p.run((tx) => tx.socialMetricSnapshot.findMany({ where: { publicationId }, orderBy: { metric: "asc" } }));
  const run = () => socialMetrics.run(p.owner);
  const clear = () => p.run((tx) => tx.socialMetricSnapshot.deleteMany({ where: { projectId: p.owner.projectId } }));

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject({ name: "Synthetic social metrics" });
    facebook = await account("facebook");
    x = await account("x");
    telegram = await account("telegram");
    setSocialFetchForTests(async (url) => {
      const u = new URL(String(url));
      calls.push(u);
      if (u.hostname === "api.x.com")
        return json(200, {
          data: u.searchParams.get("ids")!.split(",").map((id) => ({ id, public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0, quote_count: 0, impression_count: 50, bookmark_count: 0 } })),
        });
      const id = u.pathname.split("/").pop()!;
      if (fail.has(id)) return json(500, {});
      return json(200, { id, reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } });
    });
  });
  beforeEach(async () => {
    calls = [];
    fail = new Set();
    await clear();
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await p?.cleanup();
    await closeDatabase();
  });

  it("stores the figures of live publications only, and reports them per post", async () => {
    const live = await published(facebook, "900_1");
    const test = await published(facebook, "900_test", 1, { test: true });
    const old = await published(facebook, "900_old", 40);
    const channel = await published(telegram, "55");
    await run();
    expect((await rows(live.publicationId)).filter((r) => r.metric !== "orbit_read").map((r) => [r.metric, Number(r.value)])).toEqual([
      ["comments", 1],
      ["reactions", 7],
      ["shares", 2],
    ]);
    for (const skipped of [test, old, channel]) expect(await rows(skipped.publicationId)).toEqual([]);
    expect(calls.map((c) => c.pathname)).toEqual(["/v26.0/900_1"]);
    const report = await p.run((tx) => postMetrics(tx, p.owner, [live.postId, channel.postId]));
    expect(report).toEqual([
      {
        postId: live.postId,
        publications: [
          {
            publicationId: live.publicationId,
            accountId: facebook,
            platform: "facebook",
            available: true,
            observedAt: expect.any(String),
            metrics: { comments: 1, reactions: 7, shares: 2 },
          },
        ],
      },
      {
        postId: channel.postId,
        publications: [
          { publicationId: channel.publicationId, accountId: telegram, platform: "telegram", available: false, observedAt: null, metrics: {} },
        ],
      },
    ]);
  });

  it("makes at most 50 calls per run, least recently read first, and skips what it read six hours ago", async () => {
    const many: Array<{ postId: string; publicationId: string }> = [];
    for (let i = 0; i < 55; i++) many.push(await published(facebook, `901_${i}`));
    const idOf = (u: URL) => u.pathname.split("/").pop()!;
    await run();
    const first = calls.map(idOf);
    expect(first).toHaveLength(50);
    calls = [];
    // Runs are spaced: the next pass comes some minutes later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
    const second = calls.map(idOf);
    // What was left over comes now; what was just read is not due yet.
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(new Set([...first, ...second])).toEqual(new Set([...many.map((_, i) => `901_${i}`), "900_1"]));
    await p.run((tx) =>
      tx.socialPublication.updateMany({ where: { id: { in: many.map((m) => m.publicationId) } }, data: { status: "canceled" } }),
    );
  });

  it("goes on after a failed read and tries that post again later", async () => {
    const bad = await published(facebook, "902_bad");
    const good = await published(facebook, "902_good");
    fail.add("902_bad");
    await run();
    expect((await rows(bad.publicationId)).map((r) => [r.metric, Number(r.value)])).toEqual([["orbit_read", 0]]);
    expect((await rows(good.publicationId)).some((r) => r.metric === "reactions")).toBe(true);
    const report = await p.run((tx) => postMetrics(tx, p.owner, [bad.postId]));
    expect(report[0]!.publications[0]).toMatchObject({ available: true, observedAt: null, metrics: {} });
  });

  it("reads X only when the owner allows the paid reads, and then once a day", async () => {
    const tweet = await published(x, "1700");
    await run();
    expect(calls.filter((c) => c.hostname === "api.x.com")).toHaveLength(0);
    const current = await p.run((tx) => readSocialSettings(tx, p.owner));
    await p.run((tx) => saveSocialSettings(tx, p.owner, { ...current.settings, xMetrics: true }, current.version));
    // Runs are spaced five minutes apart: start from no earlier read.
    await clear();
    await run();
    expect(calls.filter((c) => c.hostname === "api.x.com")).toHaveLength(1);
    expect((await rows(tweet.publicationId)).find((r) => r.metric === "impressions")).toBeDefined();
    // Seven hours later Facebook would be due again, X not.
    // Snapshots are append-only: replace them by reads of seven hours ago.
    const live = await p.run((tx) =>
      tx.socialPublication.findMany({ where: { projectId: p.owner.projectId, status: "published" }, select: { id: true } }),
    );
    await clear();
    await p.run((tx) =>
      tx.socialMetricSnapshot.createMany({
        data: live.map((pub) => ({
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          publicationId: pub.id,
          metric: "orbit_read",
          value: 1,
          period: "lifetime",
          observedAt: new Date(Date.now() - 7 * HOUR),
        })),
      }),
    );
    calls = [];
    await run();
    expect(calls.filter((c) => c.hostname === "api.x.com")).toHaveLength(0);
  });

  it("marks the posts of an account whose credentials fail, so it does not run again at once", async () => {
    const broken = await saveConnectedAccount(p.owner, {
      platform: "facebook",
      externalId: String(Math.floor(Math.random() * 1e12)),
      handle: "@broken",
      displayName: "broken",
      secret: "not json",
      config: { metaUserId: "7" },
    });
    const post = await published(broken.accountId, "904_1");
    await run();
    expect((await rows(post.publicationId)).map((r) => [r.metric, Number(r.value)])).toEqual([["orbit_read", 0]]);
    const due = await p.run((tx) => socialMetrics.nextDueAt!(tx, p.owner));
    expect(due!.getTime()).toBeGreaterThan(Date.now());
    await p.run((tx) => tx.socialPublication.update({ where: { id: post.publicationId }, data: { status: "canceled" } }));
  });

  it("spaces the runs: leftovers wait a few minutes instead of running at once", async () => {
    const many: Array<{ publicationId: string }> = [];
    for (let i = 0; i < 52; i++) many.push(await published(facebook, `905_${i}`));
    await run();
    const due = await p.run((tx) => socialMetrics.nextDueAt!(tx, p.owner));
    expect(due!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    // A pass started before then reads nothing.
    calls = [];
    await run();
    expect(calls).toHaveLength(0);
    await p.run((tx) => tx.socialPublication.updateMany({ where: { id: { in: many.map((m) => m.publicationId) } }, data: { status: "canceled" } }));
  });

  it("reports the latest read only", async () => {
    const post = await published(facebook, "906_1");
    await p.run((tx) =>
      tx.socialMetricSnapshot.createMany({
        data: [
          { at: 3, reactions: 5, shares: 1 },
          { at: 1, reactions: 9, shares: null },
        ].flatMap((r) =>
          Object.entries({ reactions: r.reactions, shares: r.shares, orbit_read: 1 })
            .filter(([, v]) => v !== null)
            .map(([metric, value]) => ({
              id: randomUUID(),
              workspaceId: p.owner.workspaceId,
              projectId: p.owner.projectId,
              publicationId: post.publicationId,
              metric,
              value: value as number,
              period: "lifetime",
              observedAt: new Date(Date.now() - r.at * HOUR),
            })),
        ),
      }),
    );
    const [report] = await p.run((tx) => postMetrics(tx, p.owner, [post.postId]));
    expect(report!.publications[0]!.metrics).toEqual({ reactions: 9 });
    await p.run((tx) => tx.socialPublication.update({ where: { id: post.publicationId }, data: { status: "canceled" } }));
  });

  it("is due only while something can be read", async () => {
    const { socialMetrics: task } = await import("../src/modules/social/analytics/collect.ts");
    await p.run((tx) => tx.socialPublication.updateMany({ where: { projectId: p.owner.projectId }, data: { status: "canceled" } }));
    expect(await p.run((tx) => task.nextDueAt!(tx, p.owner))).toBeNull();
    const fresh = await published(facebook, "903_1", 0);
    const due = await p.run((tx) => task.nextDueAt!(tx, p.owner));
    expect(due!.getTime()).toBeGreaterThan(Date.now());
    await p.run((tx) => tx.socialPublication.update({ where: { id: fresh.publicationId }, data: { publishedAt: new Date(Date.now() - 7 * HOUR) } }));
    expect((await p.run((tx) => task.nextDueAt!(tx, p.owner)))!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
