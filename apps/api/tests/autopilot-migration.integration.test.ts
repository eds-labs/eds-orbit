import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { chatScoped } from "../src/modules/chat.ts";
import { sweepProject, nextSweepAt } from "../src/modules/lifecycle.ts";
import {
  autopilotAsAssignment,
  autopilotMigration,
  configureAutopilot,
  proposeAutopilotAssignment,
} from "../src/modules/autopilot.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Orbit Agents replaces the weekly autopilot (spec D5, §13 step 5): with the
 * flag on the sweep plans assignment runs only, and the saved autopilot
 * settings are offered as a draft assignment that the owner confirms like any
 * other. With the flag off the autopilot keeps working as before.
 */
describe.skipIf(!enabled)("Autopilot migration to assignments", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const settings = () =>
    run(async (tx) => (await list(tx, project.owner, "autopilot_settings"))[0]);
  const autopilotMissions = () =>
    run(async (tx) =>
      (await list(tx, project.owner, "missions")).filter(
        (m) => data(m).autopilot === true,
      ),
    );
  const assignments = () =>
    run((tx) => list(tx, project.owner, "assignments"));

  /** The weekly autopilot for X and Telegram, planning this and next week. */
  const configure = () =>
    run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors"))[0]!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        postingTimes: { [X]: "17:00", [TELEGRAM]: "10:00" },
      });
      await tx.project.update({
        where: { id: project.owner.projectId },
        data: { mode: "autopilot" },
      });
      return configureAutopilot(tx, project.owner, {
        enabled: true,
        channels: [X, TELEGRAM],
        factKeys: ["beta.access", "official.link"],
        assetIds: [],
        planWeekday: new Date().getDay(),
        planTime: "00:00",
      });
    });

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    project = await createPackageProject();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("proposes the saved autopilot settings as a draft assignment", async () => {
    expect(await run((tx) => autopilotAsAssignment(tx, project.owner))).toBe(
      null,
    );
    const saved = await configure();
    // A confirmed assignment already holds part of the project budget (100 USD).
    await run((tx) =>
      create(tx, project.owner, "assignments", {
        name: "Weekly recap",
        kind: "standing",
        schedule: {
          rhythm: "weekly",
          weekdays: [1],
          times: ["09:00"],
          leadMinutes: 360,
        },
        contentType: "social",
        channels: [X],
        topicFrame: "A weekly recap for product teams",
        image: false,
        styleAssetIds: [],
        vetoMinutes: 180,
        monthlyBudgetMicros: 30_000_000,
        status: "active",
        confirmation: { userId: project.owner.userId },
        actionRequestId: null,
      }),
    );
    const proposal = await run((tx) =>
      autopilotAsAssignment(tx, project.owner),
    );
    expect(proposal).toMatchObject({
      kind: "standing",
      contentType: "social",
      channels: [X, TELEGRAM],
      // One post per channel and day, at the earliest posting time.
      schedule: { rhythm: "daily", weekdays: [], times: ["10:00"] },
      image: false,
      styleAssetIds: [],
      vetoMinutes: 180,
      // What the project budget still leaves free.
      monthlyBudgetMicros: 70_000_000,
    });
    expect(proposal!.topicFrame).toContain("beta.access");
    expect(proposal!.topicFrame).toContain("official.link");

    const before = await run((tx) => autopilotMigration(tx, project.owner));
    const channelNames = { [X]: "Synthetic X", [TELEGRAM]: "Synthetic Telegram" };
    expect(before).toEqual({
      proposal,
      reason: null,
      channelNames,
      assignment: null,
    });

    const result = await proposeAutopilotAssignment(project.editor);
    const draft = await run((tx) =>
      entity(tx, project.owner, "assignments", result.assignment.id),
    );
    // A draft with an open owner confirmation; nothing is active from it.
    expect(data(draft)).toMatchObject({
      ...proposal,
      status: "draft",
      confirmation: null,
      actionRequestId: result.actionRequest.id,
      origin: { kind: "autopilot", autopilotSettingsId: saved.id },
    });
    const request = await run((tx) =>
      entity(tx, project.owner, "action_requests", result.actionRequest.id),
    );
    expect(data(request)).toMatchObject({
      actionType: "assignment.confirm",
      status: "pending",
    });
    expect(
      (await assignments()).filter((row) => data(row).status === "active"),
    ).toHaveLength(1);
    // The card lands in its own conversation of the proposing person.
    const messages = await chatScoped(project.editor, (tx) =>
      tx.chatMessage.findMany({
        where: { conversationId: result.conversationId },
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect(messages[0]!.cards).toEqual([
      expect.objectContaining({
        kind: "assignment",
        status: "confirmation_required",
        assignment: expect.objectContaining({
          id: draft.id,
          actionRequestId: result.actionRequest.id,
        }),
      }),
    ]);
    // The autopilot settings themselves stay as they were.
    expect((await settings())!.version).toBe(saved.version);
    expect(await run((tx) => autopilotMigration(tx, project.owner))).toEqual({
      proposal,
      reason: null,
      channelNames,
      assignment: {
        id: draft.id,
        status: "draft",
        actionRequestId: result.actionRequest.id,
      },
    });
    // One open proposal at a time.
    await expect(proposeAutopilotAssignment(project.editor)).rejects.toThrow(
      "AUTOPILOT_ALREADY_PROPOSED",
    );
    await expect(proposeAutopilotAssignment(project.viewer)).rejects.toThrow(
      "EDITOR_REQUIRED",
    );
  });

  it("offers the autopilot again once its proposed assignment has ended", async () => {
    await configure();
    const first = await proposeAutopilotAssignment(project.editor);
    await run(async (tx) => {
      const row = await entity(
        tx,
        project.owner,
        "assignments",
        first.assignment.id,
      );
      await update(tx, project.owner, row, { ...data(row), status: "ended" });
    });
    expect(
      (await run((tx) => autopilotMigration(tx, project.owner))).assignment,
    ).toBe(null);
    const second = await proposeAutopilotAssignment(project.editor);
    expect(second.assignment.id).not.toBe(first.assignment.id);
  });

  it("takes the time only from the channels the assignment keeps", async () => {
    const extra = ["c3-int", "c4-int", "c5-int"];
    await run(async (tx) => {
      const connector = (await list(tx, project.owner, "connectors"))[0]!;
      await update(tx, project.owner, connector, {
        ...data(connector),
        // The fifth channel, which an assignment cannot keep, has the earliest time.
        postingTimes: {
          [X]: "17:00",
          [TELEGRAM]: "12:00",
          "c3-int": "13:00",
          "c4-int": "14:00",
          "c5-int": "06:00",
        },
      });
      await create(tx, project.owner, "autopilot_settings", {
        enabled: true,
        channels: [X, TELEGRAM, ...extra],
        factKeys: ["beta.access"],
        assetIds: [],
        planWeekday: 1,
        planTime: "08:00",
        approvedBy: project.owner.userId,
        approvedAt: new Date().toISOString(),
      });
    });
    const proposal = await run((tx) =>
      autopilotAsAssignment(tx, project.owner),
    );
    expect(proposal!.channels).toEqual([X, TELEGRAM, "c3-int", "c4-int"]);
    expect(proposal!.schedule.times).toEqual(["12:00"]);
  });

  it("offers no proposal without a free project budget or an active policy, and says why", async () => {
    await configure();
    const setPolicy = (changes: Record<string, unknown>) =>
      run(async (tx) => {
        const policy = (await list(tx, project.owner, "policies"))[0]!;
        await update(tx, project.owner, policy, {
          ...data(policy),
          ...changes,
        });
      });
    // A confirmed assignment already holds the whole project budget.
    await run((tx) =>
      create(tx, project.owner, "assignments", {
        name: "Holds everything",
        kind: "standing",
        schedule: { rhythm: "daily", weekdays: [], times: ["09:00"] },
        contentType: "social",
        channels: [X],
        topicFrame: "A daily post for product teams",
        image: false,
        styleAssetIds: [],
        vetoMinutes: 180,
        monthlyBudgetMicros: 100_000_000,
        status: "active",
        confirmation: { userId: project.owner.userId },
        actionRequestId: null,
      }),
    );
    const migration = () =>
      run((tx) => autopilotMigration(tx, project.owner));
    expect(await run((tx) => autopilotAsAssignment(tx, project.owner))).toBe(
      null,
    );
    expect(await migration()).toMatchObject({
      proposal: null,
      reason: "NO_FREE_PROJECT_BUDGET",
    });
    await expect(proposeAutopilotAssignment(project.editor)).rejects.toThrow(
      "NO_FREE_PROJECT_BUDGET",
    );
    await setPolicy({ active: false });
    expect(await migration()).toMatchObject({
      proposal: null,
      reason: "ACTIVE_POLICY_REQUIRED",
    });
    await expect(proposeAutopilotAssignment(project.editor)).rejects.toThrow(
      "ACTIVE_POLICY_REQUIRED",
    );
    expect(
      (await assignments()).filter((row) => data(row).status === "draft"),
    ).toEqual([]);
  });

  it("proposes once when two people propose at the same time", async () => {
    await configure();
    const results = await Promise.allSettled([
      proposeAutopilotAssignment(project.editor),
      proposeAutopilotAssignment(project.owner),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(String(refused?.reason?.code ?? refused?.reason)).toContain(
      "AUTOPILOT_ALREADY_PROPOSED",
    );
    expect(
      (await assignments()).filter((row) => data(row).status === "draft"),
    ).toHaveLength(1);
  });

  it("plans no autopilot missions while ORBIT_AGENTS is on", async () => {
    await configure();
    const now = new Date();
    await run((tx) => sweepProject(tx, worker(), now));
    expect(await autopilotMissions()).toEqual([]);
    // The weekly plan check never ran, so nothing wakes the sweep for it.
    expect(data(await settings()).lastPlanCheckAt).toBeUndefined();
    expect(await run((tx) => nextSweepAt(tx, project.owner, now))).toBe(null);
  });

  it("keeps the autopilot unchanged while ORBIT_AGENTS is off", async () => {
    await configure();
    delete process.env.ORBIT_AGENTS;
    const now = new Date();
    await run((tx) => sweepProject(tx, worker(), now));
    expect((await autopilotMissions()).length).toBeGreaterThan(0);
    expect(data(await settings()).lastPlanCheckAt).toBe(now.toISOString());
    // No migration while the flag is off: nothing is proposed or changed.
    await expect(proposeAutopilotAssignment(project.editor)).rejects.toThrow(
      "AGENTS_DISABLED",
    );
    expect(await assignments()).toEqual([]);
    expect(data(await settings()).enabled).toBe(true);
  });
});
