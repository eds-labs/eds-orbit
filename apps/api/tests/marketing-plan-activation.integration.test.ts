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
  authDb,
  closeDatabase,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity, create, update, list } from "../src/shared.ts";
import { chatScoped } from "../src/modules/chat.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  proposePlan,
  planView,
} from "../src/modules/marketing/plans/service.ts";
import {
  proposeActivation,
  pausePlan,
} from "../src/modules/marketing/plans/activation.ts";
import { ownedPlanRefusal } from "../src/modules/marketing/plans/execution.ts";
import {
  assignmentInput,
  assignmentHash,
  updateAssignment,
} from "../src/modules/marketing/agents/assignments.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/marketing/agents/assignment-runs.ts";
import {
  runAgentTask,
  assertTaskBudget,
} from "../src/modules/marketing/agents/specialists/runner.ts";
import {
  createPackageProject,
  X,
  TELEGRAM,
} from "./support/package-project.ts";
import { assignmentHumanApprovalBlocker } from "../src/modules/marketing/policy/policy.ts";
import { zonedTime } from "../src/modules/marketing/publishing/posting-slots.ts";
import { planTools } from "../src/modules/marketing/tools/plan-tools.ts";
import { currentMarketingProfile } from "../src/modules/marketing/brand/marketing-profile.ts";
import { planSpec } from "./support/marketing-plan.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("MA-04 exact atomic plan activation", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    chatScoped(project.owner, work);
  const current = (id: string) => run((tx) => planView(tx, project.owner, id));
  const decide = (r: any, consent = true, scope = project.owner) =>
    chatScoped(scope, (tx) =>
      decideActionRequest(tx, scope, r.id, {
        version: r.version,
        packageHash: r.packageHash,
        decision: "approve",
        imageRightsConsent: consent,
      }),
    );
  async function strategy(
    image = false,
    existingWork: any[] = [],
    styles: string[] = [],
    pendingReviewLimit?: number,
  ) {
    const spec = await run((tx) => planSpec(tx, project.owner));
    if (pendingReviewLimit !== undefined)
      spec.pendingReviewLimit = pendingReviewLimit;
    spec.creative.image = image;
    spec.creative.styleAssetIds = styles;
    spec.channels = [X, TELEGRAM];
    spec.horizon.startAt = new Date(Date.now() - 1000).toISOString();
    spec.cadence = { rhythm: "daily", weekdays: [], times: ["10:00"] };
    spec.existingWork = existingWork;
    const plan = await run((tx) => proposePlan(tx, project.owner, spec));
    await decide(plan.actionRequest);
    return current(plan.id);
  }
  function child(
    p: any,
    channel = X,
    existing?: { id: string; version: number },
  ) {
    return {
      key: channel,
      ...(existing ? { existing } : {}),
      assignment: assignmentInput.parse({
        name: `Synthetic ${channel}`,
        kind: "standing",
        contentType: "social",
        channels: [channel],
        schedule: { ...p.spec.cadence, leadMinutes: 360 },
        topicFrame: "Explain the reviewed synthetic beta",
        image: p.spec.creative.image,
        styleAssetIds: p.spec.creative.styleAssetIds,
        approvalMode: "human_each",
        delivery: "publish",
        monthlyBudgetMicros: 5_000_000,
      }),
    };
  }
  const propose = (p: any, children = [child(p)]) =>
    run((tx) =>
      proposeActivation(tx, project.owner, p.id, {
        version: p.version,
        children,
      }),
    );
  beforeEach(async () => {
    vi.stubEnv("ORBIT_AGENTS", "true");
    project = await createPackageProject();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await project.cleanup();
  });
  afterAll(() => closeDatabase());
  it("binds a configured plan review limit to every exact child mandate", async () => {
    const p = await strategy(false, [], [], 4);
    const proposed = child(p);
    proposed.assignment.pendingReviewLimit = 2;
    await expect(propose(p, [proposed])).rejects.toThrow(
      "PLAN_CHILD_EXCEEDS_ENVELOPE",
    );
    proposed.assignment.pendingReviewLimit = 4;
    const activation = await propose(p, [proposed]);
    await decide(activation.activationRequest);
    expect(
      data((await run((tx) => list(tx, project.owner, "assignments")))[0]),
    ).toMatchObject({ pendingReviewLimit: 4, status: "active" });
  });
  it("proposes without effects, serializes concurrent proposal/decisions and records one exact child set", async () => {
    const p = await strategy(true),
      input = [child(p, X), child(p, TELEGRAM)];
    const activationContext = await planTools
      .find((tool) => tool.name === "marketing_plan_activation_context")!
      .execute(
        { scope: project.owner, conversationId: "unused-read-context" } as any,
        { planId: p.id },
      );
    expect(
      Buffer.byteLength(JSON.stringify(activationContext.output)),
    ).toBeLessThan(11000);
    expect(activationContext.output).toMatchObject({
      planId: p.id,
      version: p.version,
      activationContract: expect.any(Object),
    });
    const [a, b] = await Promise.all([propose(p, input), propose(p, input)]);
    expect(a.activationRequest!.id).toBe(b.activationRequest!.id);
    await run(async (tx) => {
      expect(await list(tx, project.owner, "assignments")).toHaveLength(0);
      expect(
        await tx.budgetReservation.count({
          where: { projectId: project.owner.projectId },
        }),
      ).toBe(0);
    });
    await expect(decide(a.activationRequest, false)).rejects.toThrow(
      "IMAGE_RIGHTS_CONSENT_REQUIRED",
    );
    await expect(
      decide(a.activationRequest, true, project.editor),
    ).rejects.toThrow("OWNER_REQUIRED");
    await Promise.all([
      decide(a.activationRequest),
      decide(a.activationRequest),
    ]);
    const active = await current(p.id);
    expect(active.status).toBe("active");
    await run(async (tx) => {
      const rows = await list(tx, project.owner, "assignments");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(data(row)).toMatchObject({
          status: "active",
          actionRequestId: null,
          approvalMode: "human_each",
          marketingPlan: {
            planId: p.id,
            revision: 1,
            requestId: a.activationRequest!.id,
          },
          confirmation: {
            userId: project.owner.userId,
            imageRightsConsent: true,
          },
        });
        expect(data(row).confirmation.assignmentHash).toBe(
          assignmentHash(data(row)),
        );
      }
      for (const kind of [
        "jobs",
        "missions",
        "content",
        "publications",
        "postiz_drafts",
      ])
        expect(await list(tx, project.owner, kind)).toEqual([]);
      expect(
        (await list(tx, project.owner, "action_requests")).filter(
          (r) => data(r).actionType === "assignment.confirm",
        ),
      ).toEqual([]);
    });
  });
  it("rolls back all staging and the decision if a later child fails", async () => {
    const p = await strategy(),
      a = await propose(p, [child(p, X), child(p, TELEGRAM)]);
    // Emulate a shared service/storage failure after the first staged child.
    await expect(
      run(async (tx) => {
        let stagedCount = 0;
        const wrapped = new Proxy(tx, {
          get(target, prop) {
            if (prop !== "entity") return Reflect.get(target, prop);
            const table = target.entity;
            return new Proxy(table, {
              get(obj, key) {
                if (key !== "create") return Reflect.get(obj, key);
                return async (args: any) => {
                  if (args.data.kind === "assignments" && ++stagedCount === 2)
                    throw new Error("SYNTHETIC_STORAGE_FAILURE");
                  return table.create(args);
                };
              },
            });
          },
        });
        await decideActionRequest(
          wrapped,
          project.owner,
          a.activationRequest!.id,
          {
            version: a.activationRequest!.version,
            packageHash: a.activationRequest!.packageHash,
            decision: "approve",
          },
        );
      }),
    ).rejects.toThrow("SYNTHETIC_STORAGE_FAILURE");
    await run(async (tx) => {
      expect(await list(tx, project.owner, "assignments")).toHaveLength(0);
      expect(
        data(
          await entity(
            tx,
            project.owner,
            "action_requests",
            a.activationRequest!.id,
          ),
        ).status,
      ).toBe("pending");
    });
    expect((await current(p.id)).status).toBe("proposed");
  });
  it("links independent assignments/missions without copies; explicit versioned adoption replaces one", async () => {
    const base = await strategy();
    const independent = await run(async (tx) => {
      const a = child(base).assignment;
      return create(tx, project.owner, "assignments", {
        ...a,
        status: "active",
        confirmation: { assignmentHash: assignmentHash(a) },
      });
    });
    const mission = await run((tx) =>
      create(tx, project.owner, "missions", {
        title: "Independent mission",
        status: "draft",
      }),
    );
    const p = await strategy(false, [
      {
        kind: "assignments",
        id: independent.id,
        version: independent.version,
        proposedChange: "",
      },
      {
        kind: "missions",
        id: mission.id,
        version: mission.version,
        proposedChange: "",
      },
    ]);
    const a = await propose(p, [child(p, TELEGRAM)]);
    await decide(a.activationRequest);
    await run(async (tx) => {
      expect(
        (await entity(tx, project.owner, "assignments", independent.id))
          .version,
      ).toBe(independent.version);
      expect(
        (await entity(tx, project.owner, "missions", mission.id)).version,
      ).toBe(mission.version);
    });
    const p2 = await strategy(false, [
      {
        kind: "assignments",
        id: independent.id,
        version: independent.version,
        proposedChange: "Replace with the exact child mandate",
      },
    ]);
    const b = await propose(p2, [
      child(p2, X, { id: independent.id, version: independent.version }),
    ]);
    await decide(b.activationRequest);
    await run(async (tx) => {
      expect(await list(tx, project.owner, "assignments")).toHaveLength(2);
      expect(
        data(await entity(tx, project.owner, "assignments", independent.id))
          .marketingPlan.planId,
      ).toBe(p2.id);
    });
    await run((tx) => pausePlan(tx, project.owner, p.id, a.version + 1));
    expect(
      data(
        await run((tx) =>
          entity(tx, project.owner, "assignments", independent.id),
        ),
      ).status,
    ).toBe("active");
  });
  it("rejects stale existing versions and never partially activates", async () => {
    const base = await strategy();
    const row = await run((tx) =>
      create(tx, project.owner, "assignments", {
        ...child(base).assignment,
        status: "draft",
      }),
    );
    const p = await strategy(false, [
      {
        kind: "assignments",
        id: row.id,
        version: row.version,
        proposedChange: "Exact adoption",
      },
    ]);
    const a = await propose(p, [
      child(p, X, { id: row.id, version: row.version }),
    ]);
    await run((tx) =>
      update(tx, project.owner, row, { ...data(row), name: "Changed" }),
    );
    await expect(decide(a.activationRequest)).rejects.toThrow(
      /PLAN_WORK_STALE/,
    );
    expect((await current(p.id)).status).toBe("blocked");
    await run(async (tx) => {
      expect(await list(tx, project.owner, "assignments")).toHaveLength(1);
      expect(
        data(await entity(tx, project.owner, "assignments", row.id)).status,
      ).toBe("draft");
    });
  });
  it.each(["channel", "cadence", "mode", "budget", "duplicate", "prose"])(
    "rejects %s outside the approved envelope",
    async (which) => {
      const p = await strategy(),
        c = child(p);
      if (which === "channel") c.assignment.channels = ["foreign"];
      if (which === "cadence") c.assignment.schedule.times = ["11:00"];
      if (which === "mode") c.assignment.approvalMode = "delegated_review";
      if (which === "budget") c.assignment.monthlyBudgetMicros = 21_000_000;
      if (which === "prose") {
        const mission = await run((tx) =>
          create(tx, project.owner, "missions", {
            title: "Link",
            status: "draft",
          }),
        );
        const raw = {
          ...p.spec,
          existingWork: [
            {
              kind: "missions",
              id: mission.id,
              version: mission.version,
              proposedChange: "Change it",
            },
          ],
        };
        const next = await run((tx) =>
          proposePlan(tx, project.owner, raw, null, {
            id: p.id,
            version: p.version,
          }),
        );
        await decide(next.actionRequest);
        await expect(propose(await current(p.id))).rejects.toThrow(
          "PLAN_WORK_DELTA_REQUIRED",
        );
        return;
      }
      await expect(
        propose(p, which === "duplicate" ? [c, { ...c, key: "another" }] : [c]),
      ).rejects.toThrow(/PLAN_/);
      expect((await current(p.id)).status).toBe("proposed");
    },
  );
  it.each(["source", "profile", "policy", "owner", "module"])(
    "revalidates %s drift at activation",
    async (which) => {
      const p = await strategy(),
        a = await propose(p);
      if (which === "owner")
        await authDb.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId: project.owner.workspaceId,
              userId: project.owner.userId,
            },
          },
          data: { role: "viewer" },
        });
      else if (which === "module") {
        vi.stubEnv("ORBIT_MODULES", "true");
        await run((tx) =>
          tx.projectModule.upsert({
            where: {
              workspaceId_projectId_moduleId: {
                workspaceId: project.owner.workspaceId,
                projectId: project.owner.projectId,
                moduleId: "marketing",
              },
            },
            create: {
              workspaceId: project.owner.workspaceId,
              projectId: project.owner.projectId,
              moduleId: "marketing",
              moduleVersion: "1.0.0",
              enabled: false,
            },
            update: { enabled: false },
          }),
        );
      } else
        await run(async (tx) => {
          if (which === "profile") {
            const profile = (await currentMarketingProfile(tx, project.owner))!;
            await tx.projectMarketingProfile.update({
              where: { id: profile.id },
              data: { version: profile.version + 1 },
            });
          } else {
            const ref =
              which === "source" ? p.sourceSnapshot[0] : p.spec.policy;
            const kind = which === "source" ? "sources" : "policies";
            const row = await entity(tx, project.owner, kind, ref.id);
            await update(tx, project.owner, row, {
              ...data(row),
              [which === "source" ? "publicUse" : "active"]: false,
            });
          }
        });
      await expect(decide(a.activationRequest)).rejects.toThrow();
      await run(async (tx) => {
        expect(await list(tx, project.owner, "assignments")).toHaveLength(0);
      });
    },
  );
  it("stops owned runs/tasks after pause, requires a fresh exact resume and keeps legacy work independent", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    const owned = (
      await run((tx) => list(tx, project.owner, "assignments"))
    )[0]!;
    vi.useFakeTimers({ toFake: ["Date"] });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(7, 0, 0, 0);
    vi.setSystemTime(tomorrow);
    const planned = await run((tx) => planAssignmentRuns(tx, project.owner));
    expect(planned.created).toBe(1);
    const tasks = await run((tx) => list(tx, project.owner, "agent_tasks"));
    expect(tasks.length).toBeGreaterThan(0);
    const active = await current(p.id);
    await run((tx) => pausePlan(tx, project.owner, p.id, active.version));
    await runAgentTask({ ...project.owner, userId: "worker" }, tasks[0]!.id);
    await run(async (tx) => {
      expect(
        data(await entity(tx, project.owner, "assignments", owned.id)).status,
      ).toBe("paused");
      expect(
        await ownedPlanRefusal(
          tx,
          project.owner,
          data(await entity(tx, project.owner, "assignments", owned.id)),
        ),
      ).toBe("PLAN_NOT_ACTIVE");
      expect(
        await ownedPlanRefusal(tx, project.owner, { status: "active" }),
      ).toBeNull();
      expect(
        await tx.budgetReservation.count({
          where: { projectId: project.owner.projectId },
        }),
      ).toBe(0);
      expect((await planAssignmentRuns(tx, project.owner)).created).toBe(0);
    });
    const paused = await current(p.id),
      row = await run((tx) =>
        entity(tx, project.owner, "assignments", owned.id),
      );
    const resume = await propose(paused, [
      child(paused, X, { id: row.id, version: row.version }),
    ]);
    await decide(resume.activationRequest);
    expect((await current(p.id)).status).toBe("active");
  });
  it("guards horizon expiry, source/asset/owner drift and revised plans at worker boundaries", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    const owned = (
      await run((tx) => list(tx, project.owner, "assignments"))
    )[0]!;
    expect(
      await run((tx) => ownedPlanRefusal(tx, project.owner, data(owned))),
    ).toBeNull();
    expect(
      await run((tx) =>
        ownedPlanRefusal(
          tx,
          project.owner,
          data(owned),
          new Date(p.spec.horizon.endAt),
        ),
      ),
    ).toBe("PLAN_OUTSIDE_HORIZON");
    await run(async (tx) => {
      const content = await create(tx, project.owner, "content", {
        assignmentId: owned.id,
        body: "Synthetic boundary content",
        approvalMode: "human_each",
      });
      expect(
        await assignmentHumanApprovalBlocker(
          tx,
          project.owner,
          content.id,
          new Date(p.spec.horizon.endAt),
        ),
      ).toBe("PLAN_OUTSIDE_HORIZON");
      expect(
        await assignmentHumanApprovalBlocker(
          tx,
          project.owner,
          content.id,
          new Date(Date.parse(p.spec.horizon.startAt) - 1),
        ),
      ).toBe("PLAN_OUTSIDE_HORIZON");
    });
    const active = await current(p.id);
    const revised = await run((tx) =>
      proposePlan(
        tx,
        project.owner,
        { ...p.spec, title: "Revised strategy" },
        null,
        { id: p.id, version: active.version },
      ),
    );
    expect(revised.status).toBe("proposed");
    expect(
      await run((tx) => ownedPlanRefusal(tx, project.owner, data(owned))),
    ).toBe("PLAN_NOT_ACTIVE");
    expect(
      data(
        await run((tx) => entity(tx, project.owner, "assignments", owned.id)),
      ).status,
    ).toBe("paused");
    await expect(decide(a.activationRequest)).resolves.toBeDefined();
    expect((await current(p.id)).status).toBe("proposed");
  });
  it.each(["source", "asset", "owner", "module", "child"])(
    "blocks current %s drift on already active owned work",
    async (which) => {
      const asset = await run((tx) =>
        create(tx, project.owner, "assets", {
          usageApproved: true,
          assetStatus: "approved",
          type: "image",
          name: "Synthetic style",
        }),
      );
      const p = await strategy(true, [], [asset.id]),
        a = await propose(p);
      await decide(a.activationRequest);
      const owned = (
        await run((tx) => list(tx, project.owner, "assignments"))
      )[0]!;
      if (which === "owner")
        await authDb.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId: project.owner.workspaceId,
              userId: project.owner.userId,
            },
          },
          data: { role: "viewer" },
        });
      else if (which === "module") {
        vi.stubEnv("ORBIT_MODULES", "true");
        await run((tx) =>
          tx.projectModule.create({
            data: {
              workspaceId: project.owner.workspaceId,
              projectId: project.owner.projectId,
              moduleId: "marketing",
              enabled: false,
              moduleVersion: "1.0.0",
            },
          }),
        );
      } else
        await run(async (tx) => {
          const row =
            which === "asset"
              ? asset
              : which === "child"
                ? owned
                : await entity(
                    tx,
                    project.owner,
                    "sources",
                    p.sourceSnapshot[0]!.id,
                  );
          await update(tx, project.owner, row, {
            ...data(row),
            ...(which === "source"
              ? { publicUse: false }
              : which === "child"
                ? { topicFrame: "Unconfirmed mutation" }
                : { name: "Changed style" }),
          });
        });
      const currentOwned = await run((tx) =>
        entity(tx, project.owner, "assignments", owned.id),
      );
      expect(
        await run((tx) =>
          ownedPlanRefusal(tx, project.owner, data(currentOwned)),
        ),
      ).not.toBeNull();
      expect(
        (await run((tx) => planAssignmentRuns(tx, project.owner))).created,
      ).toBe(0);
    },
  );
  it("checks exact creative versions again at activation", async () => {
    const asset = await run((tx) =>
      create(tx, project.owner, "assets", {
        usageApproved: true,
        assetStatus: "approved",
        type: "image",
      }),
    );
    const p = await strategy(true, [], [asset.id]),
      a = await propose(p);
    await run((tx) =>
      update(tx, project.owner, asset, { ...data(asset), name: "New version" }),
    );
    await expect(decide(a.activationRequest)).rejects.toThrow(
      "PLAN_ASSET_VERSION_STALE",
    );
    expect(
      await run((tx) => list(tx, project.owner, "assignments")),
    ).toHaveLength(0);
  });
  it("revises an active mandate to a smaller budget without a duplicate child or hidden restart", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    const active = await current(p.id);
    const revised = await run((tx) =>
      proposePlan(
        tx,
        project.owner,
        { ...p.spec, monthlyBudgetMicros: 3_000_000 },
        null,
        { id: p.id, version: active.version },
      ),
    );
    await decide(revised.actionRequest);
    const reviewed = await current(p.id),
      row = (await run((tx) => list(tx, project.owner, "assignments")))[0]!;
    const c = child(reviewed, X, { id: row.id, version: row.version });
    c.assignment.monthlyBudgetMicros = 3_000_000;
    const next = await propose(reviewed, [c]);
    await decide(next.activationRequest);
    expect((await current(p.id)).status).toBe("active");
    const children = await run((tx) => list(tx, project.owner, "assignments"));
    expect(children).toHaveLength(1);
    expect(data(children[0]).monthlyBudgetMicros).toBe(3_000_000);
  });
  it("refuses cross-project activation and expired owned paid work without reservations", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    const other = await createPackageProject();
    try {
      await expect(
        chatScoped(other.owner, (tx) =>
          proposeActivation(tx, other.owner, p.id, {
            version: 1,
            children: [child(p)],
          }),
        ),
      ).rejects.toThrow("NOT_FOUND");
    } finally {
      await other.cleanup();
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(7, 0, 0, 0);
    vi.setSystemTime(tomorrow);
    await run((tx) => planAssignmentRuns(tx, project.owner));
    const task = (
      await run((tx) => list(tx, project.owner, "agent_tasks"))
    )[0]!;
    vi.setSystemTime(new Date(p.spec.horizon.endAt));
    await expect(
      run((tx) =>
        assertTaskBudget(
          tx,
          project.owner,
          {
            id: task.id,
            assignmentId: data(task).assignmentId,
            runId: data(task).runId,
            stepKey: data(task).stepKey,
          },
          1,
        ),
      ),
    ).rejects.toThrow("PLAN_OUTSIDE_HORIZON");
    await runAgentTask({ ...project.owner, userId: "worker" }, task.id);
    await run(async (tx) => {
      expect(
        data(await entity(tx, project.owner, "agent_tasks", task.id)).status,
      ).toBe("canceled");
      expect(
        await tx.budgetReservation.count({
          where: { projectId: project.owner.projectId },
        }),
      ).toBe(0);
    });
  });
  it("preserves provider-owned unknown handoffs on pause and reports their actual state", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    const assignment = (
      await run((tx) => list(tx, project.owner, "assignments"))
    )[0]!;
    const publication = await run(async (tx) => {
      const r = await create(tx, project.owner, "assignment_runs", {
        assignmentId: assignment.id,
        status: "done",
        steps: [],
        slots: [],
        costMicros: 100,
      });
      const content = await create(tx, project.owner, "content", {
        assignmentId: assignment.id,
        assignmentRunId: r.id,
        channel: X,
        status: "scheduled",
        body: "Synthetic reviewed content",
      });
      return create(tx, project.owner, "publications", {
        assignmentId: assignment.id,
        assignmentRunId: r.id,
        contentId: content.id,
        channel: X,
        status: "outcome_unknown",
        remoteId: "synthetic-remote",
        handoffAt: new Date().toISOString(),
      });
    });
    const active = await current(p.id),
      paused = await run((tx) =>
        pausePlan(tx, project.owner, p.id, active.version),
      );
    expect(paused.status).toBe("paused");
    expect(paused.linkedWork[0]!.latestRun!.deliveries).toEqual([
      {
        id: publication.id,
        kind: "publications",
        status: "outcome_unknown",
        remoteId: "synthetic-remote",
      },
    ]);
    expect(
      (
        await run((tx) =>
          entity(tx, project.owner, "publications", publication.id),
        )
      ).version,
    ).toBe(publication.version);
  });
  it("never shifts an allocated slot beyond the finite horizon", async () => {
    const p = await strategy(),
      tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const slot = zonedTime(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      10,
      0,
      "Europe/Berlin",
    );
    const revised = await run((tx) =>
      proposePlan(
        tx,
        project.owner,
        {
          ...p.spec,
          horizon: {
            ...p.spec.horizon,
            endAt: new Date(slot.valueOf() + 15 * 60000).toISOString(),
          },
        },
        null,
        { id: p.id, version: p.version },
      ),
    );
    await decide(revised.actionRequest);
    const reviewed = await current(p.id),
      a = await propose(reviewed);
    await decide(a.activationRequest);
    await run((tx) =>
      create(tx, project.owner, "calendar_blocks", {
        status: "active",
        channels: [X],
        startAt: new Date(slot.valueOf() - 60000).toISOString(),
        endAt: new Date(slot.valueOf() + 30 * 60000).toISOString(),
        reason: "Synthetic horizon-bound block",
      }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slot.valueOf() - 3600000));
    await run(async (tx) => {
      expect((await planAssignmentRuns(tx, project.owner)).created).toBe(0);
      expect(await list(tx, project.owner, "assignment_runs")).toEqual([]);
      expect(await list(tx, project.owner, "agent_tasks")).toEqual([]);
      expect(
        await tx.budgetReservation.count({
          where: { projectId: project.owner.projectId },
        }),
      ).toBe(0);
    });
  });
  it("does not queue successor specialist work after plan authority is disabled", async () => {
    const p = await strategy(),
      a = await propose(p);
    await decide(a.activationRequest);
    vi.useFakeTimers({ toFake: ["Date"] });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(7, 0, 0, 0);
    vi.setSystemTime(tomorrow);
    await run((tx) => planAssignmentRuns(tx, project.owner));
    const tasks = await run((tx) => list(tx, project.owner, "agent_tasks")),
      runs = await run((tx) => list(tx, project.owner, "assignment_runs"));
    await run(async (tx) => {
      for (const task of tasks)
        await update(tx, project.owner, task, {
          ...data(task),
          status: "done",
        });
      await tx.projectModule.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          moduleId: "marketing",
          enabled: false,
          moduleVersion: "1.0.0",
        },
      });
    });
    vi.stubEnv("ORBIT_MODULES", "true");
    await run((tx) => startReadySteps(tx, project.owner, runs[0]!.id));
    await run(async (tx) => {
      expect(await list(tx, project.owner, "agent_tasks")).toHaveLength(
        tasks.length,
      );
      expect(
        data(await entity(tx, project.owner, "assignment_runs", runs[0]!.id))
          .status,
      ).toBe("canceled");
    });
  });
});
