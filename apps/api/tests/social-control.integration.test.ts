import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { data } from "../src/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { resolvePublication, resumeBlocked } from "../src/modules/social/dispatch/control.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { DELIVER } from "../src/modules/social/dispatch/jobs.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { cancelPost, createPost, getPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Stopping, pausing and settling publications (ADR 0020 §7, S5): cancel
 * stops what was not sent yet; a pause blocks deliveries and a resume picks
 * up only recent ones; the owner settles an unclear send.
 */
describe.skipIf(!enabled)("social delivery control", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  let sends = 0;

  const account = (tx: DbTx) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        connectionId: randomUUID(),
        platform: "telegram",
        externalId: randomUUID(),
        handle: "@orbit_news",
        displayName: "Orbit news",
        capability: "write_verified",
        createdBy: p.owner.userId,
      },
    });
  const dispatched = async (accounts = 2) => {
    const ids = await p.run(async (tx) => Promise.all(Array.from({ length: accounts }, async () => (await account(tx)).id)));
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: "We are live.", baseMedia: [], variants: ids.map((accountId) => ({ accountId })) }));
    const approved = await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    await dispatchPost(worker, post.id, approved.version);
    const variants = await p.run((tx) => tx.socialPostVariant.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } }));
    const pubs = await p.run((tx) => tx.socialPublication.findMany({ where: { variantId: { in: variants.map((v) => v.id) } } }));
    return { postId: post.id, pubs };
  };
  const pub = (id: string) => p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id } }));
  const post = (id: string) => p.run((tx) => getPost(tx, p.viewer, id));
  const deliverJob = async (publicationId: string) =>
    (await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "desc" } })))
      .map((j) => ({ id: j.id, ...data(j) }) as { id: string } & Record<string, any>)
      .find((j) => j.topic === DELIVER && j.resourceId === publicationId)!;

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    setSocialFetchForTests(async () => {
      sends++;
      return new Response("{}", { status: 500 });
    });
  });
  afterEach(() => {
    sends = 0;
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await p?.cleanup();
    await closeDatabase();
  });

  it("cancels what was not sent yet and marks a send in flight", async () => {
    const { postId, pubs } = await dispatched(2);
    const [waiting, inFlight] = pubs;
    await p.run((tx) => tx.socialPublication.update({ where: { id: inFlight!.id }, data: { status: "sending", fence: randomUUID() } }));
    const view = await post(postId);
    await p.run((tx) => cancelPost(tx, p.editor, postId, view.version));
    expect((await pub(waiting!.id)).status).toBe("canceled");
    expect((await deliverJob(waiting!.id)).status).toBe("canceled");
    expect((await pub(inFlight!.id)).status).toBe("cancel_requested");
    expect((await post(postId)).status).toBe("publishing");
  });

  it("drops a claimed delivery that was canceled before the provider call", async () => {
    const { pubs } = await dispatched(1);
    await p.run((tx) => tx.socialPublication.update({ where: { id: pubs[0]!.id }, data: { status: "cancel_requested" } }));
    await deliverPublication(worker, pubs[0]!.id);
    expect((await pub(pubs[0]!.id)).status).toBe("canceled");
    expect(sends).toBe(0);
  });

  it("blocks deliveries while paused and resumes only recent ones", async () => {
    const recent = await dispatched(1);
    const old = await dispatched(1);
    for (const one of [recent, old]) {
      const job = await deliverJob(one.pubs[0]!.id);
      await scoped(p.owner.workspaceId, p.owner.projectId, (tx) => registeredJobs().get(DELIVER)!.onBlockedByPause!(tx, job, worker));
    }
    expect(await pub(recent.pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "PROJECT_PAUSED" });
    // The old post was due 40 minutes ago.
    await p.run((tx) => tx.socialPublication.update({ where: { id: old.pubs[0]!.id }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } }));
    const resumed = await p.run((tx) => resumeBlocked(tx, worker, new Date(), 7));
    expect(resumed).toBe(1);
    expect((await pub(recent.pubs[0]!.id)).status).toBe("pending");
    expect((await deliverJob(recent.pubs[0]!.id)).idempotencyKey).toBe(`social-deliver:${recent.pubs[0]!.id}:g7`);
    expect(await pub(old.pubs[0]!.id)).toMatchObject({ status: "blocked", blockedCode: "PROJECT_PAUSED" });
  });

  it("lets only the owner settle an unclear send", async () => {
    const { postId, pubs } = await dispatched(1);
    const id = pubs[0]!.id;
    await p.run((tx) => tx.socialPublication.update({ where: { id }, data: { status: "outcome_unknown" } }));
    const version = (await pub(id)).version;
    await expect(p.run((tx) => resolvePublication(tx, p.editor, id, { resolution: "not_published", version }))).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
    });
    const resolved = await p.run((tx) => resolvePublication(tx, p.owner, id, { resolution: "not_published", version }));
    expect(resolved).toMatchObject({ status: "failed", resolution: "not_published" });
    expect((await post(postId)).status).toBe("failed");
    await expect(
      p.run((tx) => resolvePublication(tx, p.owner, id, { resolution: "published_confirmed", version: resolved.version })),
    ).rejects.toMatchObject({ code: "SOCIAL_PUBLICATION_NOT_UNKNOWN", status: 409 });
    const other = await dispatched(1);
    const otherId = other.pubs[0]!.id;
    await p.run((tx) => tx.socialPublication.update({ where: { id: otherId }, data: { status: "outcome_unknown" } }));
    const confirmed = await p.run(async (tx) =>
      resolvePublication(tx, p.owner, otherId, {
        resolution: "published_confirmed",
        permalink: "https://t.me/orbit_news/9",
        version: (await tx.socialPublication.findUniqueOrThrow({ where: { id: otherId } })).version,
      }),
    );
    expect(confirmed).toMatchObject({ status: "published", resolution: "published_confirmed", permalink: "https://t.me/orbit_news/9" });
    await expect(
      p.run((tx) => resolvePublication(tx, p.owner, otherId, { resolution: "published_confirmed", permalink: "javascript:alert(1)", version: confirmed.version })),
    ).rejects.toBeDefined();
  });

  it("lists a post's publications, test ones marked", async () => {
    const { postId, pubs } = await dispatched(1);
    await deliverPublication(worker, pubs[0]!.id);
    const view = await post(postId);
    expect(view.publications).toEqual([
      expect.objectContaining({ id: pubs[0]!.id, platform: "telegram", status: "published", test: true, externalPostId: expect.stringMatching(/^test:/) }),
    ]);
  });
});
