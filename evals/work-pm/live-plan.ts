import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { estimateCost } from "../../packages/ai/src/index.ts";
import { evalRateCard } from "../generation/live-plan.ts";

// The plan of the paid AI project manager eval (WP2.11): goals, route, the
// worst case and a hard ceiling of USD 2 (the plan's proposal; the live run
// needs Mario's approval) that ORBIT_EVAL_MAX_USD can only lower. The
// confirmation binds a live run to exactly this plan.

export const CEILING_MICROS = 2_000_000;
const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

export type Goal = {
  id: string;
  language: string;
  text: string;
  existingInitiative?: Record<string, unknown>;
};
export type GoalSet = {
  version: string;
  today: string;
  timezone: string;
  members: Array<{ userId: string; name: string; role: string }>;
  goals: Goal[];
};
export type Route = { plan: { model: string; maxOutputTokens: number } };

/** The model's input for one goal, shaped like the planner's context. */
export function goalContext(set: GoalSet, goal: Goal) {
  return {
    request: { text: goal.text },
    today: set.today,
    timezone: set.timezone,
    language: goal.language,
    members: set.members,
    statusCategories: ["backlog", "todo", "in_progress", "blocked", "in_review", "done", "canceled"],
    takenInitiativeKeys: goal.existingInitiative ? [goal.existingInitiative.key] : [],
    existingInitiative: goal.existingInitiative ?? null,
  };
}

/** Instructions, schema and context of a call, generously bounded. */
const callBytes = (context: unknown) => 12_000 + Buffer.byteLength(JSON.stringify(context));

export function plan(env: Record<string, string | undefined> = process.env, now = new Date()) {
  const set = read("./goals-v1.json") as GoalSet;
  const route = read("./route-v1.json") as Route;
  const candidates = read("../generation/candidates-v1.json");
  const runtime = { rateCard: evalRateCard(candidates, now.getTime()) };
  const raw = env.ORBIT_EVAL_MAX_USD;
  let maxCostMicros = CEILING_MICROS;
  if (raw !== undefined) {
    const usd = Number(raw);
    if (!raw.trim() || !Number.isFinite(usd) || usd <= 0) throw new Error("EVAL_MAX_USD_INVALID");
    maxCostMicros = Math.min(CEILING_MICROS, Math.round(usd * 1_000_000));
  }
  const costs = set.goals.map((g) =>
    estimateCost(route.plan.model, callBytes(goalContext(set, g)), route.plan.maxOutputTokens, runtime),
  );
  const worstCaseMicros = costs.reduce((a, b) => a + b, 0);
  const hash = createHash("sha256").update(JSON.stringify({ set, route, maxCostMicros })).digest("hex").slice(0, 16);
  return {
    set,
    route,
    rateCard: runtime.rateCard,
    calls: set.goals.length,
    callCostMicros: costs,
    worstCaseMicros,
    maxCostMicros,
    hash,
    confirmation: `work-pm-eval-${hash}`,
  };
}

export const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(4);

export function renderPlan(p: ReturnType<typeof plan>) {
  return [
    "AI project manager eval plan (dry run; nothing is transmitted)",
    `  dataset: ${p.set.version}, ${p.set.goals.length} goals`,
    `  route: ${p.route.plan.model} (max ${p.route.plan.maxOutputTokens} output tokens)`,
    `  worst-case estimate: ${usd(p.worstCaseMicros)}`,
    `  cost ceiling: ${usd(p.maxCostMicros)} (the run stops before a call could pass it)`,
    `  dataset hash: ${p.hash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${p.confirmation}`,
  ].join("\n");
}
