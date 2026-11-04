import { describe, expect, it } from "vitest";
import {
  modePermits,
  narrowsAllow,
  type AgentAllow,
} from "../src/platform/agents/principal.ts";
import {
  agentExposureIssue,
  defineTool,
  exposedToAgent,
} from "../src/platform/agents/tools/registry.ts";
import { z } from "zod";
import { PROJECT_READ } from "../src/platform/tenancy/permissions.ts";

describe("agent principal (WP1.2)", () => {
  it("lets each mode use exactly its risks", () => {
    const table = {
      read: { R0_read: true, P_proposal: false, W0_internal: false },
      draft: { R0_read: true, P_proposal: true, W0_internal: false },
      execute: { R0_read: true, P_proposal: true, W0_internal: true },
    } as const;
    for (const [mode, risks] of Object.entries(table))
      for (const [risk, allowed] of Object.entries(risks))
        expect(modePermits(mode as any, risk as any), `${mode}/${risk}`).toBe(allowed);
  });

  it("narrows monotonically: tools, modules, mode and knowledge only shrink", () => {
    const parent: AgentAllow = {
      tools: new Set(["a", "b"]),
      modules: new Set(["support"]),
      mode: "draft",
      knowledge: { sourceIds: ["s1", "s2"] },
    };
    const ok: AgentAllow = { ...parent, tools: new Set(["a"]), knowledge: { sourceIds: ["s1"] } };
    expect(narrowsAllow(parent, ok)).toBe(true);
    expect(narrowsAllow(parent, { ...ok, tools: new Set(["a", "c"]) })).toBe(false);
    expect(narrowsAllow(parent, { ...ok, modules: new Set(["support", "work"]) })).toBe(false);
    expect(narrowsAllow(parent, { ...ok, mode: "execute" })).toBe(false);
    expect(narrowsAllow(parent, { ...ok, mode: "read" })).toBe(true);
    expect(narrowsAllow(parent, { ...ok, knowledge: null })).toBe(false);
    expect(narrowsAllow(parent, { ...ok, knowledge: { sourceIds: ["s3"] } })).toBe(false);
    expect(narrowsAllow(parent, { ...ok, knowledge: {} })).toBe(false);
    expect(narrowsAllow({ ...parent, knowledge: null }, { ...ok, knowledge: null })).toBe(true);
  });

  it("exposes a tool to agents only with an object output schema and a catalogue entry", () => {
    const base = {
      name: "fixture_agent_tool",
      namespace: "project",
      description: "Fixture.",
      parameters: z.object({}).strict(),
      risk: "R0_read" as const,
      permission: PROJECT_READ,
      deferLoading: false,
      execute: async () => ({ output: {}, cards: [] }),
    };
    const catalog = {
      title: { en: "Fixture", de: "Fixture" },
      summary: { en: "Reads.", de: "Liest." },
    };
    expect(() => defineTool({ ...base, exposure: { agent: true } })).toThrow(
      "TOOL_AGENT_OUTPUT_SCHEMA_REQUIRED:fixture_agent_tool",
    );
    expect(() =>
      defineTool({ ...base, exposure: { agent: true }, outputSchema: z.object({}) }),
    ).toThrow("TOOL_AGENT_CATALOG_REQUIRED:fixture_agent_tool");
    expect(
      agentExposureIssue({
        ...base,
        exposure: { agent: true },
        outputSchema: z.object({}),
        catalog,
        idempotent: "by_call",
      }),
    ).toBe("TOOL_IDEMPOTENT_RISK:fixture_agent_tool");
    const tool = defineTool({ ...base, exposure: { agent: true }, outputSchema: z.object({}), catalog });
    expect(exposedToAgent(tool)).toBe(true);
    expect(exposedToAgent(defineTool(base))).toBe(false);
  });
});
