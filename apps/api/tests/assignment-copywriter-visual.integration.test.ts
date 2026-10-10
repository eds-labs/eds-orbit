import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model and image call is a mock; nothing here reaches a provider.
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  saveDraftDocument: vi.fn(),
  // Fails the image attach once when set.
  failInvalidation: false,
}));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    generateImage: provider.generateImage,
    generateImageWithReferences: provider.generateImageWithReferences,
  };
});
vi.mock("../src/modules/google-drive.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/google-drive.ts")>();
  return { ...actual, saveDraftDocument: provider.saveDraftDocument };
});
vi.mock("../src/modules/content-invalidation.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/modules/content-invalidation.ts")
    >();
  return {
    ...actual,
    invalidateContent: async (
      ...args: Parameters<typeof actual.invalidateContent>
    ) => {
      if (provider.failInvalidation) {
        provider.failInvalidation = false;
        throw new Error("ATTACH_FAILED_FOR_TEST");
      }
      return actual.invalidateContent(...args);
    },
  };
});
import { createHash } from "node:crypto";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import { create, data, entity, hash, list, update } from "../src/shared.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { GenerationOutputError } from "../../../packages/ai/src/index.ts";
import { generateMissionLive } from "../src/modules/generation.ts";
import {
  planMission,
  startApprovedLiveDraftOnce,
} from "../src/modules/workflow.ts";
import {
  resumeLiveDraftBatch,
  startApprovedLiveDraftBatch,
} from "../src/modules/draft-batch.ts";
import {
  runAgentTask,
  runBudgetKey,
} from "../src/modules/agents/specialists/runner.ts";
import { reserve } from "../src/modules/budget.ts";
import { policy as policySchema } from "../../../packages/schemas/src/index.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { imageRightsSource } from "../src/modules/agents/specialists/visual.ts";
import {
  briefKey,
  copywriterStep,
  reviseAssignmentDraft,
  saveDraftToDrive,
} from "../src/modules/agents/specialists/copywriter.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BLOG = "blog-int";
// 06:00 in Berlin tomorrow: the run for 10:00 and 17:00 is due (lead 360 minutes).
const today = new Date();
const MORNING = new Date(
  Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
    4,
  ),
);
const BODY = "Beta access is open for product teams. Learn more.";

describe.skipIf(!enabled)("Copywriter and visual in an assignment run", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let png: Buffer;
  // Channel whose drafts come back longer than a Telegram caption allows.
  let longFor: string | null = null;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const rows = (kind: string) =>
    run((tx) => list(tx, project.owner, kind)).then((found) =>
      found.map((row): Record<string, any> => ({
        id: row.id,
        version: row.version,
        ...data(row),
      })),
    );
  const task = async (stepKey: string) =>
    (await rows("agent_tasks")).find((t) => t.stepKey === stepKey)!;
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const makeAssignment = (changes: Record<string, unknown> = {}) => {
    const { consent = true, ...rest } = changes;
    const content = {
      name: "Two posts a day",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X, TELEGRAM],
      topicFrame: "Short updates about beta access for product teams",
      image: true,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
      ...rest,
    };
    return run((tx) =>
      create(tx, project.owner, "assignments", {
        ...content,
        status: "active",
        actionRequestId: null,
        confirmation: {
          userId: project.owner.userId,
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(content),
          imageRightsConsent: content.image === true && consent === true,
        },
      }),
    );
  };
  const brief = (
    slot: { channel: string; at: string },
    changes: Record<string, unknown> = {},
  ) => ({
    channel: slot.channel,
    slotAt: slot.at,
    topic: `Beta access on ${slot.channel}`,
    angle: "Lead with what teams can do on day one.",
    factKeys: ["beta.access"],
    cta: "Join the beta.",
    imageIdea: "A calm open door made of soft light.",
    notARepeatBecause: "Earlier posts announced the beta, this one shows use.",
    ...changes,
  });
  /** Plans the run and settles every step before the copywriters: strategy with these briefs. */
  const planWithBriefs = async (
    briefsFor: (
      slots: Array<{ channel: string; at: string }>,
    ) => Array<Record<string, unknown>>,
  ) => {
    await run((tx) => planAssignmentRuns(tx, project.owner, MORNING));
    const [runRow] = await rows("assignment_runs");
    const slots = runRow!.slots as Array<{ channel: string; at: string }>;
    const briefs = briefsFor(slots);
    for (const role of ["analytics", "research", "strategy"]) {
      const found = (await rows("agent_tasks")).find((t) => t.role === role);
      if (!found) continue;
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", found.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: role === "strategy" ? "done" : "failed",
          output:
            role === "strategy" ? { briefs, dropped: [], uncovered: [] } : null,
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    return { runId: runRow!.id as string, slots, briefs };
  };
  const generated = (body: string) => ({
    responseId: "resp_draft",
    output: {
      title: "Beta post",
      body,
      claims: [{ text: "Learn more.", kind: "style" }],
    },
    usage: {
      model: "synthetic-model",
      inputTokens: 40,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      costMicros: 5,
    },
  });
  const image = () => ({
    bytes: png,
    model: IMAGE_MODEL,
    size: "1024x1024",
    quality: "medium",
    background: "opaque",
    usage: null,
  });
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));

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
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    longFor = null;
    provider.embed.mockReset().mockResolvedValue({
      vectors: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 20,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costMicros: 1,
      },
    });
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      return generated(
        contract.channel === longFor
          ? `${"Beta access is open. ".repeat(60)}Learn more.`
          : `${BODY} (${contract.brief?.topic ?? "no brief"})`,
      );
    });
    provider.generateImage.mockReset().mockImplementation(async () => image());
    provider.generateImageWithReferences
      .mockReset()
      .mockImplementation(async () => image());
    provider.saveDraftDocument.mockReset().mockResolvedValue({
      id: "driveFileABC123",
      folderId: "driveFolderABC123",
      webViewLink: "https://drive.google.com/file/d/driveFileABC123/view",
    });
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X, TELEGRAM, BLOG],
      contentTypes: ["social", "blog"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_IMAGE_REFERENCES;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("writes one draft per brief with the brief in the contract", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    const xBriefs = briefs.filter((b) => b.channel === X);
    expect(xBriefs).toHaveLength(2);
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);

    const done = await task(`copywriter:${X}`);
    expect(done.status).toBe("done");
    expect(done.output.failed).toEqual([]);
    expect(done.output.contentIds).toHaveLength(2);
    // Only this channel's briefs: one generation per X brief.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(contracts().map((c) => c.brief)).toEqual(
      xBriefs.map((b) => ({
        topic: b.topic,
        angle: b.angle,
        cta: b.cta,
        notARepeatBecause: b.notARepeatBecause,
      })),
    );
    expect(contracts().every((c) => Array.isArray(c.recentChannelPosts))).toBe(
      true,
    );
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions).toHaveLength(2);
    for (const b of xBriefs) {
      const mission = missions.find((m) => m.briefKey === briefKey(b as any))!;
      expect(mission).toMatchObject({
        allowedActions: ["draft"],
        channels: [X],
        factKeys: ["beta.access"],
        plannedSlotAt: b.slotAt,
        budgetRunKey: `assignment-run:${runId}`,
        agentTaskId: copy.id,
        mediaPlanned: false,
      });
    }
    const drafts = (await rows("content")).filter((c) =>
      done.output.contentIds.includes(c.id),
    );
    expect(drafts.map((d) => d.assignmentRunId)).toEqual([runId, runId]);
    expect(drafts.every((d) => d.status === "draft")).toBe(true);
    expect(await rows("publications")).toEqual([]);
    // The drafts' paid calls count toward the task and the run (R37).
    const reservations = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    const own = reservations.filter(
      (r) =>
        r.key.includes(`:agent:${copy.id}:copy:`) ||
        r.key.includes(`:query:mission:agent:${copy.id}:copy:`),
    );
    expect(own).toHaveLength(4);
    expect(done.costMicros).toBe(
      own.reduce((sum, r) => sum + Number(r.settledMicros ?? 0), 0),
    );
    expect(done.costMicros).toBeGreaterThan(0);

    // A second pass of the same task reuses its missions and drafts (R26).
    const again = await copywriterStep(worker(), {
      ...(done as any),
      status: "running",
    });
    expect(again).toEqual(done.output);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(
      (await rows("missions")).filter((m) => m.assignmentRunId === runId),
    ).toHaveLength(2);
  });

  it("keeps writing when one brief fails and never drafts a failed brief later", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot, index) =>
        brief(slot, index === 0 ? { factKeys: ["launch.deadline"] } : {}),
      ),
    );
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);
    const done = await task(`copywriter:${X}`);
    expect(done.status).toBe("done");
    expect(done.output.contentIds).toHaveLength(1);
    expect(done.output.failed).toEqual([
      { briefKey: briefKey(briefs[0] as any), code: "FACT_NOT_USABLE" },
    ]);

    // An unusable model answer fails its brief and its mission.
    provider.generate.mockImplementationOnce(async () => {
      throw new GenerationOutputError(
        "MODEL_OUTPUT_NOT_VALID",
        generated(BODY).usage,
        "resp_invalid",
      );
    });
    await runAgentTask(worker(), (await task(`copywriter:${TELEGRAM}`)).id);
    const telegram = await task(`copywriter:${TELEGRAM}`);
    expect(telegram.status).toBe("done");
    expect(telegram.output.failed.map((f: any) => f.code)).toEqual([
      "MODEL_OUTPUT_NOT_VALID",
    ]);
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(
      missions
        .filter((m) => m.channels[0] === TELEGRAM)
        .map((m) => m.status)
        .sort(),
    ).toEqual(["completed", "failed"]);
    expect(missions.some((m) => m.status === "ready")).toBe(false);
    // The project sweep leaves assignment missions to their copywriter (R37).
    await run((tx) => sweepProject(tx, worker()));
    const jobs = (await rows("jobs")).filter(
      (job) =>
        job.topic === "generation" &&
        missions.some((m) => m.id === job.resourceId),
    );
    expect(jobs).toEqual([]);
  });

  const setPaused = (paused: boolean) =>
    run((tx) =>
      tx.project.update({
        where: { id: project.owner.projectId },
        data: { paused },
      }),
    );
  const copyReservations = (taskId: string) =>
    run((tx) =>
      tx.budgetReservation.findMany({
        where: {
          projectId: project.owner.projectId,
          key: { contains: `:agent:${taskId}:copy:` },
        },
      }),
    );

  it("leaves the briefs drafting when the pause stops the copywriter, so the requeued task writes them (N1)", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    const xBriefs = briefs.filter((b) => b.channel === X);
    const copy = await task(`copywriter:${X}`);
    const missionsOfX = async () =>
      (await rows("missions")).filter(
        (m) => m.assignmentRunId === runId && m.channels[0] === X,
      );

    await setPaused(true);
    await runAgentTask(worker(), copy.id);
    // Stopped before anything paid went out: queued for the resume, nothing failed.
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await task(`copywriter:${X}`)).toMatchObject({
      status: "queued",
      errorCode: "PROJECT_PAUSED",
      costMicros: 0,
    });
    expect(await copyReservations(copy.id)).toEqual([]);
    const paused = await missionsOfX();
    expect(paused).toHaveLength(2);
    expect(paused.map((m) => m.status)).toEqual(["ready", "ready"]);
    expect(paused.some((m) => m.failureCode)).toBe(false);

    await setPaused(false);
    await runAgentTask(worker(), copy.id);
    const done = await task(`copywriter:${X}`);
    expect(done.status).toBe("done");
    expect(done.output.failed).toEqual([]);
    expect(done.output.contentIds).toHaveLength(xBriefs.length);
    // The same missions were drafted: nothing was created or paid twice.
    const resumed = await missionsOfX();
    expect(resumed.map((m) => m.id).sort()).toEqual(
      paused.map((m) => m.id).sort(),
    );
    expect(resumed.map((m) => m.status)).toEqual(["completed", "completed"]);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    // A draft and its retrieval per brief, as without a pause.
    expect(await copyReservations(copy.id)).toHaveLength(4);
    const drafts = (await rows("content")).filter((c) =>
      done.output.contentIds.includes(c.id),
    );
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.status === "draft")).toBe(true);
    expect(await rows("publications")).toEqual([]);
  });

  it("still fails the missions of a copywriter the pause stopped after a paid call (N1)", async () => {
    await makeAssignment({ image: false });
    const { runId } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    const copy = await task(`copywriter:${X}`);
    // The pause lands while the first brief is drafted: that call is paid.
    provider.generate.mockImplementationOnce(async (params: any) => {
      await setPaused(true);
      return generated(`${BODY} (${JSON.parse(params.goal).brief.topic})`);
    });
    await runAgentTask(worker(), copy.id);
    // Paid work went out, so the task is not requeued (I7a) ...
    expect((await task(`copywriter:${X}`)).status).toBe("failed");
    expect((await copyReservations(copy.id)).length).toBeGreaterThan(0);
    // ... and nothing may stay waiting for a draft (R41/I2b).
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId && m.channels[0] === X,
    );
    expect(missions).toHaveLength(2);
    expect(missions.map((m) => m.status)).toEqual(["failed", "failed"]);
    // The brief the pause refused is among them.
    expect(missions.map((m) => m.failureCode)).toContain("PROJECT_PAUSED");
  });

  it("lets no other entry draft an assignment mission", async () => {
    await makeAssignment({ image: false });
    const { runId } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    provider.generate.mockImplementationOnce(async () => {
      throw new GenerationOutputError(
        "MODEL_OUTPUT_NOT_VALID",
        generated(BODY).usage,
        "resp_invalid",
      );
    });
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions).toHaveLength(2);
    const { owner } = project;
    for (const mission of missions) {
      // Ready again, as if an operator tried to restart it by hand.
      await run(async (tx) => {
        const row = await entity(tx, owner, "missions", mission.id);
        await update(tx, owner, row, { ...data(row), status: "ready" });
      });
      const current = (await rows("missions")).find(
        (m) => m.id === mission.id,
      )!;
      for (const attempt of [
        (tx: DbTx): Promise<unknown> => planMission(tx, owner, mission.id),
        (tx: DbTx) =>
          startApprovedLiveDraftOnce(tx, owner, mission.id, current.version),
        (tx: DbTx) =>
          startApprovedLiveDraftBatch(tx, owner, mission.id, current.version),
        (tx: DbTx) =>
          resumeLiveDraftBatch(tx, owner, mission.id, current.version),
      ])
        await expect(run(attempt)).rejects.toMatchObject({
          code: "ASSIGNMENT_MISSION_OWNED",
        });
      // A generation job of another owner is refused before any call.
      provider.generate.mockClear();
      await expect(
        generateMissionLive(worker(), mission.id, `manual:${mission.id}`),
      ).rejects.toMatchObject({ code: "ASSIGNMENT_MISSION_OWNED" });
      expect(provider.generate).not.toHaveBeenCalled();
    }
    expect(
      (await rows("jobs")).filter((job) =>
        missions.some((m) => m.id === job.resourceId),
      ),
    ).toEqual([]);
  });

  it("fails the task with the first brief's code when no draft is written", async () => {
    await makeAssignment({ image: false });
    await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot, { factKeys: ["launch.deadline"] })),
    );
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    expect(await task(`copywriter:${X}`)).toMatchObject({
      status: "failed",
      errorCode: "FACT_NOT_USABLE",
    });
  });

  it("reports a month-bound cost refusal of a reused mission as budget exhaustion", async () => {
    const assignment = await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    // A Telegram mission left by an interrupted attempt, bounded by the month.
    const template = (await rows("missions")).find(
      (m) => m.assignmentRunId === runId,
    )!;
    const telegramTask = await task(`copywriter:${TELEGRAM}`);
    const [first] = briefs.filter((b) => b.channel === TELEGRAM);
    const key = briefKey(first as any);
    await run(async (tx) => {
      const {
        id: _id,
        version: _version,
        completedRuns: _runs,
        lastContentId: _last,
        ...rest
      } = template;
      await create(tx, project.owner, "missions", {
        ...rest,
        status: "ready",
        channels: [TELEGRAM],
        plannedSlotAt: first!.slotAt,
        briefKey: key,
        agentTaskId: telegramTask.id,
        agentJobId: `agent:${telegramTask.id}:copy:${key}`,
        chatCostCeilingMicros: 1,
        costCeilingBound: "month",
      });
    });
    provider.generate.mockClear();
    await runAgentTask(worker(), telegramTask.id);
    expect(await task(`copywriter:${TELEGRAM}`)).toMatchObject({
      status: "failed",
      errorCode: "ASSIGNMENT_BUDGET_EXHAUSTED",
    });
    // The remaining brief was not attempted, and the assignment stops.
    expect(provider.generate).not.toHaveBeenCalled();
    expect(
      data(
        await run((tx) =>
          entity(tx, project.owner, "assignments", assignment.id),
        ),
      ).status,
    ).toBe("budget_exhausted");
  });

  it("refuses a draft that no longer fits the run's pool, whatever its mission ceiling (R75)", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    // A Telegram mission prepared while the pool was still large.
    const template = (await rows("missions")).find(
      (m) => m.assignmentRunId === runId,
    )!;
    const telegramTask = await task(`copywriter:${TELEGRAM}`);
    const [first] = briefs.filter((b) => b.channel === TELEGRAM);
    const key = briefKey(first as any);
    await run(async (tx) => {
      const {
        id: _id,
        version: _version,
        completedRuns: _runs,
        lastContentId: _last,
        ...rest
      } = template;
      await create(tx, project.owner, "missions", {
        ...rest,
        status: "ready",
        channels: [TELEGRAM],
        plannedSlotAt: first!.slotAt,
        briefKey: key,
        agentTaskId: telegramTask.id,
        agentJobId: `agent:${telegramTask.id}:copy:${key}`,
        chatCostCeilingMicros: 900_000,
        costCeilingBound: "task",
      });
      // Meanwhile another step of the run took what was left of its pool.
      const active = (await list(tx, project.owner, "policies")).find(
        (row) => data(row).active === true,
      )!;
      const run = data(
        await entity(tx, project.owner, "assignment_runs", runId),
      );
      const held = await tx.budgetReservation.findMany({
        where: {
          projectId: project.owner.projectId,
          id: {
            in: (
              await tx.entity.findMany({
                where: {
                  projectId: project.owner.projectId,
                  kind: "budget_runs",
                  data: { path: ["runKey"], equals: runBudgetKey(runId) },
                },
              })
            ).flatMap((row) => data(row).reservationIds as string[]),
          },
        },
      });
      const spent = held.reduce(
        (sum, row) =>
          sum +
          Number(
            row.state === "settled" ? row.settledMicros : row.amountMicros,
          ),
        0,
      );
      await reserve(
        tx,
        project.owner,
        `agent:synthetic-visual-${runId}:0`,
        "image_generation",
        Number(run.ceilingMicros) - spent,
        policySchema.parse(
          Object.fromEntries(
            Object.entries(data(active)).filter(
              ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
            ),
          ),
        ),
        new Date(),
        runBudgetKey(runId),
      );
    });
    provider.generate.mockClear();
    await runAgentTask(worker(), telegramTask.id);
    expect(await task(`copywriter:${TELEGRAM}`)).toMatchObject({
      status: "failed",
      errorCode: "AGENT_LIMIT",
    });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("revises a draft through the same mission path with the review's instruction", async () => {
    await makeAssignment({ image: false });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);
    const done = await task(`copywriter:${X}`);
    const [draftId] = done.output.contentIds as string[];
    const draft = (await rows("content")).find((c) => c.id === draftId)!;
    provider.generate.mockClear();

    const revised = await reviseAssignmentDraft(worker(), done as any, {
      contentId: draftId!,
      instruction: "Make it shorter.",
    });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const [contract] = contracts();
    expect(contract.revision).toEqual({
      instruction: "Make it shorter.",
      previousBody: draft.body,
    });
    expect(contract.brief.topic).toBe(`Beta access on ${X}`);
    expect(data(revised)).toMatchObject({
      assignmentRunId: draft.assignmentRunId,
      briefKey: draft.briefKey,
    });
    const mission = (await rows("missions")).find(
      (m) => m.id === data(revised).missionId,
    )!;
    expect(mission.revisionOf).toEqual({
      contentId: draftId,
      version: draft.version,
      instruction: "Make it shorter.",
    });
  });

  it("generates one image and attaches it to the run's drafts", async () => {
    await makeAssignment();
    const { runId } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    // Copywriters first, then the visual: the visual attaches to existing drafts.
    longFor = TELEGRAM;
    for (const channel of [X, TELEGRAM])
      await runAgentTask(worker(), (await task(`copywriter:${channel}`)).id);
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions.every((m) => m.mediaPlanned === true)).toBe(true);
    await runAgentTask(worker(), (await task("visual")).id);

    const visual = await task("visual");
    expect(visual.status).toBe("done");
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const [{ prompt }] = provider.generateImage.mock.calls[0]!;
    expect(prompt).toContain("A calm open door made of soft light.");
    expect(prompt).toMatch(/no identifiable persons/i);
    const assets = (await rows("assets")).filter(
      (a) => a.assignmentRunId === runId,
    );
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    const drafts = (await rows("content")).filter(
      (c) => c.assignmentRunId === runId,
    );
    const xDrafts = drafts.filter((d) => d.channel === X);
    const telegram = drafts.filter((d) => d.channel === TELEGRAM);
    expect(xDrafts.every((d) => d.assetId === asset.id)).toBe(true);
    // A Telegram caption holds at most 1,024 characters: that draft stays without it.
    expect(telegram.every((d) => d.assetId === undefined)).toBe(true);
    expect(visual.output).toEqual({
      assetId: asset.id,
      attached: expect.arrayContaining(xDrafts.map((d) => d.id)),
      skipped: expect.arrayContaining(
        telegram.map((d) => ({ contentId: d.id, code: "CAPTION_TOO_LONG" })),
      ),
    });
    // The image's cost counts toward the visual task (R37).
    const reservation = await run((tx) =>
      tx.budgetReservation.findFirst({
        where: {
          projectId: project.owner.projectId,
          key: `${project.owner.projectId}:image:agent:${visual.id}:image`,
        },
      }),
    );
    expect(Number(reservation!.amountMicros)).toBe(IMAGE_MAX);

    // The other order: an image that already exists goes onto a later draft.
    const { runId: secondRun } = await (async () => {
      await project.cleanup();
      project = await createPackageProject();
      await setPolicy({
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2027-12-31T00:00:00.000Z",
        maxPerDay: 2,
        minIntervalMinutes: 120,
      });
      await makeAssignment();
      return planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    })();
    longFor = null;
    await runAgentTask(worker(), (await task("visual")).id);
    expect((await task("visual")).output.attached).toEqual([]);
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    const [later] = (await rows("assets")).filter(
      (a) => a.assignmentRunId === secondRun,
    );
    const laterDrafts = (await rows("content")).filter(
      (c) => c.assignmentRunId === secondRun,
    );
    expect(laterDrafts).toHaveLength(2);
    expect(laterDrafts.every((d) => d.assetId === later!.id)).toBe(true);
  });

  it("keeps a paid image when attaching it fails", async () => {
    await makeAssignment();
    const { runId } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    provider.failInvalidation = true;
    await runAgentTask(worker(), (await task("visual")).id);
    const visual = await task("visual");
    const assets = (await rows("assets")).filter(
      (a) => a.assignmentRunId === runId,
    );
    expect(assets).toHaveLength(1);
    expect(visual).toMatchObject({
      status: "done",
      output: {
        assetId: assets[0]!.id,
        attached: [],
        attachError: "ATTACH_FAILED_FOR_TEST",
      },
    });
    // The next copywriter attaches the kept image to every draft.
    await runAgentTask(worker(), (await task(`copywriter:${TELEGRAM}`)).id);
    const drafts = (await rows("content")).filter(
      (c) => c.assignmentRunId === runId,
    );
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.assetId === assets[0]!.id)).toBe(true);
  });

  it("approves the image's rights only through the assignment consent", async () => {
    const assignment = await makeAssignment();
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    const [asset] = await rows("assets");
    expect(asset).toMatchObject({
      usageApproved: true,
      assetStatus: "approved",
      generationId: `agent:${(await task("visual")).id}:image`,
      rightsSource: {
        assignmentId: assignment.id,
        confirmationHash: data(assignment).confirmation.assignmentHash,
      },
    });

    // A changed assignment no longer carries the confirmed consent.
    await project.cleanup();
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    const changed = await makeAssignment();
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", changed.id);
      await update(tx, project.owner, row, {
        ...data(row),
        topicFrame: "A different topic than the one confirmed",
      });
    });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    provider.generateImage.mockClear();
    const visual = (await task("visual")).id;
    await runAgentTask(worker(), visual);
    // The runner refuses the unconfirmed content before the visual step (R70).
    expect(await task("visual")).toMatchObject({
      status: "canceled",
      errorCode: "ASSIGNMENT_NOT_CONFIRMED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(await rows("assets")).toEqual([]);
    // The visual step's own rights check refuses it as well.
    const row = await run((tx) =>
      entity(tx, project.owner, "assignments", changed.id),
    );
    expect(() => imageRightsSource(row)).toThrow("ASSET_RIGHTS_REQUIRED");
  });

  it("refuses an image without consent with ASSET_RIGHTS_REQUIRED", async () => {
    await makeAssignment({ consent: false });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const visual = await task("visual");
    await runAgentTask(worker(), visual.id);
    expect(await task("visual")).toMatchObject({
      status: "failed",
      errorCode: "ASSET_RIGHTS_REQUIRED",
      costMicros: 0,
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(await rows("assets")).toEqual([]);
    const reservations = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    expect(reservations.filter((r) => r.key.includes(":image:"))).toEqual([]);
  });

  it("sends approved style references, or their stored description when references are off", async () => {
    process.env.ORBIT_IMAGE_REFERENCES = "true";
    const reference = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Deep blue gradient with soft geometric light",
        tags: ["banner"],
      }),
    );
    const unapproved = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Unreviewed upload",
        type: "banner",
        mime: "image/png",
        base64: png.toString("base64"),
        usageApproved: false,
        assetStatus: "reference",
      }),
    );
    await makeAssignment({ styleAssetIds: [reference.id, unapproved.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(provider.generateImageWithReferences).toHaveBeenCalledTimes(1);
    const sent = provider.generateImageWithReferences.mock.calls[0]![0];
    expect(sent.references).toHaveLength(1);
    expect(sent.references[0].bytes.equals(png)).toBe(true);

    // With references switched off the run uses a style description stored on the assignment.
    process.env.ORBIT_IMAGE_REFERENCES = "false";
    await project.cleanup();
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    const banner = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Deep blue gradient with soft geometric light",
        tags: ["banner"],
      }),
    );
    const second = await makeAssignment({ styleAssetIds: [banner.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    provider.generateImageWithReferences.mockClear();
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    // Stored once per assignment in its own row: the assignment keeps its confirmed version.
    const [stored] = await rows("assignment_style_descriptions");
    expect(stored).toMatchObject({
      assignmentId: second.id,
      assetIds: [banner.id],
    });
    expect(
      (await run((tx) => entity(tx, project.owner, "assignments", second.id)))
        .version,
    ).toBe(second.version);
    expect(stored.text).toContain(
      "Deep blue gradient with soft geometric light",
    );
    expect(provider.generateImage.mock.calls[0]![0].prompt).toContain(
      stored.text,
    );
  });

  it("uses no reference images by default", async () => {
    const banner = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Deep blue gradient with soft geometric light",
      }),
    );
    await makeAssignment({ styleAssetIds: [banner.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    expect(provider.generateImage.mock.calls[0]![0].prompt).toContain(
      "Deep blue gradient with soft geometric light",
    );
  });

  it("falls back to the style description when no reference can be read", async () => {
    process.env.ORBIT_IMAGE_REFERENCES = "true";
    const broken = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        // Bytes that no longer match their checksum are never sent.
        sha256: "0".repeat(64),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Warm sunrise colours over calm water",
      }),
    );
    await makeAssignment({ styleAssetIds: [broken.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const [stored] = await rows("assignment_style_descriptions");
    expect(stored!.text).toContain("Warm sunrise colours over calm water");
    expect(provider.generateImage.mock.calls[0]![0].prompt).toContain(
      stored!.text,
    );
  });

  it("saves an approved blog draft to Drive and publishes nothing", async () => {
    await makeAssignment({
      name: "Weekly article",
      contentType: "blog",
      channels: [BLOG],
      image: false,
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const copy = await task("copywriter");
    await runAgentTask(worker(), copy.id);
    const done = await task("copywriter");
    expect(done.status).toBe("done");
    const [contentId] = done.output.contentIds as string[];

    // Without a recorded approval nothing goes to Drive.
    await expect(saveDraftToDrive(worker(), contentId!)).rejects.toMatchObject({
      code: "CONTENT_APPROVAL_REQUIRED",
    });
    expect(provider.saveDraftDocument).not.toHaveBeenCalled();

    // A body with its own H1 and an image whose bytes cannot be read: Markdown needs neither.
    const image = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Broken image",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: "0".repeat(64),
        usageApproved: true,
        assetStatus: "approved",
      }),
    );
    const article = `# Beta access for teams\n\n${BODY}`;
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "content", contentId!);
      await update(tx, project.owner, row, {
        ...data(row),
        body: article,
        assetId: image.id,
        humanReviewedBodyHash: hash(article),
      });
    });
    const saved = await saveDraftToDrive(worker(), contentId!);
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
    const [, upload] = provider.saveDraftDocument.mock.calls[0]!;
    expect(upload).toMatchObject({
      contentId,
      category: "Blog",
      mime: "text/markdown",
    });
    expect(upload.filename).toMatch(/\.md$/);
    const markdown = Buffer.from(upload.bytes).toString("utf8");
    expect(markdown.startsWith(`${article}`)).toBe(true);
    expect(markdown.match(/^# /gm)).toHaveLength(1);
    expect(data(saved).driveDraft).toMatchObject({
      fileId: "driveFileABC123",
      bodyHash: hash(data(saved).body),
    });
    // Saved once per approved text; nothing is scheduled or published.
    await saveDraftToDrive(worker(), contentId!);
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
    expect(await rows("publications")).toEqual([]);
    expect(data(saved).status).not.toBe("published");
  });
});
