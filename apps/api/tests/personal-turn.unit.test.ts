import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { toAnthropicTools } from "../../../packages/ai/src/providers/anthropic.ts";
import { CHAT_MAX_INPUT_BYTES } from "../src/platform/assistant/chat-limits.ts";
import {
  LOAD_PROJECT_TOOLS_DEFINITION,
  FOCUS_PRELOAD_LIMIT,
  projectListSection,
  projectToolDefinition,
  requestBytes,
} from "../src/platform/assistant/personal-turn.ts";
import {
  personalUserTools,
  resolveCapabilities,
  capabilityFeatures,
} from "../src/platform/agents/capabilities.ts";
import {
  adaptsToProjectArgument,
  inProjectCall,
  splitProjectArgument,
} from "../src/platform/agents/project-calls.ts";
import { legacyResponsesRuntime } from "../src/platform/agents/runtime/legacy-responses.ts";
import type {
  BudgetedModel,
  ModelRequest,
  ToolHost,
} from "../src/platform/agents/runtime/port.ts";
import {
  exposedToAssistant,
  exposedToPersonal,
  responsesTool,
  searchTools,
  type OrbitTool,
} from "../src/platform/agents/tools/registry.ts";
import {
  registeredAssistants,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { registerModules } from "../src/modules/registry.ts";
import { staticChatBytes } from "../src/modules/chat-runner.ts";

registerModules();

// Personal mode (ADR 0022, plan agent-platform-phase-3 WP3.2/WP3.3): the
// user tools stay out of every project channel, the staged loading is the
// same for both providers, and the personal static request leaves room.

const owner: Scope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "user-1",
  role: "owner",
};
const allFeatures = () =>
  capabilityFeatures(registeredAssistants(), {
    toolSearch: true,
    moduleOperations: true,
  });
const personalProjectTools = (): OrbitTool[] =>
  resolveCapabilities(owner, {
    channel: "personal",
    enabled: undefined,
    features: [
      ...allFeatures(),
      ...registeredAssistants().flatMap((a) =>
        a.features({ toolSearch: true, all: true }),
      ),
    ],
  }).filter(adaptsToProjectArgument);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("personal user tools", () => {
  it("are registered user tools, offered in no project channel", () => {
    const names = personalUserTools().map((tool) => tool.name);
    expect(names).toEqual([
      "projects_list",
      "my_overview",
      "pending_approvals",
      "agents_list",
      "agent_work_order_status",
      "context_remember",
    ]);
    // Within the plan's budget of eight with load_project_tools and the
    // coming agent_delegate.
    expect(names.length + 2).toBeLessThanOrEqual(8);
    for (const channel of ["assistant", "mcp", "agent"] as const) {
      const offered = resolveCapabilities(owner, {
        channel,
        enabled: undefined,
        features: allFeatures(),
      }).map((tool) => tool.name);
      for (const name of [...names, "action_status"])
        expect(offered, `${channel} offers ${name}`).not.toContain(name);
    }
  });

  it("stay out of project chat's static bytes", () => {
    // staticChatBytes counts tools exposedToAssistant: none of these is.
    const personalOnly = registeredTools().filter(
      (tool) => tool.exposure?.personal === true,
    );
    expect(personalOnly.map((tool) => tool.name)).toContain("action_status");
    for (const tool of personalOnly) expect(exposedToAssistant(tool)).toBe(false);
    expect(staticChatBytes()).toBeLessThan(CHAT_MAX_INPUT_BYTES - 48_000);
  });

  it("offers action_status as a personal project tool", () => {
    const tool = registeredTools().find((t) => t.name === "action_status")!;
    expect(exposedToPersonal(tool)).toBe(true);
    expect(personalProjectTools().map((t) => t.name)).toContain(
      "action_status",
    );
  });
});

describe("project tool definitions in personal mode", () => {
  it("every personal project tool takes the injected projectId and converts for both providers", () => {
    const tools = personalProjectTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      const definition = projectToolDefinition(tool);
      const parameters = definition.parameters as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(parameters.properties.projectId, tool.name).toBeDefined();
      expect(parameters.required, tool.name).toContain("projectId");
      // The Anthropic adapter accepts every definition (function tools only).
      expect(() => toAnthropicTools([definition])).not.toThrow();
    }
    expect(() => toAnthropicTools([LOAD_PROJECT_TOOLS_DEFINITION])).not.toThrow();
  });

  it("splits the projectId argument and refuses a call without one", () => {
    expect(splitProjectArgument({ projectId: "p", a: 1 })).toEqual({
      projectId: "p",
      rest: { a: 1 },
    });
    expect(() => splitProjectArgument({ a: 1 })).toThrow("PROJECT_REQUIRED");
    expect(splitProjectArgument({ a: 1 }, "only").projectId).toBe("only");
  });

  it("caps a tool search at the load limit", () => {
    const tools = personalProjectTools();
    expect(searchTools(tools, "zzzz-unmatched").length).toBe(tools.length);
    expect(searchTools(tools, "zzzz-unmatched", { limit: 8 })).toHaveLength(8);
  });
});

describe("personal static bytes", () => {
  it("leave at least 64 KB under CHAT_MAX_INPUT_BYTES", () => {
    // Worst case of the fixed request part: an instructions placeholder,
    // 50 projects with long names, 2 KB of personal context, every user
    // tool, load_project_tools and the six largest project tools preloaded.
    const instructions = "Personal-mode instructions placeholder. ".repeat(100);
    const projects = Array.from({ length: 50 }, (_, index) => ({
      id: randomUUID(),
      name: `Project ${index} ${"with a rather long display name".slice(0, 40)}`,
    }));
    const context = "x".repeat(2048);
    const preload = personalProjectTools()
      .map(projectToolDefinition)
      .sort((a, b) => bytes(b) - bytes(a))
      .slice(0, FOCUS_PRELOAD_LIMIT);
    const tools = [
      ...personalUserTools().map(responsesTool),
      LOAD_PROJECT_TOOLS_DEFINITION,
      ...preload,
    ];
    const fixed = requestBytes({
      input: [],
      instructions: [
        instructions,
        projectListSection(projects, { truncated: true }),
        context,
      ].join("\n"),
      tools,
    });
    expect(CHAT_MAX_INPUT_BYTES - fixed).toBeGreaterThanOrEqual(64_000);
  });

  it("count loaded definitions toward the request bytes", () => {
    const tool = personalProjectTools()[0]!;
    const base = { input: [], instructions: "x", tools: [LOAD_PROJECT_TOOLS_DEFINITION] };
    const loaded = projectToolDefinition(tool);
    expect(
      requestBytes({ ...base, tools: [...base.tools, loaded] }) -
        requestBytes(base),
    ).toBe(bytes(loaded) + 1);
  });
});

describe("runtime staged loading", () => {
  const answer = { output: [{ type: "message", role: "assistant", content: "ok" }], toolCalls: [], toolSearches: [] };

  it("passes no loaded tools for a host without staged loading (project mode)", async () => {
    const seen: ModelRequest[] = [];
    const model: BudgetedModel = {
      async call(request) {
        seen.push(request);
        return answer;
      },
    };
    const host: ToolHost = {
      execute: async () => "",
      search: async () => [],
    };
    await legacyResponsesRuntime.runTurn({
      input: [{ role: "user", content: "hi" }],
      model,
      tools: host,
      limits: { maxModelCalls: 2, maxToolCalls: 2 },
      signal: new AbortController().signal,
    });
    expect(seen[0]).not.toHaveProperty("loadedTools");
  });

  it("passes the definitions loaded so far with every following call", async () => {
    const seen: ModelRequest[] = [];
    const loaded: unknown[] = [];
    const steps = [
      {
        output: [],
        toolCalls: [{ callId: "a", name: "load", arguments: "{}" }],
        toolSearches: [],
      },
      answer,
    ];
    const model: BudgetedModel = {
      async call(request) {
        seen.push(request);
        return steps[seen.length - 1]!;
      },
    };
    const host: ToolHost = {
      async execute() {
        loaded.push({ type: "function", name: "found" });
        return "{}";
      },
      search: async () => [],
      loadedTools: () => loaded,
    };
    await legacyResponsesRuntime.runTurn({
      input: [{ role: "user", content: "hi" }],
      model,
      tools: host,
      limits: { maxModelCalls: 3, maxToolCalls: 3 },
      signal: new AbortController().signal,
    });
    expect(seen.map((request) => request.loadedTools)).toEqual([
      [],
      [{ type: "function", name: "found" }],
    ]);
  });
});

describe("lock order", () => {
  it("refuses a target-project call inside another one", async () => {
    await expect(
      inProjectCall(randomUUID(), () => inProjectCall(randomUUID(), async () => 1)),
    ).rejects.toThrow("NESTED_PROJECT_CALL");
    // One after the other is fine.
    await inProjectCall(randomUUID(), async () => 1);
    await expect(inProjectCall(randomUUID(), async () => 2)).resolves.toBe(2);
  });
});
