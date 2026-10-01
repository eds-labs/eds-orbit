/**
 * Manual, budget-capped live generation eval. Not part of `pnpm test`; run it
 * through `pnpm eval:generation` (see README.md). Without a key and a
 * confirmation it only prints the plan and transmits nothing.
 * `embed` is always replaced by a deterministic stub; `generate` is real.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => ({
    vectors: [
      Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
    ],
    usage: {
      model: "text-embedding-3-small",
      inputTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costMicros: 7,
    },
  })),
}));

import { closeDatabase } from "../../packages/db/src/index.ts";
import { parseFixtures, renderMarkdown, runEval } from "./harness.ts";
import {
  assertLiveAllowed,
  evidenceStamp,
  isLiveRequested,
  parseCandidatesFile,
  planLiveEval,
  renderPlan,
} from "./live-plan.ts";
import rawFixtures from "./fixtures-v1.json" with { type: "json" };
import rawCandidates from "./candidates-v1.json" with { type: "json" };

const evidenceDir = fileURLToPath(
  new URL("../../docs/evidence/", import.meta.url),
);

describe("Live generation eval", () => {
  it(
    "prints the plan, and runs live only with key and confirmation",
    async () => {
      const env = process.env;
      // Rejects a stale rate card and a malformed ceiling before any call.
      const plan = planLiveEval(
        env,
        parseFixtures(rawFixtures),
        parseCandidatesFile(rawCandidates),
      );
      console.log(renderPlan(plan));
      if (!isLiveRequested(env)) {
        console.log(
          "\nDry run only. To run live, review the plan above, then run:\n" +
            "  ORBIT_EVAL_OPENAI_API_KEY=<key> ORBIT_EVAL_CONFIRM=" +
            plan.hash +
            " pnpm eval:generation",
        );
        return;
      }
      const apiKey = assertLiveAllowed(env, plan.hash);
      // The run must use only the key it was given.
      delete process.env.OPENAI_API_KEY;
      const { cases, datasetVersion } = parseFixtures(rawFixtures);
      const startedAt = new Date();
      let report;
      try {
        report = await runEval({
          cases,
          candidates: plan.candidates,
          repetitions: plan.repetitions,
          maxCostMicros: plan.maxCostMicros,
          runtime: { apiKey, ...plan.runtime },
          datasetVersion,
        });
      } catch (error) {
        // Never let the key reach the test output.
        const message = String(error instanceof Error ? error.message : error);
        throw new Error(message.split(apiKey).join("[redacted]"));
      } finally {
        await closeDatabase();
      }
      expect(report.datasetHash).toBe(plan.hash);
      // Metrics only: no prompts, outputs or key.
      const stamp = evidenceStamp(startedAt);
      await mkdir(evidenceDir, { recursive: true });
      const base = `${evidenceDir}generation-eval-${stamp}`;
      await writeFile(
        base + ".json",
        JSON.stringify(
          {
            ...report,
            maxCostMicros: plan.maxCostMicros,
            worstCaseMicros: plan.worstCaseMicros,
          },
          null,
          2,
        ) + "\n",
      );
      await writeFile(base + ".md", renderMarkdown(report));
      console.log("\n" + renderMarkdown(report));
      console.log(`Report written to ${base}.json and ${base}.md`);
      if (report.stoppedReason) {
        console.error(
          `\n!!! EVAL STOPPED EARLY: ${report.stoppedReason} !!!\n` +
            `Completed runs: ${report.results.length} of ${plan.calls} planned. The partial report is written.`,
        );
        throw new Error("EVAL_STOPPED_EARLY:" + report.stoppedReason);
      }
    },
    30 * 60_000,
  );
});
