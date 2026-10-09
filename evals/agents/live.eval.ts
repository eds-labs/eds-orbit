/**
 * Manual, budget-capped live review eval (rollout Approval J). Not part of
 * `pnpm test`; run it through `pnpm eval:agent-review` (see README.md).
 * Without a key and a confirmation it only prints the plan and transmits
 * nothing. Only the review call is real: the copywriter draft that shapes the
 * cases (`generate`, `embed`) and any revision are stubs that send nothing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  ...(await import("./stubs.ts")).draftStubs(),
}));
vi.mock(
  "../../apps/api/src/modules/agents/specialists/copywriter.ts",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/agents/specialists/copywriter.ts")
    >()),
    reviseAssignmentDraft: await (await import("./stubs.ts")).revisionStub(),
  }),
);

import { closeDatabase } from "../../packages/db/src/index.ts";
import {
  assertLiveAllowed,
  evidenceStamp,
  isLiveRequested,
  parseCandidatesFile,
  redactSecret,
} from "../generation/live-plan.ts";
import { runReviewEval } from "./live-harness.ts";
import {
  evaluatePassRule,
  parseRouteFile,
  planReviewEval,
  renderPlan,
  renderReport,
  totals,
} from "./live-plan.ts";
import { parseReviewSet } from "./review-set.ts";
import rawSet from "./review-v1.json" with { type: "json" };
import rawRoute from "./review-route-v1.json" with { type: "json" };
import rawRates from "../generation/candidates-v1.json" with { type: "json" };

const evidenceDir = fileURLToPath(
  new URL("../../docs/evidence/", import.meta.url),
);

describe("Live agent review eval", () => {
  it(
    "prints the plan, and runs live only with key and confirmation",
    async () => {
      const env = process.env;
      const set = parseReviewSet(rawSet);
      // Rejects a stale rate card, an unpriced route and a malformed ceiling before any call.
      const plan = planReviewEval(
        env,
        set,
        parseRouteFile(rawRoute),
        parseCandidatesFile(rawRates),
      );
      console.log(renderPlan(plan));
      if (!isLiveRequested(env)) {
        console.log(
          "\nDry run only. To run live, review the plan above, then run:\n" +
            "  ORBIT_EVAL_OPENAI_API_KEY=<key> ORBIT_EVAL_CONFIRM=" +
            plan.confirmation +
            " pnpm eval:agent-review",
        );
        return;
      }
      const apiKey = assertLiveAllowed(env, plan.confirmation);
      // The run must use only the key it was given.
      delete process.env.OPENAI_API_KEY;
      const startedAt = new Date();
      let report;
      try {
        report = await runReviewEval({
          cases: set.cases,
          route: plan.route,
          maxCostMicros: plan.maxCostMicros,
          runtime: { apiKey, ...plan.runtime },
          datasetVersion: set.datasetVersion,
        });
      } catch (error) {
        // Never let the key reach the test output.
        throw redactSecret(error, apiKey);
      } finally {
        await closeDatabase();
      }
      const outcome = evaluatePassRule(
        set.cases,
        report.results,
        report.stoppedReason,
      );
      // Metrics only: verdict classes, codes, tokens and cost; no model text, draft body or key.
      const stamp = evidenceStamp(startedAt);
      await mkdir(evidenceDir, { recursive: true });
      const base = `${evidenceDir}agent-review-eval-${stamp}`;
      const markdown = renderReport(report, outcome);
      await writeFile(
        base + ".json",
        JSON.stringify(
          {
            ...report,
            result: outcome.pass ? "PASS" : "FAIL",
            rules: outcome.rules,
            totals: totals(report.results),
            confirmation: plan.confirmation,
            maxCostMicros: plan.maxCostMicros,
            worstCaseMicros: plan.worstCaseMicros,
          },
          null,
          2,
        ) + "\n",
      );
      await writeFile(base + ".md", markdown);
      console.log("\n" + markdown);
      console.log(`Report written to ${base}.json and ${base}.md`);
      // Checked only after the report is on disk.
      expect(report.datasetHash).toBe(plan.hash);
      if (report.stoppedReason)
        console.error(
          `\n!!! EVAL STOPPED EARLY: ${report.stoppedReason} !!!\n` +
            `Completed cases: ${report.results.length} of ${plan.caseCount}. The partial report is written.`,
        );
      console.log(`\nRESULT: ${outcome.pass ? "PASS" : "FAIL"}`);
      if (!outcome.pass)
        throw new Error(
          report.stoppedReason
            ? "EVAL_STOPPED_EARLY:" + report.stoppedReason
            : "EVAL_REVIEW_FAILED",
        );
    },
    30 * 60_000,
  );
});
