/**
 * Manual, budget-capped live review eval (rollout Approval J). Not part of
 * `pnpm test`; run it through `pnpm eval:agent-review` (see README.md).
 * Without a key and a confirmation it only prints the plan and transmits
 * nothing. Only the review calls are real: the copywriter draft that shapes
 * the cases and every revision (`generate`, `embed`) are stubs that send
 * nothing; a revision keeps the body unchanged and round 2 decides the case.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  ...(await import("./stubs.ts")).draftStubs(),
}));

import { respond } from "../../packages/ai/src/index.ts";
import { closeDatabase } from "../../packages/db/src/index.ts";
import {
  assertLiveAllowed,
  evidenceStamp,
  isLiveRequested,
  parseCandidatesFile,
  redactSecret,
} from "../generation/live-plan.ts";
import { codeVersion, reviewPromptHash } from "./code-version.ts";
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
        reviewPromptHash(),
      );
      const code = codeVersion();
      console.log(renderPlan(plan));
      console.log(
        `  code: commit ${code.commit ?? "unknown"}${code.dirty ? ", tracked files changed" : code.dirty === null ? ", state unknown" : ""}; run on the deployed commit, and re-run after any change to the review prompt, schema or runner, or to the agent_review route or quality tier`,
      );
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
      // The review call must be the real one.
      if (vi.isMockFunction(respond)) throw new Error("EVAL_RESPOND_STUBBED");
      // The run must use only the key it was given.
      delete process.env.OPENAI_API_KEY;
      const startedAt = new Date();
      let report;
      try {
        // Errors after the first review call are returned in the report, not thrown.
        report = await runReviewEval({
          cases: set.cases,
          route: plan.route,
          maxCostMicros: plan.maxCostMicros,
          runtime: { apiKey, ...plan.runtime },
          datasetVersion: set.datasetVersion,
        });
      } catch (error) {
        await closeDatabase().catch(() => undefined);
        // Never let the key reach the test output.
        throw redactSecret(error, apiKey);
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
      const markdown = renderReport(report, outcome, {
        ...code,
        promptHash: plan.promptHash,
      });
      await writeFile(
        base + ".json",
        JSON.stringify(
          {
            ...report,
            result: outcome.pass ? "PASS" : "FAIL",
            rules: outcome.rules,
            totals: totals(report.results),
            confirmation: plan.confirmation,
            commit: code.commit,
            dirty: code.dirty,
            promptHash: plan.promptHash,
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
      await closeDatabase();
      if (report.cleanupError)
        console.error(
          `\n!!! CLEANUP FAILED: ${report.cleanupError} !!! Remove the workspace "Synthetic agent review eval" (it holds the encrypted key); the next run removes it after 12 hours.`,
        );
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
      if (report.cleanupError)
        throw new Error("EVAL_CLEANUP_FAILED:" + report.cleanupError);
    },
    30 * 60_000,
  );
});
