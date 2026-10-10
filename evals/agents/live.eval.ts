/**
 * Manual, budget-capped live review eval (rollout Approval J). Not part of
 * `pnpm test`; run it through `pnpm eval:agent-review` (see README.md).
 * Without a key and a confirmation it only prints the plan and transmits
 * nothing. Only the review calls are real: the copywriter draft that shapes
 * the cases and every revision (`generate`, `embed`) are stubs that send
 * nothing; a revision keeps the body unchanged and round 2 decides the case.
 * With ORBIT_EVAL_DIAGNOSE=good it runs only the good cases and writes the
 * model's reasons to .runtime/ instead of evidence; that is never a gate result.
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
  evidenceStamp,
  isLiveRequested,
  parseCandidatesFile,
  redactSecret,
} from "../generation/live-plan.ts";
import { codeVersion, reviewPromptHash } from "./code-version.ts";
import { runReviewEval } from "./live-harness.ts";
import {
  DIAGNOSTIC_BANNER,
  writeDiagnosis,
  type CaseDiagnosis,
} from "./diagnosis.ts";
import { resolveLiveKey } from "./eval-key.ts";
import {
  evaluatePassRule,
  gateResult,
  parseRouteFile,
  planReviewEval,
  renderPlan,
  renderReport,
  totals,
} from "./live-plan.ts";
import { parseReviewSet } from "./review-set.ts";
import rawSet from "./review-v2.json" with { type: "json" };
import rawRoute from "./review-route-v1.json" with { type: "json" };
import rawRates from "../generation/candidates-v1.json" with { type: "json" };

const evidenceDir = fileURLToPath(
  new URL("../../docs/evidence/", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
      const diagnostic = plan.mode !== "normal";
      if (diagnostic) console.log(`\n=== ${DIAGNOSTIC_BANNER} ===\n`);
      console.log(renderPlan(plan));
      console.log(
        `  code: commit ${code.commit ?? "unknown"}${code.dirty ? ", tracked files changed" : code.dirty === null ? ", state unknown" : ""}; run on the deployed commit, and re-run after any change to the review prompt, schema or runner, or to the agent_review route or quality tier`,
      );
      if (!isLiveRequested(env)) {
        const prefix = diagnostic ? "ORBIT_EVAL_DIAGNOSE=good " : "";
        console.log(
          "\nDry run only. To run live, review the plan above, then run:\n" +
            `  ${prefix}ORBIT_EVAL_OPENAI_API_KEY=<key> ORBIT_EVAL_CONFIRM=${plan.confirmation} pnpm eval:agent-review\n` +
            "or, with the key stored in the macOS keychain (README.md):\n" +
            `  ${prefix}ORBIT_EVAL_KEYCHAIN_SERVICE=orbit-eval-openai ORBIT_EVAL_CONFIRM=${plan.confirmation} pnpm eval:agent-review`,
        );
        return;
      }
      // The key variable, or the keychain item once the confirmation matches.
      const apiKey = await resolveLiveKey(env, plan.confirmation);
      // The review call must be the real one.
      if (vi.isMockFunction(respond)) throw new Error("EVAL_RESPOND_STUBBED");
      // The run must use only the key it was given.
      delete process.env.OPENAI_API_KEY;
      const startedAt = new Date();
      const diagnosis: CaseDiagnosis[] = [];
      let report;
      try {
        // Errors after the first review call are returned in the report, not thrown.
        report = await runReviewEval({
          cases: plan.cases,
          brief: set.brief,
          route: plan.route,
          maxCostMicros: plan.maxCostMicros,
          runtime: { apiKey, ...plan.runtime },
          datasetVersion: set.datasetVersion,
          ...(diagnostic ? { diagnose: (d) => diagnosis.push(d) } : {}),
        });
      } catch (error) {
        await closeDatabase().catch(() => undefined);
        // Never let the key reach the test output.
        throw redactSecret(error, apiKey);
      }
      const outcome = evaluatePassRule(
        plan.cases,
        report.results,
        report.stoppedReason,
      );
      if (diagnostic) {
        // Reasons and draft bodies go only to .runtime/, never to evidence or stdout.
        let paths;
        try {
          paths = await writeDiagnosis(
            repoRoot,
            evidenceStamp(startedAt),
            {
              mode: plan.mode,
              datasetVersion: report.datasetVersion,
              datasetHash: report.datasetHash,
              startedAt: report.startedAt,
              commit: code.commit,
              dirty: code.dirty,
              promptHash: plan.promptHash,
              stoppedReason: report.stoppedReason,
              cleanupError: report.cleanupError,
              cases: diagnosis,
            },
            apiKey,
          );
        } finally {
          await closeDatabase();
        }
        const t = totals(report.results);
        console.log(
          `\n=== ${DIAGNOSTIC_BANNER} ===\n` +
            `  cases: ${t.cases} of ${plan.caseCount}; approve ${t.verdicts.approve}, reject ${t.verdicts.reject}, owner ${t.verdicts.owner}, blocked ${t.verdicts.blocked}, error ${t.verdicts.error}; revised ${t.revised}; review calls ${t.reviewCalls}; cost ${t.costMicros} micros\n` +
            "  no docs/evidence file was written",
        );
        console.log(`Reasons written to ${paths.json} (and .md)`);
        if (report.cleanupError)
          console.error(
            `\n!!! CLEANUP FAILED: ${report.cleanupError} !!! Remove the workspace "Synthetic agent review eval" (it holds the encrypted key); the next run removes it after 12 hours.`,
          );
        if (report.stoppedReason)
          console.error(
            `\n!!! EVAL STOPPED EARLY: ${report.stoppedReason} !!!\n` +
              `Completed cases: ${report.results.length} of ${plan.caseCount}.`,
          );
        console.log(`\nRESULT: ${gateResult(plan, outcome)}`);
        expect(report.datasetHash).toBe(plan.hash);
        if (report.stoppedReason)
          throw new Error("EVAL_STOPPED_EARLY:" + report.stoppedReason);
        if (report.cleanupError)
          throw new Error("EVAL_CLEANUP_FAILED:" + report.cleanupError);
        return;
      }
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
            result: gateResult(plan, outcome),
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
      console.log(`\nRESULT: ${gateResult(plan, outcome)}`);
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
