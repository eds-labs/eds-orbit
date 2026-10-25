import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  bindWorkflow,
  createConnection,
  grantConnection,
} from "../src/platform/administration/connections.ts";
import {
  receiveCallback,
  setAutomationFetchForTests,
  signAutomationBody,
} from "../src/platform/automation/workflows.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import {
  createCodingRun,
  editCodingBrief,
  loadCodingRun,
  submitCodingRun,
} from "../src/modules/work/pm/coding.ts";
import { runCodingDispatchJob } from "../src/modules/work/pm/coding-dispatch.ts";
import { readPmSettings, savePmSettings } from "../src/modules/work/pm/settings.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const SIGNING = randomBytes(32).toString("hex");
const brief = {
  goal: "Add a fee column",
  description: "Ping ops@example.org when done.",
  acceptanceCriteria: ["Fee visible"],
};

/** Coding dispatch through n8n and its signed callback results (WP2.9), against a fake endpoint. */
describe.skipIf(!enabled)("AI project manager coding dispatch through automation", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({
    ORBIT_WORK: "true",
    ORBIT_WORK_PM: "true",
    ORBIT_CONNECTIONS: "true",
    ORBIT_ADMINISTRATION: "true",
    EXECUTION_MODE: "live",
    ENABLE_EXTERNAL_WRITES: "true",
  });
  const sent: Array<{ url: string; body: any }> = [];
  let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ executionId: 99 }), { status: 200 });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const decide = (who: Scope, requestId: string) =>
    p.run(async (tx) => {
      const row = await entity(tx, who, "action_requests", requestId);
      return decideActionRequest(tx, who, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
  const approved = async (ceilingMicros = 1_000_000) => {
    const t = await p.run((tx) => createTask(tx, p.owner, { title: "Fees" }, p.as(p.owner)));
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, t.id, { repositoryKey: "orbit", brief, ceilingMicros }));
    const reviewed = await p.run((tx) => editCodingBrief(tx, p.editor, draft.id, { expectedVersion: draft.version, personalDataReviewed: true }));
    const submitted = await p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: reviewed.version }));
    await decide(p.owner, submitted.actionRequestId!);
    return { taskId: t.id, runId: draft.id };
  };
  const coding = (id: string) => p.run((tx) => loadCodingRun(tx, p.owner, id));
  const callback = (automationRunId: string, body: object) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return receiveCallback(
      p.owner.projectId,
      automationRunId,
      { "x-orbit-timestamp": ts, "x-orbit-signature": signAutomationBody(SIGNING, ts, raw) },
      raw,
    );
  };

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    const actor = { userId: p.owner.userId, role: "owner" as const, workspaceId: p.owner.workspaceId };
    const connection = await createConnection(actor, {
      provider: "n8n",
      label: "Company n8n",
      config: { baseUrl: "https://n8n.example.invalid" },
      secret: JSON.stringify({ apiKey: `n8n-${randomBytes(8).toString("hex")}`, signingSecret: SIGNING }),
    });
    const binding = await bindWorkflow(actor, connection.id, {
      contract: "automation.v1",
      workflowRef: "orbit/coding-agent",
      label: "Coding agent",
    });
    await grantConnection(actor, connection.id, { projectId: p.owner.projectId, purposes: ["automation"] });
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) =>
      savePmSettings(
        tx,
        p.owner,
        {
          ...current.settings,
          codingMonthlyCeilingMicros: 2_500_000,
          repositories: [
            {
              key: "orbit",
              label: "Orbit",
              provider: "github",
              fullName: "eds-labs/eds-orbit",
              defaultBranch: "main",
              dispatch: { kind: "automation", bindingId: binding.id },
            },
          ],
        },
        current.version,
      ),
    );
    setAutomationFetchForTests(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return answer();
    });
  });
  beforeEach(() => {
    sent.length = 0;
    answer = async () => new Response(JSON.stringify({ executionId: 99 }), { status: 200 });
  });
  afterAll(async () => {
    setAutomationFetchForTests(null);
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("sends the approved, redacted brief once and follows the signed results", async () => {
    const { taskId, runId } = await approved();
    expect((await coding(runId)).status).toBe("dispatching");
    await runCodingDispatchJob(p.owner, runId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://n8n.example.invalid/webhook/orbit/coding-agent");
    expect(sent[0]!.body).toMatchObject({
      contract: "automation.v1",
      event: "coding_agent.requested",
      payload: { codingRunId: runId, repository: "eds-labs/eds-orbit", baseBranch: "main", ceilingMicros: 1_000_000 },
    });
    expect(JSON.stringify(sent[0]!.body)).not.toContain("ops@example.org");
    const dispatched = await coding(runId);
    expect(dispatched).toMatchObject({ status: "dispatched", externalRef: "99" });
    // A repeated job sends nothing.
    await runCodingDispatchJob(p.owner, runId);
    expect(sent).toHaveLength(1);

    const automationRunId = dispatched.automationRunId!;
    await callback(automationRunId, { status: "running", result: { status: "started", branch: "agent/fees" } });
    expect(await coding(runId)).toMatchObject({ status: "running", branch: "agent/fees" });
    expect((await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: taskId } }))).statusCategory).toBe("in_progress");
    // Unknown fields and pull requests of other repositories are refused.
    expect(await failure(callback(automationRunId, { status: "running", result: { status: "started", shell: "rm -rf" } }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      await failure(
        callback(automationRunId, { status: "completed", result: { status: "succeeded", prUrl: "https://github.com/evil/repo/pull/1" } }),
      ),
    ).toBe("WORK_CODING_PR_URL_INVALID");
    await callback(automationRunId, {
      status: "completed",
      result: {
        status: "succeeded",
        prUrl: "https://github.com/eds-labs/eds-orbit/pull/77",
        tests: { passed: 12, failed: 0, skipped: 0 },
        reportedCostMicros: 1_500_000,
        summary: "Added the column.",
      },
    });
    expect(await coding(runId)).toMatchObject({ status: "succeeded", prNumber: 77, reportedCostMicros: 1_500_000n });
    expect((await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: taskId } }))).statusCategory).toBe("in_review");
    // A replay after the end changes nothing.
    expect(await callback(automationRunId, { status: "running", result: { status: "started" } })).toEqual({
      accepted: true,
      unchanged: true,
    });
  });

  it("keeps an unclear send unknown and the monthly coding budget", async () => {
    answer = async () => {
      throw new Error("socket hang up");
    };
    const { runId } = await approved(500_000);
    await runCodingDispatchJob(p.owner, runId);
    expect(await coding(runId)).toMatchObject({ status: "outcome_unknown", errorCode: "NO_ANSWER" });
    expect(sent).toHaveLength(1);
    // 1.5 reported + 0.5 unknown + 1.0 more would pass the 2.5 USD ceiling.
    const t = await p.run((tx) => createTask(tx, p.owner, { title: "Over budget" }, p.as(p.owner)));
    const draft = await p.run((tx) => createCodingRun(tx, p.editor, t.id, { repositoryKey: "orbit", brief, ceilingMicros: 1_000_000 }));
    const reviewed = await p.run((tx) => editCodingBrief(tx, p.editor, draft.id, { expectedVersion: draft.version, personalDataReviewed: true }));
    expect(await failure(p.run((tx) => submitCodingRun(tx, p.editor, draft.id, { expectedVersion: reviewed.version })))).toBe(
      "WORK_CODING_BUDGET_EXHAUSTED",
    );
  });
});
