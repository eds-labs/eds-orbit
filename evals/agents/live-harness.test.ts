import { afterAll, describe, expect, it, vi } from "vitest";

// Offline: the live harness end to end with replayed review answers; no provider is called.
const replay = vi.hoisted(() => ({
  // Recorded verdict per case id (the draft title is the case id).
  verdicts: new Map<string, string>(),
  calls: 0,
  maxBytes: 0,
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
    const drafts = JSON.parse(request.input[0].content).drafts as Array<{
      contentId: string;
      title: string;
    }>;
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
                  const verdict = replay.verdicts.get(draft.title)!;
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
vi.mock(
  "../../apps/api/src/modules/agents/specialists/copywriter.ts",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/agents/specialists/copywriter.ts")
    >()),
    reviseAssignmentDraft: await (await import("./stubs.ts")).revisionStub(),
  }),
);

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
    verdicts: Record<string, string>,
    maxCostMicros = plan.maxCostMicros,
  ) {
    replay.verdicts = new Map(Object.entries(verdicts));
    replay.calls = 0;
    return runReviewEval({
      cases,
      route: plan.route,
      maxCostMicros,
      runtime,
      datasetVersion: set.datasetVersion,
    });
  }

  it("classifies every verdict, records metrics only and deletes the project", async () => {
    const cases = [
      "good-day-one",
      "good-feedback",
      "bad-wrong-number-free-text",
      "bad-profit-revenue",
      "bad-wrong-number-price",
      "bad-link-bare-host",
      "bad-repeat-exact",
      "bad-repeat-paraphrase",
    ].map(byId);
    const report = await run(cases, {
      "good-day-one": "approve",
      // A wrong approve of a bad case the deterministic checks do not catch.
      "bad-wrong-number-free-text": "approve",
      "bad-profit-revenue": "revise",
      "good-feedback": "reject",
      "bad-repeat-paraphrase": "reject",
    });
    expect(report.stoppedReason).toBeNull();
    const verdict = Object.fromEntries(
      report.results.map((r) => [r.caseId, r.verdict]),
    );
    expect(verdict).toEqual({
      "good-day-one": "approve",
      "good-feedback": "reject",
      "bad-wrong-number-free-text": "approve",
      "bad-profit-revenue": "revise",
      "bad-wrong-number-price": "blocked",
      "bad-link-bare-host": "owner",
      "bad-repeat-exact": "blocked",
      "bad-repeat-paraphrase": "reject",
    });
    // One review call per case the model sees; never a revision or a second round.
    expect(replay.calls).toBe(5);
    expect(replay.maxBytes).toBeGreaterThan(0);
    expect(replay.maxBytes).toBeLessThan(REVIEW_REQUEST_BYTES);
    for (const r of report.results) {
      expect(r.modelCalled).toBe(byId(r.caseId).expected.modelSees);
      expect(r.costMicros).toBe(r.modelCalled ? 3000 : null);
      expect(r.settledMicros).toBe(r.modelCalled ? 3000 : null);
      expect(r.outputTokens).toBe(r.modelCalled ? 100 : null);
    }
    expect(
      report.results.find((r) => r.caseId === "bad-link-bare-host")!
        .deterministicProblems,
    ).toContain("LINK_UNVERIFIED");
    const outcome = evaluatePassRule(
      cases,
      report.results,
      report.stoppedReason,
    );
    expect(outcome.rules.noBadApproved).toBe(false);
    expect(outcome.rules.goodApprovedOrOwner).toBe(false);
    expect(outcome.rules.bareHostNotApproved).toBe(true);
    expect(outcome.pass).toBe(false);
    // Metrics only: the model's reasons and the draft bodies never reach the report.
    const written = JSON.stringify(report) + renderReport(report, outcome);
    expect(written).not.toContain("Synthetic reason");
    expect(written).not.toContain("Synthetic instruction");
    expect(written).not.toContain(runtime.apiKey);
    for (const c of cases) expect(written).not.toContain(c.body);
    expect(
      await authDb.workspace.findUnique({ where: { id: report.workspaceId } }),
    ).toBeNull();
    expect(
      await authDb.user.count({ where: { name: REVIEW_EVAL_MARKER } }),
    ).toBe(0);
  }, 120_000);

  it("stops at the ceiling before a reservation it cannot afford", async () => {
    const cases = ["good-day-one", "good-join-now"].map(byId);
    // Less than one review reservation: the first call is refused, nothing is sent.
    const report = await run(cases, { "good-day-one": "approve" }, 1_000);
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
