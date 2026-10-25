import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { respond } from "../../packages/ai/src/index.ts";
import { BASE_INSTRUCTIONS, structuredOutputSchema } from "../../apps/api/src/platform/agents/structured-run.ts";
import { PLANNER_INSTRUCTIONS } from "../../apps/api/src/modules/work/pm/instructions.ts";
import { workPlanSchema } from "../../apps/api/src/modules/work/pm/plan-schema.ts";
import { resolveLiveKey } from "../agents/eval-key.ts";
import { aggregate, scorePlan, type PlanScore } from "./metrics.ts";
import { goalContext, plan, renderPlan, usd } from "./live-plan.ts";

// The paid eval of the AI project manager's planner (WP2.11). It sends the
// production instructions and schema with synthetic goals, one call per
// goal, no tools, and scores the answers structurally. A live run needs
// Mario's approval, the key and the printed confirmation; the report holds
// ids, counts and costs only, never plan text or the key.

const evidenceDir = fileURLToPath(new URL("../../docs/evidence/", import.meta.url));

describe("AI project manager live eval", () => {
  it(
    "prints the plan, and runs live only with key and confirmation",
    async () => {
      const p = plan();
      console.log(renderPlan(p));
      if (!process.env.ORBIT_EVAL_CONFIRM) return; // dry run
      if (vi.isMockFunction(respond)) throw new Error("EVAL_RESPOND_STUBBED");
      const apiKey = await resolveLiveKey(process.env, p.confirmation);
      delete process.env.OPENAI_API_KEY;
      const runtime = { apiKey, rateCard: p.rateCard, verifiedModels: [p.route.plan.model] } as never;
      const members = new Set(p.set.members.map((m) => m.userId));
      const outputSchema = structuredOutputSchema(workPlanSchema);
      const scores: PlanScore[] = [];
      let spent = 0;
      let stoppedReason: string | null = null;
      for (const [index, goal] of p.set.goals.entries()) {
        // Stop before a call whose worst case could pass the ceiling.
        if (spent + p.callCostMicros[index]! > p.maxCostMicros) {
          stoppedReason = "CEILING";
          break;
        }
        let answer: unknown = null;
        let cost = p.callCostMicros[index]!;
        try {
          const result = await respond({
            route: p.route.plan,
            instructions: `${BASE_INSTRUCTIONS} ${PLANNER_INSTRUCTIONS.text}`,
            input: [{ role: "user", content: JSON.stringify(goalContext(p.set, goal)) }],
            tools: [],
            outputSchema,
            reservationId: `work-pm-eval-${p.hash}-${goal.id}`,
            runtime,
          });
          cost = result.usage.costMicros;
          const message = (result.output as any[]).filter((i) => i?.type === "message").at(-1);
          const text = ((message?.content ?? []) as any[]).filter((c) => c?.type === "output_text").map((c) => c.text).join("");
          answer = JSON.parse(text);
        } catch (error) {
          // An unclear call counts at its worst case and is never repeated.
          answer = null;
          console.error(`goal ${goal.id}: call failed (${error instanceof Error ? error.name : "unknown"})`);
        }
        spent += cost;
        scores.push({ ...scorePlan(goal.id, answer, members), costMicros: cost });
      }
      const summary = aggregate(scores);
      const report = {
        dataset: p.set.version,
        datasetHash: p.hash,
        confirmation: p.confirmation,
        model: p.route.plan.model,
        maxCostMicros: p.maxCostMicros,
        spentMicros: spent,
        stoppedReason,
        summary,
        scores,
      };
      await mkdir(evidenceDir, { recursive: true });
      const file = `${evidenceDir}work-pm-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      await writeFile(file, JSON.stringify(report, null, 2) + "\n");
      console.log(`\nSpent ${usd(spent)}; passed: ${summary.passed}; failed: ${summary.failed.join(", ") || "none"}`);
      console.log(`Report written to ${file}`);
      expect(stoppedReason).toBeNull();
    },
    30 * 60_000,
  );
});
