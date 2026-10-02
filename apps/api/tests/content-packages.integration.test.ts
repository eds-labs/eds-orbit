import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { ingest, setFact } from "../../../packages/knowledge/src/index.ts";
import { create, data, entity, list } from "../src/shared.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { createConversation, getConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { zonedTime } from "../src/modules/posting-slots.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { runImageJob } from "../src/modules/image-requests.ts";
import { missionHasMedia } from "../src/modules/generation.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import {
  cancelContentPackage,
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/agents/content-packages.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const X = "x-int";
const TELEGRAM = "tg-int";
const URL = "https://example.invalid";
const IMAGE_MODEL = "gpt-image-2.5-flare";
const IMAGE_MAX = 50_000;
const IMAGE_BRIEF =
  "A calm abstract artwork of an open door made of soft light, no text.";

describe.skipIf(!enabled)("Content packages from one chat request", () => {
  let owner: Scope, editor: Scope, viewer: Scope;
  let sourceId: string, betaFactId: string;
  const users: string[] = [];
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const syntheticUser = async () => {
    const row = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic package user",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(row.id);
    return row.id;
  };
  // Same shape as the add-member action: workspace viewer plus a project role.
  const projectMember = async (role: Scope["role"]) => {
    const userId = await syntheticUser();
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
  const request = (overrides: Record<string, unknown> = {}) => ({
    goal: "Announce that beta access is open for product teams",
    channels: [X, TELEGRAM],
    factKeys: ["beta.access"],
    ...overrides,
  });
  const ask = async (
    scope: Scope = editor,
    overrides: Record<string, unknown> = {},
  ) => {
    const thread = await createConversation(scope);
    return {
      thread,
      ...(await requestContentPackage(scope, thread.id, request(overrides))),
    };
  };
  const approve = (
    scope: Scope,
    actionRequest: { id: string; version: number; data: unknown },
  ) =>
    run((tx) =>
      decideActionRequest(tx, scope, actionRequest.id, {
        version: actionRequest.version,
        packageHash: data(actionRequest).packageHash,
        decision: "approve",
      }),
    );
  const missionsOf = (packageId: string) =>
    run(async (tx) =>
      (await list(tx, owner, "missions")).filter(
        (mission) => data(mission).packageId === packageId,
      ),
    );
  const snapshot = (packageId: string) =>
    run(async (tx) =>
      packageSnapshot(
        tx,
        owner,
        await entity(tx, owner, "content_packages", packageId),
      ),
    );

  beforeAll(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    const ownerId = await syntheticUser();
    const workspace = await authDb.workspace.create({
      data: {
        name: "Content packages",
        members: { create: { userId: ownerId, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Content package project",
        timezone: "Europe/Berlin",
      },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ownerId,
      role: "owner",
    };
    editor = await projectMember("editor");
    viewer = await projectMember("viewer");
    const now = Date.now();
    const past = new Date(now - 3600000).toISOString();
    const future = new Date(now + 30 * 86400000).toISOString();
    await run(async (tx) => {
      await create(tx, owner, "policies", {
        mode: "autopilot",
        channels: [X, TELEGRAM],
        contentTypes: ["social"],
        allowedOrigins: [URL],
        startAt: past,
        endAt: future,
        maxPerDay: 1,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 10_000_000,
        monthlyBudgetMicros: 100_000_000,
        perRunBudgetMicros: 5_000_000,
        approvedPaidTests: true,
        active: true,
      });
      await create(tx, owner, "connectors", {
        provider: "postiz",
        status: "read_verified",
        channels: [
          { id: X, name: "Synthetic X", identifier: "x", disabled: false },
          {
            id: TELEGRAM,
            name: "Synthetic Telegram",
            identifier: "telegram",
            disabled: false,
          },
          {
            id: "li-int",
            name: "Synthetic LinkedIn",
            identifier: "linkedin",
            disabled: false,
          },
        ],
        assignedIntegrationIds: [X, TELEGRAM, "li-int"],
        postingTimes: { [X]: "17:00" },
      });
      const source = await create(tx, owner, "sources", {
        name: "Synthetic product source",
        status: "active",
        publicUse: true,
        modelUse: true,
        authority: "official",
        generation: 1,
        maxAgeHours: 168,
      });
      sourceId = source.id;
      const link = await create(tx, owner, "facts", {
        key: "official.link",
        value: URL,
        valueType: "url",
        language: "en",
        sourceId,
        validFrom: past,
        validUntil: future,
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
      const beta = await setFact(tx, owner, {
        key: "beta.access",
        value: "open for product teams",
        valueType: "text",
        language: "en",
        sourceId,
        validFrom: past,
        validUntil: future,
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
      betaFactId = beta.id;
      await setFact(tx, owner, {
        key: "launch.deadline",
        value: "expired fixture",
        valueType: "text",
        language: "en",
        sourceId,
        validFrom: new Date(now - 48 * 3600000).toISOString(),
        validUntil: past,
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
      await ingest(tx, owner, {
        sourceId,
        externalId: "synthetic-beta-access",
        title: "Synthetic beta access",
        text: "Beta access is open for product teams.",
        mimeType: "text/plain",
        language: "en",
        validFrom: past,
        validUntil: future,
        embeddings: [
          Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
        ],
      });
      await tx.projectMarketingProfile.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          version: 1,
          data: {
            productName: "Synthetic Orbit",
            contentLanguage: "en",
            internalLanguage: "de",
            audience: "Product teams",
            positioning: "Test only",
            productStrategy: "Test only",
            presaleStrategy: "No presale",
            voice: ["clear"],
            guardrails: ["No unsupported claims"],
            primaryCtas: ["Learn more."],
            channelPriority: [X],
            notificationPreference: "none",
            officialLinks: [{ label: "Official", url: URL, factId: link.id }],
            assetPolicy: "approved_only",
          },
        },
      });
      const rate = {
        inputMicrosPerMillion: 1000,
        outputMicrosPerMillion: 1000,
        verifiedAt: new Date().toISOString(),
      };
      await saveOpenAiConfiguration(tx, owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: [
          "synthetic-model",
          "text-embedding-3-small",
          IMAGE_MODEL,
        ],
        rateCard: { "synthetic-model": rate, "text-embedding-3-small": rate },
        modelRoutes: {
          fast: "synthetic-model",
          standard: "synthetic-model",
          quality: "synthetic-model",
          escalation: "synthetic-model",
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: IMAGE_MAX,
          pricingVerifiedAt: new Date().toISOString(),
        },
      });
    });
  });
  afterEach(() => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    await authDb.workspace.delete({ where: { id: owner.workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("turns one request into a proposed package with one start decision and no missions yet", async () => {
    const { package: pkg, actionRequest } = await ask();
    expect(data(pkg)).toMatchObject({ status: "proposed" });
    expect(data(actionRequest)).toMatchObject({
      actionType: "content_package.start",
      approvalMode: "approval_required",
      status: "pending",
      payload: { packageId: pkg.id },
    });
    const plan = data(actionRequest).payload;
    expect(
      plan.deliverables.map((d: any) => [d.channelId, d.platform]),
    ).toEqual([
      [X, "x"],
      [TELEGRAM, "telegram"],
    ]);
    // Mission fields come from the project's current profile, not from the model.
    expect(plan.deliverables[0].mission).toMatchObject({
      targetAction: "Learn more.",
      targetUrl: URL,
      language: "en",
      campaignType: "product",
      profileVersion: 1,
      audience: "Product teams",
      contentType: "social",
      allowedActions: ["draft"],
      sourceIds: [sourceId],
    });
    expect(plan.ceilingMicros).toBe(
      plan.deliverables.reduce((n: number, d: any) => n + d.ceilingMicros, 0),
    );
    expect(await missionsOf(pkg.id)).toHaveLength(0);
    expect((await snapshot(pkg.id)).status).toBe("proposed");
  });

  it("starts one draft-only mission per channel now with one click, also for a repeated click", async () => {
    const { package: pkg, actionRequest } = await ask();
    const before = Date.now();
    await approve(editor, actionRequest);
    await approve(editor, actionRequest);
    const missions = await missionsOf(pkg.id);
    expect(missions.map((m) => data(m).channels)).toEqual(
      expect.arrayContaining([[X], [TELEGRAM]]),
    );
    expect(missions).toHaveLength(2);
    for (const mission of missions) {
      expect(data(mission)).toMatchObject({
        status: "ready",
        maxContents: 1,
        allowedActions: ["draft"],
        budgetRunKey: `package:${pkg.id}`,
        factKeys: ["beta.access"],
      });
      expect(Date.parse(data(mission).startAt)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(data(mission).startAt)).toBeGreaterThanOrEqual(
        before - 1000,
      );
    }
    const jobs = await run(async (tx) =>
      (await list(tx, owner, "jobs")).filter((job) =>
        missions.some((m) => m.id === data(job).resourceId),
      ),
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => data(job).topic === "generation")).toBe(true);
    expect((await snapshot(pkg.id)).status).toBe("running");
  });

  it("shows both persisted drafts as the package result", async () => {
    const { package: pkg, actionRequest, thread } = await ask();
    await approve(editor, actionRequest);
    const missions = await missionsOf(pkg.id);
    await run(async (tx) => {
      for (const mission of missions) {
        const job = (await list(tx, owner, "jobs")).find(
          (row) => data(row).resourceId === mission.id,
        )!;
        await deterministicDraft(tx, owner, mission.id, job.id);
      }
    });
    const result = await snapshot(pkg.id);
    expect(result.status).toBe("completed");
    expect(result.deliverables).toHaveLength(2);
    for (const deliverable of result.deliverables) {
      expect(deliverable.status).toBe("drafted");
      expect(deliverable.content).toMatchObject({
        id: expect.any(String),
        channel: deliverable.channelId,
        body: expect.any(String),
      });
    }
    const detail = await getConversation(editor, thread.id);
    expect(detail.packages.map((p: { id: string }) => p.id)).toEqual([pkg.id]);
  });

  it("names a missing or unusable fact instead of inventing one", async () => {
    await expect(ask(editor, { factKeys: [] })).rejects.toThrow(
      "FACTS_REQUIRED",
    );
    await expect(
      ask(editor, { factKeys: ["launch.deadline"] }),
    ).rejects.toThrow("FACT_NOT_USABLE");
    await expect(ask(editor, { factKeys: ["no.such.fact"] })).rejects.toThrow(
      "FACT_NOT_USABLE",
    );
  });

  it("names contradictory official facts as a blocker", async () => {
    await run(async (tx) => {
      for (const value of ["starter", "professional"])
        await setFact(tx, owner, {
          key: "pricing.tier",
          value,
          valueType: "text",
          language: "en",
          sourceId,
          validFrom: new Date(Date.now() - 3600000).toISOString(),
          status: "verified",
          publicUse: true,
          modelUse: true,
        });
    });
    await expect(ask(editor, { factKeys: ["pricing.tier"] })).rejects.toThrow(
      "FACT_NOT_USABLE",
    );
  });

  it("refuses a channel the active policy does not allow", async () => {
    await expect(ask(editor, { channels: [X, "li-int"] })).rejects.toThrow(
      "CHANNEL_NOT_APPROVED",
    );
  });

  it("does not start a package whose fact changed after it was shown", async () => {
    const { package: pkg, actionRequest } = await ask();
    // An owner revision supersedes the shown fact with a new verified value.
    await run(async (tx) => {
      const revised = await setFact(tx, owner, {
        supersedesId: betaFactId,
        key: "beta.access",
        value: "open for all product teams",
        valueType: "text",
        language: "en",
        sourceId,
        validFrom: new Date(Date.now() - 3600000).toISOString(),
        validUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
      betaFactId = revised.id;
    });
    await expect(approve(editor, actionRequest)).rejects.toThrow(
      "PACKAGE_STALE",
    );
    expect(await missionsOf(pkg.id)).toHaveLength(0);
  });

  it("prepares now and keeps the requested project-local slot for later", async () => {
    const local = new Date(Date.now() + 7 * 86400000);
    const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    })
      .format(local)
      .split("-")
      .map(Number) as [number, number, number];
    const intendedDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const { package: pkg, actionRequest } = await ask(editor, {
      intendedDate,
    });
    const slots = Object.fromEntries(
      data(actionRequest).payload.deliverables.map((d: any) => [
        d.channelId,
        d.plannedSlotAt,
      ]),
    );
    // X has a configured posting time; Telegram uses the 09:00 default.
    expect(slots[X]).toBe(
      zonedTime(year, month, day, 17, 0, "Europe/Berlin").toISOString(),
    );
    expect(slots[TELEGRAM]).toBe(
      zonedTime(year, month, day, 9, 0, "Europe/Berlin").toISOString(),
    );
    await approve(editor, actionRequest);
    for (const mission of await missionsOf(pkg.id)) {
      expect(Date.parse(data(mission).startAt)).toBeLessThanOrEqual(Date.now());
      expect(data(mission).plannedSlotAt).toBe(
        slots[data(mission).channels[0]],
      );
      expect(data(mission).allowedActions).toEqual(["draft"]);
    }
    await expect(ask(editor, { intendedDate: "2020-01-01" })).rejects.toThrow(
      "PACKAGE_DATE_IN_PAST",
    );
  });

  it("lets editors and owners request packages, not viewers", async () => {
    await expect(ask(viewer)).rejects.toThrow("EDITOR_REQUIRED");
    const { package: pkg } = await ask(owner);
    expect(data(pkg).status).toBe("proposed");
  });

  it("creates no package and starts no proposed package while the feature is off", async () => {
    const { actionRequest, package: pkg } = await ask();
    process.env.ORBIT_CONTENT_PACKAGES = "false";
    await expect(ask()).rejects.toThrow("CONTENT_PACKAGES_DISABLED");
    await expect(approve(editor, actionRequest)).rejects.toThrow(
      "CONTENT_PACKAGES_DISABLED",
    );
    expect(await missionsOf(pkg.id)).toHaveLength(0);
  });

  it("keeps a package inside its own private conversation", async () => {
    const theirs = await createConversation(owner);
    await expect(
      requestContentPackage(editor, theirs.id, request()),
    ).rejects.toThrow("NOT_FOUND");
    const { thread, actionRequest } = await ask(editor);
    // Only the requester can start a package from their conversation.
    await expect(approve(owner, actionRequest)).rejects.toThrow("FORBIDDEN");
    const ownView = await createConversation(owner);
    expect((await getConversation(owner, ownView.id)).packages).toEqual([]);
    expect((await getConversation(editor, thread.id)).packages).toHaveLength(1);
  });

  describe("image, review, cancel and partial results", () => {
    const worker = () => ({
      ...owner,
      userId: "worker",
      role: "owner" as const,
    });
    let png: Buffer;
    beforeAll(async () => {
      const rendered = await renderRasterTemplate({
        format: "square",
        logoApproved: true,
        title: "Synthetic fixture",
      });
      if (rendered.status !== "rendered")
        throw new Error("FIXTURE_RENDER_FAILED");
      png = rendered.bytes;
    });
    const image = (fail = false) => {
      const calls = { count: 0 };
      const generate = async () => {
        calls.count++;
        if (fail) throw new Error("connection reset after transmission");
        return {
          bytes: png,
          model: IMAGE_MODEL,
          size: "1024x1024",
          quality: "medium",
          background: "opaque",
          usage: null,
        };
      };
      return { calls, generate: generate as never };
    };
    const jobsFor = (resourceIds: string[]) =>
      run(async (tx) =>
        (await list(tx, owner, "jobs")).filter((job) =>
          resourceIds.includes(data(job).resourceId),
        ),
      );
    const startedWithImage = async () => {
      const asked = await ask(owner, { imageBrief: IMAGE_BRIEF });
      await approve(owner, asked.actionRequest);
      const missions = await missionsOf(asked.package.id);
      const steps = data(
        await run((tx) =>
          entity(tx, owner, "content_packages", asked.package.id),
        ),
      ).steps as Array<{ kind: string; actionRequestId?: string }>;
      const imageRequestId = steps.find(
        (s) => s.kind === "image",
      )!.actionRequestId!;
      return { ...asked, missions, imageRequestId };
    };
    const draftAll = (missions: Array<{ id: string }>) =>
      run(async (tx) => {
        for (const mission of missions) {
          const job = (await list(tx, owner, "jobs")).find(
            (row) => data(row).resourceId === mission.id,
          )!;
          await deterministicDraft(tx, owner, mission.id, job.id);
        }
      });

    it("lets an owner's start click also approve the package image", async () => {
      const {
        package: pkg,
        actionRequest,
        missions,
        imageRequestId,
      } = await startedWithImage();
      const plan = data(actionRequest).payload;
      expect(plan.image).toMatchObject({
        brief: { prompt: IMAGE_BRIEF },
        model: IMAGE_MODEL,
        maxCostMicros: IMAGE_MAX,
      });
      expect(plan.ceilingMicros).toBe(
        plan.deliverables.reduce(
          (n: number, d: any) => n + d.ceilingMicros,
          0,
        ) + IMAGE_MAX,
      );
      // The planned image keeps Telegram's caption limit in view while drafting.
      expect(missions.every((m) => data(m).mediaPlanned === true)).toBe(true);
      expect(missionHasMedia(data(missions[0]))).toBe(true);
      const imageRequest = await run((tx) =>
        entity(tx, owner, "action_requests", imageRequestId),
      );
      expect(data(imageRequest)).toMatchObject({
        actionType: "image.generate",
        status: "approved",
        decision: { userId: owner.userId },
        payload: { budgetRunKey: `package:${pkg.id}`, prompt: IMAGE_BRIEF },
      });
      const [job] = await jobsFor([imageRequestId]);
      expect(data(job)).toMatchObject({
        topic: "image",
        maxAttempts: 1,
        actorId: owner.userId,
      });
      expect((await snapshot(pkg.id)).image).toMatchObject({
        status: "queued",
        prompt: IMAGE_BRIEF,
      });
    });

    it("does not let an editor add an image without an owner", async () => {
      await expect(ask(editor, { imageBrief: IMAGE_BRIEF })).rejects.toThrow(
        "IMAGE_OWNER_REQUIRED",
      );
    });

    it("combines two reviewed drafts and one generated image in one result", async () => {
      const {
        package: pkg,
        missions,
        imageRequestId,
      } = await startedWithImage();
      await draftAll(missions);
      const [imageJob] = await jobsFor([imageRequestId]);
      const fake = image();
      const asset = await runImageJob(
        worker(),
        owner.userId,
        imageRequestId,
        imageJob!.id,
        fake.generate,
      );
      // The project sweep reviews package drafts with the existing claim checks.
      await run((tx) => sweepProject(tx, worker()));
      const result = await snapshot(pkg.id);
      expect(result.status).toBe("completed");
      for (const deliverable of result.deliverables) {
        expect(["reviewed", "needs_review"]).toContain(
          deliverable.content?.status,
        );
        expect(deliverable.review).toMatchObject({
          valid: expect.any(Boolean),
          problems: expect.any(Array),
        });
      }
      expect(result.image).toMatchObject({
        status: "generated",
        assetId: asset.id,
        href: `/api/projects/${owner.projectId}/assets/${asset.id}/content`,
      });
      expect(data(asset)).toMatchObject({
        assetStatus: "reference",
        usageApproved: false,
      });
      expect(fake.calls.count).toBe(1);
      const runRow = await run((tx) =>
        tx.entity.findFirstOrThrow({
          where: {
            kind: "budget_runs",
            data: { path: ["runKey"], equals: `package:${pkg.id}` },
          },
        }),
      );
      const categories = (
        await run((tx) =>
          tx.budgetReservation.findMany({
            where: { id: { in: data(runRow).reservationIds } },
          }),
        )
      ).map((row) => row.category);
      expect(categories).toContain("image_generation");
    });

    it("keeps both drafts and reports a partial package when the image outcome is unknown", async () => {
      const {
        package: pkg,
        missions,
        imageRequestId,
      } = await startedWithImage();
      await draftAll(missions);
      const [imageJob] = await jobsFor([imageRequestId]);
      const failing = image(true);
      await expect(
        runImageJob(
          worker(),
          owner.userId,
          imageRequestId,
          imageJob!.id,
          failing.generate,
        ),
      ).rejects.toThrow();
      const result = await snapshot(pkg.id);
      expect(result.status).toBe("partially_completed");
      expect(result.deliverables.every((d) => d.status === "drafted")).toBe(
        true,
      );
      expect(result.image).toMatchObject({ status: "outcome_unknown" });
      expect(failing.calls.count).toBe(1);
    });

    it("cancels a proposed package so it can no longer start", async () => {
      const { package: pkg, actionRequest } = await ask();
      const canceled = await cancelContentPackage(editor, pkg.id);
      expect(canceled.status).toBe("canceled");
      expect(
        data(
          await run((tx) =>
            entity(tx, owner, "action_requests", actionRequest.id),
          ),
        ).status,
      ).toBe("canceled");
      await expect(approve(editor, actionRequest)).rejects.toThrow(
        "ACTION_REQUEST_NOT_PENDING",
      );
      expect(await missionsOf(pkg.id)).toHaveLength(0);
    });

    it("stops queued work on cancel and reports what already exists", async () => {
      const {
        package: pkg,
        missions,
        imageRequestId,
      } = await startedWithImage();
      const xMission = missions.find((m) => data(m).channels[0] === X)!;
      const telegramMission = missions.find(
        (m) => data(m).channels[0] === TELEGRAM,
      )!;
      await draftAll([xMission]);
      const result = await cancelContentPackage(owner, pkg.id);
      expect(result.status).toBe("canceled");
      const byChannel = Object.fromEntries(
        result.deliverables.map((d) => [d.channelId, d.status]),
      );
      expect(byChannel[X]).toBe("drafted");
      expect(byChannel[TELEGRAM]).toBe("canceled");
      const [telegramJob] = await jobsFor([telegramMission.id]);
      expect(data(telegramJob).status).toBe("canceled");
      expect(
        data(
          await run((tx) => entity(tx, owner, "missions", telegramMission.id)),
        ).status,
      ).toBe("archived");
      const [imageJob] = await jobsFor([imageRequestId]);
      expect(data(imageJob).status).toBe("canceled");
      expect(result.image).toMatchObject({ status: "canceled" });
      await expect(
        runImageJob(worker(), owner.userId, imageRequestId, imageJob!.id),
      ).rejects.toThrow("ACTION_REQUEST_NOT_APPROVED");
      await expect(cancelContentPackage(viewer, pkg.id)).rejects.toThrow();
    });
  });
});
