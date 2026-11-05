import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  capabilityFeatures,
  capToolOutput,
  executeCapability,
  MAX_TOOL_OUTPUT_CHARS,
  resolveCapabilities,
} from "../src/platform/agents/capabilities.ts";
import {
  availableTools,
  defineTool,
  exposedToAssistant,
  exposedToMcp,
  type OrbitTool,
  type ToolFeature,
} from "../src/platform/agents/tools/registry.ts";
import {
  registeredAssistants,
  registeredRegistry,
  registeredToolOwner,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { effectiveRole } from "../src/platform/tenancy/module-roles.ts";
import { PROJECT_READ } from "../src/platform/tenancy/permissions.ts";
import { registerModules } from "../src/modules/registry.ts";

registerModules();

// The filters as chat-runner.ts and mcp/visibility.ts wrote them before
// WP1.1, kept here as the reference the shared resolver must equal.
function legacyFeatures(
  enabled: ReadonlySet<string> | undefined,
  channel: "chat" | "chat_delegated" | "mcp",
  options: { toolSearch: boolean; fullTools: boolean },
): ToolFeature[] {
  const features =
    channel === "mcp"
      ? registeredAssistants(enabled).flatMap((a) => a.features({ toolSearch: true }))
      : registeredAssistants(enabled).flatMap((a) =>
          a.features({ toolSearch: options.toolSearch, fullTools: options.fullTools }),
        );
  if (channel !== "chat" && process.env.ORBIT_MCP_TASKS === "true") features.push("mcp_tasks");
  if (process.env.ORBIT_MCP_PROJECT_CONFIGURATION === "true") features.push("project_configuration");
  if (process.env.ORBIT_MCP_PROJECT_ADMINISTRATION === "true") features.push("project_administration");
  return features;
}
function legacyTools(
  scope: Scope,
  enabled: ReadonlySet<string> | undefined,
  features: readonly ToolFeature[],
  exposed: (tool: OrbitTool) => boolean,
) {
  return registeredTools(enabled).filter((tool) => {
    if (!exposed(tool)) return false;
    const role = effectiveRole(scope, registeredToolOwner(tool.name));
    return role !== "none" && availableTools([tool], role, features).length > 0;
  });
}

const scopeFor = (role: Scope["role"], moduleRoles?: Scope["moduleRoles"]): Scope => ({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "user-1",
  role,
  ...(moduleRoles ? { moduleRoles } : {}),
});

describe("capability layer (WP1.1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers exactly the tools the former chat and MCP filters offered", () => {
    const modules = registeredRegistry().order;
    const enabledSets: Array<ReadonlySet<string> | undefined> = [
      undefined,
      new Set(modules),
      new Set(modules.filter((id) => id !== "support" && id !== "work")),
      new Set(["marketing"]),
    ];
    const scopes = [
      scopeFor("owner"),
      scopeFor("editor"),
      scopeFor("viewer"),
      scopeFor("editor", { support: "none", marketing: "viewer" }),
      scopeFor("viewer", { work: "editor", knowledge: "none" }),
    ];
    const flagSets = [
      {},
      { ORBIT_MCP_TASKS: "true" },
      {
        ORBIT_MCP_TASKS: "true",
        ORBIT_MCP_PROJECT_CONFIGURATION: "true",
        ORBIT_MCP_PROJECT_ADMINISTRATION: "true",
      },
    ];
    let compared = 0;
    for (const flags of flagSets) {
      vi.unstubAllEnvs();
      vi.stubEnv("ORBIT_MCP_TASKS", "false");
      vi.stubEnv("ORBIT_MCP_PROJECT_CONFIGURATION", "false");
      vi.stubEnv("ORBIT_MCP_PROJECT_ADMINISTRATION", "false");
      for (const [key, value] of Object.entries(flags)) vi.stubEnv(key, value);
      for (const enabled of enabledSets)
        for (const scope of scopes)
          for (const toolSearch of [false, true])
            for (const fullTools of [false, true]) {
              for (const channel of ["chat", "chat_delegated"] as const) {
                const features = capabilityFeatures(registeredAssistants(enabled), {
                  toolSearch,
                  fullTools,
                  moduleOperations: channel === "chat_delegated",
                });
                const legacy = legacyFeatures(enabled, channel, { toolSearch, fullTools });
                expect(features).toEqual(legacy);
                expect(
                  resolveCapabilities(scope, { channel: "assistant", enabled, features }).map((t) => t.name),
                ).toEqual(legacyTools(scope, enabled, legacy, exposedToAssistant).map((t) => t.name));
                compared++;
              }
              const mcpFeatures = capabilityFeatures(registeredAssistants(enabled), {
                toolSearch: true,
                moduleOperations: true,
              });
              const legacyMcp = legacyFeatures(enabled, "mcp", { toolSearch, fullTools });
              expect(mcpFeatures).toEqual(legacyMcp);
              expect(
                resolveCapabilities(scope, { channel: "mcp", enabled, features: mcpFeatures }).map((t) => t.name),
              ).toEqual(legacyTools(scope, enabled, legacyMcp, exposedToMcp).map((t) => t.name));
              compared++;
            }
    }
    // The matrix is not vacuous: tools differ between roles and channels.
    expect(compared).toBeGreaterThan(400);
    const owner = resolveCapabilities(scopeFor("owner"), {
      channel: "assistant",
      enabled: undefined,
      features: capabilityFeatures(registeredAssistants(), { toolSearch: true, moduleOperations: true }),
    });
    const viewer = resolveCapabilities(scopeFor("viewer"), {
      channel: "assistant",
      enabled: undefined,
      features: capabilityFeatures(registeredAssistants(), { toolSearch: true, moduleOperations: true }),
    });
    expect(owner.length).toBeGreaterThan(viewer.length);
    expect(viewer.length).toBeGreaterThan(0);
  });

  it("hides every tool of a module the member has no access to", () => {
    const owned = (name: string) => registeredToolOwner(name);
    const tools = resolveCapabilities(scopeFor("editor", { marketing: "none" }), {
      channel: "assistant",
      enabled: undefined,
      features: capabilityFeatures(registeredAssistants(), { toolSearch: true, moduleOperations: true }),
    });
    expect(tools.some((tool) => owned(tool.name) === "marketing")).toBe(false);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("runs a tool with the member's role in its module, or the project role when asked", async () => {
    const seen: Scope[] = [];
    const tool = defineTool({
      name: "fixture_capability",
      namespace: "project",
      description: "Fixture.",
      parameters: z.object({ n: z.number().int() }).strict(),
      risk: "R0_read",
      permission: PROJECT_READ,
      deferLoading: false,
      async execute(context, args) {
        seen.push(context.scope);
        return { output: args, cards: [] };
      },
    });
    const context = { scope: scopeFor("viewer"), runId: "r", conversationId: "c", callIndex: 1 };
    // Unregistered: no owner, so the project role applies either way.
    await expect(executeCapability(tool, context, { n: 1 })).resolves.toMatchObject({ output: { n: 1 } });
    await expect(
      executeCapability(tool, context, { n: 1 }, { validate: "tool", roleScope: "project" }),
    ).resolves.toMatchObject({ output: { n: 1 } });
    expect(seen.map((s) => s.role)).toEqual(["viewer", "viewer"]);
    // Host validation refuses before the tool runs; tool validation passes the raw value on.
    await expect(executeCapability(tool, context, { n: "x" }, { validate: "host" })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(seen).toHaveLength(2);
    await expect(executeCapability(tool, context, { n: "x" })).resolves.toMatchObject({ output: { n: "x" } });
  });

  it("refuses a module tool for a member without access to that module", async () => {
    const tool = registeredTools().find((t) => registeredToolOwner(t.name) === "marketing");
    expect(tool).toBeDefined();
    await expect(
      executeCapability(
        { ...tool!, execute: async () => ({ output: "ran", cards: [] }) },
        { scope: scopeFor("editor", { marketing: "none" }), runId: "r", conversationId: "c", callIndex: 1 },
        {},
      ),
    ).rejects.toMatchObject({ code: "MODULE_NOT_AVAILABLE" });
  });
});

describe("capToolOutput", () => {
  it("returns a result that fits unchanged", () => {
    expect(capToolOutput({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(capToolOutput(undefined)).toBe("null");
  });

  it("always returns valid JSON within the cap, marking a cut result", () => {
    const cases: unknown[] = [
      { text: "x".repeat(50_000) },
      { text: '"\\'.repeat(20_000) },
      { rows: Array.from({ length: 2_000 }, (_, i) => ({ i, emoji: "😀", quote: '"' })) },
      " ".repeat(30_000),
    ];
    for (const value of cases) {
      const capped = capToolOutput(value);
      expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      const parsed = JSON.parse(capped);
      expect(parsed.truncated).toBe(true);
      expect(typeof parsed.partial).toBe("string");
      expect(JSON.stringify(value).startsWith(parsed.partial)).toBe(true);
    }
    expect(capToolOutput({ text: "y".repeat(500) }, 100).length).toBeLessThanOrEqual(100);
  });
});
