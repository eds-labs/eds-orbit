import { createHash } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const create = vi.hoisted(() => vi.fn());
vi.mock("openai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  default: class {
    responses = { create };
  },
}));

import { generate } from "../../../../../../packages/ai/src/index.ts";
import { configurationTools } from "../../../platform/configuration/configuration.ts";
import {
  responsesTool,
  type OrbitTool,
} from "../../../platform/agents/tools/registry.ts";
import { strategySpecialistFor } from "../agents/specialists/strategy.ts";
import { assignmentTools } from "../tools/assignment-tools.ts";

// CS-D6 (R64): with ORBIT_CREATIVE_STUDIO off, the prompts and tool schemas the
// Creative Studio touched do not change with the flag (SHA-256 of their JSON).
// The draft, configuration and strategy answer schema hashes are byte for byte
// the merge base ad29a197. The strategy instructions and assignment tool
// schema include the 2026-11-07 daily social automation changes. Both prompts
// also include the 2026-11-27 assignment fix for full verified facts and a
// single approved CTA. These changes apply regardless of the Creative Studio flag.
const EXPECTED = {
  draftInstructions:
    "da9fd99acfd4a58ae9c3f2f6929df98f5c5f7180987e5a4aeee226fbdc15c59a",
  draftSchema:
    "1d377f83216d8f0bde5f5117fe034ff2f3ccdd13dd448ae8351cade7bbc91181",
  strategyInstructions:
    "8e3d24817c13503c66112f746cec9e5c5a2276905f6b4bb12b483a5120f0abca",
  strategySchema:
    "5f4c6960138bec2fdf93ea547899c5220ffaeda59fe378f314814a681b73d71a",
  // Changed on purpose 2026-11-07: the banner field's description no longer
  // names one brand's look as the default (brand banners from the project's
  // brand kit, docs/plans/marketing-brand-banners-and-draft-decisions.md),
  // and the daily social automation added `retry` and `historyDays`.
  assignmentTools:
    "ce8cce496a6806e3b909e5dbfa8a329f21b7f44e401cdc2763ddd806c91d03c9",
  configurationUpdate:
    "0e3a3f31320594924d8a0e4e9011251493b76815f6329ee60aada20cef2b946a",
};

// The configuration the API needs to start, so the flag can be read without a local env file.
const REQUIRED = {
  DATABASE_URL: "postgresql://a@b/c",
  AUTH_DATABASE_URL: "postgresql://a@b/c",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(32),
  ORBIT_SETUP_TOKEN: "y".repeat(20),
  CREDENTIAL_KEY: "0".repeat(64),
};

const sha = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

/** A tool as the model (strict parameters) and MCP clients (input JSON schema) see it. */
const toolJson = (tool: OrbitTool) => ({
  name: tool.name,
  description: tool.description,
  responses: responsesTool(tool).parameters,
  mcp: z.toJSONSchema(tool.parameters, { io: "input" }),
});

/** The instructions and JSON schema of a plain draft request. */
async function draftRequest() {
  create.mockReset().mockResolvedValue({
    id: "response",
    output_text: JSON.stringify({ title: "t", body: "b", claims: [] }),
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
  await generate({
    task: "draft",
    goal: "g",
    evidence: {},
    route: { model: "m", maxOutputTokens: 1800 },
    reservationId: "r",
    runtime: {
      apiKey: "test-key",
      verifiedModels: ["m"],
      rateCard: {
        m: {
          inputMicrosPerMillion: 1,
          outputMicrosPerMillion: 1,
          verifiedAt: new Date().toISOString(),
        },
      },
    },
  });
  const body = create.mock.calls[0]![0];
  return { instructions: body.instructions, schema: body.text.format };
}

/** The strategy's instructions and answer schema for a task input. */
function strategy(input: unknown) {
  const specialist = strategySpecialistFor(input);
  const { $schema: _schema, ...schema } = zodTextFormat(
    specialist.outputSchema,
    "orbit_agent_output",
  ).schema as Record<string, unknown>;
  return { instructions: specialist.instructions, schema };
}

describe("Creative Studio off: baseline prompts and tool schemas", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(REQUIRED))
      vi.stubEnv(name, process.env[name] ?? value);
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the draft instructions and the draft JSON schema", async () => {
    const request = await draftRequest();
    expect(sha(request.instructions)).toBe(EXPECTED.draftInstructions);
    expect(sha(request.schema)).toBe(EXPECTED.draftSchema);
    expect(JSON.stringify(request.schema)).not.toMatch(
      /banner|creative|coreMessage|hook/,
    );
  });

  it("keeps the strategy's instructions and answer schema, whatever the task carries", () => {
    for (const input of [
      {},
      { assignment: { creative: { artPer: "post" } } },
    ]) {
      const plain = strategy(input);
      expect(sha(plain.instructions)).toBe(EXPECTED.strategyInstructions);
      expect(sha(plain.schema)).toBe(EXPECTED.strategySchema);
    }
  });

  it("keeps the assignment tools' JSON schemas", () => {
    expect(sha(assignmentTools.map(toolJson))).toBe(EXPECTED.assignmentTools);
  });

  it("keeps the MCP configuration update tool's JSON schema and description", () => {
    const tool = configurationTools.find(
      (candidate) => candidate.name === "project_configuration_update",
    )!;
    expect(sha(toolJson(tool))).toBe(EXPECTED.configurationUpdate);
  });

  // R65: the switch alone changes no prompt; a task without a creative (the
  // runner passes one only for a project that opted in) stays as before.
  it("keeps the strategy with the switch on for a task without a creative", () => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    const plain = strategy({ assignment: {} });
    expect(sha(plain.instructions)).toBe(EXPECTED.strategyInstructions);
    expect(sha(plain.schema)).toBe(EXPECTED.strategySchema);
  });
});
