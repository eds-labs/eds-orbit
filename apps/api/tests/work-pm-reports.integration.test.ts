import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { workAttention } from "../src/modules/work/attention.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { createTask, updateTask } from "../src/modules/work/tasks.ts";
import { requestAnalysis, runAnalysisJob } from "../src/modules/work/pm/analyst.ts";
import { loadProposal } from "../src/modules/work/pm/planner.ts";
import { requestReport, runReportJob } from "../src/modules/work/pm/reporter.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { setPmState } from "../src/modules/work/pm/state.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

const mocked = vi.hoisted(() => ({ replies: [] as unknown[], calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.calls++;
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    return {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(next) }] }],
      usage: {
        model: request.route.model,
        inputTokens: 800,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 600,
        reasoningTokens: 0,
        costMicros: 20_000,
      },
      responseId: "resp_pm_report",
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const report = {
  summary: "Two of three tasks are open; #2 is late.",
  health: "at_risk",
  risks: [{ text: "Launch slips by a week", severity: "medium" }],
  nextSteps: ["Finish #2", "Review #3"],
};

/** Status reports and re-prioritization proposals (WP2.5), with a scripted model. */
describe.skipIf(!enabled)("AI project manager reports and analyses", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  let initiativeId = "";
  const tasks: Array<{ id: string; number: number; version: number }> = [];
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const reports = () => p.run((tx) => tx.workPmReport.findMany({ where: { projectId: p.owner.projectId } }));

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    const initiative = await p.run((tx) =>
      createInitiative(tx, p.owner, { title: "Reported", ownerUserId: p.editor.userId }, p.as(p.owner)),
    );
    initiativeId = initiative.id;
    await p.run((tx) => setPmState(tx, p.owner, initiativeId, { expectedVersion: 0, enabled: true }));
    for (const title of ["First", "Second", "Third"])
      tasks.push(await p.run((tx) => createTask(tx, p.owner, { initiativeId, title }, p.as(p.owner))));
  });
  beforeEach(() => {
    mocked.replies.length = 0;
    mocked.calls = 0;
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("writes a report once per state and labels it as generated", async () => {
    expect(await p.run((tx) => requestReport(tx, p.editor, initiativeId))).toEqual({ status: "queued", report: null });
    mocked.replies.push(report);
    expect(await runReportJob(p.owner, initiativeId, { requestedBy: p.editor.userId })).toMatchObject({ status: "created" });
    const [row] = await reports();
    expect(row!.body).toContain("**At risk**");
    expect(row!.body).toContain("- Finish #2");
    expect(row).toMatchObject({ kind: "status_report", costMicros: 20_000n, publishedTo: [p.editor.userId] });
    // Unchanged state: the latest report, no new job or call.
    expect(await p.run((tx) => requestReport(tx, p.editor, initiativeId))).toMatchObject({
      status: "unchanged",
      report: { id: row!.id, generated: true },
    });
    expect(await runReportJob(p.owner, initiativeId, {})).toEqual({ status: "skipped" });
    expect(mocked.calls).toBe(1);
    // A change makes a new report possible.
    const first = tasks[0]!;
    await p.run((tx) => updateTask(tx, p.owner, first.id, { expectedVersion: first.version, status: "done" }, p.as(p.owner)));
    expect((await p.run((tx) => requestReport(tx, p.editor, initiativeId))).status).toBe("queued");
  });

  it("proposes task changes an editor applies once, bound to their versions", async () => {
    const [, second, third] = tasks;
    const result = await p.run((tx) => requestAnalysis(tx, p.editor, initiativeId));
    mocked.replies.push({
      rationale: "Pull the late work forward.",
      changes: [
        { taskNumber: second!.number, priority: "high", dueDate: null, assigneeUserId: p.editor.userId, reason: "Late" },
        { taskNumber: third!.number, priority: null, dueDate: null, assigneeUserId: p.viewer.userId, reason: "Help" },
        { taskNumber: 99_999, priority: "low", dueDate: null, assigneeUserId: null, reason: "Unknown" },
      ],
    });
    await runAnalysisJob(p.owner, result!.proposal.id);
    const proposed = await p.run((tx) => loadProposal(tx, p.owner, result!.proposal.id));
    expect(proposed).toMatchObject({ kind: "adjustment", status: "proposed" });
    expect((proposed.validation as { warnings: string[] }).warnings).toEqual([
      `assignee_dropped:${third!.number}`,
      `no_change:${third!.number}`,
      "task_unknown:99999",
    ]);
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", proposed.actionRequestId!));
    expect(data(request).actionType).toBe("work.tasks.bulk_update");
    await p.run((tx) =>
      decideActionRequest(tx, p.editor, request.id, { version: request.version, packageHash: data(request).packageHash, decision: "approve" }),
    );
    const changed = await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: second!.id } }));
    expect(changed).toMatchObject({ priority: "high", assigneeUserId: p.editor.userId });
    expect(await p.run((tx) => loadProposal(tx, p.owner, proposed.id))).toMatchObject({ status: "applied" });
  });

  it("refuses an analysis whose tasks changed meanwhile", async () => {
    const third = await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: tasks[2]!.id } }));
    const result = await p.run((tx) => requestAnalysis(tx, p.editor, initiativeId));
    mocked.replies.push({
      rationale: "Raise it.",
      changes: [{ taskNumber: third.number, priority: "urgent", dueDate: null, assigneeUserId: null, reason: "Risk" }],
    });
    await runAnalysisJob(p.owner, result!.proposal.id);
    const proposed = await p.run((tx) => loadProposal(tx, p.owner, result!.proposal.id));
    await p.run((tx) => updateTask(tx, p.owner, third.id, { expectedVersion: third.version, title: "Renamed" }, p.as(p.owner)));
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", proposed.actionRequestId!));
    expect(
      await failure(
        p.run((tx) =>
          decideActionRequest(tx, p.editor, request.id, { version: request.version, packageHash: data(request).packageHash, decision: "approve" }),
        ),
      ),
    ).toBe("WORK_PROPOSAL_OUTDATED");
  });

  it("asks the analyst automatically at most once a day and stops at the daily budget", async () => {
    // The analyses above count for the reported initiative: none today.
    expect(await p.run((tx) => requestAnalysis(tx, p.owner, initiativeId, { automatic: true }))).toBeNull();
    const fresh = await p.run((tx) => createInitiative(tx, p.owner, { title: "Fresh" }, p.as(p.owner)));
    await p.run((tx) => setPmState(tx, p.owner, fresh.id, { expectedVersion: 0, enabled: true }));
    const first = await p.run((tx) => requestAnalysis(tx, p.owner, fresh.id, { automatic: true }));
    expect(first).toMatchObject({ deduplicated: false, proposal: { requestedVia: "monitor", requestedBy: "system" } });
    expect(await p.run((tx) => requestAnalysis(tx, p.owner, fresh.id, { automatic: true }))).toMatchObject({
      deduplicated: true,
    });
    // The budget is spent: requests are refused, and the members see it.
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) => savePmSettings(tx, p.owner, { ...current.settings, dailyCeilingMicros: 20_000 }, current.version));
    expect(await failure(p.run((tx) => requestReport(tx, p.editor, initiativeId)))).toBe("WORK_PM_BUDGET_EXHAUSTED");
    const items = await p.run((tx) => workAttention(tx, p.editor, new Date()));
    expect(items.map((i) => i.kind)).toContain("work_pm_budget");
    // A queued report stops before any call.
    expect(await runReportJob(p.owner, initiativeId, {})).toMatchObject({
      status: "blocked",
      code: "WORK_PM_BUDGET_EXHAUSTED",
    });
    expect(mocked.calls).toBe(0);
  });
});
