import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Offline: the model is replaced by one recorded answer; no network call is made.
const captured = vi.hoisted(() => ({
  instructions: "" as string,
  tools: [] as unknown[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(
    async (request: { instructions?: string; tools: unknown[] }) => {
      captured.instructions = String(request.instructions);
      captured.tools = request.tools;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "response.completed",
            response: {
              id: "resp_characterization",
              usage: { input_tokens: 100, output_tokens: 20 },
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "OK." }],
                },
              ],
            },
          };
        },
      };
    },
  ),
}));
import { createHash, randomUUID } from "node:crypto";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Characterization (WP0.4, plans/orbit-modularization/04 §4.1 cut 3): the
 * exact instructions and tool definitions the chat runner sends, for every
 * role and feature combination. WP2.2 composes the prompt from platform and
 * module fragments; it must keep these bytes identical. The hashes pin every
 * combination, the full text two of them for a readable diff.
 */
const sha = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
// Tool search runs only with gpt-5.4 or later on the chat route (ADR 0007).
const SEARCH_MODEL = "gpt-5.6-terra";
const NO_SEARCH_MODEL = "gpt-5.3-mini";

describe.skipIf(!enabled)("Assistant request (characterization)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let model = "";

  const useChatModel = async (next: string) => {
    if (model === next) return;
    model = next;
    const rate = {
      inputMicrosPerMillion: 1000,
      outputMicrosPerMillion: 1000,
      verifiedAt: new Date().toISOString(),
    };
    await scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
      saveOpenAiConfiguration(tx, project.owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: [next, "text-embedding-3-small", IMAGE_MODEL],
        rateCard: { [next]: rate, "text-embedding-3-small": rate },
        modelRoutes: {
          fast: next,
          standard: next,
          quality: next,
          escalation: next,
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: IMAGE_MAX,
          pricingVerifiedAt: new Date().toISOString(),
        },
      }),
    );
  };

  async function request(
    scope: Scope,
    flags: {
      packages: boolean;
      agents: boolean;
      toolSearch: boolean;
      searchModel: boolean;
    },
  ) {
    process.env.ORBIT_CONTENT_PACKAGES = String(flags.packages);
    process.env.ORBIT_AGENTS = String(flags.agents);
    process.env.ORBIT_TOOL_SEARCH = String(flags.toolSearch);
    await useChatModel(flags.searchModel ? SEARCH_MODEL : NO_SEARCH_MODEL);
    captured.instructions = "";
    captured.tools = [];
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "What can you do here?",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    expect((await getRun(scope, sent.runId)).status).toBe("succeeded");
    return { instructions: captured.instructions, tools: captured.tools };
  }

  beforeAll(async () => {
    project = await createPackageProject();
  });
  afterEach(() => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_TOOL_SEARCH;
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("pins instructions and tool definitions for every role and flag combination", async () => {
    const combinations: Record<string, unknown> = {};
    for (const role of ["owner", "editor", "viewer"] as const)
      for (const packages of [false, true])
        for (const agents of [false, true])
          for (const [toolSearch, searchModel] of [
            [false, true],
            [true, true],
            [true, false],
          ] as const) {
            const scope = project[role];
            const sent = await request(scope, {
              packages,
              agents,
              toolSearch,
              searchModel,
            });
            const key = `${role} packages=${packages} agents=${agents} toolSearch=${toolSearch} model=${searchModel ? SEARCH_MODEL : NO_SEARCH_MODEL}`;
            combinations[key] = {
              instructionsSha256: sha(sent.instructions),
              instructionsBytes: Buffer.byteLength(sent.instructions),
              tools: (sent.tools as Array<{ type: string; name?: string }>).map(
                (t) => t.name ?? t.type,
              ),
              toolsSha256: sha(sent.tools),
              toolsBytes: Buffer.byteLength(JSON.stringify(sent.tools)),
            };
          }
    expect(combinations).toMatchSnapshot();
  }, 120000);

  it("pins the full request of the smallest and the largest owner setup", async () => {
    const none = await request(project.owner, {
      packages: false,
      agents: false,
      toolSearch: false,
      searchModel: true,
    });
    const all = await request(project.owner, {
      packages: true,
      agents: true,
      toolSearch: true,
      searchModel: true,
    });
    expect({ none, all }).toMatchSnapshot();
  });
});
