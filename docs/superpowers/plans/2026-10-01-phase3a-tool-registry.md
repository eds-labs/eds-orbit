# Phase 3a — Agent Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare every Orbit Chat tool once in a registry with a zod parameter schema, send strict (`strict: true`) function definitions generated from that schema, offer each tool only to the roles allowed to use it, and keep every user-visible chat behaviour unchanged.

**Architecture:** A small registry module (`apps/api/src/modules/agents/tools/`) holds `OrbitTool` definitions. Model-facing JSON schemas are generated with the pinned `openai` SDK helper `zodResponsesFunction`, which enforces the strict-mode rules (every property required, optional fields expressed as `nullable`). Tool execution delegates to the existing implementations (`runReadTool`, `validateReadToolResult`, `createProposal`); null placeholders are dropped before those server contracts run, so their validation stays authoritative and unchanged. `chat-runner.ts` builds its tool list and dispatch from the registry.

**Tech Stack:** TypeScript 6, Node 24.18.0, Fastify 5, zod 4.6.5, `openai` 7.25.0 (`openai/helpers/zod`), Vitest 5, Prisma 7.10 + PostgreSQL 17.

**Spec:** `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §6.2 (tool taxonomy), §6.4 (tool search, design only), §9.5 rule 3 (availability per run); `docs/adr/0007-tool-registry.md` decisions 1–4 and 6.

**Base:** branch `claude/orbit-phase3a-tool-registry` from `main` at `10c69d2` or later.

## Phase 3 split

Phase 3 of the alignment plan (§13) covers three independent subsystems. Each gets its own plan so each can be reviewed, released and rolled back alone:

| Part | Content | Plan |
| --- | --- | --- |
| **3a** | Tool registry, strict schemas, per-role availability | this document |
| **3b** | `ActionRequest` table (additive migration), risk classes and approval modes as code constants, configurable expiry per action type, first adapter: content publication approvals (`policy.ts`, today a fixed 24 h); fixes `project_status.approvals`, which filters on a status nothing writes | follows after 3a is accepted |
| **3c** | Agents SDK spike: `@openai/agents` 0.18.0 exact pin (D1), `AgentRuntime` port, `BudgetedModel`, Prisma session and run-state store, Postgres trace processor, behind a per-project runtime flag; documented go/no-go for G1–G7 | follows after 3a; consumes the registry |

Order: 3a → 3c → 3b is also possible; 3b and 3c do not depend on each other.

## Global Constraints

- Node 24.18.0; run commands with the local env sourced from `../../../.runtime/local.env` (never printed).
- Local only. No production deployment, migration, paid call or provider write. No new dependency (`openai/helpers/zod` ships with the pinned `openai` 7.25.0).
- Tool names stay exactly `project_status`, `knowledge_search`, `approved_assets`, `analytics_memory`, `propose_campaign` (the system prompt and tests reference them; OpenAI function names may not contain dots, so the namespace is registry metadata, not part of the name).
- Server-side validation stays authoritative and unchanged: `runReadTool`'s zod inputs, `validateReadToolResult` (12,000-byte cap) and `createProposal` → `proposeInput` → `missionSchema`.
- Run limits unchanged: 6 model calls, 8 tool calls, 32,000 input bytes, 8,000 output characters, tool output sliced to 12,000 characters.
- Span names stay from the fixed set of registered names, otherwise `unknown_tool`; the model-supplied name is never stored.
- Out of scope (later parts): `requires` (capability/policy/connector), `costCategory`, output schemas beyond today's read-result validation, tool search, new tools, `ActionRequest`.
- English docs and comments. Required checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check`.

## Risk Analysis

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Strict mode makes the model fill every field; optional fields arrive as `null` | Server validation rejects `null` where it expects an absent field | `dropNullFields` before every server contract; test per tool that `null` behaves like omission |
| Generated schemas are larger than the hand-written ones | Runs hit `CHAT_CONTEXT_LIMIT` earlier | `$schema` removed; model-facing schemas use plain strings like today (no uuid/date-time patterns); byte budget test |
| Proposal quality changes under strict mode | Worse proposals in live use | Same field set and descriptions as today; server re-validation unchanged; first live chat after release is an owner acceptance check |
| Viewer loses the proposal tool | Model can no longer try a call that always failed | Intended by ADR 0007 §4; execution still refuses viewers (`EDITOR_REQUIRED`) |

Rollback: revert the merge commit. No schema, data or configuration change.

## Review Focus

1. The model sends `null` for an optional field (`factKeys`, `approved_assets.query`, `analytics_memory.campaign`, `mission.product`, `mission.allowedTopics`, `mission.assetIds`) → identical behaviour and identical proposal payload hash as when the field is omitted. *(Tasks 2 and 3 tests.)*
2. A viewer runs chat → `propose_campaign` is not offered; if a forged call arrives anyway it is still refused with `EDITOR_REQUIRED`. *(Task 4 tests.)*
3. The model invents a tool name or calls a tool its role was not offered → `{error:"CHAT_TOOL_NOT_ALLOWED"}` returned to the model, span name `unknown_tool` for unknown names. *(Task 4 tests plus the existing "records a generic span name" test.)*
4. Tool definitions grow → total tool JSON stays at or below 5,500 bytes so the 32,000-byte input cap is not reached earlier in practice. *(Task 4 test.)*
5. A registry entry uses `.optional()`/`.default()` without `.nullable()` → registry construction fails at import, not at the first live call. *(Task 1 test.)*

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/src/modules/agents/tools/registry.ts` (new) | `OrbitTool` type, `defineTool`, `responsesTool`, `availableTools`, `findTool`, `dropNullFields` |
| `apps/api/src/modules/agents/tools/registry.test.ts` (new) | Unit tests for the registry helpers |
| `apps/api/src/modules/agents/tools/read-tools.ts` (new) | Registry entries for the four read tools, delegating to `chat-tools.ts` |
| `apps/api/src/modules/agents/tools/proposal-tools.ts` (new) | Registry entry for `propose_campaign`, delegating to `createProposal` |
| `apps/api/src/modules/agents/tools/index.ts` (new) | `chatTools` (the ordered registry used by chat) |
| `apps/api/src/modules/chat-tools.ts` | Remove `readToolDefinitions` (moved into the registry); `runReadTool` and `validateReadToolResult` unchanged |
| `apps/api/src/modules/chat-runner.ts` | Remove `proposalTool` and `KNOWN_TOOL_NAMES` literal; build tools and dispatch from the registry |
| `apps/api/tests/chat-runner.integration.test.ts` | New tests for strict definitions, viewer availability, byte budget, null handling |
| `docs/ORBIT_CHAT_V1.md`, `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §17, `docs/IMPLEMENTATION_STATUS.md` | Documentation |

---

### Task 1: Registry core

**Files:**
- Create: `apps/api/src/modules/agents/tools/registry.ts`
- Test: `apps/api/src/modules/agents/tools/registry.test.ts`

**Interfaces:**
- Produces:
  - `type ToolRole = Scope["role"]`
  - `type ToolContext = { scope: Scope; runId: string; conversationId: string; callIndex: number }`
  - `type ToolResult = { output: unknown; cards: ChatCard[] }`
  - `type OrbitTool = { name; namespace; description; parameters: z.ZodObject; risk: "R0_read" | "W0_internal" | "P_proposal"; roles: readonly ToolRole[]; deferLoading: boolean; execute(context: ToolContext, args: unknown): Promise<ToolResult> }`
  - `defineTool(tool: OrbitTool): OrbitTool` — throws `TOOL_NAME_INVALID` or the SDK's strict-schema error
  - `responsesTool(tool: OrbitTool): { type: "function"; name: string; description: string; strict: true; parameters: Record<string, unknown> }`
  - `availableTools(registry: readonly OrbitTool[], role: ToolRole): OrbitTool[]`
  - `findTool(registry: readonly OrbitTool[], name: unknown): OrbitTool | undefined`
  - `dropNullFields(value: unknown): unknown`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/agents/tools/registry.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/modules/agents/tools/registry.ts
/**
 * Agent tool registry (ADR 0007). Every tool is declared once; the
 * model-facing strict JSON schema is generated from its zod parameters by
 * the pinned openai SDK, which rejects schemas strict mode cannot express.
 */
import type { z } from "zod";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { ChatCard } from "../../chat-tools.ts";

export type ToolRole = Scope["role"];
export type ToolNamespace =
  | "project"
  | "knowledge"
  | "content"
  | "brand"
  | "assets"
  | "analytics"
  | "calendar"
  | "drive"
  | "research"
  | "proposals";
// Agents never receive tools with external or irreversible effects.
export type ToolRisk = "R0_read" | "W0_internal" | "P_proposal";
export type ToolContext = {
  scope: Scope;
  runId: string;
  conversationId: string;
  // 1-based position of this call within the run.
  callIndex: number;
};
export type ToolResult = { output: unknown; cards: ChatCard[] };
export type OrbitTool = {
  name: string;
  namespace: ToolNamespace;
  description: string;
  parameters: z.ZodObject;
  risk: ToolRisk;
  roles: readonly ToolRole[];
  // Design for tool search (plan §6.4); unused until it is enabled.
  deferLoading: boolean;
  execute(context: ToolContext, args: unknown): Promise<ToolResult>;
};

// The function API accepts [a-zA-Z0-9_-]{1,64}; Orbit uses lower snake case.
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function responsesTool(tool: OrbitTool) {
  const generated = zodResponsesFunction({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  const { $schema: _schema, ...parameters } = generated.parameters as Record<
    string,
    unknown
  >;
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    strict: true as const,
    parameters,
  };
}

/** Validates a tool at import time, so a bad schema never reaches a paid call. */
export function defineTool(tool: OrbitTool): OrbitTool {
  if (!TOOL_NAME.test(tool.name)) throw new Error("TOOL_NAME_INVALID");
  responsesTool(tool);
  return tool;
}

export function availableTools(
  registry: readonly OrbitTool[],
  role: ToolRole,
): OrbitTool[] {
  return registry.filter((tool) => tool.roles.includes(role));
}

export function findTool(
  registry: readonly OrbitTool[],
  name: unknown,
): OrbitTool | undefined {
  return typeof name === "string"
    ? registry.find((tool) => tool.name === name)
    : undefined;
}

/**
 * Strict tool calls send null for every optional field the model leaves
 * empty; the server contracts expect such fields to be absent.
 */
export function dropNullFields(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      item !== null && typeof item === "object" ? dropNullFields(item) : item,
    );
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNullFields(field)]),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: PASS (5 tests). If the exact `parameters` object differs only in key order, keep the assertion with `toEqual` (order-insensitive); if the SDK emits additional keywords, update the expected object to the SDK's output and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/tools/registry.ts apps/api/src/modules/agents/tools/registry.test.ts
git commit -m "feat: add the agent tool registry with strict schema generation"
```

---

### Task 2: Read tools in the registry

**Files:**
- Create: `apps/api/src/modules/agents/tools/read-tools.ts`
- Test: `apps/api/src/modules/agents/tools/registry.test.ts` (append)

**Interfaces:**
- Consumes: `defineTool`, `dropNullFields`, `OrbitTool`, `ToolContext` (Task 1); `runReadTool(scope, name, raw, trusted?)`, `validateReadToolResult(name, result, cards)` from `chat-tools.ts` (unchanged).
- Produces: `readTools: readonly OrbitTool[]` in order `project_status`, `knowledge_search`, `approved_assets`, `analytics_memory`.

- [ ] **Step 1: Write the failing test** (append to `registry.test.ts`)

```ts
import { vi } from "vitest";
const read = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../chat-tools.ts", () => ({
  runReadTool: vi.fn(async (...args: unknown[]) => {
    read.calls.push(args);
    return { result: { ok: true }, cards: [] };
  }),
  validateReadToolResult: vi.fn((_name: string, result: unknown, cards: unknown[]) => ({
    result,
    cards,
  })),
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
        { retrievalJobKey: "chat:run-1:knowledge:3", budgetRunKey: "chat:run-1" },
      ],
      [scope, "approved_assets", {}, undefined],
      [scope, "analytics_memory", {}, undefined],
      [scope, "project_status", {}, undefined],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: FAIL — cannot resolve `./read-tools.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/modules/agents/tools/read-tools.ts
import { z } from "zod";
import { runReadTool, validateReadToolResult } from "../../chat-tools.ts";
import {
  defineTool,
  dropNullFields,
  type OrbitTool,
  type ToolContext,
} from "./registry.ts";

const everyone = ["viewer", "editor", "owner"] as const;

// Model-facing shapes only; runReadTool's own zod inputs stay authoritative.
function readTool(
  name: string,
  namespace: OrbitTool["namespace"],
  description: string,
  parameters: z.ZodObject,
): OrbitTool {
  return defineTool({
    name,
    namespace,
    description,
    parameters,
    risk: "R0_read",
    roles: everyone,
    deferLoading: false,
    async execute(context: ToolContext, args: unknown) {
      const read = await runReadTool(
        context.scope,
        name,
        dropNullFields(args),
        name === "knowledge_search"
          ? {
              retrievalJobKey: `chat:${context.runId}:knowledge:${context.callIndex}`,
              budgetRunKey: `chat:${context.runId}`,
            }
          : undefined,
      );
      const checked = validateReadToolResult(name, read.result, read.cards);
      return { output: checked.result, cards: checked.cards };
    },
  });
}

export const readTools: readonly OrbitTool[] = [
  readTool(
    "project_status",
    "project",
    "Read the current project, policy, open approvals, blockers, and available channels.",
    z.object({}).strict(),
  ),
  readTool(
    "knowledge_search",
    "knowledge",
    "Find current model-authorized public Verified Facts and Knowledge with source references. When an exact Verified Fact key is known, pass factKeys to avoid unrelated fact context.",
    z
      .object({
        query: z.string().min(1).max(2000),
        factKeys: z.array(z.string().min(1).max(160)).max(8).nullable(),
      })
      .strict(),
  ),
  readTool(
    "approved_assets",
    "assets",
    "Find approved brand assets in this project. Empty query lists all. Return metadata, never asset bytes or credentials.",
    z.object({ query: z.string().max(120).nullable() }).strict(),
  ),
  readTool(
    "analytics_memory",
    "analytics",
    "Summarize existing metrics, insights, and confirmed preferences as observations, not verified product facts.",
    z.object({ campaign: z.string().max(200).nullable() }).strict(),
  ),
];
```

The descriptions are copied verbatim from `readToolDefinitions` in `apps/api/src/modules/chat-tools.ts:39-88` (which has no per-property descriptions). Leave `readToolDefinitions` in place for now; Task 4 deletes it together with its last import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: PASS (7 tests). `pnpm typecheck` passes (nothing is removed yet).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/tools/read-tools.ts apps/api/src/modules/agents/tools/registry.test.ts
git commit -m "feat: declare the chat read tools in the registry"
```

---

### Task 3: Proposal tool in the registry

**Files:**
- Create: `apps/api/src/modules/agents/tools/proposal-tools.ts`
- Create: `apps/api/src/modules/agents/tools/index.ts`
- Test: `apps/api/src/modules/agents/tools/registry.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers; `createProposal(scope, conversationId, raw)` from `chat.ts` (unchanged).
- Produces: `proposalTools: readonly OrbitTool[]` (`propose_campaign`, roles editor/owner, risk `P_proposal`); `chatTools: readonly OrbitTool[]` = `[...readTools, ...proposalTools]` from `index.ts`.

- [ ] **Step 1: Write the failing test** (append to `registry.test.ts`)

```ts
const proposals = vi.hoisted(() => ({ raw: [] as unknown[] }));
vi.mock("../../chat.ts", () => ({
  createProposal: vi.fn(async (_scope: unknown, _conversationId: string, raw: unknown) => {
    proposals.raw.push(raw);
    return { id: "p1", version: 1, payloadHash: "h", status: "proposed", payload: {} };
  }),
}));
import { proposalTools } from "./proposal-tools.ts";
import { chatTools } from "./index.ts";

describe("proposal tool", () => {
  const owner = { workspaceId: "w", projectId: "p", userId: "u", role: "owner" as const };
  const propose = proposalTools[0]!;
  const definition = responsesTool(propose);
  const mission = (definition.parameters as any).properties.mission;
  it("keeps the mission field set, requires every field and is editor-only", () => {
    expect(propose.name).toBe("propose_campaign");
    expect(propose.roles).toEqual(["editor", "owner"]);
    expect(propose.risk).toBe("P_proposal");
    expect((definition.parameters as any).required).toEqual(["mission", "factIds"]);
    expect(Object.keys(mission.properties).sort()).toEqual(
      [
        "allowedTopics", "assetIds", "audience", "campaignType", "channels",
        "contentType", "endAt", "goal", "language", "maxContents", "product",
        "profileVersion", "sourceIds", "startAt", "targetAction", "targetUrl", "title",
      ],
    );
    expect([...mission.required].sort()).toEqual(Object.keys(mission.properties).sort());
    expect(mission.additionalProperties).toBe(false);
    expect(mission.properties).not.toHaveProperty("allowedActions");
    expect(chatTools.map((tool) => tool.name)).toEqual([
      "project_status", "knowledge_search", "approved_assets", "analytics_memory", "propose_campaign",
    ]);
  });
  it("passes a null optional mission field to createProposal as omitted", async () => {
    proposals.raw.length = 0;
    const result = await propose.execute(
      { scope: owner, runId: "r", conversationId: "c1", callIndex: 1 },
      { mission: { title: "T", product: null, allowedTopics: null, assetIds: null }, factIds: ["f"] },
    );
    expect(proposals.raw).toEqual([{ mission: { title: "T" }, factIds: ["f"] }]);
    expect(result).toEqual({
      output: { proposalId: "p1", version: 1, hash: "h", status: "proposed", payload: {} },
      cards: [{ kind: "status", label: "Proposal ready for confirmation", status: "confirmation_required" }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: FAIL — cannot resolve `./proposal-tools.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/modules/agents/tools/proposal-tools.ts
import { z } from "zod";
import { createProposal } from "../../chat.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

// Model-facing shape of today's propose_campaign; createProposal still runs
// proposeInput and missionSchema on the result.
const mission = z
  .object({
    title: z.string(),
    goal: z.string(),
    audience: z.string(),
    product: z.string().nullable(),
    allowedTopics: z.array(z.string()).nullable(),
    language: z.enum(["en", "de"]),
    channels: z
      .array(z.string())
      .min(1)
      .describe("Assigned integration IDs also allowed by the active policy"),
    startAt: z.string().describe("ISO 8601 UTC timestamp"),
    endAt: z.string().describe("ISO 8601 UTC timestamp after startAt"),
    maxContents: z.number().int().min(1).max(30),
    targetAction: z
      .string()
      .describe("Exact primary CTA from the current marketing profile"),
    targetUrl: z
      .string()
      .describe("Exact official target URL from the current marketing profile"),
    sourceIds: z
      .array(z.string())
      .min(1)
      .describe("Approved source IDs returned by knowledge_search"),
    assetIds: z.array(z.string()).nullable(),
    contentType: z.enum(["social", "blog", "newsletter", "ad", "script", "community"]),
    campaignType: z.enum(["product", "presale"]),
    profileVersion: z.number().int().min(1),
  })
  .strict()
  .describe(
    "One draft-only mission. Use current project_status profile, policy and assigned channel IDs, plus source IDs returned by knowledge_search. The server validates every field again before saving.",
  );

export const proposalTools: readonly OrbitTool[] = [
  defineTool({
    name: "propose_campaign",
    namespace: "proposals",
    description:
      "Save a reviewable draft-only mission proposal only after all mission fields, approved source IDs, relevant verified fact IDs, channels, period, campaign type, profile version, primary CTA and official target URL are known. This does not execute the mission.",
    parameters: z
      .object({ mission, factIds: z.array(z.string()).min(1) })
      .strict(),
    risk: "P_proposal",
    roles: ["editor", "owner"],
    deferLoading: false,
    async execute(context, args) {
      const proposal = await createProposal(
        context.scope,
        context.conversationId,
        dropNullFields(args),
      );
      return {
        output: {
          proposalId: proposal.id,
          version: proposal.version,
          hash: proposal.payloadHash,
          status: proposal.status,
          payload: proposal.payload,
        },
        cards: [
          {
            kind: "status",
            label: "Proposal ready for confirmation",
            status: "confirmation_required",
          },
        ],
      };
    },
  }),
];
```

```ts
// apps/api/src/modules/agents/tools/index.ts
import { proposalTools } from "./proposal-tools.ts";
import { readTools } from "./read-tools.ts";

/** Ordered tool set of Orbit Chat; the order is part of the cached prompt prefix. */
export const chatTools = [...readTools, ...proposalTools] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/api/src/modules/agents/tools/registry.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/tools/proposal-tools.ts apps/api/src/modules/agents/tools/index.ts apps/api/src/modules/agents/tools/registry.test.ts
git commit -m "feat: declare propose_campaign in the registry with a strict schema"
```

---

### Task 4: Chat runner uses the registry

**Files:**
- Modify: `apps/api/src/modules/chat-runner.ts` (imports; delete `KNOWN_TOOL_NAMES` literal lines 35–43 and `proposalTool` lines 61–140; byte check lines 298–305; `streamChat` tools lines 364–367; dispatch lines 446–487)
- Modify: `apps/api/src/modules/chat-tools.ts` (delete `readToolDefinitions`, lines 39–88, now unused)
- Test: `apps/api/tests/chat-runner.integration.test.ts`

**Interfaces:**
- Consumes: `chatTools` (Task 3), `availableTools`, `findTool`, `responsesTool` (Task 1).
- Produces: unchanged `runChat(scope, runId)`.

- [ ] **Step 1: Write the failing tests** (append inside the main `describe` of `chat-runner.integration.test.ts`; reuse its `createConversation`, `sendMessage`, `runChat`, `mocked`, `scope` helpers)

```ts
  it("sends strict registry tools within the byte budget", async () => {
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "What is our project status?",
      clientRequestId: randomUUID(),
    });
    mocked.tools = [];
    await runChat(scope, sent.runId);
    const tools = mocked.tools as Array<{ name: string; strict: boolean }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "project_status",
      "knowledge_search",
      "approved_assets",
      "analytics_memory",
      "propose_campaign",
    ]);
    expect(tools.every((tool) => tool.strict === true)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(5500);
  });
  it("does not offer the proposal tool to a viewer and still refuses a forged call", async () => {
    const viewer = { ...scope, role: "viewer" as const };
    const thread = await createConversation(viewer);
    const sent = await sendMessage(viewer, thread.id, {
      text: "Propose a campaign",
      clientRequestId: randomUUID(),
    });
    mocked.tools = [];
    // This mock mode makes the model call propose_campaign in its first step.
    mocked.mode = "invalid_proposal";
    try {
      await runChat(viewer, sent.runId);
    } finally {
      mocked.mode = "normal";
    }
    expect((mocked.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain(
      "propose_campaign",
    );
    // The mocked model still calls the tool; the run answers with the refusal.
    const forged = (mocked.inputs.at(-1) as Array<{ type: string; output?: string }>)
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output!));
    expect(forged).toContainEqual({ error: "CHAT_TOOL_NOT_ALLOWED" });
  });
```

The shared `scope` in this file is the owner (`beforeAll`, `role: "owner"` near line 271). `sendMessage` and `runChat` act as the scope's user, so the viewer test reuses the owner's user ID with `role: "viewer"`: role checks in chat read `scope.role`, and conversations are scoped to the user. If `sendMessage` rejects a viewer in this setup, create a second synthetic user with a `viewer` membership in `beforeAll` (same pattern as the owner block) and use its ID.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/api/tests/chat-runner.integration.test.ts -t "registry tools|viewer"`
Expected: FAIL — tools carry `strict: false`, and the viewer receives `propose_campaign` (forged call output is `{error:"EDITOR_REQUIRED"}`).

- [ ] **Step 3: Write minimal implementation** in `chat-runner.ts`

```ts
// imports: replace readToolDefinitions with the registry
import { chatTools } from "./agents/tools/index.ts";
import {
  availableTools,
  findTool,
  responsesTool,
} from "./agents/tools/registry.ts";

// Span names come from this fixed set; the model-supplied name is never stored.
const KNOWN_TOOL_NAMES = new Set<string>(chatTools.map((tool) => tool.name));
```

Inside `runChat`, once before the `while` loop:

```ts
    // Offered tools follow the caller's role; execution checks the same set.
    const offered = availableTools(chatTools, scope.role);
    const toolDefinitions = offered.map(responsesTool);
```

Byte check (replace the `tools:` entry):

```ts
          tools: toolDefinitions,
```

`streamChat` call (replace the `tools:` entry):

```ts
        tools: toolDefinitions as unknown as OpenAI.Responses.Tool[],
```

Dispatch: replace the body of the `try` block (from `const args = JSON.parse(call.arguments);` through the end of the `else` branch) with:

```ts
          const args = JSON.parse(call.arguments);
          const tool = findTool(offered, call.name);
          if (!tool) throw new DomainError("CHAT_TOOL_NOT_ALLOWED", 403);
          const result = await tool.execute(
            {
              scope,
              runId,
              conversationId: state.run.conversationId,
              callIndex: toolCalls,
            },
            args,
          );
          output = result.output;
          cards.push(...result.cards);
```

Delete `readToolDefinitions` from `chat-tools.ts`. Keep the existing `catch` block unchanged: `knowledge_search` failures still fail the run, and a `ZodError` from `propose_campaign` still becomes `PROPOSAL_VALIDATION_FAILED`. Delete the `proposalTool` constant and the now unused `createProposal`, `runReadTool` and `validateReadToolResult` imports from `chat-runner.ts` (keep `ChatCard`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/api/tests/chat-runner.integration.test.ts apps/api/tests/chat.integration.test.ts apps/api/src/modules/agents/tools/registry.test.ts`
Expected: PASS, including the existing "streams two bounded steps" proposal-schema assertions, "returns only invalid proposal field names to the model", "rejects manipulated tool output…" and "records a generic span name for a tool the model invented".

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat-runner.ts apps/api/src/modules/chat-tools.ts apps/api/tests/chat-runner.integration.test.ts
git commit -m "feat: build chat tools and dispatch from the registry"
```

---

### Task 5: Documentation and full verification

**Files:** `docs/ORBIT_CHAT_V1.md`, `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §17, `docs/IMPLEMENTATION_STATUS.md`

- [ ] **Step 1: Update docs**
  - `ORBIT_CHAT_V1.md`, paragraph starting "The registry exposes": state that tools are declared in `apps/api/src/modules/agents/tools/`, sent with `strict: true` schemas generated from zod, that optional fields arrive as `null` and are treated as omitted, and that `propose_campaign` is not offered to viewers (and still refused at execution).
  - Plan §17: new entry "Phase 3a complete (local)": registry, strict schemas, role filtering, measured tool-definition bytes before/after (record both numbers from Step 2), the Phase 3 split (3b, 3c), and the finding that `project_status.approvals` filters on a status nothing writes (fixed in 3b).
  - `IMPLEMENTATION_STATUS.md`: one bullet under the alignment section.

- [ ] **Step 2: Full verification**

Run, with the local env sourced:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm secrets:check && pnpm framework:check
```

Expected: all pass; record the test count. Measure tool bytes before (from `main`: `[...readToolDefinitions, proposalTool]`) and after (`chatTools.map(responsesTool)`) with a one-off `node --import tsx` script and record both in plan §17.

- [ ] **Step 3: Commit**

```bash
git add docs/ORBIT_CHAT_V1.md docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md docs/IMPLEMENTATION_STATUS.md
git commit -m "docs: record phase 3a tool registry"
```
