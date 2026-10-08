import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity, hash, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  assignmentHash,
  assignmentInput,
  proposeAssignment,
  setAssignmentStatus,
  updateAssignment,
} from "../src/modules/agents/assignments.ts";
import {
  createPackageProject,
  LINKEDIN,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("Assignments behind ORBIT_AGENTS", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const base = {
    name: "Daily product post",
    kind: "standing" as const,
    schedule: {
      rhythm: "daily" as const,
      weekdays: [],
      times: ["09:00"],
    },
    contentType: "social" as const,
    channels: [X],
    topicFrame: "Short updates about beta access for product teams",
    image: false,
    styleAssetIds: [],
    monthlyBudgetMicros: 30_000_000,
  };
  const propose = async (changes: Record<string, unknown> = {}) => {
    const thread = await createConversation(project.editor);
    return proposeAssignment(project.editor, thread.id, {
      ...base,
      ...changes,
    });
  };
  const decide = (
    scope: Scope,
    request: { id: string; version: number },
    extra: Record<string, unknown> = {},
  ) =>
    run(async (tx) => {
      const row = await entity(tx, scope, "action_requests", request.id);
      return decideActionRequest(tx, scope, request.id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
        ...extra,
      });
    });
  const assignmentOf = (id: string) =>
    run(async (tx) => entity(tx, project.owner, "assignments", id));
  const confirmed = async (changes: Record<string, unknown> = {}) => {
    const { assignment, actionRequest } = await propose(changes);
    await decide(project.owner, actionRequest, {
      imageRightsConsent: changes.image === true ? true : undefined,
    });
    return assignmentOf(assignment.id);
  };
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const edit = (
    id: string,
    patch: Record<string, unknown>,
    scope: Scope = project.editor,
  ) =>
    run(async (tx) => {
      const row = await entity(tx, scope, "assignments", id);
      return updateAssignment(tx, scope, id, row.version, patch);
    });
  const status = (
    id: string,
    next: "active" | "paused" | "ended",
    scope: Scope = project.editor,
  ) => run((tx) => setAssignmentStatus(tx, scope, id, next));

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    project = await createPackageProject();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("creates a draft and an owner confirmation request", async () => {
    const { assignment, actionRequest } = await propose();
    expect(data(assignment)).toMatchObject({
      status: "draft",
      name: "Daily product post",
      kind: "standing",
      vetoMinutes: 180,
      confirmation: null,
    });
    expect(data(assignment).schedule.leadMinutes).toBe(360);
    expect(data(actionRequest)).toMatchObject({
      actionType: "assignment.confirm",
      riskClass: "W0_internal",
      status: "pending",
      costCeilingMicros: 0,
      payload: { assignmentId: assignment.id, name: "Daily product post" },
    });
    expect(data(assignment).actionRequestId).toBe(actionRequest.id);
  });

  it("activates only on the owner's confirmation and records the consent", async () => {
    const { assignment, actionRequest } = await propose({ image: true });
    await expect(
      decide(project.editor, actionRequest, { imageRightsConsent: true }),
    ).rejects.toThrow("OWNER_REQUIRED");
    expect(data(await assignmentOf(assignment.id)).status).toBe("draft");
    await decide(project.owner, actionRequest, { imageRightsConsent: true });
    const active = await assignmentOf(assignment.id);
    expect(data(active)).toMatchObject({
      status: "active",
      confirmation: {
        userId: project.owner.userId,
        imageRightsConsent: true,
      },
    });
    expect(data(active).confirmation.assignmentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof data(active).confirmation.at).toBe("string");
  });

  it("refuses an image assignment without the image-rights consent", async () => {
    const { assignment, actionRequest } = await propose({ image: true });
    await expect(decide(project.owner, actionRequest)).rejects.toThrow(
      "IMAGE_RIGHTS_CONSENT_REQUIRED",
    );
    expect(data(await assignmentOf(assignment.id)).status).toBe("draft");
    const request = await run((tx) =>
      entity(tx, project.owner, "action_requests", actionRequest.id),
    );
    expect(data(request).status).toBe("pending");
  });

  it("records no consent for an assignment without images", async () => {
    const active = await confirmed();
    expect(data(active).confirmation.imageRightsConsent).toBe(false);
  });

  it("only proposes and changes assignments for editors and owners", async () => {
    const thread = await createConversation(project.viewer);
    await expect(
      proposeAssignment(project.viewer, thread.id, base),
    ).rejects.toThrow("EDITOR_REQUIRED");
    const { assignment } = await propose();
    await expect(
      edit(assignment.id, { name: "Other" }, project.viewer),
    ).rejects.toThrow("EDITOR_REQUIRED");
  });

  it("refuses channels or content types the active policy does not allow", async () => {
    await expect(propose({ channels: [X, LINKEDIN] })).rejects.toThrow(
      "SCOPE_NOT_ALLOWED",
    );
    await expect(propose({ contentType: "blog" })).rejects.toThrow(
      "SCOPE_NOT_ALLOWED",
    );
    expect(
      await run((tx) => list(tx, project.owner, "assignments")),
    ).toHaveLength(0);
  });

  it("refuses a monthly budget above the project budget left for assignments", async () => {
    await confirmed({ monthlyBudgetMicros: 60_000_000 });
    await expect(propose({ monthlyBudgetMicros: 50_000_000 })).rejects.toThrow(
      "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT",
    );
    // The exact remainder fits; an ended assignment frees its share.
    const { assignment } = await propose({ monthlyBudgetMicros: 40_000_000 });
    await expect(
      edit(assignment.id, { monthlyBudgetMicros: 40_000_001 }),
    ).rejects.toThrow("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT");
    const first = (
      await run((tx) => list(tx, project.owner, "assignments"))
    ).find((row) => data(row).monthlyBudgetMicros === 60_000_000)!;
    await status(first.id, "ended");
    await propose({ monthlyBudgetMicros: 60_000_000 });
  });

  it("counts a draft only once it is confirmed", async () => {
    const first = await propose({ monthlyBudgetMicros: 60_000_000 });
    const second = await propose({ monthlyBudgetMicros: 60_000_000 });
    await decide(project.owner, first.actionRequest);
    await expect(decide(project.owner, second.actionRequest)).rejects.toThrow(
      "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT",
    );
    expect(data(await assignmentOf(second.assignment.id)).status).toBe("draft");
    // Paused assignments keep their share.
    await status(first.assignment.id, "paused");
    await expect(decide(project.owner, second.actionRequest)).rejects.toThrow(
      "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT",
    );
    await status(first.assignment.id, "ended");
    await decide(project.owner, second.actionRequest);
    expect(data(await assignmentOf(second.assignment.id)).status).toBe(
      "active",
    );
  });

  it("takes a report without channels and ignores the channel scope for it", async () => {
    const report = {
      contentType: "report" as const,
      channels: [] as string[],
    };
    const { assignment, actionRequest } = await propose(report);
    expect(data(assignment).channels).toEqual([]);
    await decide(project.owner, actionRequest);
    expect(data(await assignmentOf(assignment.id)).status).toBe("active");
    // Budget still applies to a report.
    await expect(
      propose({ ...report, monthlyBudgetMicros: 80_000_000 }),
    ).rejects.toThrow("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT");
    expect(assignmentInput.safeParse({ ...base, ...report }).success).toBe(
      true,
    );
    expect(
      assignmentInput.safeParse({ ...base, ...report, channels: [X] }).success,
    ).toBe(false);
    expect(assignmentInput.safeParse({ ...base, channels: [] }).success).toBe(
      false,
    );
  });

  it("rechecks the policy and budget when the owner decides", async () => {
    const { actionRequest } = await propose();
    await setPolicy({ monthlyBudgetMicros: 10_000_000 });
    await expect(decide(project.owner, actionRequest)).rejects.toThrow(
      "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT",
    );
    await setPolicy({ monthlyBudgetMicros: 100_000_000, channels: [] });
    await expect(decide(project.owner, actionRequest)).rejects.toThrow(
      "SCOPE_NOT_ALLOWED",
    );
  });

  it("a content change needs a new confirmation, a pause does not", async () => {
    const active = await confirmed();
    const before = data(active).confirmation;

    const paused = await status(active.id, "paused");
    expect(data(paused).status).toBe("paused");
    const resumed = await status(active.id, "active", project.owner);
    expect(data(resumed)).toMatchObject({ status: "active" });
    expect(data(resumed).confirmation).toEqual(before);

    // Moving the times alone keeps the confirmation, with the hash kept current.
    const retimed = await edit(
      active.id,
      { schedule: { ...base.schedule, times: ["10:30"] } },
      project.owner,
    );
    expect(data(retimed).status).toBe("active");
    expect(data(retimed).confirmation).toMatchObject({
      userId: before.userId,
      at: before.at,
    });
    expect(data(retimed).confirmation.assignmentHash).not.toBe(
      before.assignmentHash,
    );

    // A topic change returns to draft with a fresh owner request.
    const changed = await edit(active.id, { topicFrame: "Pricing explainers" });
    expect(data(changed)).toMatchObject({
      status: "draft",
      confirmation: null,
      topicFrame: "Pricing explainers",
    });
    const request = await run((tx) =>
      entity(
        tx,
        project.owner,
        "action_requests",
        data(changed).actionRequestId,
      ),
    );
    expect(data(request)).toMatchObject({
      actionType: "assignment.confirm",
      status: "pending",
      payload: {
        assignmentId: active.id,
        assignmentHash: assignmentHash(data(changed)),
      },
    });
    await expect(status(active.id, "active", project.owner)).rejects.toThrow(
      "ASSIGNMENT_NOT_CONFIRMED",
    );
    await decide(project.owner, request);
    expect(data(await assignmentOf(active.id)).status).toBe("active");
  });

  it("lets only an owner move times or resume, while an editor may pause", async () => {
    const active = await confirmed();
    const retime = { schedule: { ...base.schedule, times: ["11:00"] } };
    await expect(edit(active.id, retime)).rejects.toThrow("OWNER_REQUIRED");
    expect(data(await assignmentOf(active.id)).status).toBe("active");
    await status(active.id, "paused");
    await expect(status(active.id, "active")).rejects.toThrow("OWNER_REQUIRED");
    expect(data(await assignmentOf(active.id)).status).toBe("paused");
    await status(active.id, "active", project.owner);
    const moved = await edit(active.id, retime, project.owner);
    expect(data(moved).schedule.times).toEqual(["11:00"]);
    // A draft's times are no exception for editors.
    const { assignment } = await propose();
    await expect(edit(assignment.id, retime)).rejects.toThrow("OWNER_REQUIRED");
  });

  it("withdraws the open request when a draft changes, and refuses a stale one", async () => {
    const { assignment, actionRequest } = await propose();
    const changed = await edit(assignment.id, {
      topicFrame: "New topic frame",
    });
    const old = await run((tx) =>
      entity(tx, project.owner, "action_requests", actionRequest.id),
    );
    expect(data(old).status).toBe("canceled");
    expect(data(changed).actionRequestId).not.toBe(actionRequest.id);
    await expect(decide(project.owner, actionRequest)).rejects.toThrow(
      "ACTION_REQUEST_NOT_PENDING",
    );
  });

  it("keeps the confirmation hash equal to the content hash and ends for good", async () => {
    const active = await confirmed();
    const { confirmation, ...d } = data(active);
    const content = Object.fromEntries(
      [
        "name",
        "kind",
        "schedule",
        "contentType",
        "channels",
        "topicFrame",
        "tone",
        "image",
        "styleAssetIds",
        "vetoMinutes",
        "monthlyBudgetMicros",
      ]
        .filter((key) => d[key] !== undefined)
        .map((key) => [key, d[key]]),
    );
    expect(confirmation.assignmentHash).toBe(hash(content));
    const ended = await status(active.id, "ended");
    expect(data(ended).status).toBe("ended");
    await expect(status(active.id, "active", project.owner)).rejects.toThrow(
      "ASSIGNMENT_ENDED",
    );
    await expect(edit(active.id, { name: "Again" })).rejects.toThrow(
      "ASSIGNMENT_ENDED",
    );
  });

  it("rejects a stale version and invalid input", async () => {
    const { assignment } = await propose();
    await expect(
      run((tx) =>
        updateAssignment(tx, project.editor, assignment.id, 99, {
          name: "x",
        }),
      ),
    ).rejects.toThrow("VERSION_CONFLICT");
    expect(
      assignmentInput.safeParse({ ...base, vetoMinutes: 20 }).success,
    ).toBe(false);
    expect(
      assignmentInput.safeParse({ ...base, vetoMinutes: 1441 }).success,
    ).toBe(false);
    expect(
      assignmentInput.safeParse({
        ...base,
        schedule: { ...base.schedule, times: ["9:00"] },
      }).success,
    ).toBe(false);
    // A one-off assignment runs once on a date.
    expect(
      assignmentInput.safeParse({ ...base, kind: "one_off" }).success,
    ).toBe(false);
    expect(
      assignmentInput.safeParse({
        ...base,
        kind: "one_off",
        schedule: {
          rhythm: "once",
          weekdays: [],
          times: ["09:00"],
          date: "2030-01-15",
        },
      }).success,
    ).toBe(true);
  });

  it("creates nothing while ORBIT_AGENTS is off", async () => {
    const { actionRequest } = await propose();
    process.env.ORBIT_AGENTS = "false";
    await expect(propose()).rejects.toThrow("AGENTS_DISABLED");
    await expect(decide(project.owner, actionRequest)).rejects.toThrow(
      "AGENTS_DISABLED",
    );
    expect(
      await run((tx) => list(tx, project.owner, "assignments")),
    ).toHaveLength(1);
  });
});
