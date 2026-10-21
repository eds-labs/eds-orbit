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
  scoped,
  closeDatabase,
  authDb,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity, update, list, hash } from "../src/shared.ts";
import { assignmentRun } from "./support/assignment-review.ts";
import { createPackageProject, TELEGRAM } from "./support/package-project.ts";
import { planSpec } from "./support/marketing-plan.ts";
import {
  proposePlan,
  validateSaved,
} from "../src/modules/marketing/plans/service.ts";
import {
  persistReport,
  acknowledgeReport,
  proposeReportRevision,
  attributionCampaign,
  proposedAttributionUrl,
} from "../src/modules/marketing/analytics/reports.ts";
import {
  reportWeek,
  scheduleReports,
} from "../src/modules/marketing/analytics/report-schedule.ts";
import { correctMetric } from "../src/modules/marketing/analytics/lifecycle.ts";
import { summarizeMetrics } from "../src/modules/marketing/analytics/metric-report.ts";
import { marketingAttention } from "../src/modules/marketing/attention.ts";
import { reportTools } from "../src/modules/marketing/tools/report-tools.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("MA-07 durable periodic reports", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>, planId: string;
  const now = () => new Date();
  const week = () => reportWeek(now(), "Europe/Berlin");
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, fn);
  const report = () =>
    run((tx) =>
      persistReport(tx, project.owner, {
        planId,
        from: week().from,
        to: week().to,
      }),
    );
  const metrics = (changes: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "metrics", {
        source: "synthetic",
        externalId: randomUUID(),
        accountId: "account-a",
        currency: "USD",
        timezone: "UTC",
        campaign: "project",
        reportFamily: "sessions",
        periodStart: week().from + "T00:00:00.000Z",
        periodEnd: week().from + "T23:59:59.999Z",
        sessions: 5,
        clicks: null,
        impressions: null,
        conversions: null,
        costMicros: null,
        sampleSize: 5,
        complete: true,
        ...changes,
      }),
    );
  beforeEach(async () => {
    vi.stubEnv("ORBIT_AGENTS", "true");
    project = await createPackageProject();
    planId = await run(async (tx) => {
      const proposed = await proposePlan(
        tx,
        project.owner,
        await planSpec(tx, project.owner),
      );
      const row = await entity(
          tx,
          project.owner,
          "marketing_plans",
          proposed.id,
        ),
        d = data(row);
      // Historical active strategy fixture. No child, worker or provider is started.
      const spec = {
        ...d.spec,
        horizon: {
          startAt: new Date(Date.now() - 20 * 86400000).toISOString(),
          endAt: new Date(Date.now() + 8 * 86400000).toISOString(),
        },
      };
      await update(tx, project.owner, row, {
        ...d,
        spec,
        status: "active",
        specHash: hash({ spec, sources: d.sources }),
      });
      return row.id;
    });
  });
  afterEach(async () => {
    await project.cleanup();
    vi.unstubAllEnvs();
  });
  afterAll(closeDatabase);
  it("persists explicit noData, publication uncertainty and four-channel sampling limits", async () => {
    await run(async (tx) => {
      const p = await entity(tx, project.owner, "marketing_plans", planId);
      await update(tx, project.owner, p, {
        ...data(p),
        spec: { ...data(p).spec, channels: ["a", "b", "c", "d"] },
      });
    });
    const r = data(await report());
    expect(r).toMatchObject({
      status: "ready",
      noData: true,
      complete: true,
      planReports: [],
      projectReports: [],
      coverage: {
        requestedChannels: ["a", "b", "c", "d"],
        specialistMaxChannels: 3,
        sampledAllChannels: false,
      },
    });
    expect(r.limitations).toContain("PLAN_EXCEEDS_SPECIALIST_CHANNEL_LIMIT");
    expect(r.limitations).toContain("NO_CONFIRMED_PUBLICATION_IDS");
  });
  it("does not assign project-wide website totals to the plan", async () => {
    await metrics();
    const r = data(await report());
    expect(r.noData).toBe(true);
    expect(r.projectReports[0]).toMatchObject({ sessions: 5, clicks: null });
    expect(r.planReports).toEqual([]);
  });
  it("joins confirmed publication IDs and keeps source/account/currency/timezone denominators apart", async () => {
    const pub = await run(async (tx) => {
      const c = await create(tx, project.owner, "content", {
        marketingPlan: { planId },
      });
      return create(tx, project.owner, "publications", {
        contentId: c.id,
        status: "published",
        remoteId: "synthetic-remote",
      });
    });
    await metrics({ publicationId: pub.id });
    await metrics({ source: "matomo", publicationId: pub.id, sessions: 7 });
    await metrics({ currency: "EUR", publicationId: pub.id, sessions: 9 });
    await metrics({
      timezone: "Europe/Berlin",
      publicationId: pub.id,
      sessions: 11,
    });
    await metrics({
      accountId: "account-b",
      publicationId: pub.id,
      sessions: 13,
    });
    const r = data(await report());
    expect(r.noData).toBe(false);
    expect(
      r.planReports
        .map((g: any) => g.sessions)
        .sort((a: number, b: number) => a - b),
    ).toEqual([5, 7, 9, 11, 13]);
    expect(r.publicationIds).toEqual([pub.id]);
    expect(r).not.toHaveProperty("totalSessions");
  });
  it("retains null counters and flags overlapping cumulative observations", async () => {
    await metrics({ campaign: attributionCampaign(planId) });
    await metrics({
      campaign: attributionCampaign(planId),
      sessions: 10,
      clicks: 1,
    });
    const r = data(await report());
    expect(r.complete).toBe(false);
    expect(r.planReports[0]).toMatchObject({
      overlap: true,
      sessions: null,
      clicks: null,
      complete: false,
    });
  });
  it("serializes duplicate generation and owner receipt; native delivery needs no Telegram", async () => {
    const rows = await Promise.all([report(), report(), report()]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.version)).size).toBe(1);
    const attention = () =>
      run((tx) => marketingAttention(tx, project.owner, now())).then((items) =>
        items.filter((i) => i.kind === "marketing_report_ready"),
      );
    expect(await attention()).toHaveLength(1);
    const received = await run((tx) =>
      acknowledgeReport(tx, project.owner, rows[0]!.id, rows[0]!.version),
    );
    expect(data(received).acknowledgedRevision).toBe(1);
    expect(await attention()).toEqual([]);
    const current = await report();
    expect(current.id).toBe(rows[0]!.id);
    expect(data(current).acknowledgedRevision).toBe(1);
  });
  it("uses one optional notification event for a period, including corrected revisions", async () => {
    vi.stubEnv("ORBIT_TELEGRAM", "true");
    await run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status: "linked",
        linkedUserId: project.owner.userId,
        chatId: "synthetic-report",
      }),
    );
    const m = await metrics({ campaign: attributionCampaign(planId) });
    const first = await report();
    await run((tx) =>
      correctMetric(
        tx,
        project.owner,
        m.id,
        m.version,
        { sessions: 8 },
        "synthetic correction",
      ),
    );
    await report();
    const jobs = await run((tx) => list(tx, project.owner, "jobs"));
    expect(
      jobs.filter(
        (j) => data(j).idempotencyKey === `notify:marketing_report:${first.id}`,
      ),
    ).toHaveLength(1);
  });
  it("invalidates and revises corrected measurements in place and resets the proposal", async () => {
    const m = await metrics({ campaign: attributionCampaign(planId) });
    const first = await report();
    await run((tx) =>
      correctMetric(
        tx,
        project.owner,
        m.id,
        m.version,
        { sessions: 8 },
        "synthetic correction",
      ),
    );
    expect(
      data(
        await run((tx) =>
          entity(tx, project.owner, "marketing_reports", first.id),
        ),
      ).status,
    ).toBe("invalidated");
    await run((tx) => scheduleReports(tx, project.owner, now()));
    const current = await run((tx) =>
      entity(tx, project.owner, "marketing_reports", first.id),
    );
    expect(data(current)).toMatchObject({
      revision: 2,
      status: "ready",
      planReports: [expect.objectContaining({ sessions: 8 })],
      revisionProposal: { status: "candidate" },
    });
    expect((await report()).version).toBe(current.version);
  });
  it("corrects historical reports against their saved strategy rather than a later horizon", async () => {
    const m = await metrics({ campaign: attributionCampaign(planId) });
    const old = await report(),
      original = data(old);
    await run(async (tx) => {
      const p = await entity(tx, project.owner, "marketing_plans", planId);
      const spec = {
        ...data(p).spec,
        timezone: "UTC",
        horizon: {
          startAt: new Date(Date.now() + 86400000).toISOString(),
          endAt: new Date(Date.now() + 8 * 86400000).toISOString(),
        },
      };
      await update(tx, project.owner, p, {
        ...data(p),
        spec,
        specHash: hash({ spec, sources: data(p).sources }),
      });
      await correctMetric(
        tx,
        project.owner,
        m.id,
        m.version,
        { sessions: 17 },
        "historical correction",
      );
    });
    const current = await report();
    expect(current.id).toBe(old.id);
    expect(data(current)).toMatchObject({
      revision: 2,
      planSpecHash: original.planSpecHash,
      period: original.period,
      planReports: [expect.objectContaining({ sessions: 17 })],
    });
    await expect(
      run((tx) =>
        proposeReportRevision(tx, project.owner, current.id, current.version),
      ),
    ).rejects.toThrow("REPORT_STALE");
  });
  it("rejects receipt and proposal from a newly stale snapshot before the next sweep", async () => {
    const r = await report();
    await metrics();
    await expect(
      run((tx) => acknowledgeReport(tx, project.owner, r.id, r.version)),
    ).rejects.toThrow("REPORT_STALE");
    await expect(
      run((tx) => proposeReportRevision(tx, project.owner, r.id, r.version)),
    ).rejects.toThrow("REPORT_STALE");
  });
  it("blocks an existing native proposal when new metric rows arrive before the sweep", async () => {
    const r = await report();
    const proposed = await run((tx) =>
      proposeReportRevision(tx, project.owner, r.id, r.version),
    );
    await metrics();
    await expect(
      run((tx) =>
        decideActionRequest(tx, project.owner, proposed.actionRequest!.id, {
          version: proposed.actionRequest!.version,
          packageHash: proposed.actionRequest!.packageHash,
          decision: "approve",
        }),
      ),
    ).rejects.toThrow("PLAN_REPORT_STALE");
    await expect(
      run(async (tx) =>
        validateSaved(
          tx,
          project.owner,
          await entity(tx, project.owner, "marketing_plans", proposed.id),
          true,
        ),
      ),
    ).rejects.toThrow("PLAN_REPORT_STALE");
  });
  it("creates a separate native proposal with unchanged authority and rejects its later stale review", async () => {
    const m = await metrics({
      campaign: attributionCampaign(planId),
      impressions: 25,
    });
    const r = await report();
    const active = await run((tx) =>
      entity(tx, project.owner, "marketing_plans", planId),
    );
    const proposed = await run((tx) =>
      proposeReportRevision(tx, project.owner, r.id, r.version),
    );
    expect(proposed.id).not.toBe(planId);
    expect(proposed.status).toBe("proposed");
    expect(proposed.activation).toBeNull();
    expect(proposed.spec.kpis[0]).toMatchObject({
      baselineState: "measured",
      metricRefs: [{ id: m.id, version: m.version }],
    });
    expect(proposed.actionRequest!.status).toBe("pending");
    expect(
      await run((tx) => entity(tx, project.owner, "marketing_plans", planId)),
    ).toEqual(active);
    expect(await run((tx) => list(tx, project.owner, "assignments"))).toEqual(
      [],
    );
    await run((tx) =>
      correctMetric(
        tx,
        project.owner,
        m.id,
        m.version,
        { sessions: 20 },
        "later correction",
      ),
    );
    await expect(
      run(async (tx) =>
        validateSaved(
          tx,
          project.owner,
          await entity(tx, project.owner, "marketing_plans", proposed.id),
        ),
      ),
    ).rejects.toThrow("PLAN_REPORT_STALE");
    await expect(
      run((tx) =>
        decideActionRequest(tx, project.owner, proposed.actionRequest!.id, {
          version: proposed.actionRequest!.version,
          packageHash: proposed.actionRequest!.packageHash,
          decision: "approve",
        }),
      ),
    ).rejects.toThrow("PLAN_REPORT_STALE");
  });
  it("keeps increased budget/channel/cadence proposals pending and leaves owned assignments untouched", async () => {
    const child = await assignmentRun(project).makeAssignment({
      monthlyBudgetMicros: 5000000,
    });
    await run(async (tx) => {
      const c = await entity(tx, project.owner, "assignments", child.id);
      await update(tx, project.owner, c, {
        ...data(c),
        marketingPlan: { planId },
      });
      const p = await entity(tx, project.owner, "marketing_plans", planId);
      const policy = await entity(
        tx,
        project.owner,
        "policies",
        data(p).spec.policy.id,
      );
      const policyRow = await update(tx, project.owner, policy, {
        ...data(policy),
        maxPerDay: 4,
      });
      const spec = {
        ...data(p).spec,
        policy: { id: policy.id, version: policyRow.version },
      };
      await update(tx, project.owner, p, {
        ...data(p),
        spec,
        specHash: hash({ spec, sources: data(p).sources }),
        activation: { children: [{ id: child.id }] },
      });
    });
    const r = await report(),
      base = data(
        await run((tx) => entity(tx, project.owner, "marketing_plans", planId)),
      );
    const before = await run((tx) =>
      entity(tx, project.owner, "assignments", child.id),
    );
    const proposed = await run((tx) =>
      proposeReportRevision(tx, project.owner, r.id, r.version, {
        ...base.spec,
        monthlyBudgetMicros: 25000000,
        channels: [base.spec.channels[0], TELEGRAM],
        cadence: { ...base.spec.cadence, times: ["10:00", "15:00"] },
        horizon: {
          ...base.spec.horizon,
          startAt: new Date(Date.now() + 60000).toISOString(),
        },
      }),
    );
    expect(proposed.actionRequest!.status).toBe("pending");
    expect(proposed.spec).toMatchObject({
      monthlyBudgetMicros: 25000000,
      channels: [base.spec.channels[0], TELEGRAM],
      cadence: { times: ["10:00", "15:00"] },
    });
    expect(proposed.activation).toBeNull();
    expect(
      await run((tx) => entity(tx, project.owner, "assignments", child.id)),
    ).toEqual(before);
    expect(await run((tx) => list(tx, project.owner, "publications"))).toEqual(
      [],
    );
  });
  it("exposes saved evidence through the existing assistant with scoped rights", async () => {
    const r = await report();
    const status = reportTools.find(
      (t) => t.name === "marketing_report_status",
    )!;
    const result = await status.execute({ scope: project.viewer } as never, {
      planId,
    });
    expect(result.output).toMatchObject({
      reports: [expect.objectContaining({ id: r.id, noData: true })],
    });
    const prepare = reportTools.find(
      (t) => t.name === "marketing_report_propose_revision",
    )!;
    await expect(
      prepare.execute({ scope: project.viewer } as never, {
        reportId: r.id,
        version: r.version,
      }),
    ).rejects.toThrow("FORBIDDEN");
    vi.stubEnv("ORBIT_AGENTS", "false");
    await expect(
      status.execute({ scope: project.owner } as never, { planId }),
    ).rejects.toThrow("AGENTS_DISABLED");
  });
  it("requires owner receipt and current permissions, and hides foreign project reports", async () => {
    const r = await report();
    await expect(
      run((tx) => acknowledgeReport(tx, project.editor, r.id, r.version)),
    ).rejects.toThrow("OWNER_REQUIRED");
    await expect(
      run((tx) => proposeReportRevision(tx, project.viewer, r.id, r.version)),
    ).rejects.toThrow("FORBIDDEN");
    const other = await createPackageProject();
    try {
      await expect(
        scoped(other.owner.workspaceId, other.owner.projectId, (tx) =>
          acknowledgeReport(tx, other.owner, r.id, r.version),
        ),
      ).rejects.toThrow("NOT_FOUND");
    } finally {
      await other.cleanup();
    }
    await authDb.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId: project.owner.workspaceId,
          userId: project.owner.userId,
        },
      },
      data: { role: "viewer" },
    });
    await expect(
      run((tx) => acknowledgeReport(tx, project.owner, r.id, r.version)),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("does not invent precise counts when integer totals exceed the safe range", () => {
    const rows = ["2026-10-12", "2026-10-13"].map((date) => ({
      id: randomUUID(),
      version: 1,
      updatedAt: new Date(),
      data: {
        source: "synthetic",
        campaign: "same",
        periodStart: date + "T00:00:00Z",
        periodEnd: date + "T23:59:59Z",
        sessions: Number.MAX_SAFE_INTEGER,
      },
    }));
    expect(summarizeMetrics(rows)[0]).toMatchObject({
      sessions: null,
      complete: false,
    });
  });
  it("uses actual local weeks across daylight saving and rejects open/future periods", async () => {
    expect(
      reportWeek(new Date("2026-03-30T00:30:00Z"), "Europe/Berlin"),
    ).toMatchObject({ from: "2026-03-23", to: "2026-03-29" });
    await expect(
      run((tx) =>
        persistReport(tx, project.owner, {
          planId,
          from: week().from,
          to: new Date().toISOString().slice(0, 10),
        }),
      ),
    ).rejects.toThrow("REPORT_CLOSED_PERIOD_REQUIRED");
  });
  it("prepares opaque aggregate attribution links without overwriting an existing campaign", () => {
    expect(
      proposedAttributionUrl("https://example.invalid/?x=1", planId),
    ).toEqual({
      url: `https://example.invalid/?x=1&utm_source=orbit&utm_medium=organic_social&utm_campaign=${attributionCampaign(planId)}`,
      conflict: false,
    });
    expect(
      proposedAttributionUrl(
        "https://example.invalid/?utm_campaign=existing",
        planId,
      ),
    ).toMatchObject({ conflict: true });
  });
});
