import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { marketingPlanSpec } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import {
  createConversation,
  getConversation,
  chatScoped,
} from "../src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../src/modules/action-requests.ts";
import { exportProject } from "../src/platform/governance/export.ts";
import {
  planContext,
  planView,
  proposePlan,
} from "../src/modules/marketing/plans/service.ts";
import {
  planTools,
  planCard,
} from "../src/modules/marketing/tools/plan-tools.ts";
import { availableTools } from "../src/modules/agents/tools/registry.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import { planSpec } from "./support/marketing-plan.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Marketing strategic plans (MA-03; never activation)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      chatScoped(project.owner, fn);
    const spec = () => run((tx) => planSpec(tx, project.owner));
    const propose = async () => {
      const input = await spec();
      return run((tx) => proposePlan(tx, project.owner, input));
    };
    const approve = (
      plan: Awaited<ReturnType<typeof propose>>,
      scope = project.owner,
    ) =>
      run((tx) =>
        decideActionRequest(tx, scope, plan.actionRequest!.id, {
          version: plan.actionRequest!.version,
          packageHash: plan.actionRequest!.packageHash,
          decision: "approve",
        }),
      );
    beforeEach(async () => {
      vi.stubEnv("ORBIT_AGENTS", "true");
      project = await createPackageProject();
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await project.cleanup();
    });
    afterAll(() => closeDatabase());
    it("reads bounded fresh context without providers or fabricated baselines", async () => {
      const context = await run((tx) => planContext(tx, project.owner));
      expect(context).toMatchObject({
        activationAvailable: true,
        baselineState: "no_data",
        existingPlans: [],
        existingWork: [],
        facts: expect.any(Array),
        specContract: expect.any(Object),
      });
      expect(context.allowedChannels.map((c) => c.id)).toContain(X);
      expect(JSON.stringify(context)).not.toContain(
        "synthetic-no-provider-call-key",
      );
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(40000);
    });
    it("persists independently of chat deletion with versions, audit and export; owner review starts nothing", async () => {
      const thread = await createConversation(project.owner),
        input = await spec();
      const plan = await run((tx) =>
        proposePlan(tx, project.owner, input, thread.id),
      );
      await run((tx) =>
        tx.chatMessage.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            userId: project.owner.userId,
            conversationId: thread.id,
            sequence: 1,
            role: "assistant",
            text: "Review the strategy only",
            cards: [planCard(plan)] as any,
          },
        }),
      );
      expect(
        (await getConversation(project.owner, thread.id)).marketingPlans,
      ).toEqual([expect.objectContaining({ id: plan.id })]);
      await approve(plan);
      await approve(plan);
      await run((tx) =>
        tx.chatConversation.delete({ where: { id: thread.id } }),
      );
      const saved = await run((tx) => planView(tx, project.owner, plan.id));
      expect(saved).toMatchObject({
        status: "proposed",
        strategicallyReviewed: true,
        activationAvailable: true,
        revision: 1,
      });
      await run(async (tx) => {
        for (const kind of [
          "assignments",
          "missions",
          "assignment_runs",
          "agent_tasks",
          "content",
          "publications",
          "postiz_drafts",
          "jobs",
        ])
          expect(await list(tx, project.owner, kind)).toEqual([]);
        expect(
          await tx.budgetReservation.count({
            where: { projectId: project.owner.projectId },
          }),
        ).toBe(0);
        expect(
          (await exportProject(tx, project.owner)).entities,
        ).toContainEqual(
          expect.objectContaining({ id: plan.id, kind: "marketing_plans" }),
        );
        expect(
          await tx.entityVersion.count({ where: { entityId: plan.id } }),
        ).toBeGreaterThan(1);
        const audits = await tx.auditEvent.findMany({
          where: { resourceId: plan.id },
        });
        expect(audits.map((a) => a.action)).toContain(
          "marketing_plan.reviewed",
        );
        expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain(
          input.goal,
        );
      });
    });
    it("serializes duplicate proposals without extra requests or plans", async () => {
      const input = await spec();
      const [a, b] = await Promise.all([
        run((tx) => proposePlan(tx, project.owner, input)),
        run((tx) => proposePlan(tx, project.owner, input)),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.actionRequest!.id).toBe(b.actionRequest!.id);
      expect(
        await run((tx) => list(tx, project.owner, "marketing_plans")),
      ).toHaveLength(1);
    });
    it("revisions invalidate reviewed strategy; stale and parallel changes fail", async () => {
      const plan = await propose();
      await approve(plan);
      const current = await run((tx) => planView(tx, project.owner, plan.id));
      const changed = {
        ...current.spec,
        goal: "A changed goal needs a new exact strategic approval",
      };
      const results = await Promise.allSettled([
        run((tx) =>
          proposePlan(tx, project.owner, changed, null, {
            id: plan.id,
            version: current.version,
          }),
        ),
        run((tx) =>
          proposePlan(
            tx,
            project.owner,
            { ...changed, title: "Another revision" },
            null,
            { id: plan.id, version: current.version },
          ),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "VERSION_CONFLICT" }),
        }),
      ]);
      expect(
        await run((tx) => planView(tx, project.owner, plan.id)),
      ).toMatchObject({
        revision: 2,
        strategicallyReviewed: false,
        status: "proposed",
      });
      expect(data(await approve(plan)).status).toBe("canceled");
      expect(
        (await run((tx) => planView(tx, project.owner, plan.id)))
          .strategicallyReviewed,
      ).toBe(false);
    });
    it.each([
      "channel",
      "profile",
      "fact",
      "source",
      "budget",
      "horizon",
      "cadence",
      "work",
      "baseline",
      "language",
    ])("refuses invalid %s before saving anything", async (variant) => {
      const input: any = await spec();
      if (variant === "channel") input.channels = ["unassigned-channel"];
      if (variant === "profile") input.profileVersion++;
      if (variant === "fact") input.facts[0].version++;
      if (variant === "source")
        await run(async (tx) => {
          const row = await entity(
            tx,
            project.owner,
            "sources",
            input.sourceRefs[0].id,
          );
          await update(tx, project.owner, row, {
            ...data(row),
            publicUse: false,
          });
        });
      if (variant === "budget") input.monthlyBudgetMicros = 101_000_000;
      if (variant === "horizon")
        input.horizon.endAt = new Date(
          Date.now() + 1000 * 86400000,
        ).toISOString();
      if (variant === "cadence") input.cadence.times.push("14:00");
      if (variant === "work")
        input.existingWork = [
          {
            kind: "assignments",
            id: randomUUID(),
            version: 1,
            proposedChange: "",
          },
        ];
      if (variant === "baseline")
        input.kpis[0] = {
          ...input.kpis[0],
          baselineState: "measured",
          metricRefs: [{ id: randomUUID(), version: 1 }],
        };
      if (variant === "language") input.language = "de";
      await expect(
        run((tx) => proposePlan(tx, project.owner, input)),
      ).rejects.toThrow();
      expect(
        await run((tx) => list(tx, project.owner, "marketing_plans")),
      ).toEqual([]);
      expect(
        await run((tx) => list(tx, project.owner, "action_requests")),
      ).toEqual([]);
    });
    it.each([
      "profile",
      "fact_expiry",
      "source_rights",
      "source_version",
      "policy",
      "channel",
      "budget",
    ])("blocks stale %s at review and status read", async (variant) => {
      const plan = await propose();
      await run(async (tx) => {
        if (variant === "profile") {
          await tx.projectMarketingProfile.updateMany({
            where: { projectId: project.owner.projectId },
            data: { version: { increment: 1 } },
          });
          return;
        }
        const kind = variant.startsWith("source")
          ? "sources"
          : variant === "fact_expiry"
            ? "facts"
            : variant === "channel"
              ? "connectors"
              : "policies";
        const row = (await list(tx, project.owner, kind))[0]!;
        let patch: any = {};
        if (variant === "fact_expiry")
          patch = { validUntil: new Date(Date.now() - 1000).toISOString() };
        if (variant === "source_rights") patch = { modelUse: false };
        if (variant === "source_version") patch = { name: "Updated source" };
        if (variant === "channel") patch = { assignedIntegrationIds: [] };
        if (variant === "policy") patch = { maxPerDay: 0 };
        if (variant === "budget") patch = { monthlyBudgetMicros: 0 };
        // Expire exactly the CTA fact, not an unrelated fact in the fixture.
        const target =
          variant === "fact_expiry"
            ? await entity(tx, project.owner, "facts", plan.spec.cta.factId)
            : row;
        await update(tx, project.owner, target, { ...data(target), ...patch });
      });
      await expect(approve(plan)).rejects.toThrow();
      expect(
        await run((tx) => planView(tx, project.owner, plan.id)),
      ).toMatchObject({
        status: "blocked",
        strategicallyReviewed: false,
        activationAvailable: false,
      });
    });
    it("keeps editor proposals separate from owner strategic review and blocks revoked owners", async () => {
      const input = await spec(),
        plan = await run((tx) => proposePlan(tx, project.editor, input));
      await expect(approve(plan, project.editor)).rejects.toThrow(
        "OWNER_REQUIRED",
      );
      await expect(
        run((tx) => proposePlan(tx, project.viewer, input)),
      ).rejects.toThrow("FORBIDDEN");
      await authDb.workspaceMember.updateMany({
        where: {
          workspaceId: project.owner.workspaceId,
          userId: project.owner.userId,
        },
        data: { role: "viewer" },
      });
      await expect(approve(plan)).rejects.toThrow("FORBIDDEN");
    });
    it("refuses foreign project reads and references", async () => {
      const other = await createPackageProject();
      try {
        const foreign = await scoped(
          other.owner.workspaceId,
          other.owner.projectId,
          async (tx) =>
            proposePlan(tx, other.owner, await planSpec(tx, other.owner)),
        );
        await expect(
          run((tx) => planView(tx, project.owner, foreign.id)),
        ).rejects.toThrow("NOT_FOUND");
        const input = await spec();
        input.facts = foreign.spec.facts;
        await expect(
          run((tx) => proposePlan(tx, project.owner, input)),
        ).rejects.toThrow();
      } finally {
        await other.cleanup();
      }
    });
    it("hides tools and refuses services when Marketing or agents are disabled", async () => {
      vi.stubEnv("ORBIT_MODULES", "true");
      await run((tx) =>
        tx.projectModule.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            moduleId: "marketing",
            moduleVersion: "1.0.0",
            enabled: false,
            changedBy: project.owner.userId,
          },
        }),
      );
      await expect(run((tx) => planContext(tx, project.owner))).rejects.toThrow(
        "MODULE_DISABLED",
      );
      vi.stubEnv("ORBIT_MODULES", "false");
      vi.stubEnv("ORBIT_AGENTS", "false");
      await expect(run((tx) => planContext(tx, project.owner))).rejects.toThrow(
        "AGENTS_DISABLED",
      );
      expect(availableTools(planTools, "owner", [])).toEqual([]);
    });
    it("projects linked work and its real run without changing or activating it", async () => {
      const input = await spec();
      const assignment = await run((tx) =>
        create(tx, project.owner, "assignments", {
          name: "Independent existing job",
          status: "active",
          monthlyBudgetMicros: 15_000_000,
        }),
      );
      const runRow = await run((tx) =>
        create(tx, project.owner, "assignment_runs", {
          assignmentId: assignment.id,
          status: "done",
          costMicros: 1234,
        }),
      );
      input.existingWork = [
        {
          kind: "assignments",
          id: assignment.id,
          version: assignment.version,
          proposedChange:
            "Review a future cadence adjustment; do not apply it now",
        },
      ];
      const plan = await run((tx) => proposePlan(tx, project.owner, input));
      expect(plan.linkedWork).toEqual([
        expect.objectContaining({
          id: assignment.id,
          status: "active",
          latestRun: { id: runRow.id, status: "done", costMicros: 1234, deliveries: [] },
        }),
      ]);
      await approve(plan);
      expect(
        (
          await run((tx) =>
            entity(tx, project.owner, "assignments", assignment.id),
          )
        ).version,
      ).toBe(assignment.version);
      expect(
        await run((tx) => list(tx, project.owner, "assignments")),
      ).toHaveLength(1);
    });
    it("accepts only measured baselines with a matching stored dimension", async () => {
      const input = await spec();
      const metric = await run((tx) =>
        create(tx, project.owner, "metrics", {
          source: "manual_test",
          externalId: "synthetic-baseline",
          campaign: "beta",
          timezone: "Europe/Berlin",
          currency: "USD",
          periodStart: new Date(Date.now() - 86400000).toISOString(),
          periodEnd: new Date().toISOString(),
          impressions: 50,
          clicks: null,
          sessions: null,
          conversions: null,
          costMicros: null,
          sampleSize: 50,
          synthetic: true,
        }),
      );
      input.kpis = [
        {
          name: "Reach",
          unit: "impressions",
          baselineState: "measured",
          metricRefs: [{ id: metric.id, version: metric.version }],
        },
      ];
      expect(
        (await run((tx) => proposePlan(tx, project.owner, input))).spec.kpis[0]
          .baselineState,
      ).toBe("measured");
      input.kpis[0].unit = "conversions";
      await expect(
        run((tx) => proposePlan(tx, project.owner, input)),
      ).rejects.toThrow("PLAN_BASELINE_NOT_MEASURED");
    });
    it("filters support-only sources from Marketing context and refuses their use", async () => {
      const input = await spec();
      await run(async (tx) => {
        const source = await entity(
          tx,
          project.owner,
          "sources",
          input.sourceRefs[0].id,
        );
        await update(tx, project.owner, source, {
          ...data(source),
          audiences: ["support"],
        });
      });
      expect((await run((tx) => planContext(tx, project.owner))).facts).toEqual(
        [],
      );
      await expect(
        run((tx) => proposePlan(tx, project.owner, input)),
      ).rejects.toThrow("PLAN_SOURCE_STALE_OR_UNUSABLE");
    });
    it("binds auto-derived sources and invalidates strategy review on source revision", async () => {
      const input = await spec();
      input.sourceRefs = [];
      const plan = await run((tx) => proposePlan(tx, project.owner, input));
      expect(plan.sourceSnapshot).toHaveLength(1);
      await approve(plan);
      await run(async (tx) => {
        const source = await entity(
          tx,
          project.owner,
          "sources",
          plan.sourceSnapshot[0].id,
        );
        await update(tx, project.owner, source, {
          ...data(source),
          name: "Changed provenance",
        });
      });
      expect(
        await run((tx) => planView(tx, project.owner, plan.id)),
      ).toMatchObject({
        status: "blocked",
        strategicallyReviewed: false,
        blockers: ["PLAN_SOURCE_SNAPSHOT_STALE"],
      });
    });
    it("renders the exact review snapshot through the generic module summary contract", async () => {
      const plan = await propose();
      const pending = await run((tx) => listActionRequests(tx, project.owner));
      expect(pending).toContainEqual(
        expect.objectContaining({
          id: plan.actionRequest!.id,
          summary: expect.objectContaining({
            marketingPlan: expect.objectContaining({
              planId: plan.id,
              specHash: plan.specHash,
              spec: plan.spec,
            }),
          }),
        }),
      );
      expect(
        marketingPlanSpec.safeParse({ ...plan.spec, status: "active" }).success,
      ).toBe(false);
    });
  },
);
