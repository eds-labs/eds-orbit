import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

// The model's steps, scripted; the offered tools are recorded.
const script = vi.hoisted(() => ({
  steps: [] as Array<{ name: string; arguments: unknown } | null>,
  calls: 0,
  offered: [] as string[],
  outputs: [] as unknown[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(
    async (request: { tools: Array<{ name: string }>; input: unknown[] }) => {
      script.offered = request.tools.map((tool) => tool.name);
      script.outputs.push(request.input);
      const step = script.steps[script.calls++] ?? null;
      return {
        async *[Symbol.asyncIterator]() {
          if (step) {
            yield {
              type: "response.completed",
              response: {
                usage: { input_tokens: 100, output_tokens: 30 },
                output: [
                  {
                    type: "function_call",
                    name: step.name,
                    call_id: `call-${script.calls}`,
                    arguments: JSON.stringify(step.arguments),
                  },
                ],
              },
            };
            return;
          }
          yield { type: "response.output_text.delta", delta: "Done." };
          yield {
            type: "response.completed",
            response: {
              usage: { input_tokens: 100, output_tokens: 10 },
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Done." }],
                },
              ],
            },
          };
        },
      };
    },
  ),
}));
import {
  createConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { actorScope } from "../src/platform/tenancy/member-scope.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Module-level roles in the assistant (WP4.5): a member without access to a
 * module is offered none of its tools or prompt fragments, a forged call is
 * refused, and the platform's knowledge_search stays.
 */
describe.skipIf(!enabled)("module-level roles in the assistant", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  beforeAll(async () => {
    project = await createPackageProject({
      name: "Synthetic module roles chat",
    });
  });
  afterEach(() => {
    delete process.env.ORBIT_MODULE_ROLES;
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });
  const chat = async (steps: typeof script.steps) => {
    const scope = (await actorScope(
      project.editor.workspaceId,
      project.editor.projectId,
      project.editor.userId,
    ))!;
    script.steps = steps;
    script.calls = 0;
    script.outputs = [];
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "Plan a campaign.",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    return { scope, run: await getRun(scope, sent.runId) };
  };

  it("offers an editor's marketing tools only while marketing is not none", async () => {
    await chat([]);
    expect(script.offered).toContain("propose_campaign");

    process.env.ORBIT_MODULE_ROLES = "true";
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: project.editor.workspaceId,
        projectId: project.editor.projectId,
        userId: project.editor.userId,
        moduleId: "marketing",
        role: "none",
      },
    });
    const { scope, run } = await chat([
      { name: "propose_campaign", arguments: { mission: {}, factIds: [] } },
    ]);
    expect(scope.moduleRoles).toEqual({ marketing: "none" });
    expect(run.status).toBe("succeeded");
    // Only the platform's search is left; the forged call is refused.
    expect(script.offered).toEqual(["knowledge_search"]);
    const followup = script.outputs[1] as Array<Record<string, unknown>>;
    expect(
      followup
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(String(item.output))),
    ).toEqual([{ error: "CHAT_TOOL_NOT_ALLOWED" }]);
  });

  it("offers the marketing tools again when the flag is off", async () => {
    await chat([]);
    expect(script.offered).toContain("propose_campaign");
  });
});
