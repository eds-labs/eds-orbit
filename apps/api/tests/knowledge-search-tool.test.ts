import { describe, expect, it, vi } from "vitest";

const searches = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../src/platform/knowledge/search.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/platform/knowledge/search.ts")
  >()),
  knowledgeSearch: vi.fn(async (...args: unknown[]) => {
    searches.calls.push(args);
    return {
      result: {
        status: "ready",
        retrieval: {
          mode: "hybrid",
          indexProfile: "p",
          indexGeneration: 1,
          evidenceId: "00000000-0000-4000-8000-000000000001",
        },
        facts: [],
        passages: [],
        gaps: [],
      },
      cards: [],
    };
  }),
}));
import { responsesTool } from "../src/modules/agents/tools/registry.ts";
import { readTools } from "../src/modules/marketing/tools/read-tools.ts";
import { agentKnowledgeSearch } from "../src/modules/marketing/tools/agent-tools.ts";

const scope = {
  workspaceId: "w",
  projectId: "p",
  userId: "u",
  role: "owner" as const,
};
const assistant = readTools.find((tool) => tool.name === "knowledge_search")!;

/** One knowledge_search definition, two budget contexts (WP3.2). */
describe("knowledge_search tool", () => {
  it("offers the assistant and specialists the same model-facing tool", () => {
    expect(responsesTool(agentKnowledgeSearch)).toEqual(
      responsesTool(assistant),
    );
    expect(assistant.feature).toBeUndefined();
    expect(agentKnowledgeSearch.feature).toBe("agents");
    expect([assistant.deferLoading, agentKnowledgeSearch.deferLoading]).toEqual(
      [false, false],
    );
  });

  it("reserves the assistant's search under its chat run", async () => {
    searches.calls.length = 0;
    await assistant.execute(
      { scope, runId: "r1", conversationId: "c", callIndex: 2 },
      { query: "beta", factKeys: null },
    );
    expect(searches.calls).toEqual([
      [
        scope,
        { query: "beta" },
        { retrievalJobKey: "chat:r1:knowledge:2", budgetRunKey: "chat:r1" },
        // The platform assistant names no module: shared sources only (WP3.5).
        undefined,
      ],
    ]);
    expect(searches.calls[0]).toHaveLength(4);
  });

  it("reserves a specialist's search under its task and assignment run", async () => {
    searches.calls.length = 0;
    await agentKnowledgeSearch.execute(
      {
        scope,
        runId: "chat-unused",
        conversationId: "c",
        callIndex: 0,
        agentTask: { taskId: "t1", runId: "r1" },
      },
      { query: "beta", factKeys: ["a"] },
    );
    expect(searches.calls).toEqual([
      [
        scope,
        { query: "beta", factKeys: ["a"] },
        {
          retrievalJobKey: "agent:t1:knowledge:0",
          budgetRunKey: "assignment-run:r1",
        },
        // Specialists search as marketing (WP3.5).
        "marketing",
      ],
    ]);
  });

  it("refuses the specialist variant outside a specialist task", async () => {
    searches.calls.length = 0;
    await expect(
      agentKnowledgeSearch.execute(
        { scope, runId: "r1", conversationId: "c", callIndex: 1 },
        { query: "beta", factKeys: null },
      ),
    ).rejects.toThrow("AGENT_TOOL_NOT_ALLOWED");
    expect(searches.calls).toEqual([]);
  });
});
