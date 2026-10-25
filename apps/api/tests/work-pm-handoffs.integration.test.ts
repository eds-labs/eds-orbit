import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { ServerModule } from "../../../packages/module-contracts/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules, registerTestModules } from "../src/modules/registry.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { eventJob } from "../src/platform/events/events.ts";
import { availableHandoffs } from "../src/platform/handoffs/handoffs.ts";
import { linksOf } from "../src/platform/links/links.ts";
import { registeredHandoff } from "../src/platform/modules/contributions.ts";
import { permission } from "../src/platform/tenancy/permissions.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { createTask } from "../src/modules/work/tasks.ts";
import { proposeHandoff } from "../src/modules/work/pm/handoffs.ts";
import { runHandoffJob } from "../src/modules/work/pm/research.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

// A paid target of a test-only module: the owner decides every time.
const DRAFTS = permission("fixturepay.drafts", "Order paid drafts", ["owner", "editor"]);
const paid: ServerModule = {
  id: "fixturepay",
  version: "1.0.0",
  displayName: { en: "Fixture", de: "Fixture" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [],
  tables: [],
  permissions: [DRAFTS],
};
registerTestModules([
  {
    module: paid,
    contributions: {
      handoffs: {
        drafts: {
          label: { en: "Paid drafts", de: "Bezahlte Entwürfe" },
          permission: DRAFTS,
          risk: "P_proposal",
          input: z.object({ brief: z.string() }).strict(),
          costCeilingMicros: () => 500_000,
          async create(_tx, _scope, _from, _input, _actor, handoffId) {
            return { target: { type: "work.handoff", id: handoffId } };
          },
        },
      },
    },
  },
]);
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
        inputTokens: 500,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 300,
        reasoningTokens: 0,
        costMicros: 9_000,
      },
      responseId: "resp_pm_handoff",
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** Handoffs to the PM's research and to another module's paid target (WP2.7). */
describe.skipIf(!enabled)("AI project manager handoffs", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  let initiativeId = "";
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
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
  /** Delivers queued events to the handoff subscriber, as the worker does. */
  const deliver = async () => {
    const jobs = await p.run((tx) =>
      tx.entity.findMany({
        where: {
          projectId: p.owner.projectId,
          kind: "jobs",
          AND: [
            { data: { path: ["subscriber"], equals: "work.handoff_sync" } },
            { data: { path: ["status"], equals: "queued" } },
          ],
        },
        orderBy: { createdAt: "asc" },
      }),
    );
    for (const job of jobs) {
      await eventJob.handler({ scope: { ...p.owner, userId: "worker" }, jobId: job.id, job: data(job), executionMode: "test" });
      await p.run((tx) => tx.entity.update({ where: { id: job.id }, data: { data: { ...data(job), status: "done" } } }));
    }
  };
  const task = (title: string) =>
    p.run((tx) => createTask(tx, p.owner, { initiativeId, title }, p.as(p.owner)));
  const category = (id: string) =>
    p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id } })).then((t) => t.statusCategory);

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    initiativeId = (await p.run((tx) => createInitiative(tx, p.owner, { title: "Handoffs" }, p.as(p.owner)))).id;
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

  it("lists the targets a member may hand off to", async () => {
    expect(registeredHandoff("work.research")?.risk).toBe("W0_internal");
    const keys = async (who: Scope) => (await p.run((tx) => availableHandoffs(tx, who))).map((t) => t.key).sort();
    expect(await keys(p.editor)).toEqual(["fixturepay.drafts", "work.analysis", "work.research"]);
    expect(await keys(p.viewer)).toEqual([]);
  });

  it("hands a task to research after an editor approves and moves it forward, never to done", async () => {
    const t = await task("Compare listing fees");
    expect(await failure(p.run((tx) => proposeHandoff(tx, p.viewer, t.id, { target: "work.research", input: { question: "Fees?" } })))).toBe(
      "FORBIDDEN",
    );
    const handoff = await p.run((tx) =>
      proposeHandoff(tx, p.editor, t.id, { target: "work.research", input: { question: "Which listing fees do competitors charge?", web: true } }),
    );
    expect(handoff.status).toBe("awaiting_approval");
    expect(
      await failure(p.run((tx) => proposeHandoff(tx, p.editor, t.id, { target: "work.research", input: { question: "Again?" } }))),
    ).toBe("WORK_HANDOFF_ACTIVE");
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", handoff.actionRequestId!));
    expect(data(request).actionType).toBe("work.handoff");
    await decide(p.editor, handoff.actionRequestId!);
    const running = await p.run((tx) => tx.workHandoff.findFirstOrThrow({ where: { id: handoff.id } }));
    expect(running).toMatchObject({ status: "running", targetType: "work.handoff", targetId: handoff.id });
    const links = await p.run((tx) => linksOf(tx, p.editor, { type: "work.task", id: t.id }));
    expect(links.map((l) => [l.relation, l.object.type, l.object.title])).toEqual([["delegated_to", "work.handoff", "AI research"]]);
    expect((await p.run((tx) => tx.workTask.findFirstOrThrow({ where: { id: t.id } }))).assigneeAgentKey).toBe("work.research");

    // Web search stays off: the initiative's research mode is not `web`.
    mocked.replies.push({
      summary: "Fees range from 2 to 5 %.",
      findings: [{ text: "Market A charges 5 %.", sourceUrls: ["https://example.org/fees"] }],
    });
    await runHandoffJob(p.owner, handoff.id, "research");
    await deliver();
    expect(await category(t.id)).toBe("in_review");
    const comments = await p.run((tx) => tx.workComment.findMany({ where: { taskId: t.id } }));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorKind: "agent", authorUserId: null });
    expect(comments[0]!.bodyText).toContain("AI research");
    // An URL no search of the run returned is never shown.
    expect(comments[0]!.bodyText).not.toContain("example.org");
    const finished = await p.run((tx) => tx.workHandoff.findFirstOrThrow({ where: { id: handoff.id } }));
    expect(finished).toMatchObject({ status: "finished", result: { sources: 0, droppedSources: 1 } });
    expect(mocked.calls).toBe(1);
  });

  it("asks the owner for a paid target", async () => {
    const t = await task("Draft the announcement");
    const handoff = await p.run((tx) => proposeHandoff(tx, p.editor, t.id, { target: "fixturepay.drafts", input: { brief: "Short" } }));
    const request = await p.run((tx) => entity(tx, p.owner, "action_requests", handoff.actionRequestId!));
    expect(data(request)).toMatchObject({ actionType: "work.handoff_owner", costCeilingMicros: 500_000 });
    expect(await failure(decide(p.editor, handoff.actionRequestId!))).toBe("OWNER_REQUIRED");
    await decide(p.owner, handoff.actionRequestId!);
    expect((await p.run((tx) => tx.workHandoff.findFirstOrThrow({ where: { id: handoff.id } }))).status).toBe("running");
  });
});
