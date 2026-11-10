import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { readiness } from "../src/modules/marketing/readiness/readiness.ts";
import { readReadiness } from "../src/modules/marketing/readiness/readiness-admin.ts";
import { readinessActions } from "../src/modules/marketing/readiness/action-readiness.ts";
import { reconcilePublication } from "../src/modules/marketing/publishing/publisher.ts";
import { publishIntent } from "../src/modules/marketing/pipeline/workflow.ts";
import { bookPostizDraft } from "../src/modules/marketing/agents/draft-delivery.ts";
import { submitOriginPost } from "../src/modules/social/contract.ts";
import { packageFor, preflight } from "../src/modules/marketing/policy/policy.ts";
import { assertAssignedSocialChannels } from "../src/modules/marketing/publishing/postiz-assignment.ts";
import { resolveChannelRules } from "../src/modules/marketing/publishing/channel-rules.ts";
import { readPolicy, savePolicy } from "../src/modules/marketing/policy/policy-admin.ts";
import { channelNames } from "../src/modules/marketing/agents/assignment-overview.ts";
import { channelDirectory } from "../src/modules/marketing/publishing/channel-directory.ts";
import { forcePublishingBackend } from "./support/marketing-backend.ts";
import { createPackageProject, TELEGRAM, X } from "./support/package-project.ts";

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

  it("Marketing reconciles a Social SOCIAL_SLOT_EXPIRED as failed with the same code", async () => {
    await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X } }));
    const pubId = randomUUID();
    const { postId } = await run((tx) =>
      submitOriginPost(tx, project.owner, {
        origin: { module: "marketing", type: "publication", id: pubId, version: 1 },
        accountId,
        text: `Expired ${pubId}`,
        mediaIds: [],
        mode: "now",
        packageHash: "2".repeat(64),
      }),
    );
    const row = await run((tx) =>
      create(tx, project.owner, "publications", {
        contentId,
        channel: X,
        status: "scheduled_remote",
        publishingBackend: "social",
        remoteId: postId,
        scheduledAt: new Date().toISOString(),
        test: false,
      }),
    );
    await run(async (tx) => {
      const variant = await tx.socialPostVariant.findFirstOrThrow({ where: { postId } });
      await tx.socialPublication.create({
        data: {
          id: randomUUID(),
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          variantId: variant.id,
          accountId,
          idempotencyKey: randomUUID(),
          status: "failed",
          retryDisposition: "never",
          lastErrorCode: "SOCIAL_SLOT_EXPIRED",
        },
      });
      await tx.socialPost.update({ where: { id: postId }, data: { status: "failed" } });
    });
    await reconcilePublication(project.owner, row.id);
    const after = await run(async (tx) => data(await entity(tx, project.owner, "publications", row.id)));
    expect(after).toMatchObject({ status: "failed", remoteState: "failed", reason: "SOCIAL_SLOT_EXPIRED" });
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

  describe("native social:<accountId> channels (G9)", () => {
    const code = async (work: Promise<unknown>) => {
      try {
        await work;
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    const check = (channels: string[]) => run((tx) => assertAssignedSocialChannels(tx, project.owner, channels));

    it("accepts a social: reference on the Social backend", async () => {
      process.env.ORBIT_SOCIAL_PLATFORMS = "x";
      await backend("social");
      try {
        await expect(check([`social:${accountId}`])).resolves.toBeUndefined();
        const names = await run((tx) => channelNames(tx, project.owner));
        expect(names.get(`social:${accountId}`)).toBe("@orbit_x");
      } finally {
        await backend("postiz");
      }
    });

    it("refuses a social: reference on the Postiz backend", async () => {
      expect(await code(check([`social:${accountId}`]))).toBe("SOCIAL_CHANNEL_REQUIRES_SOCIAL_BACKEND");
    });

    it("refuses another project's account and a disabled one", async () => {
      const other = await createPackageProject({ name: "Synthetic other project" });
      try {
        const foreign = await scoped(other.owner.workspaceId, other.owner.projectId, async (tx) => {
          const account = await tx.socialAccount.create({
            data: {
              id: randomUUID(),
              workspaceId: other.owner.workspaceId,
              projectId: other.owner.projectId,
              connectionId: randomUUID(),
              platform: "x",
              externalId: "9",
              handle: "@other",
              displayName: "Other",
              capability: "write_verified",
              createdBy: other.owner.userId,
            },
          });
          return account.id;
        });
        await backend("social");
        try {
          expect(await code(check([`social:${foreign}`]))).toBe("POSTIZ_CHANNEL_NOT_ASSIGNED");
          expect(await code(check([`social:${randomUUID()}`]))).toBe("POSTIZ_CHANNEL_NOT_ASSIGNED");
          await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { status: "disabled" } }));
          expect(await code(check([`social:${accountId}`]))).toBe("POSTIZ_CHANNEL_NOT_ASSIGNED");
        } finally {
          await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { status: "active" } }));
          await backend("postiz");
        }
      } finally {
        await other.cleanup();
      }
    });

    it("refuses a platform the installation has not switched on", async () => {
      await backend("social");
      try {
        process.env.ORBIT_SOCIAL_PLATFORMS = "telegram";
        expect(await code(check([`social:${accountId}`]))).toBe("SOCIAL_PLATFORM_NOT_AVAILABLE");
        process.env.ORBIT_SOCIAL_PLATFORMS = "x";
        await expect(check([`social:${accountId}`])).resolves.toBeUndefined();
      } finally {
        await backend("postiz");
      }
    });

    it("accepts only the lowercase spelling of a social: reference", async () => {
      process.env.ORBIT_SOCIAL_PLATFORMS = "x";
      await backend("social");
      try {
        expect(await code(check([`social:${accountId.toUpperCase()}`]))).toBe("SOCIAL_CHANNEL_NOT_LOWERCASE");
        await expect(check([`social:${accountId}`])).resolves.toBeUndefined();
      } finally {
        await backend("postiz");
      }
    });

    it("names every channel content can carry, a disconnected account inactive (WP3)", async () => {
      const entries = async () => run((tx) => channelDirectory(tx, project.owner));
      expect(await entries()).toEqual(
        expect.arrayContaining([
          { id: X, name: "Synthetic X", platform: "x", source: "postiz", active: true },
          { id: TELEGRAM, name: "Synthetic Telegram", platform: "telegram", source: "postiz", active: true },
          { id: `social:${accountId}`, name: "@orbit_x", platform: "x", source: "social", active: true },
        ]),
      );
      // On either backend, and a viewer reads the same names.
      expect(await run((tx) => channelDirectory(tx, project.viewer))).toEqual(await entries());
      await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { status: "disabled" } }));
      try {
        expect((await entries()).find((e) => e.id === `social:${accountId}`)).toEqual({
          id: `social:${accountId}`,
          name: "@orbit_x",
          platform: "x",
          source: "social",
          active: false,
        });
        // Nothing beyond name and platform: no token, connection or external id.
        expect(JSON.stringify(await entries())).not.toMatch(/4242|connection|token/i);
      } finally {
        await run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { status: "active" } }));
      }
    });

    it("leaves Social's accounts out while Social is off or the member's Social role is none", async () => {
      const social = (entries: Array<{ source: string }>) => entries.filter((e) => e.source === "social");
      const postizOnly = (entries: Array<{ source: string }>) => entries.filter((e) => e.source === "postiz");
      const full = await run((tx) => channelDirectory(tx, project.viewer));
      expect(social(full)).not.toEqual([]);
      // Hidden from a member whose Social role is none; Postiz names stay.
      const hidden = await run((tx) => channelDirectory(tx, { ...project.viewer, moduleRoles: { social: "none" } }));
      expect(social(hidden)).toEqual([]);
      expect(hidden).toEqual(postizOnly(full));
      expect(JSON.stringify(hidden)).not.toContain("@orbit_x");
      // An owner always keeps the role.
      expect(social(await run((tx) => channelDirectory(tx, { ...project.owner, moduleRoles: { social: "none" } })))).not.toEqual([]);
      // Off for the installation or for the project.
      delete process.env.ORBIT_SOCIAL;
      try {
        expect(social(await run((tx) => channelDirectory(tx, project.owner)))).toEqual([]);
      } finally {
        process.env.ORBIT_SOCIAL = "true";
      }
      const where = { workspaceId_projectId_moduleId: { workspaceId: project.owner.workspaceId, projectId: project.owner.projectId, moduleId: "social" } };
      await run((tx) => tx.projectModule.update({ where, data: { enabled: false } }));
      try {
        const off = await run((tx) => channelDirectory(tx, project.owner));
        expect(social(off)).toEqual([]);
        expect(off).toEqual(postizOnly(full));
      } finally {
        await run((tx) => tx.projectModule.update({ where, data: { enabled: true } }));
      }
    });

    it("lists the project's Social accounts as assignable policy channels on the Social backend only", async () => {
      const ids = async () => (await run((tx) => readPolicy(tx, project.owner))).options.channels.map((c: { id: string }) => c.id);
      expect(await ids()).not.toContain(`social:${accountId}`);
      await backend("social");
      try {
        const channels = (await run((tx) => readPolicy(tx, project.owner))).options.channels;
        expect(channels).toContainEqual({ id: `social:${accountId}`, name: "@orbit_x", platform: "x" });
      } finally {
        await backend("postiz");
      }
    });

    it("channel rules for a social: Instagram channel require media", async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      const instagram = await run(async (tx) => {
        const account = await tx.socialAccount.create({
          data: {
            id: randomUUID(),
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            connectionId: randomUUID(),
            platform: "instagram",
            externalId: "ig-1",
            handle: "synthetic.ig",
            displayName: "IG",
            capability: "write_verified",
            createdBy: project.owner.userId,
          },
        });
        return account.id;
      });
      try {
        const rules = await run((tx) => resolveChannelRules(tx, project.owner, `social:${instagram}`, "social", true));
        expect(rules).toMatchObject({
          providerIdentifier: "instagram",
          connectorId: null,
          connectorVersion: null,
          characterLimit: 2200,
          liveCapabilityKnown: true,
          mediaRequired: true,
          postingTime: null,
        });
      } finally {
        delete process.env.ORBIT_CREATIVE_STUDIO;
        await run((tx) => tx.socialAccount.delete({ where: { id: instagram } }));
      }
    });
  });

  /**
   * Readiness mirrors preflight per backend (WP1): Postiz exactly as before,
   * Social's channel checks on Social, the drain plus Postiz's checks while
   * draining. Reading readiness never sends anything.
   */
  describe("readiness per publishing backend", () => {
    const POSTIZ_CODES = [
      "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
      "CHANNEL_WRITE_VERIFICATION_REQUIRED",
      "POSTIZ_NOT_CONNECTED",
      "POSTIZ_CHANNELS_NOT_ASSIGNED",
    ];
    const ENV = ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ENABLE_POSTIZ_DRAFTS", "ORBIT_SOCIAL_PLATFORMS", "ORBIT_SOCIAL"];
    let before: Record<string, string | undefined> = {};
    let telegramId = "";
    const state = () => run((tx) => readiness(tx, project.owner));
    const social = (codes: string[]) => codes.filter((code) => code.startsWith("SOCIAL_"));
    const postiz = (codes: string[]) => codes.filter((code) => POSTIZ_CODES.includes(code));
    // What a publish attempt would leave behind.
    const sent = () =>
      run(async (tx) => ({
        publications: await tx.entity.count({ where: { projectId: project.owner.projectId, kind: "publications" } }),
        socialPublications: await tx.socialPublication.count({ where: { projectId: project.owner.projectId } }),
        outbox: await tx.outbox.count({ where: { projectId: project.owner.projectId } }),
      }));
    const live = () => Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ENABLE_POSTIZ_DRAFTS: "true", ORBIT_SOCIAL_PLATFORMS: "x,telegram" });

    beforeAll(async () => {
      before = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
      telegramId = await run(async (tx) => {
        await tx.socialAccount.update({ where: { id: accountId }, data: { legacyPostizIntegrationId: X, status: "active", capability: "write_verified" } });
        const account = await tx.socialAccount.create({
          data: {
            id: randomUUID(),
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            connectionId: randomUUID(),
            platform: "telegram",
            externalId: "-1001",
            handle: "@orbit_tg",
            displayName: "Orbit Telegram",
            capability: "write_verified",
            legacyPostizIntegrationId: TELEGRAM,
            createdBy: project.owner.userId,
          },
        });
        return account.id;
      });
    });
    afterEach(() => {
      for (const key of ENV)
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
    });

    it("postiz: stays exactly as before (pinned) and publish_* equals postiz_*", async () => {
      Object.assign(process.env, { EXECUTION_MODE: "test", ENABLE_EXTERNAL_WRITES: "false" });
      delete process.env.ENABLE_POSTIZ_DRAFTS;
      const start = await sent();
      const r = await state();
      // Observed on the code before the backend split: the same values.
      expect(r.state).toBe("test_ready");
      expect(r.blockers).toEqual(["LIVE_RAG_EVAL_REQUIRED", "PUBLISHER_WRITE_VERIFICATION_REQUIRED", "EXTERNAL_WRITES_DISABLED"]);
      const write = ["PUBLISHER_WRITE_VERIFICATION_REQUIRED", "CHANNEL_WRITE_VERIFICATION_REQUIRED", "EXECUTION_MODE_TEST", "EXTERNAL_WRITES_DISABLED"];
      expect(r.actions.postiz_draft).toEqual({ state: "not_configured", effect: "external", blockers: ["POSTIZ_DRAFTS_DISABLED"] });
      expect(r.actions.postiz_schedule).toEqual({ state: "blocked", effect: "external", blockers: write });
      expect(r.actions.postiz_live).toEqual({ state: "blocked", effect: "external", blockers: write });
      expect(r.capabilities.social).toEqual({ state: "test_ready" });
      expect(Object.keys(r.actions)).toEqual([...readinessActions]);
      expect(r.actions.publish_draft).toEqual(r.actions.postiz_draft);
      expect(r.actions.publish_schedule).toEqual(r.actions.postiz_schedule);
      expect(r.actions.publish_live).toEqual(r.actions.postiz_live);
      expect(r.publishing).toEqual({ backend: "postiz", postizBacklog: 0 });
      expect((await run((tx) => readReadiness(tx, project.owner))).publishingBackend).toBe("postiz");
      expect(await sent()).toEqual(start);
    });

    it("social: Social's checks replace every Postiz code", async () => {
      live();
      const start = await sent();
      await backend("social");
      try {
        const r = await state();
        expect(postiz(r.blockers)).toEqual([]);
        expect(social(r.blockers)).toEqual([]);
        expect(r.publishing).toEqual({ backend: "social", postizBacklog: 0 });
        for (const action of ["publish_draft", "publish_schedule", "publish_live"] as const)
          expect(r.actions[action]).toMatchObject({ state: "ready", blockers: [] });
        for (const action of ["postiz_draft", "postiz_schedule", "postiz_live"] as const)
          expect(r.actions[action]).toEqual({ state: "not_configured", effect: "external", blockers: ["PUBLISHING_BACKEND_SOCIAL"] });
        for (const value of Object.values(r.actions)) expect(postiz(value.blockers)).toEqual([]);
        const admin = await run((tx) => readReadiness(tx, project.owner));
        expect(admin.publishingBackend).toBe("social");
        expect(postiz(admin.blockers.map((b) => b.code))).toEqual([]);
        expect(admin.blockers.find((b) => b.code === "PUBLISHING_BACKEND_SOCIAL")).toMatchObject({
          resolution: "orbit",
          affects: ["postiz_draft", "postiz_schedule", "postiz_live"],
        });
      } finally {
        await backend("postiz");
      }
      expect(await sent()).toEqual(start);
    });

    it("social: an unverified, inactive or unmapped account, a platform or module that is off name their codes", async () => {
      live();
      const start = await sent();
      const policyRow = await run(async (tx) => (await tx.entity.findMany({ where: { projectId: project.owner.projectId, kind: "policies" } })).find((p) => data(p).active)!);
      await backend("social");
      try {
        await run((tx) => tx.socialAccount.update({ where: { id: telegramId }, data: { capability: "read_verified" } }));
        let r = await state();
        expect(social(r.blockers)).toEqual(["SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED"]);
        expect(r.actions.publish_live.blockers).toEqual(["SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED"]);
        // A Social draft needs no verified posting.
        expect(r.actions.publish_draft).toMatchObject({ state: "ready", blockers: [] });
        // Test mode: still a blocker, as the Postiz write verification always is.
        process.env.EXECUTION_MODE = "test";
        r = await state();
        expect(social(r.blockers)).toEqual(["SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED"]);
        expect(r.actions.publish_schedule.blockers).toEqual(["SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED", "EXECUTION_MODE_TEST"]);
        process.env.EXECUTION_MODE = "live";
        await run((tx) => tx.socialAccount.update({ where: { id: telegramId }, data: { capability: "write_verified", status: "reconnect_required" } }));
        expect(social((await state()).blockers)).toEqual(["SOCIAL_ACCOUNT_NOT_ACTIVE"]);
        await run((tx) => tx.socialAccount.update({ where: { id: telegramId }, data: { status: "active", legacyPostizIntegrationId: null } }));
        r = await state();
        expect(social(r.blockers)).toEqual(["SOCIAL_CHANNEL_NOT_MAPPED"]);
        expect(r.actions.publish_draft.blockers).toEqual(["SOCIAL_CHANNEL_NOT_MAPPED"]);
        await run((tx) => tx.socialAccount.update({ where: { id: telegramId }, data: { legacyPostizIntegrationId: TELEGRAM } }));
        process.env.ORBIT_SOCIAL_PLATFORMS = "x";
        expect(social((await state()).blockers)).toEqual(["SOCIAL_PLATFORM_NOT_AVAILABLE"]);
        process.env.ORBIT_SOCIAL_PLATFORMS = "x,telegram";
        delete process.env.ORBIT_SOCIAL;
        r = await state();
        expect(social(r.blockers)).toEqual(["SOCIAL_DISABLED"]);
        expect(r.actions.publish_live).toMatchObject({ state: "not_configured", blockers: ["SOCIAL_DISABLED"] });
        process.env.ORBIT_SOCIAL = "true";
        await run((tx) => tx.entity.update({ where: { id: policyRow.id }, data: { data: { ...data(policyRow), channels: [] } } }));
        r = await state();
        expect(r.blockers).toContain("POLICY_CHANNELS_REQUIRED");
        expect(social(r.blockers)).toEqual([]);
        // Every code over MCP comes with its cause and fix.
        await run((tx) => tx.socialAccount.update({ where: { id: telegramId }, data: { capability: "read_verified" } }));
        const admin = await run((tx) => readReadiness(tx, project.owner));
        expect(admin.blockers.filter((b) => b.cause === "See the code.")).toEqual([]);
        expect(admin.blockers.find((b) => b.code === "POLICY_CHANNELS_REQUIRED")!.fix).toContain("social:<accountId>");
      } finally {
        await run(async (tx) => {
          await tx.entity.update({ where: { id: policyRow.id }, data: { data: data(policyRow) } });
          await tx.socialAccount.update({ where: { id: telegramId }, data: { capability: "write_verified", status: "active", legacyPostizIntegrationId: TELEGRAM } });
        });
        await backend("postiz");
      }
      process.env.ORBIT_SOCIAL_PLATFORMS = "x";
      await backend("social");
      try {
        const admin = await run((tx) => readReadiness(tx, project.owner));
        expect(admin.blockers.find((b) => b.code === "SOCIAL_PLATFORM_NOT_AVAILABLE")).toMatchObject({ resolution: "operator", automatable: false });
      } finally {
        await backend("postiz");
      }
      expect(await sent()).toEqual(start);
    });

    it("refuses live autopilot on Social until the owner decides; nothing is saved and Postiz is unchanged", async () => {
      live();
      const start = await sent();
      const stored = () =>
        run(async (tx) => ({
          policies: (await tx.entity.findMany({ where: { projectId: project.owner.projectId, kind: "policies" }, select: { id: true, version: true } })).sort((a, b) => a.id.localeCompare(b.id)),
          mode: (await tx.project.findUniqueOrThrow({ where: { id: project.owner.projectId }, select: { mode: true } })).mode,
          audits: await tx.auditEvent.count({ where: { projectId: project.owner.projectId, action: "policies.create" } }),
        }));
      const active = await run(async (tx) => (await tx.entity.findMany({ where: { projectId: project.owner.projectId, kind: "policies" } })).find((p) => data(p).active)!);
      const { active: _a, activatedAt: _at, activatedBy: _by, ...fields } = data(active) as Record<string, unknown>;
      const save = (mode: string) => run((tx) => savePolicy(tx, project.owner, { ...fields, mode }));
      const before = await stored();
      for (const value of ["social", "postiz_draining"] as const) {
        await backend(value);
        try {
          await expect(save("autopilot")).rejects.toMatchObject({
            code: "LIVE_ACTIVATION_BLOCKED:AUTOPILOT_ON_SOCIAL_NOT_APPROVED",
            status: 409,
          });
          expect(await stored()).toEqual(before);
          // Not a readiness blocker: an assisted project on Social is not
          // shown a missing configuration.
          expect((await state()).blockers).not.toContain("AUTOPILOT_ON_SOCIAL_NOT_APPROVED");
        } finally {
          await backend("postiz");
        }
      }
      // Postiz: the readiness refusal as before, without the Social code.
      const postizRefusal = await save("autopilot").catch((error: { code?: string }) => error);
      expect(postizRefusal).toMatchObject({ status: 409 });
      expect((postizRefusal as { code: string }).code).toMatch(/^LIVE_ACTIVATION_BLOCKED:/);
      expect((postizRefusal as { code: string }).code).not.toContain("AUTOPILOT_ON_SOCIAL_NOT_APPROVED");
      expect(await stored()).toEqual(before);
      // In test mode the policy saves on Social as before.
      process.env.EXECUTION_MODE = "test";
      await backend("social");
      try {
        const row = await save("autopilot");
        expect(data(row)).toMatchObject({ mode: "autopilot", active: true });
      } finally {
        await backend("postiz");
        await run(async (tx) => {
          const rows = await tx.entity.findMany({ where: { projectId: project.owner.projectId, kind: "policies" } });
          for (const row of rows)
            await tx.entity.update({ where: { id: row.id }, data: { data: { ...data(row), active: row.id === active.id } } });
          await tx.project.update({ where: { id: project.owner.projectId }, data: { mode: before.mode } });
        });
      }
      expect(await sent()).toEqual(start);
    });

    it("postiz_draining: the drain with Postiz's backlog, and the Postiz checks stay", async () => {
      const pending = await run((tx) =>
        create(tx, project.owner, "publications", { contentId, channel: X, status: "scheduled_remote", scheduledAt: new Date().toISOString(), test: false }),
      );
      const start = await sent();
      await backend("postiz_draining");
      try {
        const r = await state();
        expect(r.publishing).toEqual({ backend: "postiz_draining", postizBacklog: 1 });
        expect(r.blockers).toEqual(expect.arrayContaining(["PUBLISHING_BACKEND_DRAINING", "PUBLISHER_WRITE_VERIFICATION_REQUIRED"]));
        expect(social(r.blockers)).toEqual([]);
        for (const action of ["postiz_draft", "postiz_schedule", "postiz_live", "publish_draft", "publish_schedule", "publish_live"] as const)
          expect(r.actions[action].blockers).toContain("PUBLISHING_BACKEND_DRAINING");
        expect(r.actions.publish_schedule).toEqual(r.actions.postiz_schedule);
        const admin = await run((tx) => readReadiness(tx, project.owner));
        expect(admin.publishingBackend).toBe("postiz_draining");
        expect(admin.blockers.find((b) => b.code === "PUBLISHING_BACKEND_DRAINING")).toMatchObject({
          details: { postizBacklog: 1 },
          resolution: "orbit",
          affects: expect.arrayContaining(["publish_schedule", "postiz_draft"]),
        });
      } finally {
        await backend("postiz");
        await run(async (tx) => update(tx, project.owner, await entity(tx, project.owner, "publications", pending.id), { ...data(pending), status: "canceled" }));
      }
      expect(await sent()).toEqual(start);
    });
  });
});
