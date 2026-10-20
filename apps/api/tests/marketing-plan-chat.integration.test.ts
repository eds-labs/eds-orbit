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
const replay = vi.hoisted(() => ({
  steps: [] as unknown[][],
  inputs: [] as any[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(async (request: any) => {
    replay.inputs.push(structuredClone(request.input));
    const output = replay.steps.shift();
    if (!output) throw new Error("UNRECORDED_CHAT");
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.completed",
          response: {
            id: `synthetic_${replay.inputs.length}`,
            usage: { input_tokens: 100, output_tokens: 20 },
            output,
          },
        };
      },
    };
  }),
}));
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  chatScoped,
  createConversation,
  sendMessage,
  getRun,
  getConversation,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  IMAGE_MAX,
} from "./support/package-project.ts";
import { planSpec } from "./support/marketing-plan.ts";
import { list } from "../src/shared.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const call = (name: string, args: unknown) => ({
  type: "function_call",
  id: randomUUID(),
  call_id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
const search = {
  type: "tool_search_call",
  id: "ts",
  call_id: "search",
  execution: "client",
  status: "completed",
  arguments: { goal: "marketing_plan_context marketing_plan_propose strategy" },
};
const answer = {
  type: "message",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: "Review this saved strategy. It is not active; no assignments or publishing start.",
    },
  ],
};
describe.skipIf(!enabled)("MA-03 offline assistant orchestration", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  beforeEach(async () => {
    vi.stubEnv("ORBIT_AGENTS", "true");
    vi.stubEnv("ORBIT_TOOL_SEARCH", "true");
    project = await createPackageProject();
    replay.inputs = [];
    const rate = {
      inputMicrosPerMillion: 1000,
      outputMicrosPerMillion: 1000,
      verifiedAt: new Date().toISOString(),
    };
    await chatScoped(project.owner, (tx) =>
      saveOpenAiConfiguration(tx, project.owner, {
        apiKey: "synthetic-offline-key",
        verifiedModels: [
          "gpt-5.6-terra",
          "text-embedding-3-small",
          IMAGE_MODEL,
        ],
        rateCard: { "gpt-5.6-terra": rate, "text-embedding-3-small": rate },
        modelRoutes: {
          fast: "gpt-5.6-terra",
          standard: "gpt-5.6-terra",
          quality: "gpt-5.6-terra",
          escalation: "gpt-5.6-terra",
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: IMAGE_MAX,
          pricingVerifiedAt: new Date().toISOString(),
        },
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await project.cleanup();
  });
  afterAll(() => closeDatabase());
  async function turn(specJson: string) {
    replay.steps = [
      [search],
      [call("marketing_plan_context", {})],
      [call("marketing_plan_propose", { specJson })],
      [answer],
    ];
    const thread = await createConversation(project.owner);
    const sent = await sendMessage(project.owner, thread.id, {
      text: "Propose a durable seven-day English product strategy, monthly AI budget USD 20, for my review. Start no work.",
      clientRequestId: randomUUID(),
    });
    await runChat(project.owner, sent.runId);
    expect((await getRun(project.owner, sent.runId)).status).toBe("succeeded");
    const outputs = replay.inputs
      .at(-1)
      .filter((item: any) => item.type === "function_call_output")
      .map((item: any) => JSON.parse(item.output));
    return { detail: await getConversation(project.owner, thread.id), outputs };
  }
  it("reads context, saves a bounded strategy and reloads its live revision through the shared assistant", async () => {
    const spec = await chatScoped(project.owner, (tx) =>
      planSpec(tx, project.owner),
    );
    const { detail, outputs } = await turn(JSON.stringify(spec));
    expect(outputs).toContainEqual(
      expect.objectContaining({
        specContract: expect.any(Object),
        baselineState: "no_data",
      }),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        revision: 1,
        activationAvailable: false,
        status: "proposed",
      }),
    );
    expect(detail.marketingPlans).toEqual([
      expect.objectContaining({
        spec,
        revision: 1,
        strategicallyReviewed: false,
      }),
    ]);
    expect(detail.messages.flatMap((m) => m.cards)).toContainEqual(
      expect.objectContaining({ kind: "marketing_plan" }),
    );
    expect(
      await chatScoped(project.owner, (tx) =>
        list(tx, project.owner, "assignments"),
      ),
    ).toEqual([]);
  });
  it("returns a safe malformed-JSON error without saving a plan", async () => {
    const { outputs } = await turn("not-json");
    expect(outputs).toContainEqual({ error: "MARKETING_PLAN_JSON_INVALID" });
    expect(
      await chatScoped(project.owner, (tx) =>
        list(tx, project.owner, "marketing_plans"),
      ),
    ).toEqual([]);
  });
});
