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
