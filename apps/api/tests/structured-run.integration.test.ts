import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import { DomainError } from "../src/shared.ts";
import { PROJECT_READ, PROJECT_WRITE } from "../src/platform/tenancy/permissions.ts";
import { defineTool, type OrbitTool } from "../src/platform/agents/tools/registry.ts";
import {
  MAX_TOOL_OUTPUT_CHARS,
  runStructured,
  type StructuredRunSpec,
} from "../src/platform/agents/structured-run.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createPackageProject } from "./support/package-project.ts";

registerModules();

// Each queued reply is the provider's output items for one call, or an
// error the call throws. No test reaches a provider.
const mocked = vi.hoisted(() => ({
  replies: [] as Array<unknown[] | Error>,
  requests: [] as any[],
  // The next answer stops at the output limit.
  truncated: false,
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.requests.push(structuredClone({ input: request.input, tools: request.tools }));
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    if (next instanceof Error) throw next;
    return {
      output: next,
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 7,
      },
      responseId: `resp_${randomUUID()}`,
      truncated: mocked.truncated,
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const message = (value: unknown) => [
  {
    type: "message",
    role: "assistant",
    content: [
      { type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  },
];
const call = (name: string, args: unknown) => [
  { type: "function_call", call_id: `call_${randomUUID()}`, name, arguments: JSON.stringify(args) },
];

const answer = z.object({ summary: z.string(), count: z.number() }).strict();
const lookup: OrbitTool = defineTool({
  name: "fixture_lookup",
  namespace: "fixture",
  description: "Looks something up.",
  parameters: z.object({ size: z.number() }).strict(),
  risk: "R0_read",
  permission: PROJECT_READ,
  deferLoading: false,
  async execute(_context, args) {
    return { output: { text: "x".repeat((args as { size: number }).size) }, cards: [] };
  },
});

/**
 * The platform's structured run (ADR 0017 P-2): read tools only, strict
 * answers, the paid path per call, and nothing sent twice.
 */
describe.skipIf(!enabled)("structured runs", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const scope = () => project.owner;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope().workspaceId, scope().projectId, fn);
  const spec = (overrides: Partial<StructuredRunSpec<z.infer<typeof answer>>> = {}) => {
    const key = randomUUID();
    return {
      agentName: "fixture.structured",
      taskClass: "pm_analysis" as const,
      kind: "work_pm" as const,
      subject: { type: "fixture.subject", id: randomUUID() },
      instructions: "Summarize.",
      input: { text: "Some input" },
      tools: [lookup],
      outputSchema: answer,
      limits: { maxModelCalls: 3, maxToolCalls: 3, maxWebSearches: 0, timeoutMs: 10_000, maxInputBytes: 64_000 },
      budget: { category: "fixture_structured", runKey: `fixture:${key}`, callKey: `fixture:${key}` },
      ...overrides,
    } satisfies StructuredRunSpec<z.infer<typeof answer>>;
  };
  const reservations = (callKey: string) =>
    run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: scope().projectId, key: { startsWith: `${scope().projectId}:${callKey}:` } },
        orderBy: { key: "asc" },
      }),
    );

  beforeAll(async () => {
    project = await createPackageProject({ name: "Synthetic structured run" });
  });
  beforeEach(() => {
    mocked.replies.length = 0;
    mocked.requests.length = 0;
    mocked.truncated = false;
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  it("returns a parsed answer, settles each call and records the run", async () => {
    const s = spec();
    mocked.replies.push(call("fixture_lookup", { size: 50_000 }), message({ summary: "done", count: 2 }));
    const result = await runStructured(scope(), s);
    expect(result).toMatchObject({ status: "ok", output: { summary: "done", count: 2 }, costMicros: 14 });
    // The tool result went back to the model cut at the cap.
    const toolOutput = mocked.requests[1].input.find((item: any) => item.type === "function_call_output");
    expect(toolOutput.output.length).toBe(MAX_TOOL_OUTPUT_CHARS);
    const rows = await reservations(s.budget.callKey);
    expect(rows.map((r) => [r.key, r.state, Number(r.settledMicros)])).toEqual([
      [`${scope().projectId}:${s.budget.callKey}:0`, "settled", 7],
      [`${scope().projectId}:${s.budget.callKey}:1`, "settled", 7],
    ]);
    const agentRun = await run((tx) => tx.agentRun.findFirstOrThrow({ where: { id: result.agentRunId! } }));
    expect(agentRun).toMatchObject({ kind: "work_pm", status: "succeeded", subjectId: s.subject.id, taskClass: "pm_analysis" });
  });

  it("refuses write tools and tools the member may not use before anything runs", async () => {
    const write = { ...lookup, name: "fixture_write", risk: "W0_internal" as const };
    await expect(runStructured(scope(), spec({ tools: [write] }))).rejects.toThrow("STRUCTURED_RUN_TOOL_RISK");
    const owned = { ...lookup, permission: PROJECT_WRITE };
    await expect(runStructured(project.viewer, spec({ tools: [owned] }))).rejects.toThrow("STRUCTURED_RUN_TOOL_FORBIDDEN");
    expect(mocked.requests).toHaveLength(0);
  });

  it("fails an invalid answer with its cost settled and never asks again", async () => {
    const s = spec();
    mocked.replies.push(message({ summary: "no count" }));
    expect(await runStructured(scope(), s)).toMatchObject({ status: "failed", code: "AGENT_OUTPUT_INVALID", costMicros: 7 });
    expect(mocked.requests).toHaveLength(1);
    expect((await reservations(s.budget.callKey)).map((r) => r.state)).toEqual(["settled"]);
  });

  it("names an answer cut off at the output limit, with its cost settled", async () => {
    const s = spec();
    mocked.truncated = true;
    mocked.replies.push(message('{"summary":"cut'));
    expect(await runStructured(scope(), s)).toMatchObject({ status: "failed", code: "AGENT_OUTPUT_LIMIT", costMicros: 7 });
    expect((await reservations(s.budget.callKey)).map((r) => r.state)).toEqual(["settled"]);
  });

  it("keeps an unclear call unknown and a repeated attempt from sending it again", async () => {
    const s = spec();
    mocked.replies.push(new Error("socket hang up"));
    expect(await runStructured(scope(), s)).toMatchObject({ status: "outcome_unknown", code: "AGENT_OUTCOME_UNKNOWN" });
    expect((await reservations(s.budget.callKey)).map((r) => [r.state, r.settledMicros])).toEqual([["unknown", null]]);
    // The job's retry uses the same call key: nothing is sent.
    expect(await runStructured(scope(), s)).toMatchObject({ status: "outcome_unknown" });
    expect(mocked.requests).toHaveLength(1);
  });

  it("blocks oversized input and the caller's own ceiling before any reservation", async () => {
    const big = spec({ input: { text: "y".repeat(70_000) } });
    expect(await runStructured(scope(), big)).toMatchObject({ status: "blocked", code: "AGENT_CONTEXT_LIMIT", costMicros: 0 });
    const capped = spec({
      budget: {
        ...spec().budget,
        async check() {
          throw new DomainError("FIXTURE_CEILING", 409);
        },
      },
    });
    expect(await runStructured(scope(), capped)).toMatchObject({ status: "blocked", code: "FIXTURE_CEILING" });
    expect(mocked.requests).toHaveLength(0);
    expect(await reservations(capped.budget.callKey)).toEqual([]);
  });

  it("stops at its call limits and when its guard refuses", async () => {
    mocked.replies.push(call("fixture_lookup", { size: 1 }), call("fixture_lookup", { size: 1 }), call("fixture_lookup", { size: 1 }));
    expect(await runStructured(scope(), spec())).toMatchObject({ status: "failed", code: "AGENT_LIMIT" });
    const guarded = spec({
      async guard() {
        throw new DomainError("FIXTURE_GONE", 409);
      },
    });
    expect(await runStructured(scope(), guarded)).toMatchObject({ status: "failed", code: "FIXTURE_GONE" });
  });

  it("offers web search only when asked, prices it and returns its sources", async () => {
    mocked.replies.push(message({ summary: "a", count: 1 }));
    await runStructured(scope(), spec());
    expect(mocked.requests[0].tools.some((t: any) => t.type === "web_search")).toBe(false);
    mocked.replies.push([
      { type: "web_search_call", action: { sources: [{ url: "https://example.org/a#x" }] } },
      ...message({ summary: "b", count: 2 }),
    ]);
    const searched = await runStructured(
      scope(),
      spec({ webSearch: true, limits: { ...spec().limits, maxWebSearches: 2 } }),
    );
    expect(mocked.requests[1].tools.some((t: any) => t.type === "web_search")).toBe(true);
    expect(searched).toMatchObject({ status: "ok", sources: ["https://example.org/a"] });
  });
});
