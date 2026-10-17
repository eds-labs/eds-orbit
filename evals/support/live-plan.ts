import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { estimateCost } from "../../packages/ai/src/index.ts";
import { evalRateCard } from "../generation/live-plan.ts";

// The plan of the paid support AI eval (WP5.6): cases, routes, the worst
// case and a hard ceiling of 3 USD that ORBIT_EVAL_MAX_USD can only lower
// (Mario's approval of 2026-10-17). The confirmation binds a live run to
// exactly this plan.

export const CEILING_MICROS = 3_000_000;
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

export type SupportEvalSet = {
  version: string;
  categories: string[];
  triage: Array<{
    id: string;
    text: string;
    category: string;
    language: string;
    sensitive: boolean;
  }>;
  drafts: Array<{
    id: string;
    text: string;
    expect: "answer" | "handoff";
    facts: Array<{ id: string; key: string; value: string }>;
    passages: Array<{ chunkId: string; title: string; text: string }>;
  }>;
};
export type Routes = {
  triage: { model: string; maxOutputTokens: number };
  draft: { model: string; maxOutputTokens: number };
};

/** Bytes of instructions and content a call may send, generously bounded. */
export const callBytes = (text: string, extra = 0) =>
  4000 + Buffer.byteLength(text) + extra;

export function plan(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
) {
  const set = read("./model-v1.json") as SupportEvalSet;
  const routes = read("./route-v1.json") as Routes;
  const candidates = read("../generation/candidates-v1.json");
  const rateCard = evalRateCard(candidates, now.getTime());
  const runtime = { rateCard };
  const raw = env.ORBIT_EVAL_MAX_USD;
  let maxCostMicros = CEILING_MICROS;
  if (raw !== undefined) {
    const usd = Number(raw);
    if (!raw.trim() || !Number.isFinite(usd) || usd <= 0)
      throw new Error("EVAL_MAX_USD_INVALID");
    maxCostMicros = Math.min(CEILING_MICROS, Math.round(usd * 1_000_000));
  }
  const triageCost = set.triage.map((c) =>
    estimateCost(
      routes.triage.model,
      callBytes(c.text),
      routes.triage.maxOutputTokens,
      runtime,
    ),
  );
  const draftCost = set.drafts.map((c) =>
    estimateCost(
      routes.draft.model,
      callBytes(
        c.text,
        Buffer.byteLength(JSON.stringify([c.facts, c.passages])),
      ),
      routes.draft.maxOutputTokens,
      runtime,
    ),
  );
  const worstCaseMicros = [...triageCost, ...draftCost].reduce(
    (a, b) => a + b,
    0,
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({ set, routes, maxCostMicros }))
    .digest("hex")
    .slice(0, 16);
  return {
    set,
    routes,
    rateCard,
    calls: set.triage.length + set.drafts.length,
    worstCaseMicros,
    maxCostMicros,
    hash,
    confirmation: `support-eval-${hash}`,
  };
}

export const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(4);

export function renderPlan(p: ReturnType<typeof plan>) {
  return [
    "Support AI eval plan (dry run; nothing is transmitted)",
    `  dataset: ${p.set.version}, ${p.set.triage.length} triage + ${p.set.drafts.length} draft cases`,
    `  routes: triage ${p.routes.triage.model} (max ${p.routes.triage.maxOutputTokens}), draft ${p.routes.draft.model} (max ${p.routes.draft.maxOutputTokens})`,
    `  worst-case estimate: ${usd(p.worstCaseMicros)}`,
    `  cost ceiling: ${usd(p.maxCostMicros)} (the run stops before a call could pass it)`,
    `  dataset hash: ${p.hash}`,
    `  confirmation (ORBIT_EVAL_CONFIRM): ${p.confirmation}`,
  ].join("\n");
}
