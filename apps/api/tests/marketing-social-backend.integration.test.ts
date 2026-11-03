import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import { create, data, entity } from "../src/shared.ts";
import { reconcilePublication } from "../src/modules/marketing/publishing/publisher.ts";
import { publishIntent } from "../src/modules/marketing/pipeline/workflow.ts";
import { bookPostizDraft } from "../src/modules/marketing/agents/draft-delivery.ts";
import { submitOriginPost } from "../src/modules/social/contract.ts";
import { packageFor, preflight } from "../src/modules/marketing/policy/policy.ts";
import { forcePublishingBackend } from "./support/marketing-backend.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Marketing on Social (ADR 0020, S9): a Postiz project's package is exactly
 * as before; a project on Social binds the Social account behind the
 * channel instead of the Postiz connector, and Social's blockers replace
 * the Postiz write checks.
 */
describe.skipIf(!enabled)("marketing publishing through Social", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let contentId = "";
  let accountId = "";
  const saved = { ...process.env };
  const run = <T>(work: (tx: DbTx) => Promise<T>) => scoped(project.owner.workspaceId, project.owner.projectId, work);

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    project = await createPackageProject({ name: "Synthetic marketing on social" });
    contentId = await run(async (tx) => {
      const evidence = await create(tx, project.owner, "evidence", { status: "valid", items: [], facts: [] });
      const content = await create(tx, project.owner, "content", {
        type: "social",
        channel: X,
        title: "Synthetic launch",
        body: "We launch the beta today.",
        evidenceId: evidence.id,
        status: "reviewed",
      });
      return content.id;
    });
    accountId = await run(async (tx) => {
      await tx.projectModule.create({
        data: { workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: project.owner.userId },
      });
      const account = await tx.socialAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          connectionId: randomUUID(),
          platform: "x",
          externalId: "4242",
          handle: "@orbit_x",
          displayName: "Orbit X",
          capability: "write_verified",
          createdBy: project.owner.userId,
        },
      });
      return account.id;
    });
  });
  afterEach(() => {
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  const backend = (value: "postiz" | "postiz_draining" | "social") => run((tx) => forcePublishingBackend(tx, project.owner, value));

  it("keeps a Postiz project's package input exactly as before", async () => {
    const pkg = await run((tx) => packageFor(tx, project.owner, contentId));
    // The keys, in this order, are hashed: any change re-approves every post.
    expect(Object.keys(pkg.packageData)).toEqual([
      "projectId",
      "connectorId",
      "connectorVersion",
      "connectorBaseUrl",
      "contentId",
      "contentVersion",
      "body",
      "title",
      "channel",
      "targetUrl",
      "assetId",
      "assetVersion",
      "assetHash",
      "scheduledAt",
      "evidenceId",
      "evidenceVersion",
      "evidenceHash",
      "policyId",
      "policyVersion",
    ]);
  });

  it("binds the Social account on Social, and switching changes the package", async () => {
    const before = await run((tx) => packageFor(tx, project.owner, contentId));
    await backend("social");
    try {
      const unmapped = await run((tx) => packageFor(tx, project.owner, contentId));
      expect(unmapped.packageData).toMatchObject({ publishingBackend: "social", socialAccountId: null });
      expect(unmapped.packageData).not.toHaveProperty("connectorId");
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
      const mapped = await run((tx) => packageFor(tx, project.owner, contentId));
      expect(mapped.packageData).toMatchObject({ publishingBackend: "social", socialAccountId: accountId });
      expect(mapped.packageHash).not.toBe(before.packageHash);
      // A health refusal and restore bump the account's version: approvals stay (Social re-checks at send).
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { version: { increment: 2 } } }));
      expect((await run((tx) => packageFor(tx, project.owner, contentId))).packageHash).toBe(mapped.packageHash);
    } finally {
      await backend("postiz");
    }
    expect((await run((tx) => packageFor(tx, project.owner, contentId))).packageHash).toBe(before.packageHash);
  });

  it("counts a text Social already published on the account as a duplicate", async () => {
    await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
    await backend("social");
    try {
      expect((await run((tx) => preflight(tx, project.owner, contentId, { test: true }))).blockers).not.toContain("DUPLICATE_CONTENT");
      await run(async (tx) => {
        const post = await tx.socialPost.create({
          data: { id: randomUUID(), workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, baseText: "We launch the beta today.", baseMedia: [], status: "published", scheduleTimezone: "UTC", createdBy: project.owner.userId },
        });
        const variant = await tx.socialPostVariant.create({
          data: { id: randomUUID(), workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, postId: post.id, accountId, body: "We launch the beta today.", contentHash: "a".repeat(64) },
        });
        await tx.socialPublication.create({
          data: { id: randomUUID(), workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, variantId: variant.id, accountId, idempotencyKey: randomUUID(), status: "published", externalPostId: "9", publishedAt: new Date() },
        });
      });
      expect((await run((tx) => preflight(tx, project.owner, contentId, { test: true }))).blockers).toContain("DUPLICATE_CONTENT");
    } finally {
      await backend("postiz");
    }
  });

  it("reconciles a blocked delivery as waiting, a post taken back as canceled, and withdraws on a stop", async () => {
    await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
    const handed = async (status: string) => {
      const pubId = randomUUID();
      const { postId } = await run((tx) =>
        submitOriginPost(tx, project.owner, {
          origin: { module: "marketing", type: "publication", id: pubId, version: 1 },
          accountId,
          text: `Handed ${pubId}`,
          mediaIds: [],
          mode: "now",
          packageHash: "1".repeat(64),
        }),
      );
      const row = await run((tx) =>
        create(tx, project.owner, "publications", {
          contentId,
          channel: X,
          status,
          publishingBackend: "social",
          remoteId: postId,
          scheduledAt: new Date().toISOString(),
          test: false,
        }),
      );
      return { pubId: row.id, postId };
    };
    const pub = (id: string) => run(async (tx) => data(await entity(tx, project.owner, "publications", id)));
    const blocked = await handed("scheduled_remote");
    await run(async (tx) => {
      const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { postId: blocked.postId } });
      await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          variantId: variant.id,
          accountId,
          idempotencyKey: randomUUID(),
          status: "blocked",
          blockedCode: "ACCOUNT_RECONNECT_REQUIRED",
        },
      });
    });
    await reconcilePublication(project.owner, blocked.pubId);
    expect(await pub(blocked.pubId)).toMatchObject({ status: "scheduled_remote", remoteState: "blocked", reason: "ACCOUNT_RECONNECT_REQUIRED" });
    const exceptions = await run((tx) => tx.entity.findMany({ where: { projectId: project.owner.projectId, kind: "exceptions" } }));
    expect(
      exceptions
        .map((e) => data(e))
        .filter((e) => e.resourceId === blocked.pubId || (e.resourceIds ?? []).includes(blocked.pubId))
        .map((e) => e.code),
    ).toContain("SOCIAL_DELIVERY_BLOCKED");
    const back = await handed("scheduled_remote");
    await run((tx) => tx.socialPost.update({ where: { id: back.postId }, data: { status: "draft" } }));
    await reconcilePublication(project.owner, back.pubId);
    expect(await pub(back.pubId)).toMatchObject({ status: "canceled", reason: "SOCIAL_POST_WITHDRAWN" });
    // A stop that reached Marketing after the handoff withdraws it in Social.
    const stopped = await handed("cancellation_required");
    await reconcilePublication(project.owner, stopped.pubId);
    expect(await pub(stopped.pubId)).toMatchObject({ status: "canceled" });
    expect((await run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: stopped.postId } }))).status).toBe("canceled");
  });

  it("drains Postiz: nothing new goes to Postiz, pending posts keep their package (S10)", async () => {
    const before = await run((tx) => packageFor(tx, project.owner, contentId));
    await backend("postiz_draining");
    try {
      expect((await run((tx) => packageFor(tx, project.owner, contentId))).packageHash).toBe(before.packageHash);
      const content = await run((tx) => entity(tx, project.owner, "content", contentId));
      await expect(run((tx) => publishIntent(tx, project.owner, { contentId, version: content.version }))).rejects.toThrow(
        "PUBLISHING_BACKEND_DRAINING",
      );
      await expect(
        run((tx) =>
          bookPostizDraft(tx, project.owner, {
            content,
            slotAt: new Date(Date.now() + 86_400_000),
            runId: randomUUID(),
            assignmentId: randomUUID(),
            approvedBy: "owner",
            reviewTaskId: null,
          }),
        ),
      ).rejects.toThrow("PUBLISHING_BACKEND_DRAINING");
    } finally {
      await backend("postiz");
    }
  });

  it("checks Social's blockers instead of the Postiz write verification on Social", async () => {
    Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: "telegram" });
    const postiz = await run((tx) => preflight(tx, project.owner, contentId, { test: false }));
    expect(postiz.blockers).toContain("PUBLISHER_WRITE_VERIFICATION_REQUIRED");
    await backend("social");
    try {
      const social = await run((tx) => preflight(tx, project.owner, contentId, { test: false }));
      expect(social.blockers).toContain("SOCIAL_PLATFORM_NOT_AVAILABLE");
      expect(social.blockers).not.toContain("PUBLISHER_WRITE_VERIFICATION_REQUIRED");
      expect(social.blockers).not.toContain("CHANNEL_WRITE_VERIFICATION_REQUIRED");
      process.env.ORBIT_SOCIAL_PLATFORMS = "x";
      const ready = await run((tx) => preflight(tx, project.owner, contentId, { test: false }));
      expect(ready.blockers.filter((b) => b.startsWith("SOCIAL_"))).toEqual([]);
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: null } }));
      const lost = await run((tx) => preflight(tx, project.owner, contentId, { test: false }));
      expect(lost.blockers).toContain("SOCIAL_CHANNEL_NOT_MAPPED");
    } finally {
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
      await backend("postiz");
    }
  });
});
