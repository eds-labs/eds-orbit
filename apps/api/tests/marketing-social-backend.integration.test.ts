import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import { create } from "../src/shared.ts";
import { packageFor, preflight } from "../src/modules/marketing/policy/policy.ts";
import { readMarketingSettings, saveMarketingSettings } from "../src/modules/marketing/publishing/backend.ts";
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

  const backend = async (value: "postiz" | "social") => {
    const current = await run((tx) => readMarketingSettings(tx, project.owner));
    await run((tx) => saveMarketingSettings(tx, project.owner, { publishingBackend: value }, current.version));
  };

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
      expect(unmapped.packageData).toMatchObject({ publishingBackend: "social", socialAccountId: null, socialAccountVersion: null });
      expect(unmapped.packageData).not.toHaveProperty("connectorId");
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
      const mapped = await run((tx) => packageFor(tx, project.owner, contentId));
      expect(mapped.packageData).toMatchObject({ publishingBackend: "social", socialAccountId: accountId, socialAccountVersion: 1 });
      expect(mapped.packageHash).not.toBe(before.packageHash);
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
