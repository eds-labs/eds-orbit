import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { data } from "../src/shared.ts";
import { DELIVER, DISPATCH } from "../src/modules/social/dispatch/jobs.ts";
import { refreshPostStatus } from "../src/modules/social/dispatch/status.ts";
import { publishNow, reschedulePost, schedulePost } from "../src/modules/social/posts/approval.ts";
import { createPost, getPost, updatePost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const DAY = 86_400_000;

/**
 * From an approved post to its publications (ADR 0020 §7, S5): one
 * dispatch job per approved version, due at the post's time; it creates a
 * publication and a delivery job per account. A change before that cancels
 * the job.
 */
describe.skipIf(!enabled)("social dispatch", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let x = "";
  let telegram = "";
  const localIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + "10:00";
  const account = (tx: DbTx, platform: string) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_orbit`,
        displayName: platform,
        capability: "write_verified",
        createdBy: p.owner.userId,
      },
    });
  const draft = () =>
    p.run((tx) => createPost(tx, p.editor, { baseText: "We are live.", baseMedia: [], variants: [{ accountId: telegram }, { accountId: x }] }));
  const jobs = (topic: string, resourceId?: string) =>
    p.run(async (tx) =>
      (await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "asc" } }))
        .filter((j) => data(j).topic === topic && (!resourceId || data(j).resourceId === resourceId))
        .map((j) => ({ id: j.id, ...data(j) }) as { id: string } & Record<string, any>),
    );
  const runDispatch = async (job: { id: string } & Record<string, unknown>) =>
    registeredJobs()
      .get(DISPATCH)!
      .handler({ scope: { ...p.owner, userId: "worker" }, jobId: job.id, job, executionMode: "test" });
  const publications = (postId: string) =>
    p.run(async (tx) => {
      const variants = await tx.socialPostVariant.findMany({ where: { postId } });
      return tx.socialPublication.findMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
    });

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    x = (await p.run((tx) => account(tx, "x"))).id;
    telegram = (await p.run((tx) => account(tx, "telegram"))).id;
  });
  afterAll(async () => {
    await p?.cleanup();
    await closeDatabase();
  });

  it("enqueues one dispatch job at the scheduled time, and one for now on publish-now", async () => {
    const post = await draft();
    const scheduled = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(3) }));
    const [job] = await jobs(DISPATCH, post.id);
    expect(job).toMatchObject({ status: "queued", idempotencyKey: `social-dispatch:${post.id}:v${scheduled.version}`, postVersion: String(scheduled.version) });
    expect(Date.parse(String(job!.availableAt))).toBe(Date.parse(scheduled.schedule.at!));
    const now = await draft();
    await p.run((tx) => publishNow(tx, p.owner, now.id, { version: 1 }));
    const [nowJob] = await jobs(DISPATCH, now.id);
    expect(Math.abs(Date.parse(String(nowJob!.availableAt)) - Date.now())).toBeLessThan(10_000);
  });

  it("creates a publication and a delivery job per account, once", async () => {
    const post = await draft();
    await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    const [job] = await jobs(DISPATCH, post.id);
    expect(await runDispatch(job!)).toEqual({ status: "succeeded", errorCode: null });
    const pubs = await publications(post.id);
    expect(pubs.map((pub) => pub.status).sort()).toEqual(["pending", "pending"]);
    expect(new Set(pubs.map((pub) => pub.idempotencyKey)).size).toBe(2);
    expect((await p.run((tx) => getPost(tx, p.viewer, post.id))).status).toBe("publishing");
    const delivers = (await jobs(DELIVER)).filter((j) => pubs.some((pub) => pub.id === j.resourceId));
    expect(delivers.map((j) => j.idempotencyKey).sort()).toEqual(pubs.map((pub) => `social-deliver:${pub.id}:1`).sort());
    expect(await runDispatch(job!)).toMatchObject({ status: "canceled" });
    expect(await publications(post.id)).toHaveLength(2);
  });

  it("cancels the job of a post that changed, and leaves an old version's job without effect", async () => {
    const post = await draft();
    const scheduled = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(3) }));
    await p.run((tx) =>
      updatePost(tx, p.owner, post.id, {
        version: scheduled.version,
        baseText: "Changed.",
        baseMedia: [],
        variants: [{ accountId: telegram }, { accountId: x }],
      }),
    );
    const [job] = await jobs(DISPATCH, post.id);
    expect(job).toMatchObject({ status: "canceled" });
    expect(await runDispatch({ ...job!, status: "queued" })).toEqual({ status: "canceled", errorCode: "SOCIAL_POST_CHANGED" });
    expect(await publications(post.id)).toHaveLength(0);
  });

  it("replaces the job when an owner moves the post", async () => {
    const post = await draft();
    const scheduled = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(3) }));
    const moved = await p.run((tx) => reschedulePost(tx, p.owner, post.id, { version: scheduled.version, local: localIn(4), reapprove: true }));
    const all = await jobs(DISPATCH, post.id);
    expect(all.map((j) => j.status)).toEqual(["canceled", "queued"]);
    expect(Date.parse(String(all[1]!.availableAt))).toBe(Date.parse(moved.schedule.at!));
  });

  it("derives the post's status from its publications", async () => {
    const post = await draft();
    await p.run((tx) => publishNow(tx, p.owner, post.id, { version: 1 }));
    await runDispatch((await jobs(DISPATCH, post.id))[0]!);
    const [a, b] = await publications(post.id);
    const statusWith = async (first: string, second: string) => {
      await p.run(async (tx) => {
        await tx.socialPublication.update({ where: { id: a!.id }, data: { status: first } });
        await tx.socialPublication.update({ where: { id: b!.id }, data: { status: second } });
        await refreshPostStatus(tx, p.owner, post.id);
      });
      return (await p.run((tx) => getPost(tx, p.viewer, post.id))).status;
    };
    expect(await statusWith("published", "published")).toBe("published");
    expect(await statusWith("published", "failed")).toBe("partially_published");
    expect(await statusWith("failed", "canceled")).toBe("failed");
    expect(await statusWith("canceled", "canceled")).toBe("canceled");
    expect(await statusWith("published", "outcome_unknown")).toBe("publishing");
    // A publishing post cannot be edited.
    const current = await p.run((tx) => getPost(tx, p.viewer, post.id));
    await expect(
      p.run((tx) => updatePost(tx, p.owner, post.id, { version: current.version, baseText: "x", baseMedia: [], variants: [{ accountId: x }] })),
    ).rejects.toMatchObject({ code: "SOCIAL_POST_NOT_EDITABLE" });
  });
});
