/**
 * Manual, budget-capped live vision eval (spec
 * docs/superpowers/specs/2026-11-11-agent-review-creatives-design.md §7). Not
 * part of `pnpm test`; run it through `pnpm eval:creative-vision` (see
 * README.md). Without a key and a confirmation it only prints the plan and
 * transmits nothing. Only the vision review calls are real: every creative
 * is composed for free from the offline fixtures. The route is
 * vision-route-v1.json, production's creative_review route on Anthropic; the
 * key is the variable or keychain item of the route's provider.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { respond } from "../../packages/ai/src/index.ts";
import { closeDatabase } from "../../packages/db/src/index.ts";
import {
  evidenceStamp,
  parseCandidatesFile,
  redactSecret,
} from "../generation/live-plan.ts";
import { codeVersion } from "../agents/code-version.ts";
import { runVisionEval, VISION_EVAL_MARKER } from "./vision-harness.ts";
import {
  evaluateVisionPassRule,
  parseVisionRouteFile,
  renderVisionReport,
  startVisionEval,
  visionTotals,
} from "./vision-plan.ts";
import { parseVisionSet } from "./vision-set.ts";
import rawSet from "./vision-v1.json" with { type: "json" };
import rawRoute from "./vision-route-v1.json" with { type: "json" };
import rawRates from "../generation/candidates-v1.json" with { type: "json" };

const evidenceDir = fileURLToPath(
  new URL("../../docs/evidence/", import.meta.url),
);

describe("Live creative vision eval", () => {
  it(
    "prints the plan, and runs live only with key and confirmation",
    async () => {
      const env = process.env;
      const set = parseVisionSet(rawSet);
      const code = codeVersion();
      // Rejects a stale rate card, an unpriced route and a malformed ceiling
      // before any call; a key alone or a confirmation alone is an error.
      const { plan, apiKey } = await startVisionEval(env, {
        set,
        routeFile: parseVisionRouteFile(rawRoute),
        rates: parseCandidatesFile(rawRates),
        code: `  code: commit ${code.commit ?? "unknown"}${code.dirty ? ", tracked files changed" : code.dirty === null ? ", state unknown" : ""}; run on the deployed commit, and re-run after any change to the vision prompt, schema or this runner, or to the creative_review route or standard tier`,
      });
      if (apiKey === null) return;
      // The vision review call must be the real one.
      if (vi.isMockFunction(respond)) throw new Error("EVAL_RESPOND_STUBBED");
      // The run must use only the key it was given.
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const startedAt = new Date();
      let report;
      try {
        // Errors after the first review call are returned in the report, not thrown.
        report = await runVisionEval({
          set,
          route: plan.route,
          provider: plan.provider,
          apiKey,
          maxCostMicros: plan.maxCostMicros,
          runtime: plan.runtime,
        });
      } catch (error) {
        await closeDatabase().catch(() => undefined);
        // Never let the key reach the test output.
        throw redactSecret(error, apiKey);
      }
      const outcome = evaluateVisionPassRule(
        set.cases,
        report.results,
        report.stoppedReason,
      );
      // Metrics only: verdicts, scores, issue counts, codes, tokens and cost;
      // no notes, no image bytes, no key.
      const stamp = evidenceStamp(startedAt);
      await mkdir(evidenceDir, { recursive: true });
      const base = `${evidenceDir}creative-vision-eval-${stamp}`;
      const markdown = renderVisionReport(report, outcome, {
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
            goodPasses: outcome.goodPasses,
            totals: visionTotals(report.results),
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
          `\n!!! CLEANUP FAILED: ${report.cleanupError} !!! Remove the workspace "${VISION_EVAL_MARKER}" (it holds the encrypted key); the next run removes it after 12 hours.`,
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
            : "EVAL_VISION_FAILED",
        );
      if (report.cleanupError)
        throw new Error("EVAL_CLEANUP_FAILED:" + report.cleanupError);
    },
    30 * 60_000,
  );
});
