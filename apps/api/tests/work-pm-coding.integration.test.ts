import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { linksOf } from "../src/platform/links/links.ts";
import { workAttention } from "../src/modules/work/attention.ts";
import { createTask, deleteTask } from "../src/modules/work/tasks.ts";
import {
  createCodingRun,
  editCodingBrief,
  expireCodingRuns,
  loadCodingRun,
  reportManualRun,
  runCodingDraftJob,
  submitCodingRun,
} from "../src/modules/work/pm/coding.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

const mocked = vi.hoisted(() => ({ replies: [] as unknown[] }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    return {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(next) }] }],
      usage: { model: request.route.model, inputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0, costMicros: 5_000 },
      responseId: "resp_pm_coding",
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const brief = {
  goal: "Add a fee column to listings",
  // The fake token is split so the repository secret scan does not flag it.
  description: "Reported by jane.doe@example.org; staging token ghp_" + "abcdefghijklmnopqrstuvwxyz123456 works.",
  acceptanceCriteria: ["Listings show the fee", "Tests cover the fee"],
};

/** Coding work orders with the manual provider (WP2.8). */
describe.skipIf(!enabled)("AI project manager coding work orders", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const task = (title: string) => p.run((tx) => createTask(tx, p.owner, { title }, p.as(p.owner)));
  const run = (id: string) => p.run((tx) => loadCodingRun(tx, p.owner, id));
  const decide = (who: Scope, requestId: string) =>
    p.run(async (tx) => {
      const row = await entity(tx, who, "action_requests", requestId);
      return decideActionRequest(tx, who, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
  /** A reviewed draft submitted and approved by the owner. */
  const dispatched = async (taskId: string) => {
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, taskId, { repositoryKey: "orbit", brief }));
    const reviewed = await p.run((tx) => editCodingBrief(tx, p.editor, draft.id, { expectedVersion: draft.version, personalDataReviewed: true }));
    const submitted = await p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: reviewed.version }));
    await decide(p.owner, submitted.actionRequestId!);
    return run(draft.id);
  };

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) =>
      savePmSettings(
        tx,
        p.owner,
        {
          ...current.settings,
          codingMaxConcurrent: 2,
          repositories: [
            { key: "orbit", label: "Orbit", provider: "github", fullName: "eds-labs/eds-orbit", defaultBranch: "main", dispatch: { kind: "manual" } },
          ],
        },
        current.version,
      ),
    );
  });
  beforeEach(() => {
    mocked.replies.length = 0;
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("redacts the brief, needs a review and the owner's approval, then dispatches by hand", async () => {
    const t = await task("Fee column");
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, t.id, { repositoryKey: "orbit", brief }));
    expect(draft).toMatchObject({ status: "draft", provider: "manual", ceilingMicros: 0n });
    expect(draft.sanitization).toEqual({ email: 1, secret: 1 });
    expect(JSON.stringify(draft.brief)).not.toMatch(/jane\.doe|ghp_/);
    expect(await failure(p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: draft.version })))).toBe(
      "WORK_CODING_REVIEW_REQUIRED",
    );
    const reviewed = await p.run((tx) => editCodingBrief(tx, p.editor, draft.id, { expectedVersion: draft.version, personalDataReviewed: true }));
    const submitted = await p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: reviewed.version }));
    expect(submitted.status).toBe("awaiting_approval");
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", submitted.actionRequestId!));
    expect(data(request).actionType).toBe("work.coding.dispatch");
    expect(await failure(decide(p.editor, submitted.actionRequestId!))).toBe("OWNER_REQUIRED");
    await decide(p.owner, submitted.actionRequestId!);
    const out = await run(draft.id);
    expect(out.status).toBe("dispatched");
    expect(out.timeoutAt!.getTime() - out.dispatchedAt!.getTime()).toBe(24 * 3_600_000);
    const links = await p.run((tx) => linksOf(tx, p.editor, { type: "work.task", id: t.id }));
    expect(links.map((l) => [l.relation, l.object.type])).toEqual([["delegated_to", "work.coding_run"]]);
    // One active run per task.
    const second = await p.run((tx) => createCodingRun(tx, p.editor, t.id, { repositoryKey: "orbit", brief }));
    const marked = await p.run((tx) => editCodingBrief(tx, p.editor, second.id, { expectedVersion: second.version, personalDataReviewed: true }));
    expect(await failure(p.run((tx) => submitCodingRun(tx, p.editor, second.id, { expectedVersion: marked.version })))).toBe(
      "WORK_CODING_RUN_ACTIVE",
    );
  });

  it("records the developer's progress, moves the task to review, never to done", async () => {
    const t = await task("Fee tests");
    let row = await dispatched(t.id);
    row = await p.run((tx) => reportManualRun(tx, p.editor, row.id, { expectedVersion: row.version, status: "running", branch: "feat/fees" }));
    expect((await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: t.id } }))).statusCategory).toBe("in_progress");
    expect(
      await failure(
        p.run((tx) => reportManualRun(tx, p.editor, row.id, { expectedVersion: row.version, prUrl: "https://github.com/other/repo/pull/3" })),
      ),
    ).toBe("WORK_CODING_PR_URL_INVALID");
    row = await p.run((tx) =>
      reportManualRun(tx, p.editor, row.id, {
        expectedVersion: row.version,
        status: "succeeded",
        prUrl: "https://github.com/eds-labs/eds-orbit/pull/321",
        commitSha: "abc1234",
        tests: { passed: 40, failed: 0, skipped: 1 },
      }),
    );
    expect(row).toMatchObject({ status: "succeeded", prNumber: 321 });
    expect((await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: t.id } }))).statusCategory).toBe("in_review");
    expect(
      await failure(p.run((tx) => reportManualRun(tx, p.editor, row.id, { expectedVersion: row.version, status: "running" }))),
    ).toBe("WORK_CODING_RUN_CLOSED");
    // The record of the dispatch stays: the task can be archived, not deleted.
    expect(await failure(p.run((tx) => deleteTask(tx, p.owner, t.id, true, p.as(p.owner))))).toBe("WORK_TASK_HAS_CODING_RUNS");
  });

  it("limits concurrent runs and marks silent runs as unknown", async () => {
    const t = await task("Silent run");
    const row = await dispatched(t.id);
    const other = await task("Waiting run");
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, other.id, { repositoryKey: "orbit", brief }));
    const marked = await p.run((tx) => editCodingBrief(tx, p.editor, draft.id, { expectedVersion: draft.version, personalDataReviewed: true }));
    // Two runs are open (this one and the first test's): the limit is two.
    expect(await failure(p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: marked.version })))).toBe(
      "WORK_CODING_CONCURRENCY",
    );
    await p.run((tx) => tx.workCodingRun.update({ where: { id: row.id }, data: { timeoutAt: new Date(Date.now() - 1000) } }));
    expect(await p.run((tx) => expireCodingRuns(tx, p.owner))).toBeGreaterThanOrEqual(1);
    expect(await run(row.id)).toMatchObject({ status: "outcome_unknown", errorCode: "WORK_CODING_TIMEOUT" });
    const items = await p.run((tx) => workAttention(tx, p.editor, new Date()));
    expect(items.find((i) => i.kind === "work_coding_unknown")).toMatchObject({ severity: "warning" });
  });

  it("lets the PM draft a brief, redacted like any other", async () => {
    const t = await task("Draft me");
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, t.id, { repositoryKey: "orbit", aiDraft: true }));
    mocked.replies.push({
      goal: "Show the fee on listings",
      description: "Ask max@example.org for details.",
      acceptanceCriteria: ["Fee visible"],
      constraints: ["Keep the API stable"],
      doNotTouch: ["packages/db"],
      testExpectations: "pnpm test",
    });
    await runCodingDraftJob(p.owner, draft.id);
    const drafted = await run(draft.id);
    expect(drafted).toMatchObject({ briefRevision: 2, personalDataReviewed: false, sanitization: { email: 1 } });
    expect(JSON.stringify(drafted.brief)).not.toContain("max@example.org");
  });
});
