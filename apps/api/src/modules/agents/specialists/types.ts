import type { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { TaskClass } from "../../../../../../packages/ai/src/routing.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { StepRole } from "../assignment-runs.ts";
import type { OrbitTool } from "../tools/registry.ts";

/** Bounds of one specialist task; exceeding any of them fails it with `AGENT_LIMIT`. */
export type SpecialistLimits = {
  maxModelCalls: number;
  // Function tool calls; hosted web searches are counted separately.
  maxToolCalls: number;
  maxWebSearches: number;
  timeoutMs: number;
};

/** Spec §5 defaults: 4 model calls, 6 tool calls, 3 web searches, 120 s. */
export const DEFAULT_SPECIALIST_LIMITS: SpecialistLimits = {
  maxModelCalls: 4,
  maxToolCalls: 6,
  maxWebSearches: 3,
  timeoutMs: 120_000,
};

/**
 * A model specialist: one bounded agent turn with its own instructions, a
 * role tool set (function tools Orbit executes plus hosted tools such as
 * `web_search`) and a strict JSON final answer.
 */
export type Specialist = {
  role: StepRole;
  taskClass: TaskClass;
  instructions: string;
  tools: OrbitTool[];
  hostedTools: unknown[];
  outputSchema: z.ZodObject;
  limits: SpecialistLimits;
  /**
   * Adds stored context (read-only) to the task input before the model sees
   * it; the result is the input `finalize` gets. The stored task keeps the
   * plain input.
   */
  prepareInput?: (tx: DbTx, scope: Scope, input: any) => Promise<unknown>;
  /**
   * Runs on the parsed answer with the normalized URLs the task's web
   * searches returned or cited (`normalizeSourceUrl`) and the input the model
   * got; returns the answer to store.
   */
  finalize?: (output: any, sources: ReadonlySet<string>, input: any) => unknown;
};

/** A URL as compared with search sources: scheme, lower-case host and path only (no query, fragment or trailing slash). */
export function normalizeSourceUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export type AgentTaskStatus =
  "queued" | "running" | "done" | "failed" | "canceled" | "outcome_unknown";

/** The data of an `agent_tasks` row: one step of an assignment run. */
export type AgentTaskData = {
  runId: string;
  stepKey: string;
  role: StepRole;
  assignmentId: string;
  assignmentVersion: number;
  ceilingMicros: number;
  input: unknown;
  output: unknown;
  status: AgentTaskStatus;
  errorCode: string | null;
  costMicros: number;
};

export type AgentTask = AgentTaskData & { id: string };

/**
 * Runs one task of a role and returns its output. Paid calls reserve under
 * `agent:<taskId>:<n>` so the runner can price, settle and recover them.
 */
export type StepHandler = (scope: Scope, task: AgentTask) => Promise<unknown>;
