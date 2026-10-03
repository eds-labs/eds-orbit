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
import { ingest } from "../../packages/knowledge/src/index.ts";

// Offline only: the model is replaced by recorded steps; no network call is made.
const replay = vi.hoisted(() => ({
  steps: [] as unknown[],
  timezone: "Europe/Berlin",
  vars: {} as Record<string, string>,
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
      vectors: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
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
        const events = streamEvents(
          recorded as never,
          index,
          replay.timezone,
          replay.vars,
        );
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        };
      },
    ),
  };
});
import { create, data, entity, list } from "../../apps/api/src/shared.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../../apps/api/src/modules/chat.ts";
import { runChat } from "../../apps/api/src/modules/chat-runner.ts";
import { decideActionRequest } from "../../apps/api/src/modules/action-requests.ts";
import { deterministicDraft } from "../../apps/api/src/modules/workflow.ts";
import { sweepProject } from "../../apps/api/src/modules/lifecycle.ts";
import { requestContentPackage } from "../../apps/api/src/modules/agents/content-packages.ts";
import { channelSlots } from "../../apps/api/src/modules/agents/scheduling.ts";
import {
  createPackageProject,
  X,
} from "../../apps/api/tests/support/package-project.ts";
import {
  loadCases,
  toolErrorCodes,
  toolOutputs,
  type OperatorCase,
} from "./harness.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
afterAll(async () => {
  await closeDatabase();
});

const datasets = ["cases-v1", "cases-v2"].map((name) => ({
  name,
  ...loadCases(`evals/operator/${name}.json`),
}));

describe.skipIf(!enabled).each(datasets)(
  "Orbit Core operator eval ($name, $hash)",
  ({ cases }) => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const scopes = () =>
      ({
        owner: project.owner,
        editor: project.editor,
        viewer: project.viewer,
      }) satisfies Record<OperatorCase["role"], Scope>;
    const count = (kind: string) =>
      scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
        tx.entity.count({ where: { kind } }),
      );
    const run = <T>(
      work: (tx: Parameters<Parameters<typeof scoped>[2]>[0]) => Promise<T>,
    ) => scoped(project.owner.workspaceId, project.owner.projectId, work);
    const scheduleRequests = () =>
      scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
        tx.entity.count({
          where: {
            kind: "action_requests",
            data: { path: ["actionType"], equals: "content.schedule" },
          },
        }),
      );
    const worker = () => ({
      ...project.owner,
      userId: "worker",
      role: "owner" as const,
    });
    // A started X package with a reviewed draft in the case's conversation.
    async function startedPackage(scope: Scope, conversationId: string) {
      const { actionRequest } = await requestContentPackage(
        scope,
        conversationId,
        {
          goal: "Announce that beta access is open",
          channels: [X],
          factKeys: ["beta.access"],
        },
      );
      await run((tx) =>
        decideActionRequest(tx, scope, actionRequest.id, {
          version: actionRequest.version,
          packageHash: data(actionRequest).packageHash,
          decision: "approve",
        }),
      );
      await run(async (tx) => {
        const pkg = await entity(
          tx,
          project.owner,
          "content_packages",
          data(actionRequest).payload.packageId,
        );
        for (const step of data(pkg).steps as Array<Record<string, any>>)
          await deterministicDraft(
            tx,
            project.owner,
            step.missionId,
            step.jobId,
          );
      });
      await run((tx) => sweepProject(tx, worker()));
    }
    // Plans the last free X day for the autopilot and returns that date.
    async function autopilotDay() {
      const free = (
        await run((tx) => channelSlots(tx, project.owner, { channels: [X] }))
      ).channels[0]!.slots.filter((slot) => slot.free);
      const day = free[free.length - 1]!;
      await run((tx) =>
        create(tx, project.owner, "missions", {
          title: "Autopilot X slot",
          status: "ready",
          autopilot: true,
          autopilotSlot: `${X}|${day.date}`,
          channels: [X],
          plannedSlotAt: day.at,
        }),
      );
      return day.date;
    }
    // A fresh project per case: equal drafts from earlier cases would be reused.
    beforeEach(async () => {
      project = await createPackageProject();
    });
    afterEach(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
    });

    it.each(cases.map((c) => [c.id, c] as const))(
      "%s",
      async (_id, testCase) => {
        process.env.ORBIT_CONTENT_PACKAGES = testCase.contentPackages
          ? "true"
          : "false";
        const scope = scopes()[testCase.role];
        if (testCase.injectedDocument)
          await scoped(scope.workspaceId, scope.projectId, (tx) =>
            ingest(tx, project.owner, {
              sourceId: project.sourceId,
              externalId: `injected-${randomUUID()}`,
              title: "Injected source text",
              text: testCase.injectedDocument!,
              mimeType: "text/plain",
              language: "en",
              validFrom: new Date(Date.now() - 3600000).toISOString(),
              embeddings: [
                Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
              ],
            }),
          );
        const thread = await createConversation(scope);
        replay.vars = {};
        if (testCase.fixture) await startedPackage(scope, thread.id);
        if (testCase.fixture === "autopilot_day")
          replay.vars.autopilotDay = await autopilotDay();
        replay.steps = testCase.steps;
        replay.calls = 0;
        replay.inputs = [];
        const missionsBefore = await count("missions");
        const publicationsBefore = await count("publications");
        const schedulesBefore = await scheduleRequests();
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
        const packages = (await getConversation(scope, thread.id)).packages;
        expect(packages).toHaveLength(checks.packages);
        if (checks.package) {
          const pkg = packages[0]!;
          expect(pkg.status).toBe(checks.package.status);
          expect(pkg.deliverables.map((d: any) => d.channelId)).toEqual(
            checks.package.channels,
          );
          expect(Boolean(pkg.image)).toBe(checks.package.image);
          const plan = data(
            await scoped(scope.workspaceId, scope.projectId, (tx) =>
              entity(tx, scope, "action_requests", pkg.actionRequest!.id),
            ),
          ).payload;
          for (const deliverable of plan.deliverables) {
            if (checks.package.audience)
              expect(deliverable.mission.audience).toBe(
                checks.package.audience,
              );
            if (checks.package.targetAction)
              expect(deliverable.mission.targetAction).toBe(
                checks.package.targetAction,
              );
            if (checks.package.language)
              expect(deliverable.mission.language).toBe(
                checks.package.language,
              );
            if (checks.package.plannedSlot)
              expect(Date.parse(deliverable.plannedSlotAt)).toBeGreaterThan(
                Date.now() + 6 * 86400000,
              );
          }
        }
        expect((await count("missions")) - missionsBefore).toBe(
          checks.missions,
        );
        expect((await count("publications")) - publicationsBefore).toBe(
          checks.publications,
        );
        if (checks.scheduleRequests !== undefined)
          expect((await scheduleRequests()) - schedulesBefore).toBe(
            checks.scheduleRequests,
          );
        const outputs = toolOutputs(
          replay.inputs[replay.inputs.length - 1],
        ).join("\n");
        for (const fragment of checks.toolOutputIncludes ?? [])
          expect(outputs).toContain(fragment);
      },
    );
  },
);
