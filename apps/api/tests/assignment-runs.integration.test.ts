import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list, update } from "../src/shared.ts";
import { sweepProject, nextSweepAt } from "../src/modules/lifecycle.ts";
import { configureAutopilot } from "../src/modules/autopilot.ts";
import {
  buildWorkPlan,
  nextAssignmentPlanAt,
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import {
  assignmentHash,
  setAssignmentStatus,
} from "../src/modules/agents/assignments.ts";
import { channelSlots } from "../src/modules/agents/scheduling.ts";
import { assignmentTools } from "../src/modules/agents/tools/assignment-tools.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Berlin: 2026-10-20 is summer time (UTC+2); daylight saving ends on 2026-10-25.
const MORNING = new Date("2026-10-20T04:00:00Z"); // 06:00 local
const EVENING = new Date("2026-10-20T20:00:00Z");
const NEXT_MORNING = new Date("2026-10-21T02:30:00Z"); // 04:30 local

const assignmentData = (changes: Record<string, unknown> = {}) => ({
  name: "Daily product post",
  kind: "standing",
  schedule: {
    rhythm: "daily",
    weekdays: [],
    times: ["10:00"],
    leadMinutes: 360,
  },
  contentType: "social",
  channels: [X],
  topicFrame: "Short updates about beta access for product teams",
  tone: undefined,
  image: false,
  styleAssetIds: [],
  vetoMinutes: 180,
  monthlyBudgetMicros: 30_000_000,
  status: "active",
  confirmation: { userId: "owner", at: "2026-10-01T00:00:00.000Z" },
  actionRequestId: null,
  ...changes,
});

describe("Work plan of an assignment", () => {
  const plan = (changes: Record<string, unknown>) =>
    buildWorkPlan(assignmentData(changes));
  const shape = (steps: ReturnType<typeof plan>) =>
    steps.map((step) => [step.key, step.role, step.dependsOn]);

  it("plans analytics, research, strategy, one copywriter per channel, a visual if wanted and a review for social", () => {
    const steps = plan({ channels: [X, TELEGRAM], image: true });
    expect(shape(steps)).toEqual([
      ["analytics", "analytics", []],
      ["research", "research", []],
      ["strategy", "strategy", ["analytics", "research"]],
      [`copywriter:${X}`, "copywriter", ["strategy"]],
      [`copywriter:${TELEGRAM}`, "copywriter", ["strategy"]],
      ["visual", "visual", ["strategy"]],
      [
        "review",
        "review",
        [`copywriter:${X}`, `copywriter:${TELEGRAM}`, "visual"],
      ],
    ]);
    for (const step of steps)
      expect(step).toMatchObject({ taskId: null, status: "pending" });
    expect(steps.every((step) => step.ceilingMicros > 0)).toBe(true);
    // A daily run may spend a thirtieth of the monthly budget.
    expect(steps.reduce((sum, step) => sum + step.ceilingMicros, 0)).toBe(
      1_000_000,
    );
  });

  it("leaves out the visual without an image", () => {
    expect(plan({}).map((step) => step.role)).toEqual([
      "analytics",
      "research",
      "strategy",
      "copywriter",
      "review",
    ]);
  });

  it("plans analytics only for a report", () => {
    const steps = plan({ contentType: "report", channels: [] });
    expect(shape(steps)).toEqual([["analytics", "analytics", []]]);
    expect(steps[0]!.ceilingMicros).toBe(1_000_000);
  });

  it("plans one copywriter without channel suffix for blog and newsletter", () => {
    for (const contentType of ["blog", "newsletter"])
      expect(shape(plan({ contentType }))).toEqual([
        ["research", "research", []],
        ["strategy", "strategy", ["research"]],
        ["copywriter", "copywriter", ["strategy"]],
        ["review", "review", ["copywriter"]],
      ]);
  });

  it("plans a visual for every content type with images except a report", () => {
    for (const contentType of ["blog", "newsletter"])
      expect(shape(plan({ contentType, image: true }))).toEqual([
        ["research", "research", []],
        ["strategy", "strategy", ["research"]],
        ["copywriter", "copywriter", ["strategy"]],
        ["visual", "visual", ["strategy"]],
        ["review", "review", ["copywriter", "visual"]],
      ]);
    expect(
      plan({ contentType: "report", channels: [], image: true }).map(
        (step) => step.key,
      ),
    ).toEqual(["analytics"]);
  });

  it("treats analytics and research as optional inputs of the strategy only", () => {
    const optional = (changes: Record<string, unknown>) =>
      Object.fromEntries(
        plan(changes)
          .filter((step) => step.optionalDependsOn.length)
          .map((step) => [step.key, step.optionalDependsOn]),
      );
    expect(optional({ image: true })).toEqual({
      strategy: ["analytics", "research"],
    });
    expect(optional({ contentType: "blog" })).toEqual({
      strategy: ["research"],
    });
  });

  it("gives a one-off assignment its whole budget and a weekly one a share per run", () => {
    const once = plan({
      kind: "one_off",
      schedule: { rhythm: "once", weekdays: [], times: ["10:00"], date: "x" },
    });
    expect(once.reduce((sum, step) => sum + step.ceilingMicros, 0)).toBe(
      30_000_000,
    );
    const weekly = plan({
      schedule: { rhythm: "weekly", weekdays: [1, 3], times: ["10:00"] },
    });
    // Two runs a week, about 8.7 a month.
    expect(weekly.reduce((sum, step) => sum + step.ceilingMicros, 0)).toBe(
      Math.floor(30_000_000 / 9),
    );
  });
});

describe.skipIf(!enabled)("Assignment runs, work plans and slots", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const makeAssignment = (changes: Record<string, unknown> = {}) => {
    const content = assignmentData(changes);
    return run((tx) =>
      create(tx, project.owner, "assignments", {
        ...content,
        // As a confirmed assignment: the confirmation covers exactly this content.
        confirmation: {
          userId: "owner",
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(content),
        },
      } as Record<string, unknown>),
    );
  };
  const plan = (now: Date) =>
    run((tx) => planAssignmentRuns(tx, project.owner, now));
  const runs = async () =>
    (await run((tx) => list(tx, project.owner, "assignment_runs")))
      .map((row): Record<string, any> => ({
        id: row.id,
        version: row.version,
        ...data(row),
      }))
      .sort((a: any, b: any) =>
        `${a.date}${a.assignmentId}`.localeCompare(
          `${b.date}${b.assignmentId}`,
        ),
      );
  const advanceRun = (runId: string) =>
    run((tx) => startReadySteps(tx, project.owner, runId)).then((row) =>
      data(row),
    );
  const tasks = () =>
    run((tx) => list(tx, project.owner, "agent_tasks")).then((rows) =>
      rows.map((row): Record<string, any> => ({ id: row.id, ...data(row) })),
    );
  const localTime = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-01-01T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    vi.useRealTimers();
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("creates one run per due day, once", async () => {
    const assignment = await makeAssignment();
    expect(await plan(MORNING)).toEqual({ created: 1 });
    expect(await plan(MORNING)).toEqual({ created: 0 });
    // The evening of the same day: today's slot has passed, tomorrow's run is not due yet.
    expect(await plan(EVENING)).toEqual({ created: 0 });
    expect(await plan(NEXT_MORNING)).toEqual({ created: 1 });
    expect(await plan(NEXT_MORNING)).toEqual({ created: 0 });
    const all = await runs();
    expect(all.map((r: any) => r.date)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(all[0]).toMatchObject({
      assignmentId: assignment.id,
      assignmentVersion: 1,
      idempotencyKey: `assignment:${assignment.id}:2026-10-20`,
      status: "running",
      costMicros: 0,
      slots: [{ channel: X, at: "2026-10-20T08:00:00.000Z" }],
      unavailable: [],
    });
  });

  it("creates a weekly run the day before at the first slot's local time", async () => {
    // Wednesday 2026-10-21 at 10:00; the run starts Tuesday 10:00 local.
    await makeAssignment({
      schedule: {
        rhythm: "weekly",
        weekdays: [3],
        times: ["10:00"],
        leadMinutes: 60,
      },
    });
    expect(await plan(new Date("2026-10-20T07:59:00Z"))).toEqual({
      created: 0,
    });
    expect(await plan(new Date("2026-10-20T08:00:00Z"))).toEqual({
      created: 1,
    });
    expect((await runs())[0]).toMatchObject({
      date: "2026-10-21",
      slots: [{ channel: X, at: "2026-10-21T08:00:00.000Z" }],
    });
  });

  it("plans a one-off assignment once on its date", async () => {
    await makeAssignment({
      kind: "one_off",
      schedule: {
        rhythm: "once",
        weekdays: [],
        times: ["10:00"],
        date: "2026-10-22",
        leadMinutes: 360,
      },
    });
    expect(await plan(MORNING)).toEqual({ created: 0 });
    expect(await plan(new Date("2026-10-22T02:00:00Z"))).toEqual({
      created: 1,
    });
    expect(await plan(new Date("2026-10-22T02:10:00Z"))).toEqual({
      created: 0,
    });
    expect((await runs()).map((r: any) => r.date)).toEqual(["2026-10-22"]);
  });

  it("allocates one slot per channel across assignments", async () => {
    const first = await makeAssignment({ name: "First" });
    const second = await makeAssignment({ name: "Second" });
    const third = await makeAssignment({ name: "Third" });
    expect(await plan(MORNING)).toEqual({ created: 3 });
    const byAssignment = new Map(
      (await runs()).map((r: any) => [r.assignmentId, r]),
    );
    expect(byAssignment.get(first.id)).toMatchObject({
      slots: [{ channel: X, at: "2026-10-20T08:00:00.000Z" }],
      unavailable: [],
    });
    // Ten o'clock is taken: the next slot of the day that keeps the two-hour spacing.
    expect(byAssignment.get(second.id)).toMatchObject({
      slots: [{ channel: X, at: "2026-10-20T10:00:00.000Z" }],
      unavailable: [],
    });
    // The daily quota of two is used up: no slot, and the run says so.
    expect(byAssignment.get(third.id)).toMatchObject({
      slots: [],
      unavailable: [
        {
          channel: X,
          requestedAt: "2026-10-20T08:00:00.000Z",
          code: "SLOT_UNAVAILABLE",
        },
      ],
    });
    const taken = [...byAssignment.values()].flatMap((r: any) =>
      r.slots.map((s: any) => `${s.channel}|${s.at}`),
    );
    expect(new Set(taken).size).toBe(taken.length);
    // Package scheduling sees the run slots as taken, too.
    const overview = await run((tx) =>
      channelSlots(tx, project.owner, { channels: [X], days: 1 }, MORNING),
    );
    expect(
      overview.channels[0]!.slots[0]!.occupiedBy!.map((o) => o.kind),
    ).toEqual(["run", "run"]);
  });

  it("treats a scheduled publication as a taken slot", async () => {
    await setPolicy({ maxPerDay: 1 });
    await run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: "00000000-0000-4000-8000-000000000020",
        channel: X,
        status: "intent_created",
        scheduledAt: "2026-10-20T08:00:00.000Z",
      }),
    );
    await makeAssignment();
    await plan(MORNING);
    expect((await runs())[0]).toMatchObject({
      slots: [],
      unavailable: [{ code: "SLOT_UNAVAILABLE" }],
    });
  });

  it("drops a time that has already passed instead of moving it", async () => {
    await makeAssignment({
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["08:00", "15:00"],
        leadMinutes: 600,
      },
    });
    // 11:00 local: eight o'clock is past, three o'clock is open.
    await plan(new Date("2026-10-20T09:00:00Z"));
    expect((await runs())[0]).toMatchObject({
      slots: [{ channel: X, at: "2026-10-20T13:00:00.000Z" }],
      unavailable: [
        { requestedAt: "2026-10-20T06:00:00.000Z", code: "SLOT_UNAVAILABLE" },
      ],
    });
  });

  it("keeps local slot times across the DST change", async () => {
    await setPolicy({ maxPerDay: 3 });
    await makeAssignment();
    await plan(new Date("2026-10-24T05:00:00Z"));
    await plan(new Date("2026-10-25T04:00:00Z"));
    await plan(new Date("2026-10-26T05:00:00Z"));
    const slots = new Map(
      (await runs()).map((r: any) => [r.date, r.slots[0].at as string]),
    );
    expect(slots.get("2026-10-24")).toBe("2026-10-24T08:00:00.000Z");
    expect(slots.get("2026-10-25")).toBe("2026-10-25T09:00:00.000Z");
    expect(slots.get("2026-10-26")).toBe("2026-10-26T09:00:00.000Z");
    for (const at of slots.values()) expect(localTime(at)).toBe("10:00");
  });

  it("gives a report no slots and an analytics-only plan", async () => {
    await makeAssignment({ contentType: "report", channels: [] });
    await plan(MORNING);
    const [report] = await runs();
    expect(report).toMatchObject({ slots: [], unavailable: [] });
    expect(report.steps.map((step: any) => step.key)).toEqual(["analytics"]);
    expect((await tasks()).map((task) => task.role)).toEqual(["analytics"]);
  });

  it("does not plan paused, budget-exhausted, draft or ended assignments", async () => {
    for (const status of ["paused", "budget_exhausted", "draft", "ended"])
      await makeAssignment({ status });
    expect(await plan(MORNING)).toEqual({ created: 0 });
    expect(await runs()).toEqual([]);
  });

  it("does not plan while the project is paused", async () => {
    await makeAssignment();
    await run((tx) =>
      tx.project.update({
        where: { id: project.owner.projectId },
        data: { paused: true },
      }),
    );
    expect(await plan(MORNING)).toEqual({ created: 0 });
  });

  it("plans nothing while ORBIT_AGENTS is off", async () => {
    await makeAssignment();
    delete process.env.ORBIT_AGENTS;
    expect(await plan(MORNING)).toEqual({ created: 0 });
  });

  describe("steps", () => {
    const finish = (taskIds: string[], values: Record<string, unknown>) =>
      run(async (tx) => {
        for (const id of taskIds) {
          const row = (await list(tx, project.owner, "agent_tasks")).find(
            (task) => task.id === id,
          )!;
          await update(tx, project.owner, row, { ...data(row), ...values });
        }
      });
    const advance = async (runId: string) =>
      data(await run((tx) => startReadySteps(tx, project.owner, runId)));
    const statuses = (steps: Array<Record<string, any>>) =>
      Object.fromEntries(steps.map((step) => [step.key, step.status]));
    const queuedKeys = (taskIds: string[]) =>
      run(async (tx) =>
        (await list(tx, project.owner, "jobs"))
          .map((job) => data(job))
          .filter((job) => job.topic === "agent")
          .filter((job) => taskIds.includes(job.resourceId))
          .map((job) => job.idempotencyKey)
          .sort(),
      );

    it("starts steps in dependency order", async () => {
      await makeAssignment({ channels: [X, TELEGRAM], image: true });
      await plan(MORNING);
      const [created] = await runs();
      expect(created.status).toBe("running");
      // Analytics and research have no dependencies and start with the run.
      let current = await tasks();
      expect(current.map((task) => task.stepKey).sort()).toEqual([
        "analytics",
        "research",
      ]);
      expect(current[0]).toMatchObject({
        runId: created.id,
        status: "queued",
        assignmentId: created.assignmentId,
        assignmentVersion: 1,
      });
      expect(await queuedKeys(current.map((task) => task.id))).toEqual(
        current.map((task) => `agent:${task.id}`).sort(),
      );
      expect(statuses(created.steps)).toMatchObject({
        analytics: "queued",
        research: "queued",
        strategy: "pending",
        review: "pending",
      });
      // Nothing new while the first steps run; calling again changes nothing.
      expect(await advance(created.id)).toMatchObject({ status: "running" });
      expect(await tasks()).toHaveLength(2);

      await finish(
        current.map((task) => task.id),
        { status: "done", costMicros: 1000 },
      );
      let after = await advance(created.id);
      expect(statuses(after.steps)).toMatchObject({
        analytics: "done",
        research: "done",
        strategy: "queued",
        visual: "pending",
      });
      expect(after.costMicros).toBe(2000);

      current = await tasks();
      await finish(
        current.filter((t) => t.stepKey === "strategy").map((t) => t.id),
        { status: "done", costMicros: 500 },
      );
      after = await advance(created.id);
      expect(statuses(after.steps)).toMatchObject({
        strategy: "done",
        [`copywriter:${X}`]: "queued",
        [`copywriter:${TELEGRAM}`]: "queued",
        visual: "queued",
        review: "pending",
      });

      current = await tasks();
      await finish(
        current
          .filter((t) => /^(copywriter|visual)/.test(t.stepKey))
          .map((t) => t.id),
        { status: "done", costMicros: 100 },
      );
      after = await advance(created.id);
      expect(statuses(after.steps).review).toBe("queued");
      expect(after.status).toBe("running");

      current = await tasks();
      await finish(
        current.filter((t) => t.stepKey === "review").map((t) => t.id),
        { status: "done", costMicros: 50 },
      );
      after = await advance(created.id);
      expect(after.status).toBe("done");
      expect(after.costMicros).toBe(2000 + 500 + 300 + 50);
      // Every task was enqueued exactly once.
      expect(await tasks()).toHaveLength(7);
      expect(await queuedKeys((await tasks()).map((t) => t.id))).toHaveLength(
        7,
      );
    });

    it("starts the strategy with what exists when analytics or research failed", async () => {
      await makeAssignment();
      await plan(MORNING);
      const [created] = await runs();
      const [first, second] = await tasks();
      const research = [first!, second!].find((t) => t.stepKey === "research")!;
      const analytics = [first!, second!].find(
        (t) => t.stepKey === "analytics",
      )!;
      // One optional input still runs: the strategy waits for it.
      await finish([research.id], {
        status: "failed",
        errorCode: "AGENT_LIMIT",
        costMicros: 20,
      });
      expect(statuses((await advance(created.id)).steps).strategy).toBe(
        "pending",
      );
      await finish([analytics.id], { status: "done", costMicros: 10 });
      const after = await advance(created.id);
      expect(statuses(after.steps)).toEqual({
        analytics: "done",
        research: "failed",
        strategy: "queued",
        [`copywriter:${X}`]: "pending",
        review: "pending",
      });
      expect(after.status).toBe("running");
      expect(after.costMicros).toBe(30);
    });

    it("skips only the dependents of a failed step and ends the run partial", async () => {
      await makeAssignment({ channels: [X, TELEGRAM], image: true });
      await plan(MORNING);
      const [created] = await runs();
      await finish(
        (await tasks()).map((t) => t.id),
        { status: "done", costMicros: 1 },
      );
      await advance(created.id);
      await finish(
        (await tasks())
          .filter((t) => t.stepKey === "strategy")
          .map((t) => t.id),
        { status: "done", costMicros: 1 },
      );
      await advance(created.id);
      const open = await tasks();
      await finish(
        open.filter((t) => t.stepKey === `copywriter:${X}`).map((t) => t.id),
        { status: "failed", errorCode: "AGENT_LIMIT" },
      );
      await finish(
        open
          .filter((t) => /^(copywriter:tg|visual)/.test(t.stepKey))
          .map((t) => t.id),
        { status: "done", costMicros: 1 },
      );
      const after = await advance(created.id);
      // The other channel and the image are untouched; the review needs every copy, so it drops.
      expect(statuses(after.steps)).toMatchObject({
        strategy: "done",
        [`copywriter:${X}`]: "failed",
        [`copywriter:${TELEGRAM}`]: "done",
        visual: "done",
        review: "skipped",
      });
      expect(after.status).toBe("partial");
    });

    it("lets parallel task completions of one run serialize and both advance it", async () => {
      await makeAssignment({ channels: [X, TELEGRAM] });
      await plan(MORNING);
      const [created] = await runs();
      await finish(
        (await tasks()).map((t) => t.id),
        { status: "done", costMicros: 1 },
      );
      await advance(created.id);
      await finish(
        (await tasks())
          .filter((t) => t.stepKey === "strategy")
          .map((t) => t.id),
        { status: "done", costMicros: 1 },
      );
      await advance(created.id);
      const copy = (await tasks()).filter((t) =>
        t.stepKey.startsWith("copywriter"),
      );
      expect(copy).toHaveLength(2);
      // Two transactions, each completing its own task and then advancing the
      // run. (scoped() already serializes a project's transactions; the run
      // row lock in startReadySteps holds for any other caller.)
      const complete = (task: Record<string, any>) =>
        run(async (tx) => {
          const row = (await list(tx, project.owner, "agent_tasks")).find(
            (candidate) => candidate.id === task.id,
          )!;
          await update(tx, project.owner, row, {
            ...data(row),
            status: "done",
            costMicros: 5,
          });
          return startReadySteps(tx, project.owner, created.id);
        });
      await Promise.all(copy.map(complete));
      const [after] = await runs();
      expect(statuses(after.steps)).toMatchObject({
        [`copywriter:${X}`]: "done",
        [`copywriter:${TELEGRAM}`]: "done",
        review: "queued",
      });
      expect(after.costMicros).toBe(2 + 1 + 10);
      expect(
        (await tasks()).filter((t) => t.stepKey === "review"),
      ).toHaveLength(1);
    });

    it("fails a run in which no step finished", async () => {
      await makeAssignment({ contentType: "report", channels: [] });
      await plan(MORNING);
      const [created] = await runs();
      await finish(
        (await tasks()).map((t) => t.id),
        { status: "outcome_unknown" },
      );
      expect((await advance(created.id)).status).toBe("failed");
    });
  });

  describe("pausing and ending", () => {
    const setStatus = (id: string, next: "active" | "paused" | "ended") =>
      run((tx) => setAssignmentStatus(tx, project.owner, id, next));

    it("cancels a planned run and its tasks on pause and frees its slot", async () => {
      await setPolicy({ maxPerDay: 1 });
      const first = await makeAssignment({ name: "First" });
      await plan(MORNING);
      const [planned] = await runs();
      expect(planned.slots).toHaveLength(1);
      await setStatus(first.id, "paused");
      const [canceled] = await runs();
      expect(canceled.status).toBe("canceled");
      expect(canceled.steps.map((s: any) => s.status)).toEqual([
        "canceled",
        "canceled",
        "canceled",
        "canceled",
        "canceled",
      ]);
      expect((await tasks()).map((t) => t.status)).toEqual([
        "canceled",
        "canceled",
      ]);
      // Nothing starts for a canceled run.
      expect((await advanceRun(canceled.id)).status).toBe("canceled");
      // Another assignment can now take the freed slot.
      const second = await makeAssignment({ name: "Second" });
      await plan(MORNING);
      const taken = (await runs()).find(
        (r: any) => r.assignmentId === second.id,
      )!;
      expect(taken.slots).toEqual([
        { channel: X, at: "2026-10-20T08:00:00.000Z" },
      ]);
    });

    it("plans the date again when a resumed assignment still has time", async () => {
      const assignment = await makeAssignment();
      await plan(MORNING);
      await setStatus(assignment.id, "paused");
      expect(await plan(MORNING)).toEqual({ created: 0 });
      await setStatus(assignment.id, "active");
      expect(await plan(MORNING)).toEqual({ created: 1 });
      const all = await runs();
      expect(all.map((r: any) => r.status).sort()).toEqual([
        "canceled",
        "running",
      ]);
      expect(all.find((r: any) => r.status === "running")!.slots).toEqual([
        { channel: X, at: "2026-10-20T08:00:00.000Z" },
      ]);
      // Once the time has passed, resuming plans nothing for that day.
      await setStatus(assignment.id, "paused");
      await setStatus(assignment.id, "active");
      expect(await plan(new Date("2026-10-20T09:00:00Z"))).toEqual({
        created: 0,
      });
    });

    it("cancels the open runs of an ended assignment but keeps finished ones", async () => {
      const assignment = await makeAssignment({
        contentType: "report",
        channels: [],
      });
      await plan(MORNING);
      const [report] = await runs();
      await run(async (tx) => {
        const row = (await list(tx, project.owner, "agent_tasks"))[0]!;
        await update(tx, project.owner, row, {
          ...data(row),
          status: "done",
        });
        await startReadySteps(tx, project.owner, report.id);
      });
      expect((await runs())[0].status).toBe("done");
      await plan(NEXT_MORNING);
      expect(await runs()).toHaveLength(2);
      await setStatus(assignment.id, "ended");
      expect((await runs()).map((r: any) => r.status)).toEqual([
        "done",
        "canceled",
      ]);
    });
  });

  it("uses the assignment version at run start", async () => {
    const assignment = await makeAssignment();
    await plan(MORNING);
    // Mario moves the time afterwards: the version rises, the run keeps its own.
    await run(async (tx) => {
      const row = (await list(tx, project.owner, "assignments"))[0]!;
      await update(tx, project.owner, row, {
        ...data(row),
        schedule: { ...data(row).schedule, times: ["11:00"] },
      });
    });
    expect(await plan(MORNING)).toEqual({ created: 0 });
    const [first] = await runs();
    expect(first).toMatchObject({
      assignmentVersion: 1,
      slots: [{ channel: X, at: "2026-10-20T08:00:00.000Z" }],
    });
    expect((await tasks())[0]).toMatchObject({ assignmentVersion: 1 });
    // The next day starts with the new version and the new time.
    expect(await plan(new Date("2026-10-21T03:30:00Z"))).toEqual({
      created: 1,
    });
    const next = (await runs()).find((r: any) => r.date === "2026-10-21")!;
    expect(next).toMatchObject({
      assignmentId: assignment.id,
      assignmentVersion: 2,
      slots: [{ channel: X, at: "2026-10-21T09:00:00.000Z" }],
    });
  });

  describe("sweep", () => {
    it("plans runs from the sweep and leaves the autopilot alone while on", async () => {
      await makeAssignment();
      await run(async (tx) => {
        await tx.project.update({
          where: { id: project.owner.projectId },
          data: { mode: "autopilot" },
        });
        await configureAutopilot(tx, project.owner, {
          enabled: true,
          channels: [X],
          factKeys: ["beta.access"],
          assetIds: [],
          planWeekday: new Date().getDay(),
          planTime: "00:00",
        });
      });
      const checked = async () =>
        data(
          (await run((tx) => list(tx, project.owner, "autopilot_settings")))[0],
        ).lastPlanCheckAt;
      await run((tx) => sweepProject(tx, worker(), MORNING));
      expect((await runs()).map((r: any) => r.date)).toEqual(["2026-10-20"]);
      expect(await checked()).toBeUndefined();
      expect(
        (await run((tx) => list(tx, project.owner, "missions"))).filter(
          (m) => data(m).autopilot === true,
        ),
      ).toEqual([]);
    });

    it("keeps planning the autopilot and no runs while off", async () => {
      await makeAssignment();
      delete process.env.ORBIT_AGENTS;
      await run(async (tx) => {
        await tx.project.update({
          where: { id: project.owner.projectId },
          data: { mode: "autopilot" },
        });
        await configureAutopilot(tx, project.owner, {
          enabled: true,
          channels: [X],
          factKeys: ["beta.access"],
          assetIds: [],
          planWeekday: new Date().getDay(),
          planTime: "00:00",
        });
      });
      await run((tx) => sweepProject(tx, worker(), MORNING));
      expect(await runs()).toEqual([]);
      expect(
        data(
          (await run((tx) => list(tx, project.owner, "autopilot_settings")))[0],
        ).lastPlanCheckAt,
      ).toBe(MORNING.toISOString());
    });

    it("wakes the sweep when the next run is due", async () => {
      await makeAssignment();
      const at = (now: Date) =>
        run((tx) => nextSweepAt(tx, project.owner, now));
      // Slot 10:00 local minus six hours.
      expect(await at(new Date("2026-10-20T00:00:00Z"))).toEqual(
        new Date("2026-10-20T02:00:00Z"),
      );
      expect(await nextAssignmentPlanAt_(MORNING)).toEqual(
        new Date("2026-10-21T02:00:00Z"),
      );
      await plan(MORNING);
      expect(await at(MORNING)).toEqual(new Date("2026-10-21T02:00:00Z"));
    });
    const nextAssignmentPlanAt_ = (now: Date) =>
      run((tx) => nextAssignmentPlanAt(tx, project.owner, now));
  });

  describe("Orbit Core tools", () => {
    const tool = (name: string) =>
      assignmentTools.find((candidate) => candidate.name === name)!;
    const call = async (name: string, args: Record<string, unknown>) =>
      (
        await tool(name).execute(
          {
            scope: project.owner,
            runId: "run",
            conversationId: "conversation",
            callIndex: 1,
          },
          args,
        )
      ).output as Record<string, any>;

    it("reports today's runs with slots, steps and cost, only for the day and assignment asked", async () => {
      const mine = await makeAssignment({ name: "Mine" });
      await makeAssignment({ name: "Other", channels: [TELEGRAM] });
      await plan(MORNING);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
      const all = await call("run_status", { assignmentId: null });
      expect(all.date).toBe("2026-10-20");
      expect(all.runs).toHaveLength(2);
      const one = await call("run_status", { assignmentId: mine.id });
      expect(one.runs).toHaveLength(1);
      expect(one.runs[0]).toMatchObject({
        assignmentName: "Mine",
        date: "2026-10-20",
        status: "running",
        costMicros: 0,
        slots: [{ channel: X, at: "2026-10-20T08:00:00.000Z" }],
        unavailable: [],
        steps: [
          { key: "analytics", role: "analytics", status: "queued" },
          { key: "research", role: "research", status: "queued" },
          { key: "strategy", role: "strategy", status: "pending" },
          {
            key: `copywriter:${X}`,
            role: "copywriter",
            status: "pending",
          },
          { key: "review", role: "review", status: "pending" },
        ],
      });
      vi.setSystemTime(new Date("2026-10-21T07:00:00Z"));
      expect((await call("run_status", { assignmentId: null })).runs).toEqual(
        [],
      );
    });

    it("lists the next planned slot and the cost of this month's runs only", async () => {
      const mine = await makeAssignment();
      await plan(MORNING);
      await run(async (tx) => {
        const row = (await list(tx, project.owner, "assignment_runs"))[0]!;
        await update(tx, project.owner, row, {
          ...data(row),
          costMicros: 4200,
        });
        await create(tx, project.owner, "assignment_runs", {
          assignmentId: mine.id,
          date: "2026-09-30",
          status: "done",
          costMicros: 999,
          slots: [],
          steps: [],
        });
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
      let listed = await call("assignment_list", {});
      expect(listed.assignments[0]).toMatchObject({
        id: mine.id,
        nextSlotLocal: "2026-10-20 10:00",
        monthCostMicros: 4200,
      });
      // After the planned slot the next run is derived from the schedule.
      vi.setSystemTime(new Date("2026-10-20T09:00:00Z"));
      listed = await call("assignment_list", {});
      expect(listed.assignments[0].nextSlotLocal).toBe("2026-10-21 10:00");
    });
  });
});
