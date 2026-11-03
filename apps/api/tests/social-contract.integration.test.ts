import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { data } from "../src/shared.ts";
import {
  accountForChannel,
  importOriginMedia,
  originPostStatus,
  publishingBlockers,
  recentPublishedTexts,
  socialPublishingAvailable,
  submitOriginPost,
} from "../src/modules/social/contract.ts";
import { DISPATCH } from "../src/modules/social/dispatch/queues.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * What Marketing may use of Social (ADR 0020 §6.4, S9): Marketing's channel
 * (a Postiz integration id mapped to an account, or `social:<accountId>`),
 * what would block a post there, an origin-authorized post Social sends at
 * once or a timed draft for a human, and the post's status afterwards.
 */
describe.skipIf(!enabled)("social contract for Marketing", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let telegram = "";
  let x = "";
  const saved = { ...process.env };
  const origin = (id = randomUUID(), version = 1) => ({ module: "marketing" as const, type: "publication", id, version });

  const account = (tx: DbTx, q: typeof p, platform: string, legacy: string | null, extra: Record<string, unknown> = {}) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: q.owner.workspaceId,
        projectId: q.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_contract`,
        displayName: platform,
        capability: "write_verified",
        legacyPostizIntegrationId: legacy,
        createdBy: q.owner.userId,
        ...extra,
      },
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject({ name: "Synthetic social contract" });
    other = await createSocialProject({ name: "Synthetic social contract B" });
    telegram = (await p.run((tx) => account(tx, p, "telegram", "postiz-tg-1"))).id;
    x = (await p.run((tx) => account(tx, p, "x", "postiz-x-1"))).id;
    await other.run((tx) => account(tx, other, "telegram", "postiz-foreign"));
  });
  afterEach(() => {
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("knows whether the project can publish through Social", async () => {
    expect(await p.run((tx) => socialPublishingAvailable(tx, p.owner))).toBe(true);
    await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: p.owner.projectId, moduleId: "social" }, data: { enabled: false } }));
    try {
      expect(await p.run((tx) => socialPublishingAvailable(tx, p.owner))).toBe(false);
      expect(await p.run((tx) => publishingBlockers(tx, p.owner, "postiz-tg-1", { text: "Hi" }))).toEqual(["SOCIAL_DISABLED"]);
    } finally {
      await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: p.owner.projectId, moduleId: "social" }, data: { enabled: true } }));
    }
  });

  it("finds the account behind a Marketing channel, only in its own project", async () => {
    expect(await p.run((tx) => accountForChannel(tx, p.owner, "postiz-tg-1"))).toMatchObject({ accountId: telegram, platform: "telegram" });
    expect(await p.run((tx) => accountForChannel(tx, p.owner, `social:${x}`))).toMatchObject({ accountId: x, platform: "x" });
    for (const unknown of ["postiz-foreign", "postiz-none", `social:${randomUUID()}`, "social:not-a-uuid"])
      expect(await p.run((tx) => accountForChannel(tx, p.owner, unknown))).toBeNull();
  });

  it("lists what would block a post on the channel", async () => {
    const blockers = (channel: string, text: string) => p.run((tx) => publishingBlockers(tx, p.owner, channel, { text }));
    expect(await blockers("postiz-tg-1", "Fine")).toEqual([]);
    expect(await blockers("postiz-none", "Fine")).toEqual(["SOCIAL_CHANNEL_NOT_MAPPED"]);
    expect(await blockers("postiz-x-1", "x".repeat(300))).toContain("SOCIAL_TEXT_TOO_LONG");
    Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: "x" });
    expect(await blockers("postiz-tg-1", "Fine")).toContain("SOCIAL_PLATFORM_NOT_AVAILABLE");
    process.env.ORBIT_SOCIAL_PLATFORMS = "telegram";
    await p.run((tx) => tx.socialAccount.update({ where: { id: telegram }, data: { capability: "read_verified" } }));
    try {
      expect(await blockers("postiz-tg-1", "Fine")).toContain("SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED");
    } finally {
      await p.run((tx) => tx.socialAccount.update({ where: { id: telegram }, data: { capability: "write_verified" } }));
    }
  });

  it("creates an origin-authorized post that Social sends at once, once per origin", async () => {
    const o = origin();
    const first = await p.run((tx) =>
      submitOriginPost(tx, p.owner, { origin: o, accountId: telegram, text: "From Marketing", mediaIds: [], mode: "now", packageHash: "a".repeat(64) }),
    );
    expect(first.deduplicated).toBe(false);
    const post = await p.run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: first.postId } }));
    expect(post).toMatchObject({
      origin: "marketing",
      originModule: "marketing",
      originType: "publication",
      originId: o.id,
      originVersion: 1,
      status: "approved",
      scheduleMode: "now",
      approvedBy: p.owner.userId,
      baseText: "From Marketing",
    });
    const jobs = await p.run(async (tx) =>
      (await tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" } })).map((j) => data(j)).filter((j) => j.resourceId === post.id),
    );
    expect(jobs.map((j) => j.topic)).toEqual([DISPATCH]);
    const audits = await p.run((tx) => tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "social.post.approved", resourceId: post.id } }));
    expect(audits.map((a) => a.metadata)).toEqual([expect.objectContaining({ channel: "origin_authorized", originType: "publication", originPackageHash: "a".repeat(64) })]);
    const again = await p.run((tx) =>
      submitOriginPost(tx, p.owner, { origin: o, accountId: telegram, text: "From Marketing", mediaIds: [], mode: "now", packageHash: "a".repeat(64) }),
    );
    expect(again).toEqual({ postId: first.postId, deduplicated: true });
    await expect(
      p.run((tx) => submitOriginPost(tx, p.owner, { origin: origin(), accountId: x, text: "x".repeat(300), mediaIds: [], mode: "now", packageHash: "b".repeat(64) })),
    ).rejects.toThrow("SOCIAL_VALIDATION_FAILED");
  });

  it("creates a timed draft with an image for a human", async () => {
    const mediaId = await importOriginMedia(p.owner, { bytes: PNG, mime: "image/png" });
    const at = new Date(Date.now() + 2 * 86_400_000);
    const draft = await p.run((tx) =>
      submitOriginPost(tx, p.owner, { origin: origin(), accountId: telegram, text: "Draft from Marketing", mediaIds: [mediaId], mode: "draft", at }),
    );
    const post = await p.run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: draft.postId } }));
    expect(post).toMatchObject({ status: "draft", origin: "marketing", scheduleMode: "at", approvedAt: null, baseMedia: [mediaId] });
    expect(post.scheduledAt?.toISOString()).toBe(at.toISOString());
  });

  it("reports the status of origin posts and the texts published recently", async () => {
    const { postId } = await p.run((tx) =>
      submitOriginPost(tx, p.owner, { origin: origin(), accountId: telegram, text: "Status text", mediaIds: [], mode: "now", packageHash: "c".repeat(64) }),
    );
    expect(await p.run((tx) => originPostStatus(tx, p.owner, [postId, randomUUID()]))).toEqual([
      { postId, status: "pending", permalink: null, publishedAt: null, errorCode: null },
    ]);
    await p.run(async (tx) => {
      const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { postId } });
      await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          variantId: variant.id,
          accountId: telegram,
          idempotencyKey: randomUUID(),
          status: "published",
          externalPostId: "55",
          permalink: "https://t.me/orbit/55",
          publishedAt: new Date(),
        },
      });
      await tx.socialPost.update({ where: { id: postId }, data: { status: "published" } });
    });
    expect(await p.run((tx) => originPostStatus(tx, p.owner, [postId]))).toEqual([
      { postId, status: "published", permalink: "https://t.me/orbit/55", publishedAt: expect.any(String), errorCode: null },
    ]);
    expect(await p.run((tx) => recentPublishedTexts(tx, p.owner, [telegram], 7))).toContain("Status text");
    expect(await p.run((tx) => recentPublishedTexts(tx, p.owner, [x], 7))).not.toContain("Status text");
  });
});
