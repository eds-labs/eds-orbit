import { describe, expect, it } from "vitest";
import {
  AGENT_DEFINITIONS,
  AgentConfig,
  AgentDefinition,
  Trigger,
  configHash,
} from "../src/platform/agents/definitions/schema.ts";
import { readAgentDefinition } from "../src/platform/agents/definitions/store.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import type { DbTx } from "../../../packages/db/src/index.ts";

const config = () => ({
  name: "Ticket triage",
  description: "Sorts new tickets",
  templateKey: "support.ticket_agent",
  instructions: "Be brief.",
  modules: ["support"],
  tools: ["support_ticket_read", "support_ticket_tag"],
  knowledge: {
    sourceIds: ["4f8c2c0e-8a3b-4c5d-9e6f-7a8b9c0d1e2f"],
    audiences: ["support" as const],
  },
  mode: "draft" as const,
  model: { override: null },
  limits: {
    maxModelCalls: 4,
    maxToolCalls: 8,
    wallSeconds: 120,
    maxRunsPerDay: 50,
    maxConcurrent: 1,
  },
  budget: { monthlyCeilingMicros: 5_000_000, runCeilingMicros: 100_000 },
  triggers: [
    { kind: "manual" as const },
    { kind: "schedule" as const, rhythm: "daily" as const, times: ["09:00"] },
    { kind: "event" as const, type: "support.ticket.created", filter: {} },
  ],
  delegateTo: [],
  outputs: { notify: ["sponsor" as const], onFailure: "notify" as const },
});

const activation = (hash: string) => ({
  sponsorUserId: "owner-1",
  activatedAt: "2026-11-04T10:00:00.000Z",
  version: 3,
  configHash: hash,
});

/** Agent definition schema (ADR 0021, agent platform plan §2.2). */
describe("agent definition schema", () => {
  it("accepts a valid configuration and applies trigger defaults", () => {
    const parsed = AgentConfig.parse(config());
    const event = parsed.triggers.find((t) => t.kind === "event");
    expect(event).toMatchObject({ debounceSeconds: 0 });
    expect(parsed.budget.runCeilingMicros).toBe(100_000);
  });

  it.each([
    ["model calls above 8", { maxModelCalls: 9 }],
    ["no model call", { maxModelCalls: 0 }],
    ["tool calls above 16", { maxToolCalls: 17 }],
    ["wall time below 30 s", { wallSeconds: 29 }],
    ["wall time above 300 s", { wallSeconds: 301 }],
    ["runs per day above 500", { maxRunsPerDay: 501 }],
    ["concurrency above 3", { maxConcurrent: 4 }],
    ["a fractional limit", { maxToolCalls: 1.5 }],
  ])("refuses limits out of range: %s", (_name, limit) => {
    const c = config();
    expect(
      AgentConfig.safeParse({ ...c, limits: { ...c.limits, ...limit } }).success,
    ).toBe(false);
  });

  it("refuses bad budgets, lists and unknown keys", () => {
    const c = config();
    const bad = [
      { ...c, budget: { monthlyCeilingMicros: 0, runCeilingMicros: 0 } },
      { ...c, budget: { monthlyCeilingMicros: 1000, runCeilingMicros: 2000 } },
      { ...c, budget: { monthlyCeilingMicros: 1.5, runCeilingMicros: 1 } },
      { ...c, budget: { monthlyCeilingMicros: 10n, runCeilingMicros: 1n } },
      { ...c, modules: [] },
      { ...c, modules: ["a", "b", "c", "d", "e", "f"] },
      { ...c, modules: ["support", "support"] },
      { ...c, modules: ["Support"] },
      { ...c, tools: [] },
      { ...c, tools: Array.from({ length: 25 }, (_, i) => `tool_${i}`) },
      { ...c, tools: ["Bad-Tool"] },
      { ...c, delegateTo: ["not-a-uuid"] },
      { ...c, name: "  " },
      { ...c, name: "x".repeat(81) },
      { ...c, instructions: "x".repeat(6001) },
      { ...c, templateKey: "Support.Ticket" },
      { ...c, mode: "admin" },
      { ...c, knowledge: { audiences: ["finance"] } },
      { ...c, triggers: Array.from({ length: 6 }, () => ({ kind: "manual" })) },
      { ...c, extra: true },
    ];
    for (const input of bad)
      expect({ input, ok: AgentConfig.safeParse(input).success }).toMatchObject({
        ok: false,
      });
  });

  it.each([
    ["an unknown kind", { kind: "webhook" }],
    ["a daily rhythm without times", { kind: "schedule", rhythm: "daily", times: [] }],
    ["more than four times", { kind: "schedule", rhythm: "daily", times: ["01:00", "02:00", "03:00", "04:00", "05:00"] }],
    ["an invalid time", { kind: "schedule", rhythm: "daily", times: ["24:00"] }],
    ["a weekly rhythm without days", { kind: "schedule", rhythm: "weekly", times: ["09:00"] }],
    ["a day outside 1..7", { kind: "schedule", rhythm: "weekly", times: ["09:00"], days: [0] }],
    ["an interval without minutes", { kind: "schedule", rhythm: "interval", times: [] }],
    ["an interval below an hour", { kind: "schedule", rhythm: "interval", times: [], everyMinutes: 30 }],
    ["an interval with times", { kind: "schedule", rhythm: "interval", times: ["09:00"], everyMinutes: 60 }],
    ["an undotted event type", { kind: "event", type: "ticket_created", filter: {} }],
    ["a long debounce", { kind: "event", type: "support.ticket.created", filter: {}, debounceSeconds: 3601 }],
    ["an unknown field", { kind: "manual", every: 1 }],
  ])("refuses a bad trigger: %s", (_name, trigger) => {
    expect(Trigger.safeParse(trigger).success).toBe(false);
  });

  it("accepts weekly and interval schedules", () => {
    expect(
      Trigger.parse({ kind: "schedule", rhythm: "weekly", times: ["09:00", "17:30"], days: [1, 5] }),
    ).toMatchObject({ rhythm: "weekly" });
    expect(
      Trigger.parse({ kind: "schedule", rhythm: "interval", times: [], everyMinutes: 120 }),
    ).toMatchObject({ everyMinutes: 120 });
  });

  it("accepts the draft and the active shape", () => {
    const hash = configHash(config());
    expect(
      AgentDefinition.safeParse({ status: "draft", active: null, draft: config(), activation: null }).success,
    ).toBe(true);
    for (const status of ["active", "paused", "disabled", "budget_exhausted"])
      expect(
        AgentDefinition.safeParse({ status, active: config(), draft: null, activation: activation(hash) }).success,
      ).toBe(true);
    // An active agent being edited keeps both configurations.
    expect(
      AgentDefinition.safeParse({
        status: "active",
        active: config(),
        draft: { ...config(), name: "Ticket triage v2" },
        activation: activation(hash),
      }).success,
    ).toBe(true);
  });

  it("refuses inconsistent definitions", () => {
    const hash = configHash(config());
    const bad = [
      // A draft agent with an active configuration.
      { status: "draft", active: config(), draft: null, activation: activation(hash) },
      // An active agent without an active configuration.
      { status: "active", active: null, draft: config(), activation: null },
      // An active configuration without its activation, and the reverse.
      { status: "active", active: config(), draft: null, activation: null },
      { status: "draft", active: null, draft: config(), activation: activation(hash) },
      // Nothing at all.
      { status: "draft", active: null, draft: null, activation: null },
      // A bad activation hash and an unknown status.
      { status: "active", active: config(), draft: null, activation: activation("nope") },
      { status: "running", active: config(), draft: null, activation: activation(hash) },
    ];
    for (const input of bad)
      expect({ input, ok: AgentDefinition.safeParse(input).success }).toMatchObject({
        ok: false,
      });
  });

  it("hashes a configuration stably", () => {
    const a = config();
    const { name, ...rest } = a;
    // Key order and omitted defaults do not change the hash.
    const reordered = { ...rest, name };
    const withDefault = {
      ...a,
      triggers: a.triggers.map((t) => (t.kind === "event" ? { ...t, debounceSeconds: 0 } : t)),
    };
    expect(configHash(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(configHash(reordered)).toBe(configHash(a));
    expect(configHash(withDefault)).toBe(configHash(a));
    expect(configHash({ ...a, instructions: "Be thorough." })).not.toBe(configHash(a));
    expect(() => configHash({ ...a, modules: [] })).toThrow();
  });

  it("reads a stored definition and refuses a missing or malformed one", async () => {
    const scope = { workspaceId: "w", projectId: "p" };
    const stored = { status: "draft", active: null, draft: config(), activation: null };
    const tx = (row: unknown) =>
      ({ entity: { findFirst: async () => row } }) as unknown as DbTx;
    await expect(
      readAgentDefinition(tx({ id: "a1", version: 2, data: stored }), scope, "a1"),
    ).resolves.toMatchObject({ id: "a1", version: 2, definition: { status: "draft" } });
    await expect(readAgentDefinition(tx(null), scope, "a1")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      status: 404,
    });
    await expect(
      readAgentDefinition(tx({ id: "a1", version: 1, data: { ...stored, status: "running" } }), scope, "a1"),
    ).rejects.toMatchObject({ code: "AGENT_DEFINITION_INVALID", status: 409 });
  });

  it("is a platform entity kind that is exported with the project", () => {
    const kind = platformDeclaration.entityKinds.find((k) => k.kind === AGENT_DEFINITIONS);
    expect(kind).toBeDefined();
    expect(kind!.exported).toBeUndefined();
  });
});
