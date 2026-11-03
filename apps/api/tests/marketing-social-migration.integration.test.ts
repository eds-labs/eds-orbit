import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import { readMarketingSettings, saveMarketingSettings } from "../src/modules/marketing/publishing/backend.ts";
import { mapPostizChannel, mirrorPostizHistory, postizInventory, socialMapping } from "../src/modules/marketing/publishing/social-migration.ts";
import { updatePost } from "../src/modules/social/posts/posts.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { createPackageProject, TELEGRAM, X } from "./support/package-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Moving a project from Postiz to Social (ADR 0020, S10): the owner maps
 * each Postiz channel to the Social account of the same platform; Social
 * then resolves Marketing's channels through that mapping (S9).
 */
describe.skipIf(!enabled)("marketing social migration", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let xAccount = "";
  let telegramAccount = "";
  let otherX = "";
  const run = <T>(work: (tx: DbTx) => Promise<T>) => scoped(project.owner.workspaceId, project.owner.projectId, work);
  const account = (tx: DbTx, platform: string, handle: string) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle,
        displayName: handle,
        capability: "write_verified",
        createdBy: project.owner.userId,
      },
    });

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    project = await createPackageProject({ name: "Synthetic social migration" });
    await run(async (tx) => {
      await tx.projectModule.create({
        data: { workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: project.owner.userId },
      });
      xAccount = (await account(tx, "x", "@synthetic_x")).id;
      otherX = (await account(tx, "x", "@other_x")).id;
      telegramAccount = (await account(tx, "telegram", "Synthetic Telegram")).id;
    });
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  it("lists the Postiz channels with a suggested account of the same platform", async () => {
    const view = await run((tx) => socialMapping(tx, project.owner));
    expect(view.backend).toBe("postiz");
    const byId = Object.fromEntries(view.channels.map((c) => [c.integrationId, c]));
    expect(byId[X]).toMatchObject({ name: "Synthetic X", platform: "x", accountId: null });
    expect(byId[TELEGRAM]).toMatchObject({ platform: "telegram", accountId: null, suggestedAccountId: telegramAccount });
    // LinkedIn has no Social account type yet.
    expect(byId["li-int"]).toMatchObject({ platform: null, suggestedAccountId: null });
    expect(view.accounts.map((a) => a.accountId).sort()).toEqual([xAccount, otherX, telegramAccount].sort());
  });

  it("maps a channel to one account of its platform, by the owner only", async () => {
    await expect(run((tx) => mapPostizChannel(tx, project.editor, { integrationId: X, accountId: xAccount }))).rejects.toThrow("OWNER_REQUIRED");
    await expect(run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: telegramAccount }))).rejects.toThrow(
      "SOCIAL_MAPPING_PLATFORM_MISMATCH",
    );
    await expect(run((tx) => mapPostizChannel(tx, project.owner, { integrationId: "unknown-int", accountId: xAccount }))).rejects.toThrow(
      "POSTIZ_CHANNEL_NOT_FOUND",
    );
    await run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: xAccount }));
    // A second account cannot take a mapped channel; an account maps one channel.
    await expect(run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: otherX }))).rejects.toThrow("SOCIAL_MAPPING_TAKEN");
    const view = await run((tx) => socialMapping(tx, project.owner));
    expect(view.channels.find((c) => c.integrationId === X)).toMatchObject({ accountId: xAccount });
    const audits = await run((tx) => tx.auditEvent.findMany({ where: { projectId: project.owner.projectId, action: "marketing.social_channel_mapped" } }));
    expect(audits.map((a) => a.metadata)).toEqual([{ integrationId: X, accountId: xAccount }]);
  });

  it("refuses to unmap while Marketing publishes through Social", async () => {
    const settings = await run((tx) => readMarketingSettings(tx, project.owner));
    await run((tx) => saveMarketingSettings(tx, project.owner, { publishingBackend: "social" }, settings.version));
    try {
      await expect(run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: null }))).rejects.toThrow("SOCIAL_MAPPING_IN_USE");
    } finally {
      const current = await run((tx) => readMarketingSettings(tx, project.owner));
      await run((tx) => saveMarketingSettings(tx, project.owner, { publishingBackend: "postiz" }, current.version));
    }
    await run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: null }));
    expect((await run((tx) => socialMapping(tx, project.owner))).channels.find((c) => c.integrationId === X)).toMatchObject({ accountId: null });
  });

  it("mirrors the Postiz history of mapped channels read-only, once, and follows the source", async () => {
    await run((tx) => mapPostizChannel(tx, project.owner, { integrationId: X, accountId: xAccount }));
    const pubs = await run(async (tx) => {
      const evidence = await create(tx, project.owner, "evidence", { status: "valid", items: [], facts: [] });
      const content = await create(tx, project.owner, "content", {
        type: "social",
        channel: X,
        title: "History",
        body: "From the Postiz days.",
        targetUrl: "https://example.invalid/blog",
        evidenceId: evidence.id,
        status: "reviewed",
      });
      const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      const pub = (status: string, extra: Record<string, unknown> = {}) =>
        create(tx, project.owner, "publications", { contentId: content.id, channel: X, status, scheduledAt: at(3), test: false, ...extra });
      return {
        published: await pub("published", { remoteId: "postiz-1", releaseUrl: "https://x.com/synthetic/status/1", completedAt: at(3) }),
        failed: await pub("failed"),
        canceled: await pub("canceled"),
        remote: await pub("scheduled_remote", { remoteId: "postiz-2" }),
        intent: await pub("intent_created"),
        test: await pub("published_test", { test: true }),
        unmapped: await create(tx, project.owner, "publications", { contentId: content.id, channel: TELEGRAM, status: "published", scheduledAt: at(2), test: false }),
        draft: await create(tx, project.owner, "postiz_drafts", {
          contentId: content.id,
          contentVersion: content.version,
          integrationId: X,
          status: "accepted",
          remoteId: "postiz-draft-1",
          remoteDate: at(1),
          body: "From the Postiz days.",
        }),
      };
    });
    const dry = await run((tx) => mirrorPostizHistory(tx, project.owner, { dryRun: true }));
    expect(dry).toMatchObject({ dryRun: true, created: 5, updated: 0, unchanged: 0, unmapped: 1 });
    expect(dry.byStatus).toEqual({ published: 1, failed: 1, canceled: 1, accepted: 1, draft: 1 });
    expect(await run((tx) => tx.socialPost.count({ where: { projectId: project.owner.projectId, origin: "legacy_postiz" } }))).toBe(0);
    await expect(run((tx) => mirrorPostizHistory(tx, project.editor, { dryRun: false }))).rejects.toThrow("OWNER_REQUIRED");
    const applied = await run((tx) => mirrorPostizHistory(tx, project.owner, { dryRun: false }));
    expect(applied).toMatchObject({ dryRun: false, created: 5, updated: 0, unmapped: 1 });
    const mirrored = await run((tx) =>
      tx.socialPublication.findFirstOrThrow({ where: { projectId: project.owner.projectId, legacyEntityId: pubs.published.id } }),
    );
    expect(mirrored).toMatchObject({ status: "published", externalPostId: "postiz-1", permalink: "https://x.com/synthetic/status/1", accountId: xAccount });
    const post = await run(async (tx) => {
      const variant = await tx.socialPostVariant.findUniqueOrThrow({ where: { id: mirrored.variantId } });
      return tx.socialPost.findUniqueOrThrow({ where: { id: variant.postId } });
    });
    expect(post).toMatchObject({ origin: "legacy_postiz", readOnly: true, status: "published" });
    expect(post.baseText).toContain("From the Postiz days.");
    await expect(
      run((tx) => updatePost(tx, project.owner, post.id, { version: post.version, baseText: "Changed", baseMedia: [], variants: [{ accountId: xAccount }] })),
    ).rejects.toThrow("SOCIAL_POST_READ_ONLY");
    // Again: nothing new; a source that moved on updates its mirror only.
    expect(await run((tx) => mirrorPostizHistory(tx, project.owner, { dryRun: false }))).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "publications", pubs.remote.id);
      await update(tx, project.owner, row, { ...data(row), status: "published", releaseUrl: "https://x.com/synthetic/status/2" });
    });
    expect(await run((tx) => mirrorPostizHistory(tx, project.owner, { dryRun: false }))).toMatchObject({ created: 0, updated: 1, unchanged: 4 });
    const moved = await run((tx) =>
      tx.socialPublication.findFirstOrThrow({ where: { projectId: project.owner.projectId, legacyEntityId: pubs.remote.id } }),
    );
    expect(moved).toMatchObject({ status: "published", permalink: "https://x.com/synthetic/status/2" });
    // The source is never touched.
    expect(data(await run((tx) => entity(tx, project.owner, "publications", pubs.published.id)))).not.toHaveProperty("mirroredAt");
    expect(pubs.intent && pubs.test && pubs.unmapped && pubs.draft).toBeTruthy();
  });

  it("counts what Postiz still holds, without any text, and says when the switch is safe", async () => {
    const inventory = await run((tx) => postizInventory(tx, project.owner));
    expect(inventory).toMatchObject({
      backend: "postiz",
      channels: { assigned: 3, mapped: 1 },
      publications: expect.objectContaining({ published: 3, failed: 1, canceled: 1 }),
      postizDrafts: { accepted: 1 },
      readyToSwitch: true,
    });
    expect(JSON.stringify(inventory)).not.toMatch(/Postiz days|body|text|token/i);
    // A post Postiz has not settled yet holds the switch back.
    await run((tx) => create(tx, project.owner, "publications", { channel: X, status: "scheduled_remote", scheduledAt: new Date().toISOString(), test: false }));
    expect(await run((tx) => postizInventory(tx, project.owner))).toMatchObject({ readyToSwitch: false, blockingSwitch: 1 });
  });
});
