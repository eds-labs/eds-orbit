import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  proposeImageRequest,
  runImageJob,
} from "../src/modules/image-requests.ts";

const drive = vi.hoisted(() => ({ enabled: false, uploads: 0 }));
vi.mock("../src/modules/google-drive.ts", async (original) => {
  const real =
    await original<typeof import("../src/modules/google-drive.ts")>();
  return {
    ...real,
    connectionStatus: vi.fn(async () => ({ enabled: drive.enabled })),
    saveGeneratedAsset: vi.fn(async () => {
      drive.uploads++;
      throw new Error("DRIVE_UPLOAD_FAILED");
    }),
  };
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const IMAGE_MODEL = "gpt-image-2.5-flare";
const MAX_COST = 5000;

describe.skipIf(!enabled)("Action requests for image generation", () => {
  let owner: Scope, editor: Scope, delegate: Scope;
  let png: Buffer;
  const users: string[] = [];
  const worker = () => ({ ...owner, userId: "worker", role: "owner" as const });
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const saveConfig = (maxCostMicrosPerImage: number) =>
    run((tx) =>
      saveOpenAiConfiguration(tx, owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-model", IMAGE_MODEL],
        rateCard: {
          "synthetic-model": {
            inputMicrosPerMillion: 1000,
            outputMicrosPerMillion: 1000,
            verifiedAt: new Date().toISOString(),
          },
        },
        modelRoutes: {
          fast: "synthetic-model",
          standard: "synthetic-model",
          quality: "synthetic-model",
          escalation: "synthetic-model",
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage,
          pricingVerifiedAt: new Date().toISOString(),
        },
      }),
    );
  const syntheticUser = async () => {
    const row = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic action requester",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(row.id);
    return row.id;
  };
  // Same shape as the add-member action: workspace viewer plus a project role.
  const projectMember = async (userId: string, role: Scope["role"]) => {
    await authDb.workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId, role: "viewer" },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        userId,
        role,
      },
    });
    return { ...owner, userId, role };
  };
  const brief = {
    name: "Synthetic beta artwork",
    prompt: "A calm geometric abstract artwork with soft gradients.",
    size: "1024x1024" as const,
    quality: "low" as const,
    background: "opaque" as const,
    validUses: ["social" as const],
  };
  const propose = () =>
    run((tx) =>
      proposeImageRequest(tx, owner, brief, {
        kind: "user",
        userId: owner.userId,
      }),
    );
  const decide = (
    scope: Scope,
    request: { id: string; version: number; data: unknown },
    decision: "approve" | "reject" = "approve",
  ) =>
    run((tx) =>
      decideActionRequest(tx, scope, request.id, {
        version: request.version,
        packageHash: data(request).packageHash,
        decision,
      }),
    );
  const jobsFor = (id: string) =>
    run(async (tx) =>
      (await list(tx, owner, "jobs")).filter(
        (job) => data(job).topic === "image" && data(job).resourceId === id,
      ),
    );
  const current = (id: string) =>
    run((tx) => entity(tx, owner, "action_requests", id));
  const assetsFor = (id: string) =>
    run(async (tx) =>
      (await list(tx, owner, "assets")).filter(
        (asset) => data(asset).generationId === id,
      ),
    );
  const provider = () => {
    const calls = { count: 0 };
    const generate = async () => {
      calls.count++;
      return {
        bytes: png,
        model: IMAGE_MODEL,
        size: "1024x1024",
        quality: "low",
        background: "opaque",
        usage: null,
      };
    };
    return { calls, generate: generate as never };
  };

  beforeAll(async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    png = rendered.bytes;
    const ownerId = await syntheticUser();
    const workspace = await authDb.workspace.create({
      data: {
        name: "Action requests",
        members: { create: { userId: ownerId, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Action request project" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ownerId,
      role: "owner",
    };
    editor = await projectMember(await syntheticUser(), "editor");
    delegate = await projectMember(await syntheticUser(), "owner");
    await run(async (tx) => {
      await create(tx, owner, "policies", {
        mode: "observe",
        channels: ["x-test"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: new Date(Date.now() - 3600000).toISOString(),
        endAt: new Date(Date.now() + 86400000).toISOString(),
        maxPerDay: 0,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 100000,
        monthlyBudgetMicros: 100000,
        perRunBudgetMicros: 10000,
        approvedPaidTests: true,
        active: true,
      });
      // Stored directly: the official-link fact checks of saveMarketingProfile are out of scope here.
      await tx.projectMarketingProfile.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          version: 1,
          data: marketingProfile.parse({
            productName: "Synthetic brand",
            contentLanguage: "en",
            internalLanguage: "de",
            audience: "Product teams",
            positioning: "Evidence-led publishing",
            productStrategy: "Explain the product",
            presaleStrategy: "Use verified facts only",
            voice: ["Clear"],
            guardrails: ["No unsupported claims"],
            primaryCtas: ["Learn more"],
            channelPriority: ["x"],
            notificationPreference: "none",
            officialLinks: [
              {
                label: "Website",
                url: "https://example.invalid",
                factId: randomUUID(),
              },
            ],
            visualIdentity: {
              primaryColor: "#112233",
              secondaryColor: "#334455",
              accentColor: "#55AAFF",
              backgroundColor: "#F0F4F8",
              surfaceColor: "#FFFFFF",
              textColor: "#101820",
              headingFont: "Inter",
              bodyFont: "Arial",
              designRules: ["Use clean geometric forms."],
            },
            assetPolicy: "approved_only",
          }),
        },
      });
    });
    await saveConfig(MAX_COST);
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: owner.workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  describe("decisions", () => {
    it("records a pending request with the code-defined risk class and the current image terms", async () => {
      const request = await propose();
      expect(data(request)).toMatchObject({
        actionType: "image.generate",
        riskClass: "C2",
        approvalMode: "approval_required",
        status: "pending",
        requestedBy: { kind: "user", userId: owner.userId },
        costCeilingMicros: MAX_COST,
        payload: { ...brief, model: IMAGE_MODEL, maxCostMicros: MAX_COST },
      });
      expect(data(request).packageHash).toMatch(/^[a-f0-9]{64}$/);
      expect(data(request).policy).toEqual({
        id: expect.any(String),
        version: expect.any(Number),
      });
      const ttl = Date.parse(data(request).expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(23 * 3600000);
      expect(ttl).toBeLessThanOrEqual(24 * 3600000);
    });

    it("lets only an owner approve an image request", async () => {
      const request = await propose();
      await expect(decide(editor, request)).rejects.toThrow("OWNER_REQUIRED");
      expect(data(await current(request.id)).status).toBe("pending");
    });

    it("never accepts a decision from the worker's own scope", async () => {
      const request = await propose();
      await expect(decide(worker(), request)).rejects.toThrow(
        "DECISION_USER_REQUIRED",
      );
    });

    it("requires the decision to match the version and hash that were shown", async () => {
      const request = await propose();
      await expect(
        run((tx) =>
          decideActionRequest(tx, owner, request.id, {
            version: request.version,
            packageHash: "0".repeat(64),
            decision: "approve",
          }),
        ),
      ).rejects.toThrow("ACTION_REQUEST_STALE");
      await expect(
        decide(owner, { ...request, version: request.version + 1 }),
      ).rejects.toThrow("ACTION_REQUEST_STALE");
    });

    it("queues exactly one single-attempt image job, also for a repeated click", async () => {
      const request = await propose();
      const first = await decide(owner, request);
      const second = await decide(owner, request);
      expect(second.id).toBe(first.id);
      expect(data(first)).toMatchObject({
        status: "approved",
        decision: { userId: owner.userId, decision: "approve", channel: "web" },
      });
      const jobs = await jobsFor(request.id);
      expect(jobs).toHaveLength(1);
      expect(data(jobs[0])).toMatchObject({
        status: "queued",
        maxAttempts: 1,
        actorId: owner.userId,
      });
      expect(
        await run((tx) =>
          tx.outbox.count({ where: { entityId: jobs[0]!.id, topic: "image" } }),
        ),
      ).toBe(1);
    });

    it("queues nothing for a rejection and refuses a later approval", async () => {
      const request = await propose();
      expect(data(await decide(owner, request, "reject")).status).toBe(
        "rejected",
      );
      await expect(decide(owner, request)).rejects.toThrow(
        "ACTION_REQUEST_NOT_PENDING",
      );
      expect(await jobsFor(request.id)).toHaveLength(0);
    });

    it("cannot approve an expired request", async () => {
      const request = await propose();
      const expired = await run((tx) =>
        update(tx, owner, request, {
          ...data(request),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await expect(decide(owner, expired)).rejects.toThrow(
        "ACTION_REQUEST_EXPIRED",
      );
      expect(await jobsFor(request.id)).toHaveLength(0);
    });

    it("is stale when the image ceiling changed before the decision", async () => {
      const request = await propose();
      await saveConfig(MAX_COST + 1);
      try {
        await expect(decide(owner, request)).rejects.toThrow(
          "IMAGE_REQUEST_STALE",
        );
      } finally {
        await saveConfig(MAX_COST);
      }
    });
  });

  describe("execution", () => {
    const approved = async (decider: Scope = owner) => {
      const request = await propose();
      await decide(decider, request);
      const [job] = await jobsFor(request.id);
      return { request, jobId: job!.id };
    };

    it("turns an approved request into one reference asset and consumes the approval", async () => {
      const { request, jobId } = await approved();
      const fake = provider();
      const asset = await runImageJob(
        worker(),
        owner.userId,
        request.id,
        jobId,
        fake.generate,
      );
      expect(fake.calls.count).toBe(1);
      expect(data(asset)).toMatchObject({
        generationId: request.id,
        assetStatus: "reference",
        usageApproved: false,
        prompt: brief.prompt,
        createdBy: owner.userId,
      });
      expect(data(await current(request.id))).toMatchObject({
        status: "consumed",
        consumedBy: { executionId: jobId },
      });
    });

    it("returns the same asset for a repeated dispatch without a second provider call", async () => {
      const { request, jobId } = await approved();
      const fake = provider();
      const first = await runImageJob(
        worker(),
        owner.userId,
        request.id,
        jobId,
        fake.generate,
      );
      const again = await runImageJob(
        worker(),
        owner.userId,
        request.id,
        jobId,
        fake.generate,
      );
      const otherExecution = await runImageJob(
        worker(),
        owner.userId,
        request.id,
        randomUUID(),
        fake.generate,
      );
      expect(again.id).toBe(first.id);
      expect(otherExecution.id).toBe(first.id);
      expect(fake.calls.count).toBe(1);
      expect(await assetsFor(request.id)).toHaveLength(1);
    });

    it("never executes a request that was not approved", async () => {
      const request = await propose();
      const fake = provider();
      await expect(
        runImageJob(
          worker(),
          owner.userId,
          request.id,
          randomUUID(),
          fake.generate,
        ),
      ).rejects.toThrow("ACTION_REQUEST_NOT_APPROVED");
      expect(fake.calls.count).toBe(0);
    });

    it("does not replay a request whose provider outcome is unknown", async () => {
      const { request, jobId } = await approved();
      let calls = 0;
      const failing = (async () => {
        calls++;
        throw new Error("connection reset after transmission");
      }) as never;
      await expect(
        runImageJob(worker(), owner.userId, request.id, jobId, failing),
      ).rejects.toThrow();
      await expect(
        runImageJob(worker(), owner.userId, request.id, jobId, failing),
      ).rejects.toThrow("IMAGE_OUTCOME_UNKNOWN");
      expect(calls).toBe(1);
      expect(await assetsFor(request.id)).toHaveLength(0);
      const reservation = await run((tx) =>
        tx.budgetReservation.findFirstOrThrow({
          where: { key: `${owner.projectId}:image:${request.id}` },
        }),
      );
      expect(reservation.state).toBe("unknown");
    });

    it("gives no image to a decider who lost the owner role, and keeps the approval unused", async () => {
      const { request, jobId } = await approved(delegate);
      await authDb.projectMember.update({
        where: {
          projectId_userId: {
            projectId: owner.projectId,
            userId: delegate.userId,
          },
        },
        data: { role: "editor" },
      });
      const fake = provider();
      await expect(
        runImageJob(
          worker(),
          delegate.userId,
          request.id,
          jobId,
          fake.generate,
        ),
      ).rejects.toThrow("OWNER_REQUIRED");
      expect(fake.calls.count).toBe(0);
      expect(data(await current(request.id)).status).toBe("approved");
    });

    it("refuses a job whose user has no project access", async () => {
      const { request, jobId } = await approved();
      const fake = provider();
      await expect(
        runImageJob(worker(), randomUUID(), request.id, jobId, fake.generate),
      ).rejects.toThrow("ACTOR_MEMBERSHIP_REQUIRED");
      expect(fake.calls.count).toBe(0);
    });

    it("blocks a changed image ceiling after approval without consuming the approval", async () => {
      const { request, jobId } = await approved();
      await saveConfig(MAX_COST + 1);
      const fake = provider();
      try {
        await expect(
          runImageJob(worker(), owner.userId, request.id, jobId, fake.generate),
        ).rejects.toThrow("IMAGE_COST_CONFIRMATION_STALE");
      } finally {
        await saveConfig(MAX_COST);
      }
      expect(fake.calls.count).toBe(0);
      expect(data(await current(request.id)).status).toBe("approved");
    });

    it("keeps the asset when the Drive save fails and never generates it again", async () => {
      const { request, jobId } = await approved();
      const fake = provider();
      drive.enabled = true;
      drive.uploads = 0;
      try {
        const asset = await runImageJob(
          worker(),
          owner.userId,
          request.id,
          jobId,
          fake.generate,
        );
        expect(data(asset).driveSyncStatus).toBe("FAILED");
        const again = await runImageJob(
          worker(),
          owner.userId,
          request.id,
          jobId,
          fake.generate,
        );
        expect(again.id).toBe(asset.id);
      } finally {
        drive.enabled = false;
      }
      expect(drive.uploads).toBe(1);
      expect(fake.calls.count).toBe(1);
      expect(await assetsFor(request.id)).toHaveLength(1);
    });
  });
});
