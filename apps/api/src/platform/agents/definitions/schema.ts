/**
 * Agent definitions (ADR 0021, agent platform plan §2.2): the stored shape of
 * a project agent in the entity kind `agent_definitions`. This file checks
 * the shape only; whether the named modules, tools, models, sources, event
 * types and delegates exist and may be used is checked against the
 * registries, the catalogue, the template guard rules and the entitlements
 * on every save and every run (WP1.5, WP1.6).
 *
 * Money is `z.number().int()` micros, not bigint: entities are JSON, which
 * has no bigint, and agent mandates store micros the same way. Every amount
 * stays a safe integer (at most 2^53 - 1 micros, about 9 billion USD).
 */
import { z } from "zod";
import {
  EVENT_TYPE,
  MODULE_ID,
} from "../../../../../../packages/module-contracts/src/index.ts";
import { knowledgeAudience } from "../../../../../../packages/schemas/src/index.ts";
import { hash } from "../../shared.ts";

export const AGENT_DEFINITIONS = "agent_definitions";

/** The same rule as TOOL_NAME in agents/tools/registry.ts. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
const distinct = <S extends z.ZodType>(item: S) =>
  z.array(item).refine(unique, "duplicate entry");

export const ModuleId = z.string().regex(MODULE_ID);
export const ToolName = z.string().regex(TOOL_NAME);
export const ModelId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
/** HH:MM in the project's timezone. */
export const LocalTime = z.string().regex(LOCAL_TIME);
/** A module-declared triggerable event type ("<module>.<object>.<event>"). */
export const TriggerableEventType = z.string().regex(EVENT_TYPE);
export const Micros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const Trigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z
    .strictObject({
      kind: z.literal("schedule"),
      rhythm: z.enum(["daily", "weekly", "interval"]),
      times: distinct(LocalTime).max(4),
      days: distinct(z.int().min(1).max(7)).max(7).optional(),
      everyMinutes: z.int().min(60).max(1440).optional(),
    })
    .superRefine((t, ctx) => {
      // Daily and weekly run at given times; weekly also on given days;
      // an interval runs every `everyMinutes` and names no times.
      if (t.rhythm === "interval") {
        if (t.everyMinutes === undefined)
          ctx.addIssue({ code: "custom", path: ["everyMinutes"], message: "required for an interval" });
        if (t.times.length || t.days)
          ctx.addIssue({ code: "custom", path: ["times"], message: "an interval names no times or days" });
        return;
      }
      if (!t.times.length)
        ctx.addIssue({ code: "custom", path: ["times"], message: "at least one time" });
      if (t.everyMinutes !== undefined)
        ctx.addIssue({ code: "custom", path: ["everyMinutes"], message: "only for an interval" });
      if (t.rhythm === "weekly" && !t.days?.length)
        ctx.addIssue({ code: "custom", path: ["days"], message: "at least one day" });
      if (t.rhythm === "daily" && t.days)
        ctx.addIssue({ code: "custom", path: ["days"], message: "only for a weekly rhythm" });
    }),
  z.strictObject({
    kind: z.literal("event"),
    type: TriggerableEventType,
    // Validated against the event type's declaration on save.
    filter: z.record(z.string(), z.unknown()),
    debounceSeconds: z.int().min(0).max(3600).default(0),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const AgentConfig = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    templateKey: z
      .string()
      .regex(/^[a-z]+\.[a-z_]+$/)
      .nullable(),
    // The user's part of the instructions only; the platform adds its own.
    instructions: z.string().max(6000),
    modules: distinct(ModuleId).min(1).max(5),
    // Registry names with agent exposure.
    tools: distinct(ToolName).min(1).max(24),
    knowledge: z
      .strictObject({
        sourceIds: distinct(z.uuid()).max(50).optional(),
        audiences: distinct(knowledgeAudience).optional(),
      })
      .nullable(),
    mode: z.enum(["read", "draft", "execute"]),
    // Task class agent_custom; null uses its route.
    model: z.strictObject({ override: ModelId.nullable() }),
    limits: z.strictObject({
      maxModelCalls: z.int().min(1).max(8),
      maxToolCalls: z.int().min(0).max(16),
      wallSeconds: z.int().min(30).max(300),
      maxRunsPerDay: z.int().min(1).max(500),
      maxConcurrent: z.int().min(1).max(3),
    }),
    budget: z
      .strictObject({
        monthlyCeilingMicros: Micros,
        runCeilingMicros: Micros,
      })
      .refine((b) => b.runCeilingMicros <= b.monthlyCeilingMicros, {
        path: ["runCeilingMicros"],
        message: "a run ceiling above the month ceiling",
      }),
    triggers: z.array(Trigger).max(5),
    // Named agents of the same project this one may hand work to.
    delegateTo: distinct(z.uuid()).max(5),
    outputs: z.strictObject({
      notify: distinct(z.enum(["sponsor", "agent_managers"])),
      onFailure: z.enum(["notify", "silent"]),
    }),
  });
export type AgentConfig = z.infer<typeof AgentConfig>;

export const AgentStatus = z.enum([
  "draft",
  "active",
  "paused",
  "disabled",
  "budget_exhausted",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentActivation = z.strictObject({
  sponsorUserId: z.string().min(1),
  activatedAt: z.iso.datetime(),
  version: z.int().min(1),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const AgentDefinition = z
  .strictObject({
    status: AgentStatus,
    // What runs; replaced only by an activation.
    active: AgentConfig.nullable(),
    // The working copy; edits never touch `active`.
    draft: AgentConfig.nullable(),
    activation: AgentActivation.nullable(),
  })
  .superRefine((d, ctx) => {
    // An agent that was never activated is a draft: no active configuration
    // and no activation record. Every other status runs (or ran) an
    // activated configuration.
    if ((d.active === null) !== (d.activation === null))
      ctx.addIssue({ code: "custom", path: ["activation"], message: "an active configuration and its activation come together" });
    if (d.status === "draft" && d.active !== null)
      ctx.addIssue({ code: "custom", path: ["status"], message: "a draft agent has no active configuration" });
    if (d.status !== "draft" && d.active === null)
      ctx.addIssue({ code: "custom", path: ["active"], message: "required unless the agent is a draft" });
    if (d.active === null && d.draft === null)
      ctx.addIssue({ code: "custom", path: ["draft"], message: "an agent has a draft or an active configuration" });
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/**
 * The hash an activation binds to and every work order records: sha256 of
 * the canonical JSON of the parsed configuration, so key order and omitted
 * defaults do not change it. Throws on an invalid configuration.
 */
export function configHash(config: unknown): string {
  return hash(AgentConfig.parse(config));
}
