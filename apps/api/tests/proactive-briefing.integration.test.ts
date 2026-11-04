import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { getConversation } from "../src/platform/assistant/chat.ts";
import { enqueue } from "../src/platform/jobs/enqueue.ts";
import { runBriefing } from "../src/platform/proactive/briefing.ts";
import { proactiveScheduler } from "../src/platform/proactive/scheduler.ts";
import {
  readPreferences,
  readState,
  savePreferences,
  slotsAround,
} from "../src/platform/proactive/preferences.ts";
import { BRIEFING_SUMMARIZER, ceilingCheck } from "../src/platform/proactive/summarizer.ts";
import { configHash, AgentConfig } from "../src/platform/agents/definitions/schema.ts";
import { finishWorkOrder } from "../src/platform/agents/work-orders/execute.ts";
import { weeklyReportTemplate, WEEKLY_REPORT_TEMPLATE } from "../src/modules/work/signals.ts";
import { registeredAgentTemplates } from "../src/platform/modules/contributions.ts";
import { proactiveFixture, type ProactiveFixture } from "./support/proactive-fixture.ts";

// Briefings and the report template (ADR 0023 item 8, plan WP4.4): local
// times across daylight saving, the personal-space scheduler, deterministic
// aggregation into the "Briefings" conversation, the opt-in AI summary
// only within its ceiling, and the weekly report template's results.

const provider = vi.hoisted(() => ({ calls: 0, summary: "real" as "real" | "ok" }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    provider.calls++;
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));
vi.mock("../src/platform/proactive/summarizer.ts", async (original) => {
  const actual = await original<typeof import("../src/platform/proactive/summarizer.ts")>();
  return {
    ...actual,
    summarizeBriefing: vi.fn(async (...args: Parameters<typeof actual.summarizeBriefing>) =>
      provider.summary === "ok"
        ? { status: "ok", output: { summary: "Two approvals wait in the synthetic project." }, agentRunId: null, costMicros: 900, sources: [] }
        : actual.summarizeBriefing(...args),
    ),
  };
});

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_NOTIFICATIONS: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_AGENT_PLATFORM: "true",
  ORBIT_WORK: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

describe("briefing slots across daylight saving (Europe/Berlin)", () => {
  it("keeps the local time when the clocks change", () => {
    // Before the spring change 08:00 is 07:00 UTC, after it 06:00 UTC.
    expect(slotsAround(new Date("2026-03-28T12:00:00Z"), "08:00", "Europe/Berlin")).toEqual({
      previous: new Date("2026-03-28T07:00:00Z"),
      next: new Date("2026-03-29T06:00:00Z"),
    });
    // In autumn it goes back to 07:00 UTC.
    expect(slotsAround(new Date("2026-10-24T12:00:00Z"), "08:00", "Europe/Berlin").next).toEqual(
      new Date("2026-10-25T07:00:00Z"),
    );
    // A time in the spring gap runs at the first valid minute after it.
    expect(slotsAround(new Date("2026-03-28T12:00:00Z"), "02:30", "Europe/Berlin").next).toEqual(
      new Date("2026-03-29T01:00:00Z"),
    );
    // A time that exists twice runs once, at its first occurrence.
    expect(slotsAround(new Date("2026-10-24T12:00:00Z"), "02:30", "Europe/Berlin").next).toEqual(
      new Date("2026-10-25T00:30:00Z"),
    );
  });

  it("skips weekends for a weekday briefing", () => {
    // Friday 13 Nov 2026 after 08:00 UTC: next is Monday 16 Nov.
    expect(slotsAround(new Date("2026-11-13T09:00:00Z"), "08:00", "UTC", "weekdays").next).toEqual(
      new Date("2026-11-16T08:00:00Z"),
    );
  });

  it("refuses a summary estimate above its USD 0.05 ceiling", async () => {
    const check = ceilingCheck({ micros: 0 });
    await check(null, null, 30_000);
    await expect(check(null, null, 30_000)).rejects.toMatchObject({ code: "BRIEFING_SUMMARY_CEILING" });
    expect(BRIEFING_SUMMARIZER.limits).toMatchObject({ maxModelCalls: 2, maxToolCalls: 4 });
  });
});

describe.skipIf(!enabled)("Briefings and the report template (ADR 0023)", () => {
  let f: ProactiveFixture;
  let personal: Scope;
  let projectId: string;

  const save = (scope: Scope, patch: Record<string, unknown>) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const { version, preferences } = await readPreferences(tx, scope);
      const briefing = { ...preferences.briefing, ...(patch.briefing as object) };
      return savePreferences(tx, scope, { version, ...patch, briefing });
    });
  async function briefingJob(scope: Scope, slot = new Date().toISOString()) {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      enqueue(tx, scope, "assistant_briefing", scope.projectId, `briefing:${slot}:${randomUUID()}`, new Date(), { slot }),
    );
    const jobs = await f.jobs(scope.projectId, "assistant_briefing");
    return jobs.at(-1)!.id;
  }
  const briefingNotices = async (scope: Scope) => {
    const { state } = await scoped(scope.workspaceId, scope.projectId, (tx) => readState(tx, scope));
    if (!state.briefingConversationId) return [];
    return (await getConversation(scope, state.briefingConversationId)).messages.filter((m) => m.role === "notice");
  };

  beforeAll(async () => {
    process.env.ORBIT_PROACTIVE = "true";
    f = await proactiveFixture("Synthetic briefing org");
    personal = await f.personal(f.owner);
    projectId = await f.project("Synthetic briefing project", []);
    // One approval the owner may decide.
    await scoped(f.workspaceId, projectId, (tx) =>
      tx.entity.create({
        data: {
          workspaceId: f.workspaceId,
          projectId,
          kind: "action_requests",
          data: {
            status: "pending",
            actionType: "platform.task.start",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            payload: {},
          },
        },
      }),
    );
  });
  beforeEach(() => {
    process.env.ORBIT_PROACTIVE = "true";
    provider.calls = 0;
    provider.summary = "real";
  });
  afterAll(async () => {
    delete process.env.ORBIT_PROACTIVE;
    await f?.cleanup();
    await closeDatabase();
  });

  it("queues one briefing per local slot and moves the due marker to the next one", async () => {
    await save(personal, { timeZone: "UTC", briefing: { enabled: true, time: "08:00", rhythm: "daily" } });
    const worker = f.worker(personal.projectId);
    const sweep = (at: string) =>
      scoped(f.workspaceId, personal.projectId, (tx) => proactiveScheduler.sweep(tx, worker, new Date(at)));
    // The first pass only records the current slot: nothing for the past.
    expect(await sweep("2026-11-10T09:00:00Z")).toEqual({ queued: 0 });
    expect(
      await scoped(f.workspaceId, personal.projectId, (tx) =>
        proactiveScheduler.nextDueAt(tx, worker, new Date("2026-11-10T09:00:00Z")),
      ),
    ).toEqual(new Date("2026-11-11T08:00:00Z"));
    expect(await sweep("2026-11-11T08:01:00Z")).toEqual({ queued: 1 });
    expect(await sweep("2026-11-11T08:30:00Z")).toEqual({ queued: 0 });
    const jobs = (await f.jobs(personal.projectId, "assistant_briefing")).filter(
      (j: Record<string, unknown>) => j.slot === "2026-11-11T08:00:00.000Z",
    );
    expect(jobs).toHaveLength(1);
  });

  it("writes a deterministic briefing with a card per project into the Briefings conversation, without a model call", async () => {
    await save(personal, { briefing: { enabled: true, aiSummary: false } });
    await runBriefing(f.worker(personal.projectId), await briefingJob(personal));
    const notices = await briefingNotices(personal);
    expect(notices).toHaveLength(1);
    const notice = notices[0]! as (typeof notices)[number] & { notice: { kind: string } };
    expect(notice.notice.kind).toBe("briefing");
    expect(notice.text).toContain("Synthetic briefing project: 1 approval to decide");
    expect(notice.cards.some((c) => (c as { projectId?: string }).projectId === projectId)).toBe(true);
    expect(provider.calls).toBe(0);
  });

  it("skips an empty briefing or says nothing new, as set", async () => {
    const loner = await f.user("loner");
    await f.addMember(loner, "viewer");
    const space = await f.personal(loner);
    await save(space, { briefing: { enabled: true, skipEmpty: true } });
    await runBriefing(f.worker(space.projectId), await briefingJob(space));
    expect(await briefingNotices(space)).toHaveLength(0);
    await save(space, { briefing: { enabled: true, skipEmpty: false } });
    await runBriefing(f.worker(space.projectId), await briefingJob(space));
    const notices = await briefingNotices(space);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Nothing new.");
  });

  it("runs the opt-in summary only within the cap: without one it is refused before sending, the briefing stands and a signal is raised", async () => {
    await save(personal, { briefing: { enabled: true, aiSummary: true } });
    const before = (await briefingNotices(personal)).length;
    await runBriefing(f.worker(personal.projectId), await briefingJob(personal));
    const notices = await briefingNotices(personal);
    expect(notices.length).toBe(before + 1);
    expect((notices.at(-1) as { notice: { kind: string } }).notice.kind).toBe("briefing");
    // No assistant cap: refused before anything reached a provider.
    expect(provider.calls).toBe(0);
    expect(await f.runSubscriber(personal.projectId, "platform.signal_briefing_summary_failed")).toBe(1);
    const failed = (await f.notices(personal.projectId, f.owner)).filter(
      (n) => n.kind === "assistant_briefing_summary_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.link).toBe("/assistant");
  });

  it("appends the summary as a second notice when the run succeeds", async () => {
    provider.summary = "ok";
    const before = (await briefingNotices(personal)).length;
    await runBriefing(f.worker(personal.projectId), await briefingJob(personal));
    const notices = await briefingNotices(personal);
    expect(notices.length).toBe(before + 2);
    const last = notices.at(-1) as (typeof notices)[number] & { notice: { kind: string } };
    expect(last.notice.kind).toBe("briefing_summary");
    expect(last.text).toBe("Two approvals wait in the synthetic project.");
  });

  it("stores a weekly report template run as a Work report and notifies its sponsor once", async () => {
    expect(registeredAgentTemplates().some((t) => t.key === WEEKLY_REPORT_TEMPLATE)).toBe(true);
    const workProject = await f.project("Synthetic report project", [[f.editor, "editor"]]);
    const scope = f.scopeOf(workProject, f.owner);
    await scoped(f.workspaceId, workProject, (tx) =>
      tx.projectModule.upsert({
        where: { workspaceId_projectId_moduleId: { workspaceId: f.workspaceId, projectId: workProject, moduleId: "work" } },
        create: { workspaceId: f.workspaceId, projectId: workProject, moduleId: "work", enabled: true, moduleVersion: "1.0.0", changedBy: f.owner },
        update: { enabled: true },
      }),
    );
    const config = AgentConfig.parse({ ...weeklyReportTemplate.defaults, templateKey: WEEKLY_REPORT_TEMPLATE });
    const agent = await scoped(f.workspaceId, workProject, (tx) =>
      tx.entity.create({
        data: {
          workspaceId: f.workspaceId,
          projectId: workProject,
          kind: "agent_definitions",
          data: {
            status: "active",
            active: config,
            draft: config,
            activation: { sponsorUserId: f.owner, activatedAt: new Date().toISOString(), version: 1, configHash: configHash(config) },
          } as object,
        },
      }),
    );
    const initiativeId = randomUUID();
    await scoped(f.workspaceId, workProject, (tx) =>
      tx.workInitiative.create({
        data: { id: initiativeId, workspaceId: f.workspaceId, projectId: workProject, key: "SYN", title: "Synthetic initiative", createdBy: f.owner, ownerUserId: f.editor },
      }),
    );
    const row = await scoped(f.workspaceId, workProject, (tx) =>
      tx.agentWorkOrder.create({
        data: {
          workspaceId: f.workspaceId,
          projectId: workProject,
          target: "agent",
          origin: "schedule",
          agentId: agent.id,
          sponsorUserId: f.owner,
          idempotencyKey: `test:${randomUUID()}`,
          requestedBy: { kind: "schedule" },
          allow: {},
          goal: "Weekly report",
          status: "running",
          ceilingMicros: BigInt(100_000),
          subjectType: "work.initiative",
          subjectId: initiativeId,
        },
      }),
    );
    await scoped(f.workspaceId, workProject, (tx) =>
      finishWorkOrder(tx, f.worker(workProject), row, {
        status: "succeeded",
        result: { outcome: "done", summary: "On track: 3 of 5 tasks done." },
      }),
    );
    expect(await f.runSubscriber(workProject, "work.weekly_report_results")).toBe(1);
    const reports = await scoped(f.workspaceId, workProject, (tx) =>
      tx.workPmReport.findMany({ where: { projectId: workProject, initiativeId } }),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "status_report", body: "On track: 3 of 5 tasks done." });
    expect(reports[0]!.data).toMatchObject({ source: WEEKLY_REPORT_TEMPLATE, workOrderId: row.id });
    for (const userId of [f.owner, f.editor]) {
      const rows = (await f.notices(workProject, userId)).filter((n) => n.kind === "work_pm_report");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe(`weekly_report:${row.id}`);
    }
    expect(provider.calls).toBe(0);
    void scope;
    void authDb;
  });
});
