import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { create, data } from "../src/shared.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import {
  archivePost,
  cancelPost,
  createPost,
  getPost,
  listPosts,
  packageOf,
  updatePost,
} from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * Social posts (ADR 0020, S4): one base text and image set, a variant per
 * account that inherits or overrides it, optimistic versions, and an
 * approval that any change of the package clears.
 */
describe.skipIf(!enabled)("social posts", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let x = "";
  let telegram = "";
  let image = "";
  let image2 = "";

  const account = (tx: DbTx, q: typeof p, platform: string, status = "active") =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: q.owner.workspaceId,
        projectId: q.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_orbit`,
        displayName: `Orbit ${platform}`,
        capability: "write_verified",
        status,
        createdBy: q.owner.userId,
      },
    });
  const draft = (over: Record<string, unknown> = {}) =>
    p.run((tx) =>
      createPost(tx, p.editor, {
        title: "Launch",
        baseText: "We are live.",
        baseMedia: [image],
        variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X." }],
        ...over,
      }),
    );

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
    x = (await p.run((tx) => account(tx, p, "x"))).id;
    telegram = (await p.run((tx) => account(tx, p, "telegram"))).id;
    image = (await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" })).id;
    image2 = (await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" })).id;
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("creates a draft whose variants inherit the base or override it", async () => {
    const post = await draft();
    expect(post).toMatchObject({ status: "draft", title: "Launch", baseText: "We are live.", version: 1, packageHash: null });
    expect(post.baseMedia.map((m) => m.mediaId)).toEqual([image]);
    expect(post.approval).toEqual({ state: "none", requestId: null, approvedAt: null, approvedBy: null });
    const byAccount = Object.fromEntries(post.variants.map((v) => [v.accountId, v]));
    expect(byAccount[telegram]).toMatchObject({ platform: "telegram", body: "We are live.", inheritsText: true, inheritsMedia: true });
    expect(byAccount[telegram]!.media.map((m) => m.mediaId)).toEqual([image]);
    expect(byAccount[x]).toMatchObject({ platform: "x", body: "We are live on X.", inheritsText: false, inheritsMedia: true });
    expect(post.schedule).toMatchObject({ mode: "none", at: null, timeZone: expect.any(String) });
    // Validation runs on save but never blocks a draft.
    expect(byAccount[x]!.issues).toEqual([]);
  });

  it("passes base changes only to inheriting variants and refuses old versions", async () => {
    const post = await draft();
    const updated = await p.run((tx) =>
      updatePost(tx, p.editor, post.id, {
        version: 1,
        title: "Launch",
        baseText: "We are live today.",
        baseMedia: [image2, image],
        variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X.", media: [image] }],
      }),
    );
    const byAccount = Object.fromEntries(updated.variants.map((v) => [v.accountId, v]));
    expect(byAccount[telegram]!.body).toBe("We are live today.");
    expect(byAccount[telegram]!.media.map((m) => m.mediaId)).toEqual([image2, image]);
    expect(byAccount[x]).toMatchObject({ body: "We are live on X.", inheritsMedia: false });
    expect(updated.version).toBe(2);
    await expect(
      p.run((tx) => updatePost(tx, p.editor, post.id, { version: 1, baseText: "x", baseMedia: [], variants: [{ accountId: x }] })),
    ).rejects.toMatchObject({ code: "SOCIAL_VERSION_CONFLICT", status: 409 });
    // Dropping an account removes its variant.
    const fewer = await p.run((tx) =>
      updatePost(tx, p.editor, post.id, { version: 2, baseText: "Only X", baseMedia: [], variants: [{ accountId: x }] }),
    );
    expect(fewer.variants.map((v) => v.accountId)).toEqual([x]);
  });

  it("never touches another project's accounts or images", async () => {
    const foreignAccount = (await other.run((tx) => account(tx, other, "telegram"))).id;
    const foreignImage = (await uploadMedia(other.editor, { bytes: PNG, mime: "image/png" })).id;
    await expect(draft({ variants: [{ accountId: foreignAccount }] })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(draft({ baseMedia: [foreignImage] })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const post = await draft();
    await expect(other.run((tx) => getPost(tx, other.viewer, post.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a disconnected account", async () => {
    const gone = (await p.run((tx) => account(tx, p, "facebook", "disabled"))).id;
    await expect(draft({ variants: [{ accountId: gone }] })).rejects.toMatchObject({ code: "SOCIAL_ACCOUNT_NOT_ACTIVE", status: 409 });
  });

  it("clears an approval and withdraws a pending request when the package changes", async () => {
    const post = await draft();
    const pkg = await p.run((tx) => packageOf(tx, p.owner, post.id));
    // An approved, scheduled post (the approval flow itself is S4 Task 6).
    await p.run((tx) =>
      tx.socialPost.update({
        where: { id: post.id },
        data: {
          status: "scheduled",
          scheduleMode: "at",
          scheduledAt: new Date(Date.now() + 86_400_000),
          approvedAt: new Date(),
          approvedBy: p.owner.userId,
        },
      }),
    );
    const scheduledHash = (await p.run((tx) => packageOf(tx, p.owner, post.id))).hash;
    expect(scheduledHash).not.toBe(pkg.hash);
    await p.run((tx) => tx.socialPost.update({ where: { id: post.id }, data: { packageHash: scheduledHash } }));
    // A title alone is not part of the package.
    const titled = await p.run((tx) =>
      updatePost(tx, p.editor, post.id, {
        version: 1,
        title: "Launch day",
        baseText: "We are live.",
        baseMedia: [image],
        variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X." }],
      }),
    );
    expect(titled).toMatchObject({ status: "scheduled", packageHash: scheduledHash });
    const edited = await p.run((tx) =>
      updatePost(tx, p.editor, post.id, {
        version: 2,
        title: "Launch day",
        baseText: "We are live!",
        baseMedia: [image],
        variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X." }],
      }),
    );
    expect(edited).toMatchObject({ status: "draft", packageHash: null, approval: { state: "none" } });
    expect(edited.schedule.mode).toBe("at");

    // A post waiting for a decision: the request is withdrawn.
    const waiting = await draft();
    const request = await p.run(async (tx) => {
      const row = await create(tx, p.editor, "action_requests", {
        actionType: "social.post.schedule",
        status: "pending",
        payload: { postId: waiting.id },
        packageHash: "f".repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await tx.socialPost.update({
        where: { id: waiting.id },
        data: { status: "needs_approval", approvalRequestId: row.id, packageHash: "f".repeat(64) },
      });
      return row;
    });
    expect((await p.run((tx) => getPost(tx, p.viewer, waiting.id))).approval).toMatchObject({ state: "pending", requestId: request.id });
    await p.run((tx) => cancelPost(tx, p.editor, waiting.id, 1));
    const after = await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: request.id } }));
    expect(data(after).status).toBe("canceled");
    expect(await p.run((tx) => getPost(tx, p.viewer, waiting.id))).toMatchObject({ status: "draft", approval: { state: "none" } });
  });

  it("hashes the package: body, image order, options and time, not the title", async () => {
    const post = await draft();
    const base = (await p.run((tx) => packageOf(tx, p.owner, post.id))).hash;
    const variant = async (change: (tx: DbTx) => Promise<unknown>) => {
      await p.run(change);
      return (await p.run((tx) => packageOf(tx, p.owner, post.id))).hash;
    };
    const titled = await variant((tx) => tx.socialPost.update({ where: { id: post.id }, data: { title: "Other" } }));
    expect(titled).toBe(base);
    const options = await variant((tx) =>
      tx.socialPostVariant.updateMany({ where: { postId: post.id, accountId: x }, data: { platformOptions: { replySettings: "following" } } }),
    );
    expect(options).not.toBe(base);
    const timed = await variant((tx) =>
      tx.socialPost.update({ where: { id: post.id }, data: { scheduleMode: "at", scheduledAt: new Date(Date.now() + 3_600_000) } }),
    );
    expect(timed).not.toBe(options);
  });

  it("keeps legacy mirrors read-only and archives only finished or draft posts", async () => {
    const post = await draft();
    await p.run((tx) => tx.socialPost.update({ where: { id: post.id }, data: { status: "scheduled" } }));
    await expect(p.run((tx) => archivePost(tx, p.editor, post.id, 1))).rejects.toMatchObject({ code: "SOCIAL_POST_NOT_EDITABLE", status: 409 });
    const free = await draft();
    expect(await p.run((tx) => archivePost(tx, p.editor, free.id, 1))).toMatchObject({ status: "archived", version: 2 });
    await p.run((tx) =>
      tx.socialPost.update({ where: { id: free.id }, data: { origin: "legacy_postiz", readOnly: true, status: "draft" } }),
    );
    await expect(
      p.run((tx) => updatePost(tx, p.editor, free.id, { version: 2, baseText: "x", baseMedia: [], variants: [{ accountId: x }] })),
    ).rejects.toMatchObject({ code: "SOCIAL_POST_READ_ONLY", status: 409 });
  });

  it("lists posts newest first with paging and a bounded time range", async () => {
    const page = await p.run((tx) => listPosts(tx, p.viewer, { limit: 2 }));
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await p.run((tx) => listPosts(tx, p.viewer, { limit: 2, cursor: page.nextCursor! }));
    expect(next.items.map((i) => i.id)).not.toContain(page.items[0]!.id);
    expect(page.items[0]).toMatchObject({ accounts: expect.any(Array), approvalState: expect.any(String) });
    await expect(
      p.run((tx) => listPosts(tx, p.viewer, { from: "2026-12-01T00:00:00Z", to: "2027-02-02T00:00:00Z" })),
    ).rejects.toMatchObject({ code: "SOCIAL_RANGE_TOO_LARGE", status: 422 });
    const drafts = await p.run((tx) => listPosts(tx, p.viewer, { status: "archived" }));
    expect(drafts.items.every((i) => i.status === "archived")).toBe(true);
    const all = await p.run((tx) => listPosts(tx, p.viewer, {}));
    expect(all.items.some((i) => i.status === "archived")).toBe(false);
  });
});
