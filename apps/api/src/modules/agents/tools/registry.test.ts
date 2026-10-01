import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  availableTools,
  defineTool,
  dropNullFields,
  findTool,
  responsesTool,
  type OrbitTool,
} from "./registry.ts";

const tool = (overrides: Partial<OrbitTool> = {}): OrbitTool => ({
  name: "sample_read",
  namespace: "project",
  description: "Synthetic read tool.",
  parameters: z
    .object({
      query: z.string().max(100),
      limit: z.number().int().min(1).max(5).nullable(),
    })
    .strict(),
  risk: "R0_read",
  roles: ["viewer", "editor", "owner"],
  deferLoading: false,
  execute: async () => ({ output: {}, cards: [] }),
  ...overrides,
});

describe("tool registry", () => {
  it("generates a strict function definition without the $schema key", () => {
    const definition = responsesTool(defineTool(tool()));
    expect(definition).toEqual({
      type: "function",
      name: "sample_read",
      description: "Synthetic read tool.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 100 },
          limit: {
            anyOf: [
              { type: "integer", minimum: 1, maximum: 5 },
              { type: "null" },
            ],
          },
        },
        required: ["query", "limit"],
        additionalProperties: false,
      },
    });
  });
  it("rejects a schema the strict API mode cannot express", () => {
    expect(() =>
      defineTool(
        tool({
          parameters: z.object({ query: z.string().optional() }).strict(),
        }),
      ),
    ).toThrow(/nullable/);
  });
  it("rejects names the function API does not accept", () => {
    expect(() => defineTool(tool({ name: "knowledge.search" }))).toThrow(
      "TOOL_NAME_INVALID",
    );
  });
  it("offers a tool only to its roles and finds only registered names", () => {
    const registry = [
      defineTool(tool()),
      defineTool(tool({ name: "sample_propose", roles: ["editor", "owner"] })),
    ];
    expect(availableTools(registry, "viewer").map((t) => t.name)).toEqual([
      "sample_read",
    ]);
    expect(availableTools(registry, "owner").map((t) => t.name)).toEqual([
      "sample_read",
      "sample_propose",
    ]);
    expect(findTool(registry, "sample_propose")?.name).toBe("sample_propose");
    expect(findTool(registry, "missing")).toBeUndefined();
    expect(findTool(registry, 42)).toBeUndefined();
  });
  it("drops null object fields recursively and keeps array entries", () => {
    expect(
      dropNullFields({
        a: null,
        b: { c: null, d: 1 },
        e: [{ f: null, g: "x" }, null],
      }),
    ).toEqual({ b: { d: 1 }, e: [{ g: "x" }, null] });
    expect(dropNullFields(null)).toBeNull();
    expect(dropNullFields("text")).toBe("text");
  });
});

import { vi } from "vitest";
const read = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../chat-tools.ts", () => ({
  runReadTool: vi.fn(async (...args: unknown[]) => {
    read.calls.push(args);
    return { result: { ok: true }, cards: [] };
  }),
  validateReadToolResult: vi.fn(
    (_name: string, result: unknown, cards: unknown[]) => ({
      result,
      cards,
    }),
  ),
}));
import { readTools } from "./read-tools.ts";

describe("read tools", () => {
  const scope = {
    workspaceId: "w",
    projectId: "p",
    userId: "u",
    role: "viewer" as const,
  };
  const context = (callIndex: number) => ({
    scope,
    runId: "run-1",
    conversationId: "c",
    callIndex,
  });
  it("keeps the existing names, strict schemas and viewer access", () => {
    expect(readTools.map((tool) => tool.name)).toEqual([
      "project_status",
      "knowledge_search",
      "approved_assets",
      "analytics_memory",
    ]);
    for (const tool of readTools) {
      expect(tool.risk).toBe("R0_read");
      expect(tool.roles).toEqual(["viewer", "editor", "owner"]);
      expect(responsesTool(tool).strict).toBe(true);
    }
  });
  it("treats null optional fields like omitted ones and passes trusted keys only to knowledge_search", async () => {
    read.calls.length = 0;
    const byName = Object.fromEntries(readTools.map((t) => [t.name, t]));
    await byName.knowledge_search!.execute(context(3), {
      query: "presale",
      factKeys: null,
    });
    await byName.approved_assets!.execute(context(4), { query: null });
    await byName.analytics_memory!.execute(context(5), { campaign: null });
    await byName.project_status!.execute(context(6), {});
    expect(read.calls).toEqual([
      [
        scope,
        "knowledge_search",
        { query: "presale" },
        {
          retrievalJobKey: "chat:run-1:knowledge:3",
          budgetRunKey: "chat:run-1",
        },
      ],
      [scope, "approved_assets", {}, undefined],
      [scope, "analytics_memory", {}, undefined],
      [scope, "project_status", {}, undefined],
    ]);
  });
});
