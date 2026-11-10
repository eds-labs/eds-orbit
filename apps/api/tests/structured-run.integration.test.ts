import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { AgentPrincipal } from "../src/platform/agents/principal.ts";
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
  // A task class whose planned provider is forced (D-11 tests).
  forceAnthropic: null as string | null,
}));
vi.mock("../src/platform/ai/call-plan.ts", async (original) => {
  const real = await original<typeof import("../src/platform/ai/call-plan.ts")>();
  return {
    ...real,
    planCall: async (...args: Parameters<typeof real.planCall>) => {
      const plan = await real.planCall(...args);
      return mocked.forceAnthropic === args[2]
        ? { ...plan, provider: "anthropic" as const }
        : plan;
    },
  };
});
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
    mocked.forceAnthropic = null;
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
    // The tool result went back to the model capped, as valid JSON that says so.
    const toolOutput = mocked.requests[1].input.find((item: any) => item.type === "function_call_output");
    expect(toolOutput.output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(toolOutput.output.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS - 100);
    expect(JSON.parse(toolOutput.output)).toMatchObject({ truncated: true });
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

  it("D-11: blocks customer data on a Claude route with zero reservations and runs it on OpenAI (WP2 D)", async () => {
    const claude = spec({ dataClass: "customer_personal" });
    mocked.forceAnthropic = "pm_analysis";
    expect(await runStructured(scope(), claude)).toMatchObject({
      status: "blocked",
      code: "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
      costMicros: 0,
    });
    expect(mocked.requests).toHaveLength(0);
    expect(await reservations(claude.budget.callKey)).toEqual([]);
    // Financial data likewise; internal data is not bound to a provider.
    const financial = spec({ dataClass: "financial" });
    expect(await runStructured(scope(), financial)).toMatchObject({
      code: "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
    });
    expect(await reservations(financial.budget.callKey)).toEqual([]);
    mocked.forceAnthropic = null;
    const openai = spec({ dataClass: "customer_personal" });
    mocked.replies.push(message({ summary: "done", count: 1 }));
    expect(await runStructured(scope(), openai)).toMatchObject({ status: "ok" });
    expect((await reservations(openai.budget.callKey)).map((r) => r.state)).toEqual(["settled"]);
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
  // ADR 0021 (WP1.3): a configured agent's run checks its principal on every call.
  const agentCatalog = { title: { en: "Fixture", de: "Fixture" }, summary: { en: "Fixture.", de: "Fixture." } };
  const writes: string[] = [];
  const note: OrbitTool = defineTool({
    name: "fixture_note",
    namespace: "fixture",
    description: "Stores a note.",
    parameters: z.object({ text: z.string() }).strict(),
    risk: "W0_internal",
    permission: PROJECT_WRITE,
    deferLoading: false,
    exposure: { agent: true },
    outputSchema: z.object({ stored: z.boolean() }),
    catalog: agentCatalog,
    async execute(_context, args) {
      writes.push((args as { text: string }).text);
      return { output: { stored: true }, cards: [] };
    },
  });
  const agentLookup: OrbitTool = { ...lookup, exposure: { agent: true }, outputSchema: z.object({ text: z.string() }), catalog: agentCatalog };
  const principal = (extra: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
    kind: "agent",
    userId: project.editor.userId,
    agentId: randomUUID(),
    agentVersion: 1,
    workOrderId: randomUUID(),
    depth: 0,
    allow: { tools: new Set(["fixture_note", "fixture_lookup"]), modules: new Set(), mode: "execute", knowledge: null },
    ceilingMicros: 1_000_000,
    ...extra,
  });

  it("runs W0 tools for a principal in execute mode and logs each step", async () => {
    writes.length = 0;
    const steps: unknown[] = [];
    mocked.replies.push(call("fixture_note", { text: "a" }), message({ summary: "done", count: 1 }));
    const result = await runStructured(scope(), spec({ tools: [note], principal: { agent: principal() }, onStep: (step) => void steps.push(step) }));
    expect(result).toMatchObject({ status: "ok" });
    expect(writes).toEqual(["a"]);
    expect(steps).toEqual([{ index: 1, tool: "fixture_note", risk: "W0_internal", outcome: "succeeded" }]);
  });

  it("stops the whole run on a refused principal call, and nothing runs (scenario D)", async () => {
    writes.length = 0;
    // Draft mode may not write internally.
    mocked.replies.push(call("fixture_note", { text: "b" }), message({ summary: "x", count: 0 }));
    const draft = await runStructured(scope(), spec({ tools: [note], principal: { agent: principal({ allow: { ...principal().allow, mode: "draft" } }) } }));
    expect(draft).toMatchObject({ status: "blocked", code: "AGENT_PRINCIPAL_FORBIDDEN" });
    expect(writes).toEqual([]);
    // The run stopped before asking for its final answer.
    expect(mocked.replies).toHaveLength(1);
    mocked.replies.length = 0;
    // The sponsor is demoted between the first and the second tool call.
    const demoting: OrbitTool = {
      ...agentLookup,
      async execute() {
        await authDb.projectMember.update({
          where: { projectId_userId: { projectId: scope().projectId, userId: project.editor.userId } },
          data: { role: "viewer" },
        });
        return { output: { text: "read" }, cards: [] };
      },
    };
    mocked.replies.push(call("fixture_lookup", { size: 1 }), call("fixture_note", { text: "c" }), message({ summary: "x", count: 0 }));
    try {
      const steps: Array<{ tool: string; code?: string }> = [];
      const demoted = await runStructured(scope(), spec({ tools: [demoting, note], principal: { agent: principal() }, onStep: (st) => void steps.push(st) }));
      expect(demoted).toMatchObject({ status: "blocked", code: "AGENT_PRINCIPAL_FORBIDDEN" });
      expect(writes).toEqual([]);
      expect(steps.map((st) => [st.tool, st.code])).toEqual([
        ["fixture_lookup", undefined],
        ["fixture_note", "AGENT_PRINCIPAL_FORBIDDEN"],
      ]);
      // The run stopped: the final answer was never requested.
      expect(mocked.replies).toHaveLength(1);
      mocked.replies.length = 0;
    } finally {
      await authDb.projectMember.update({
        where: { projectId_userId: { projectId: scope().projectId, userId: project.editor.userId } },
        data: { role: "editor" },
      });
    }
    // The work order's own check (a changed agent version) stops it too.
    mocked.replies.push(call("fixture_note", { text: "d" }), message({ summary: "x", count: 0 }));
    const changed = await runStructured(scope(), spec({
      tools: [note],
      principal: { agent: principal(), current: async () => { throw new DomainError("AGENT_VERSION_CHANGED", 409); } },
    }));
    expect(changed).toMatchObject({ status: "blocked", code: "AGENT_VERSION_CHANGED" });
    expect(writes).toEqual([]);
    mocked.replies.length = 0;
  });

  it("stops when its cancellation signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    mocked.replies.push(message({ summary: "x", count: 0 }));
    const result = await runStructured(scope(), spec({ signal: controller.signal }));
    expect(result.status).not.toBe("ok");
    mocked.replies.length = 0;
  });
});
