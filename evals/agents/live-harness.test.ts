import { afterAll, describe, expect, it, vi } from "vitest";

// Offline: the live harness end to end with replayed review answers; no provider is called.
const replay = vi.hoisted(() => ({
  // Recorded verdict per draft body and review round.
  verdicts: new Map<string, { 1: string; 2?: string }>(),
  calls: 0,
  maxBytes: 0,
  // Bodies the model saw, per round.
  seen: { 1: [] as string[], 2: [] as string[] },
}));
vi.mock("../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/ai/src/index.ts")>()),
  ...(await import("./stubs.ts")).draftStubs(),
  respond: vi.fn(async (request: any) => {
    replay.calls++;
    // The size the runner reserves for (see runSpecialist).
    replay.maxBytes = Math.max(
      replay.maxBytes,
      Buffer.byteLength(
        JSON.stringify({
          input: request.input,
          instructions: request.instructions,
          tools: request.tools,
          outputSchema: request.outputSchema,
        }),
      ),
    );
    const input = JSON.parse(request.input[0].content) as {
      round: 1 | 2;
      drafts: Array<{ contentId: string; body: string }>;
    };
    const drafts = input.drafts;
    for (const draft of drafts) replay.seen[input.round].push(draft.body);
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                decisions: drafts.map((draft) => {
                  const recorded = replay.verdicts.get(draft.body)!;
                  const verdict =
                    input.round === 2
                      ? (recorded[2] ?? recorded[1])
                      : recorded[1];
                  return {
                    contentId: draft.contentId,
                    verdict,
                    reasons: verdict === "approve" ? [] : ["Synthetic reason."],
                    revisionInstructions:
                      verdict === "revise" ? "Synthetic instruction." : null,
                  };
                }),
              }),
            },
          ],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 100,
        reasoningTokens: 50,
        costMicros: 3000,
      },
      responseId: "resp_review",
    };
  }),
}));
import { authDb, closeDatabase } from "../../packages/db/src/index.ts";
import { parseCandidatesFile } from "../generation/live-plan.ts";
import { REVIEW_EVAL_MARKER, runReviewEval } from "./live-harness.ts";
import {
  evaluatePassRule,
  parseRouteFile,
  planReviewEval,
  REVIEW_REQUEST_BYTES,
  renderReport,
} from "./live-plan.ts";
import { parseReviewSet, type ReviewCase } from "./review-set.ts";
import { reviewPromptHash } from "./code-version.ts";
import rawSet from "./review-v1.json" with { type: "json" };
import rawRoute from "./review-route-v1.json" with { type: "json" };
import rawRates from "../generation/candidates-v1.json" with { type: "json" };

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const set = parseReviewSet(rawSet);
const rates = parseCandidatesFile(rawRates);
const plan = planReviewEval(
  {},
  set,
  parseRouteFile(rawRoute),
  rates,
  reviewPromptHash(),
  new Date(rates.verifiedAt).valueOf() + 3600_000,
);
const runtime = {
  apiKey: "synthetic-eval-key-not-real-0123456789",
  ...plan.runtime,
};
const byId = (id: string) => set.cases.find((c) => c.id === id)!;

describe.skipIf(!enabled)("Live review eval harness (offline replay)", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  async function run(
    cases: ReviewCase[],
    verdicts: Record<string, { 1: string; 2?: string }>,
    maxCostMicros = plan.maxCostMicros,
  ) {
    replay.verdicts = new Map(
      Object.entries(verdicts).map(([id, v]) => [byId(id).body, v]),
    );
    replay.calls = 0;
    replay.seen = { 1: [], 2: [] };
    return runReviewEval({
      cases,
      route: plan.route,
      maxCostMicros,
      runtime,
      datasetVersion: set.datasetVersion,
    });
  }

  it("runs the whole set as planned with the recorded answers, metrics only, and deletes the project", async () => {
    replay.maxBytes = 0;
    const report = await run(
      set.cases,
      Object.fromEntries(
        set.cases.map((c) => [c.id, { 1: c.recorded.verdict }]),
      ),
    );
    expect(report.stoppedReason).toBeNull();
    expect(report.cleanupError).toBeNull();
    expect(report.results).toHaveLength(21);
    const outcome = evaluatePassRule(set.cases, report.results, null);
    expect(outcome.rules).toEqual({
      noBadApproved: true,
      bareHostNotApproved: true,
      goodApprovedOrOwner: true,
      complete: true,
      asPlanned: true,
      costsKnown: true,
    });
    expect(outcome.pass).toBe(true);
    for (const r of report.results) {
      expect(r.asPlanned).toBe(true);
      expect(r.reviewCalls).toBe(r.modelCalled ? 1 : 0);
      expect(r.costMicros).toBe(r.modelCalled ? 3000 : null);
      expect(r.settledMicros).toBe(r.modelCalled ? 3000 : null);
      expect(r.revised).toBe(false);
    }
    expect(replay.calls).toBe(
      set.cases.filter((c) => c.expected.modelSees).length,
    );
    // Every review request of the set stays below the planning bound.
    expect(replay.maxBytes).toBeGreaterThan(0);
    expect(replay.maxBytes).toBeLessThan(REVIEW_REQUEST_BYTES);
    // Metrics only: the model's reasons, the draft bodies and the key never reach the report.
    const written = JSON.stringify(report) + renderReport(report, outcome);
    expect(written).not.toContain("Synthetic reason");
    expect(written).not.toContain(runtime.apiKey);
    for (const c of set.cases) expect(written).not.toContain(c.body);
    expect(
      await authDb.workspace.findUnique({ where: { id: report.workspaceId } }),
    ).toBeNull();
    expect(
      await authDb.user.count({ where: { name: REVIEW_EVAL_MARKER } }),
    ).toBe(0);
  }, 300_000);

  it("runs the production revision with an unchanged body and lets round 2 decide", async () => {
    const cases = [
      "good-day-one",
      "bad-profit-revenue",
      "bad-advice-savings",
      "bad-repeat-paraphrase",
    ].map(byId);
    const report = await run(cases, {
      "good-day-one": { 1: "revise", 2: "approve" },
      // The worst case: the copywriter ignores the instruction and round 2 approves.
      "bad-profit-revenue": { 1: "revise", 2: "approve" },
      "bad-advice-savings": { 1: "revise", 2: "revise" },
      "bad-repeat-paraphrase": { 1: "revise", 2: "reject" },
    });
    expect(report.stoppedReason).toBeNull();
    const result = Object.fromEntries(report.results.map((r) => [r.caseId, r]));
    expect(result["good-day-one"]!.verdict).toBe("approve");
    expect(result["bad-profit-revenue"]!.verdict).toBe("approve");
    // Round 2 has no further revision: anything but approve rejects.
    expect(result["bad-advice-savings"]!.verdict).toBe("reject");
    expect(result["bad-repeat-paraphrase"]!.verdict).toBe("reject");
    for (const r of report.results) {
      expect(r.revised).toBe(true);
      expect(r.reviewCalls).toBe(2);
      expect(r.costMicros).toBe(6000);
      // The unchanged revision does not trip a duplicate check: the old draft is rejected.
      expect(r.deterministicProblems).toEqual([]);
      expect(r.asPlanned).toBe(true);
    }
    expect(replay.calls).toBe(8);
    // Round 2 judged exactly the original texts.
    expect(replay.seen[2].sort()).toEqual(cases.map((c) => c.body).sort());
    const outcome = evaluatePassRule(cases, report.results, null);
    expect(outcome.rules.noBadApproved).toBe(false);
    expect(outcome.rules.goodApprovedOrOwner).toBe(true);
    expect(outcome.pass).toBe(false);
  }, 120_000);

  it("stops at the ceiling before a reservation it cannot afford", async () => {
    const cases = ["good-day-one", "good-join-now"].map(byId);
    // Less than one review reservation: the first call is refused, nothing is sent.
    const report = await run(
      cases,
      { "good-day-one": { 1: "approve" } },
      1_000,
    );
    expect(replay.calls).toBe(0);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.verdict).toBe("error");
    expect(report.results[0]!.modelCalled).toBe(false);
    expect(report.results[0]!.errorCode).toBe("AGENT_LIMIT");
    expect(report.stoppedReason).toBe("AGENT_LIMIT");
    expect(
      evaluatePassRule(cases, report.results, report.stoppedReason).pass,
    ).toBe(false);
  }, 120_000);
});
