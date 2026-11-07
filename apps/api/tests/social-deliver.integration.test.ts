import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { socialAttention } from "../src/modules/social/attention.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { finishPublication } from "../src/modules/social/dispatch/claim.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { DELIVER } from "../src/modules/social/dispatch/jobs.ts";
import { socialDeliverySweep } from "../src/modules/social/dispatch/sweep.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { cancelPost, createPost, getPost } from "../src/modules/social/posts/posts.ts";
import { data } from "../src/shared.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";

/**
 * Delivering one publication (ADR 0020 §7, S5): claim with a fence, send
 * outside the transaction, finish only with the same fence. Test mode posts
 * nothing; an unclear send is never repeated.
 */
describe.skipIf(!enabled)("social deliver", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  let sends = 0;
  let answer: () => Response | Promise<Response> = () => new Response("{}", { status: 500 });
  const env = { EXECUTION_MODE: process.env.EXECUTION_MODE, ENABLE_EXTERNAL_WRITES: process.env.ENABLE_EXTERNAL_WRITES, ORBIT_SOCIAL_PLATFORMS: process.env.ORBIT_SOCIAL_PLATFORMS };
  const live = (platforms = "telegram") => Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: platforms });
  const ok = (id: number) => new Response(JSON.stringify({ ok: true, result: { message_id: id } }), { status: 200 });

  /** A Telegram channel account with its sealed publishing bot. */
  const telegramAccount = async (capability = "write_verified") => {
    const { saveConnectedAccount } = await import("../src/modules/social/accounts/store.ts");
    const chatId = `-100${Math.floor(Math.random() * 1e9)}`;
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "telegram",
      externalId: chatId,
      handle: "@orbit_news",
      displayName: "Orbit news",
      secret: JSON.stringify({ botToken: BOT }),
      config: { chatId, botId: "222222222", botUsername: "orbit_pub_bot" },
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability } }));
    return accountId;
  };
  /** An approved publish-now post, dispatched: its publications. */
  const publications = async (accounts: string[]) => {
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: "We are live.", baseMedia: [], variants: accounts.map((accountId) => ({ accountId })) }));
    const approved = await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    await dispatchPost(worker, post.id, approved.version);
    const variants = await p.run((tx) => tx.socialPostVariant.findMany({ where: { postId: post.id } }));
    const pubs = await p.run((tx) => tx.socialPublication.findMany({ where: { variantId: { in: variants.map((v) => v.id) } } }));
    return { postId: post.id, pubs };
  };
  const pub = (id: string) => p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id } }));
  const deliverJobs = (publicationId: string) =>
    p.run(async (tx) =>
      (await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "asc" } }))
        .map((j) => ({ id: j.id, ...data(j) }) as { id: string } & Record<string, any>)
        .filter((j) => j.topic === DELIVER && j.resourceId === publicationId),
    );

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    setSocialFetchForTests(async (url) => {
      if (String(url).includes("/sendMessage")) sends++;
      return answer();
    });
  });
  afterEach(() => {
    sends = 0;
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await p?.cleanup();
    await closeDatabase();
  });

  it("publishes test publications without any provider call", async () => {
    const accounts = [await telegramAccount(), await telegramAccount()];
    const { postId, pubs } = await publications(accounts);
    for (const one of pubs) expect(await deliverPublication(worker, one.id)).toEqual({ status: "succeeded", errorCode: null });
    for (const one of pubs) expect(await pub(one.id)).toMatchObject({ status: "published", externalPostId: expect.stringMatching(/^test:/), providerState: { test: true } });
    expect(sends).toBe(0);
    expect((await p.run((tx) => getPost(tx, p.viewer, postId))).status).toBe("published");
    const events = await p.run((tx) => tx.domainEvent.findMany({ where: { projectId: p.owner.projectId, type: "social.publication.published" } }));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("sends a live publication exactly once and records the attempt without its text", async () => {
    live();
    answer = () => ok(77);
    const { pubs } = await publications([await telegramAccount()]);
    await deliverPublication(worker, pubs[0]!.id);
    expect(sends).toBe(1);
    expect(await pub(pubs[0]!.id)).toMatchObject({ status: "published", externalPostId: "77", permalink: "https://t.me/orbit_news/77" });
    const attempts = await p.run((tx) => tx.socialDeliveryAttempt.findMany({ where: { publicationId: pubs[0]!.id } }));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ step: "publish", outcome: "ok" });
    expect(JSON.stringify(attempts[0])).not.toContain("We are live");
  });

  it("lets two concurrent deliveries of one publication send once", async () => {
    live();
    answer = () => new Promise((resolve) => setTimeout(() => resolve(ok(78)), 300));
    const { pubs } = await publications([await telegramAccount()]);
    const results = await Promise.all([deliverPublication(worker, pubs[0]!.id), deliverPublication(worker, pubs[0]!.id)]);
    expect(sends).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(["succeeded", "succeeded"]);
    expect((await pub(pubs[0]!.id)).status).toBe("published");
  });

  it("refuses a result written with another fence", async () => {
    const { pubs } = await publications([await telegramAccount()]);
    await p.run((tx) => tx.socialPublication.update({ where: { id: pubs[0]!.id }, data: { status: "sending", fence: randomUUID() } }));
    await expect(
      p.run((tx) => finishPublication(tx, worker, pubs[0]!.id, randomUUID(), { kind: "published", externalPostId: "1", permalink: null }, "live")),
    ).rejects.toMatchObject({ code: "SOCIAL_STALE_FENCE" });
    expect((await pub(pubs[0]!.id)).status).toBe("sending");
  });

  it("turns a lease that ran out while sending into an unknown outcome, never a second send", async () => {
    live();
    answer = () => ok(79);
    const { postId, pubs } = await publications([await telegramAccount()]);
    await p.run((tx) => tx.socialPublication.update({ where: { id: pubs[0]!.id }, data: { status: "sending", fence: randomUUID() } }));
    const [job] = await deliverJobs(pubs[0]!.id);
    await scoped(p.owner.workspaceId, p.owner.projectId, (tx) => registeredJobs().get(DELIVER)!.onLeaseExpired!(tx, worker, job!));
    expect((await pub(pubs[0]!.id)).status).toBe("outcome_unknown");
    await deliverPublication(worker, pubs[0]!.id);
    expect(sends).toBe(0);
    const items = await p.run((tx) => socialAttention(tx, p.owner, new Date()));
    expect(items.map((i) => i.kind)).toContain("social_publication_problem");
    expect((await p.run((tx) => getPost(tx, p.viewer, postId))).status).toBe("publishing");
  });

  it("retries a rate limit later, at most three times", async () => {
    live();
    answer = () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 30 } }), { status: 429 });
    const { pubs } = await publications([await telegramAccount()]);
    const id = pubs[0]!.id;
    const before = Date.now();
    await deliverPublication(worker, id);
    const first = await pub(id);
    expect(first).toMatchObject({ status: "failed", retryDisposition: "after-delay", attempts: 1 });
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect((await deliverJobs(id)).map((j) => j.idempotencyKey)).toContain(`social-deliver:${id}:2`);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await p.run((tx) => tx.socialPublication.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } }));
      await deliverPublication(worker, id);
    }
    expect(await pub(id)).toMatchObject({ status: "failed", attempts: 3, nextAttemptAt: null, lastErrorCode: "SOCIAL_RATE_LIMITED" });
    expect(sends).toBe(3);
  });

  it("blocks and asks for a reconnect when the bot lost the channel", async () => {
    live();
    answer = () => new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 403 });
    const account = await telegramAccount();
    const { pubs } = await publications([account]);
    await deliverPublication(worker, pubs[0]!.id);
    expect(await pub(pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "ACCOUNT_RECONNECT_REQUIRED" });
    expect((await p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id: account } }))).status).toBe("reconnect_required");
  });

  it("calls an outage after sending unknown and does not retry", async () => {
    live();
    answer = () => new Response("bad gateway", { status: 502 });
    const { pubs } = await publications([await telegramAccount()]);
    await deliverPublication(worker, pubs[0]!.id);
    expect((await pub(pubs[0]!.id)).status).toBe("outcome_unknown");
    expect((await deliverJobs(pubs[0]!.id)).map((j) => j.idempotencyKey)).toEqual([`social-deliver:${pubs[0]!.id}:1`]);
  });

  it("sends nothing live to an unverified account or a platform that is off", async () => {
    const { pubs } = await publications([await telegramAccount("read_verified")]);
    live();
    answer = () => ok(80);
    await deliverPublication(worker, pubs[0]!.id);
    expect(await pub(pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED" });
    const other = await publications([await telegramAccount()]);
    live("x");
    await deliverPublication(worker, other.pubs[0]!.id);
    expect(await pub(other.pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "SOCIAL_PLATFORM_NOT_AVAILABLE" });
    expect(sends).toBe(0);
  });

  it("holds a publication back while the channel's minute is used up", async () => {
    live();
    answer = () => ok(81);
    const account = await telegramAccount();
    const { pubs } = await publications([account]);
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await p.run((tx: DbTx) =>
      tx.socialAccountThrottle.create({
        data: { workspaceId: p.owner.workspaceId, projectId: p.owner.projectId, accountId: account, window: "minute", windowStart: minute, count: 20 },
      }),
    );
    expect(await deliverPublication(worker, pubs[0]!.id)).toEqual({ status: "succeeded", errorCode: "SOCIAL_THROTTLED" });
    expect((await pub(pubs[0]!.id)).status).toBe("pending");
    expect(sends).toBe(0);
    const later = (await deliverJobs(pubs[0]!.id)).find((j) => String(j.idempotencyKey).includes(":t"));
    expect(Date.parse(later!.availableAt)).toBe(minute.getTime() + 60_000);
  });

  it("never sends again after a stop that arrived while sending (final review C1, I1)", async () => {
    const { postId, pubs } = await publications([await telegramAccount()]);
    const id = pubs[0]!.id;
    const fence = randomUUID();
    await p.run((tx) => tx.socialPublication.update({ where: { id }, data: { status: "sending", fence, attempts: 1 } }));
    const view = await p.run((tx) => getPost(tx, p.viewer, postId));
    await p.run((tx) => cancelPost(tx, p.owner, postId, view.version));
    // The send in flight keeps its state: its result decides, a crash makes it unknown.
    expect(await pub(id)).toMatchObject({ status: "sending", providerState: { cancelRequested: true } });
    await p.run((tx) =>
      finishPublication(tx, worker, id, fence, { kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: 30_000 }, "live"),
    );
    expect(await pub(id)).toMatchObject({ status: "canceled", nextAttemptAt: null });
    expect((await deliverJobs(id)).map((j) => j.idempotencyKey)).toEqual([`social-deliver:${id}:1`]);
    // A crash after a stop while sending: maybe sent, so unknown, never "canceled".
    const other = await publications([await telegramAccount()]);
    const otherId = other.pubs[0]!.id;
    await p.run((tx) => tx.socialPublication.update({ where: { id: otherId }, data: { status: "sending", fence: randomUUID() } }));
    await p.run(async (tx) => cancelPost(tx, p.owner, other.postId, (await getPost(tx, p.viewer, other.postId)).version));
    const [job] = await deliverJobs(otherId);
    await scoped(p.owner.workspaceId, p.owner.projectId, (tx) => registeredJobs().get(DELIVER)!.onLeaseExpired!(tx, worker, job!));
    expect((await pub(otherId)).status).toBe("outcome_unknown");
  });

  it("settles publications stuck while sending or claimed (final review I2)", async () => {
    const { pubs: [stuck] } = await publications([await telegramAccount()]);
    const { pubs: [claimed] } = await publications([await telegramAccount()]);
    const { pubs: [fresh] } = await publications([await telegramAccount()]);
    const old = new Date(Date.now() - 11 * 60_000);
    await p.run(async (tx) => {
      await tx.socialPublication.update({ where: { id: stuck!.id }, data: { status: "sending", fence: randomUUID(), claimedAt: old } });
      await tx.socialPublication.update({ where: { id: claimed!.id }, data: { status: "claimed", fence: randomUUID(), claimedAt: old } });
      await tx.socialPublication.update({ where: { id: fresh!.id }, data: { status: "sending", fence: randomUUID(), claimedAt: new Date() } });
    });
    expect(await p.run((tx) => socialDeliverySweep.nextDueAt!(tx, p.owner))).toEqual(new Date(old.getTime() + 10 * 60_000));
    await socialDeliverySweep.run(p.owner);
    expect((await pub(stuck!.id)).status).toBe("outcome_unknown");
    expect(await pub(claimed!.id)).toMatchObject({ status: "pending", fence: null });
    expect((await deliverJobs(claimed!.id)).length).toBe(2);
    expect((await pub(fresh!.id)).status).toBe("sending");
  });

  it("never reopens a publication that failed for good when the project is paused (final review M5)", async () => {
    const { pubs } = await publications([await telegramAccount()]);
    const id = pubs[0]!.id;
    await p.run((tx) => tx.socialPublication.update({ where: { id }, data: { status: "failed", retryDisposition: "never", resolution: "not_published" } }));
    const [job] = await deliverJobs(id);
    await scoped(p.owner.workspaceId, p.owner.projectId, (tx) => registeredJobs().get(DELIVER)!.onBlockedByPause!(tx, job!, worker));
    expect((await pub(id)).status).toBe("failed");
  });

  describe("lateness (D-3): never more than 30 minutes late", () => {
    const MIN = 60_000;
    const setPost = (postId: string, data: Record<string, unknown>) => p.run((tx) => tx.socialPost.update({ where: { id: postId }, data }));
    const expectExpired = async (id: string, postId: string) => {
      expect(await pub(id)).toMatchObject({ status: "failed", retryDisposition: "never", lastErrorCode: "SOCIAL_SLOT_EXPIRED", nextAttemptAt: null, fence: null });
      expect((await p.run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: postId } }))).status).toBe("failed");
      expect(sends).toBe(0);
    };

    it("a scheduled post claimed 31 minutes after its time expires and is never sent", async () => {
      live();
      answer = () => ok(90);
      const { postId, pubs } = await publications([await telegramAccount()]);
      await setPost(postId, { scheduleMode: "at", scheduledAt: new Date(Date.now() - 31 * MIN) });
      expect(await deliverPublication(worker, pubs[0]!.id)).toEqual({ status: "succeeded", errorCode: "SOCIAL_SLOT_EXPIRED" });
      await expectExpired(pubs[0]!.id, postId);
    });

    it("a now post claimed 31 minutes after its approval expires", async () => {
      live();
      const { postId, pubs } = await publications([await telegramAccount()]);
      await setPost(postId, { approvedAt: new Date(Date.now() - 31 * MIN) });
      await deliverPublication(worker, pubs[0]!.id);
      await expectExpired(pubs[0]!.id, postId);
    });

    it("a now post without an approval time measures from its creation", async () => {
      live();
      const { postId, pubs } = await publications([await telegramAccount()]);
      await setPost(postId, { approvedAt: null, createdAt: new Date(Date.now() - 31 * MIN) });
      await deliverPublication(worker, pubs[0]!.id);
      await expectExpired(pubs[0]!.id, postId);
    });

    it("a claim 29 minutes late still sends", async () => {
      live();
      answer = () => ok(91);
      const { postId, pubs } = await publications([await telegramAccount()]);
      await setPost(postId, { approvedAt: new Date(Date.now() - 29 * MIN) });
      await deliverPublication(worker, pubs[0]!.id);
      expect(sends).toBe(1);
      expect((await pub(pubs[0]!.id)).status).toBe("published");
    });

    it("an after-delay retry whose next attempt lies beyond the deadline fails at once with SOCIAL_SLOT_EXPIRED", async () => {
      live();
      answer = () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 30 } }), { status: 429 });
      const { postId, pubs } = await publications([await telegramAccount()]);
      const id = pubs[0]!.id;
      await setPost(postId, { approvedAt: new Date(Date.now() - 29 * MIN - 30_000) });
      await deliverPublication(worker, id);
      expect(sends).toBe(1);
      expect(await pub(id)).toMatchObject({ status: "failed", retryDisposition: "never", lastErrorCode: "SOCIAL_SLOT_EXPIRED", nextAttemptAt: null, attempts: 1 });
      expect((await deliverJobs(id)).map((j) => j.idempotencyKey)).not.toContain(`social-deliver:${id}:2`);
      const events = await p.run((tx) => tx.domainEvent.findMany({ where: { projectId: p.owner.projectId, type: "social.publication.failed", subjectId: id } }));
      expect(events.length).toBe(1);
    });

    it("a throttle wait beyond the deadline expires instead of re-queuing", async () => {
      live();
      answer = () => ok(92);
      const account = await telegramAccount();
      const { postId, pubs } = await publications([account]);
      const minute = new Date(Math.floor(Date.now() / MIN) * MIN);
      await p.run((tx: DbTx) =>
        tx.socialAccountThrottle.create({
          data: { workspaceId: p.owner.workspaceId, projectId: p.owner.projectId, accountId: account, window: "minute", windowStart: minute, count: 20 },
        }),
      );
      // Deadline one second before the next minute opens.
      await setPost(postId, { approvedAt: new Date(minute.getTime() + 59_000 - 30 * MIN) });
      expect(await deliverPublication(worker, pubs[0]!.id)).toEqual({ status: "succeeded", errorCode: "SOCIAL_SLOT_EXPIRED" });
      await expectExpired(pubs[0]!.id, postId);
      expect((await deliverJobs(pubs[0]!.id)).some((j) => String(j.idempotencyKey).includes(":t"))).toBe(false);
    });
  });

  it("blocks a publication whose post changed after it was dispatched", async () => {
    const { postId, pubs } = await publications([await telegramAccount()]);
    await p.run((tx) => tx.socialPostVariant.updateMany({ where: { postId }, data: { body: "Changed behind the approval." } }));
    await deliverPublication(worker, pubs[0]!.id);
    expect(await pub(pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "SOCIAL_APPROVAL_STALE" });
  });
});
