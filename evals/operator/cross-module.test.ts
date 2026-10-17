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
import { closeDatabase, scoped } from "../../packages/db/src/index.ts";
import type { Scope } from "../../packages/schemas/src/index.ts";

// Offline only: the model is replaced by recorded steps; no network call is made.
const replay = vi.hoisted(() => ({
  steps: [] as unknown[],
  calls: 0,
  inputs: [] as unknown[],
  tools: [] as Array<{ name: string }>,
}));
vi.mock("../../packages/ai/src/index.ts", async (original) => {
  const actual =
    await original<typeof import("../../packages/ai/src/index.ts")>();
  const { streamEvents } = await import("./harness.ts");
  return {
    ...actual,
    embed: vi.fn(async () => ({
      vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 10,
        outputTokens: 0,
        costMicros: 1,
      },
    })),
    streamChat: vi.fn(
      async (request: { input: unknown; tools: Array<{ name: string }> }) => {
        const index = replay.calls++;
        replay.inputs.push(request.input);
        replay.tools = request.tools;
        const recorded = replay.steps[index];
        if (!recorded) throw new Error("EVAL_STEP_MISSING");
        const events = streamEvents(recorded as never, index, "Europe/Berlin");
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        };
      },
    ),
  };
});
import { data, list } from "../../apps/api/src/shared.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../../apps/api/src/modules/chat.ts";
import { runChat } from "../../apps/api/src/modules/chat-runner.ts";
import {
  moduleRegistry,
  registerModules,
  registerTestModules,
} from "../../apps/api/src/modules/registry.ts";
import { setModuleEnabled } from "../../apps/api/src/platform/modules/activation.ts";
import { tasksFixture } from "../../apps/api/tests/fixtures/modules/tasks/contributions.ts";
import { createPackageProject } from "../../apps/api/tests/support/package-project.ts";
import { loadCases, toolErrorCodes, type OperatorCase } from "./harness.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The test-only third module joins the registry (WP4.1); v1 and v2 run without it.
registerTestModules([tasksFixture]);
registerModules();
afterAll(async () => {
  await closeDatabase();
});

const dataset = loadCases("evals/operator/cases-v3.json");

/**
 * Cross-module operator eval (WP4.4): recorded model steps through the real
 * chat runner with knowledge, marketing and the fixture module registered.
 * Checks tool choice across modules, tool sets filtered by role and module
 * activation, and one ActionRequest per write.
 */
describe.skipIf(!enabled)(
  `Cross-module operator eval (cases-v3, ${dataset.hash})`,
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const count = (kind: string) =>
      run((tx) => tx.entity.count({ where: { kind } }));
    const requestsByType = async () => {
      const counts: Record<string, number> = {};
      for (const row of await run((tx) =>
        list(tx, project.owner, "action_requests"),
      ))
        counts[data(row).actionType] = (counts[data(row).actionType] ?? 0) + 1;
      return counts;
    };
    beforeEach(async () => {
      project = await createPackageProject();
    });
    afterEach(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      delete process.env.ORBIT_MODULES;
      await project.cleanup();
    });

    it.each(dataset.cases.map((c) => [c.id, c] as const))(
      "%s",
      async (_id, testCase: OperatorCase) => {
        process.env.ORBIT_CONTENT_PACKAGES = testCase.contentPackages
          ? "true"
          : "false";
        if (testCase.disabledModules?.length) {
          process.env.ORBIT_MODULES = "true";
          for (const id of testCase.disabledModules)
            await run((tx) =>
              setModuleEnabled(tx, project.owner, moduleRegistry(), id, false),
            );
        }
        const scope: Scope = {
          owner: project.owner,
          editor: project.editor,
          viewer: project.viewer,
        }[testCase.role];
        replay.steps = testCase.steps;
        replay.calls = 0;
        replay.inputs = [];
        const missionsBefore = await count("missions");
        const publicationsBefore = await count("publications");
        const requestsBefore = await requestsByType();
        const thread = await createConversation(scope);
        const sent = await sendMessage(scope, thread.id, {
          text: testCase.input,
          clientRequestId: randomUUID(),
        });
        await runChat(scope, sent.runId);

        const checks = testCase.checks;
        expect((await getRun(scope, sent.runId)).status).toBe(checks.runStatus);
        expect(replay.calls).toBe(testCase.steps.length);
        expect(
          toolErrorCodes(replay.inputs[replay.inputs.length - 1]).sort(),
        ).toEqual([...checks.toolErrors].sort());
        const offered = replay.tools.map((tool) => tool.name);
        if (checks.offeredExact) expect(offered).toEqual(checks.offeredExact);
        for (const name of checks.offeredIncludes ?? [])
          expect(offered).toContain(name);
        for (const name of checks.offeredExcludes ?? [])
          expect(offered).not.toContain(name);
        // Marketing contributes the packages section; without it there is none.
        const packages =
          (await getConversation(scope, thread.id)).packages ?? [];
        expect(packages).toHaveLength(checks.packages);
        expect((await count("missions")) - missionsBefore).toBe(
          checks.missions,
        );
        expect((await count("publications")) - publicationsBefore).toBe(
          checks.publications,
        );
        const requestsAfter = await requestsByType();
        for (const [type, expected] of Object.entries(
          checks.actionRequests ?? {},
        ))
          expect(
            (requestsAfter[type] ?? 0) - (requestsBefore[type] ?? 0),
            type,
          ).toBe(expected);
        // Proposals wait for a decision: no fixture task exists after a run.
        expect(await count("fixture_tasks")).toBe(0);
      },
    );
  },
);
