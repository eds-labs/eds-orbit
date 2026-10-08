import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  availableTools,
  defineTool,
  deferredDefinition,
  dropNullFields,
  findTool,
  responsesTool,
  searchTools,
  supportsToolSearch,
  TOOL_SEARCH,
  type OrbitTool,
  type ToolFeature,
} from "./registry.ts";

const tool = (overrides: Partial<OrbitTool> = {}): OrbitTool => ({
  name: "sample_read",
  namespace: "project",
  description: "Synthetic read tool.",
  parameters: z
    .object({
      query: z.string(),
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
          query: { type: "string" },
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
  it("rejects keywords the strict API mode does not support", () => {
    expect(() =>
      defineTool(
        tool({ parameters: z.object({ query: z.string().max(10) }).strict() }),
      ),
    ).toThrow(
      "TOOL_SCHEMA_KEYWORD_UNSUPPORTED:parameters/properties/query/maxLength",
    );
    expect(() =>
      defineTool(
        tool({
          parameters: z
            .object({ tags: z.array(z.string().min(1)).max(3) })
            .strict(),
        }),
      ),
    ).toThrow(
      "TOOL_SCHEMA_KEYWORD_UNSUPPORTED:parameters/properties/tags/items/minLength",
    );
    expect(() =>
      defineTool(
        tool({
          parameters: z.object({ query: z.string().default("x") }).strict(),
        }),
      ),
    ).toThrow(
      "TOOL_SCHEMA_KEYWORD_UNSUPPORTED:parameters/properties/query/default",
    );
  });
  it("sends only strict-mode keywords for every chat tool", () => {
    const supported = new Set([
      "type",
      "description",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "anyOf",
      "enum",
      "const",
      "pattern",
      "format",
      "multipleOf",
      "maximum",
      "exclusiveMaximum",
      "minimum",
      "exclusiveMinimum",
      "minItems",
      "maxItems",
    ]);
    const keywords = (
      schema: unknown,
      found = new Set<string>(),
    ): Set<string> => {
      if (Array.isArray(schema))
        schema.forEach((item) => keywords(item, found));
      else if (schema && typeof schema === "object")
        for (const [key, value] of Object.entries(schema)) {
          found.add(key);
          if (key === "properties")
            Object.values(value as object).forEach((child) =>
              keywords(child, found),
            );
          else if (key === "items" || key === "anyOf") keywords(value, found);
        }
      return found;
    };
    for (const tool of chatTools)
      for (const key of keywords(responsesTool(tool).parameters))
        expect(supported, `${tool.name}: ${key}`).toContain(key);
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

const proposals = vi.hoisted(() => ({ raw: [] as unknown[] }));
vi.mock("../../chat.ts", () => ({
  createProposal: vi.fn(
    async (_scope: unknown, _conversationId: string, raw: unknown) => {
      proposals.raw.push(raw);
      return {
        id: "p1",
        version: 1,
        payloadHash: "h",
        status: "proposed",
        payload: {},
      };
    },
  ),
}));
import { proposalTools } from "./proposal-tools.ts";
import { chatTools } from "./index.ts";

describe("proposal tool", () => {
  const owner = {
    workspaceId: "w",
    projectId: "p",
    userId: "u",
    role: "owner" as const,
  };
  const propose = proposalTools[0]!;
  const definition = responsesTool(propose);
  const mission = (definition.parameters as any).properties.mission;
  it("keeps the mission field set, requires every field and is editor-only", () => {
    expect(propose.name).toBe("propose_campaign");
    expect(propose.roles).toEqual(["editor", "owner"]);
    expect(propose.risk).toBe("P_proposal");
    expect((definition.parameters as any).required).toEqual([
      "mission",
      "factIds",
    ]);
    expect(Object.keys(mission.properties).sort()).toEqual([
      "allowedTopics",
      "assetIds",
      "audience",
      "campaignType",
      "channels",
      "contentType",
      "endAt",
      "goal",
      "language",
      "maxContents",
      "product",
      "profileVersion",
      "sourceIds",
      "startAt",
      "targetAction",
      "targetUrl",
      "title",
    ]);
    expect([...mission.required].sort()).toEqual(
      Object.keys(mission.properties).sort(),
    );
    expect(mission.additionalProperties).toBe(false);
    expect(mission.properties).not.toHaveProperty("allowedActions");
    expect(chatTools.map((tool) => tool.name)).toEqual([
      "project_status",
      "knowledge_search",
      "approved_assets",
      "analytics_memory",
      "propose_campaign",
      "request_content_package",
      "package_status",
      "revise_package_deliverable",
      "recent_content",
      "schedule_options",
      "propose_schedule",
      "assignment_propose",
      "assignment_list",
      "assignment_change",
      "run_status",
      "channel_history",
    ]);
  });
  it("offers assignment tools only with the agents feature", () => {
    const names = (
      role: "viewer" | "editor" | "owner",
      features: ToolFeature[],
    ) => availableTools(chatTools, role, features).map((tool) => tool.name);
    const assignmentTools = [
      "assignment_propose",
      "assignment_list",
      "assignment_change",
      "run_status",
    ];
    for (const name of assignmentTools) {
      expect(names("owner", [])).not.toContain(name);
      expect(names("owner", ["content_packages"])).not.toContain(name);
    }
    expect(names("owner", ["agents"])).toEqual(
      expect.arrayContaining(assignmentTools),
    );
    expect(names("editor", ["agents"])).toEqual(
      expect.arrayContaining(assignmentTools),
    );
    // Viewers read only: no proposal or change tool.
    expect(
      names("viewer", ["agents"]).filter((n) => assignmentTools.includes(n)),
    ).toEqual(["assignment_list", "run_status"]);
    const defined = (name: string) =>
      chatTools.find((tool) => tool.name === name)!;
    expect(defined("assignment_propose").risk).toBe("P_proposal");
    expect(defined("assignment_change").risk).toBe("P_proposal");
    expect(defined("assignment_list").risk).toBe("R0_read");
    expect(defined("run_status").risk).toBe("R0_read");
    // Deferred, so the always-loaded tool set stays small.
    for (const name of assignmentTools)
      expect(defined(name).deferLoading).toBe(true);
  });
  it("offers the package tools only with their feature, and the request only to editors and owners", () => {
    const names = (
      role: "viewer" | "editor" | "owner",
      features: ToolFeature[],
    ) => availableTools(chatTools, role, features).map((tool) => tool.name);
    expect(names("owner", [])).not.toContain("request_content_package");
    expect(names("owner", [])).not.toContain("package_status");
    expect(names("editor", ["content_packages"])).toEqual(
      expect.arrayContaining(["request_content_package", "package_status"]),
    );
    expect(names("viewer", ["content_packages"])).toContain("package_status");
    expect(names("viewer", ["content_packages"])).toContain("recent_content");
    expect(names("owner", [])).not.toContain("recent_content");
    expect(names("viewer", ["content_packages"])).toContain("schedule_options");
    expect(names("owner", [])).not.toContain("schedule_options");
    expect(names("viewer", ["content_packages"])).not.toContain(
      "request_content_package",
    );
    expect(names("viewer", ["content_packages"])).not.toContain(
      "propose_schedule",
    );
    expect(names("editor", ["content_packages"])).toContain("propose_schedule");
    const request = chatTools.find(
      (tool) => tool.name === "request_content_package",
    )!;
    expect(request.risk).toBe("P_proposal");
    // Scheduling is only ever proposed; an owner decides the exact post.
    expect(
      chatTools.find((tool) => tool.name === "propose_schedule")!.risk,
    ).toBe("P_proposal");
  });
  it("passes a null optional mission field to createProposal as omitted", async () => {
    proposals.raw.length = 0;
    const result = await propose.execute(
      { scope: owner, runId: "r", conversationId: "c1", callIndex: 1 },
      {
        mission: {
          title: "T",
          product: null,
          allowedTopics: null,
          assetIds: null,
        },
        factIds: ["f"],
      },
    );
    expect(proposals.raw).toEqual([
      { mission: { title: "T" }, factIds: ["f"] },
    ]);
    expect(result).toEqual({
      output: {
        proposalId: "p1",
        version: 1,
        hash: "h",
        status: "proposed",
        payload: {},
      },
      cards: [
        {
          kind: "status",
          label: "Proposal ready for confirmation",
          status: "confirmation_required",
        },
      ],
    });
  });
});

describe("client-executed tool search", () => {
  const deferred = [
    tool({
      name: "schedule_options",
      namespace: "calendar",
      description: "Free and taken slots per channel.",
      deferLoading: true,
    }),
    tool({
      name: "propose_schedule",
      namespace: "calendar",
      description: "Propose or move a package post's slot.",
      deferLoading: true,
    }),
    tool({
      name: "recent_content",
      namespace: "content",
      description: "Recent drafts and posts per channel.",
      deferLoading: true,
    }),
    tool({
      name: "analytics_memory",
      namespace: "analytics",
      description: "Measured performance memory.",
      deferLoading: true,
    }),
  ];
  const names = (found: OrbitTool[]) => found.map((t) => t.name);

  it("returns the deferred tools that match the goal, best first and at most three", () => {
    expect(
      names(searchTools(deferred, "Propose a slot to schedule the X post")),
    ).toEqual(["propose_schedule", "schedule_options"]);
    // Weak matches below half of the best match are left out.
    expect(names(searchTools(deferred, "recent posts on X"))).toEqual([
      "recent_content",
    ]);
    expect(
      searchTools(deferred, "slots schedule posts channel recent analytics")
        .length,
    ).toBeLessThanOrEqual(3);
  });

  it("returns every deferred tool when nothing matches, for example a German goal", () => {
    expect(names(searchTools(deferred, "Termin für morgen finden"))).toEqual(
      names(deferred),
    );
    expect(searchTools([], "anything")).toEqual([]);
  });

  it("loads found tools as strict deferred function definitions", () => {
    expect(deferredDefinition(deferred[0]!)).toMatchObject({
      type: "function",
      name: "schedule_options",
      strict: true,
      defer_loading: true,
    });
    expect(TOOL_SEARCH).toMatchObject({
      type: "tool_search",
      execution: "client",
      parameters: {
        type: "object",
        required: ["goal"],
        additionalProperties: false,
      },
    });
  });

  it("uses tool search only on models from gpt-5.4", () => {
    expect(supportsToolSearch("gpt-5.4")).toBe(true);
    expect(supportsToolSearch("gpt-5.6-terra")).toBe(true);
    expect(supportsToolSearch("gpt-6-astra")).toBe(true);
    expect(supportsToolSearch("gpt-5.3-mini")).toBe(false);
    expect(supportsToolSearch("gpt-4.1")).toBe(false);
    expect(supportsToolSearch("synthetic-model")).toBe(false);
  });
});
