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
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  DIAGNOSIS_DIR,
  writeDiagnosis,
  type CaseDiagnosis,
} from "./diagnosis.ts";
import { reviewPromptHash } from "./code-version.ts";
import rawSet from "./review-v2.json" with { type: "json" };
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
    diagnose?: (entry: CaseDiagnosis) => void,
  ) {
    replay.verdicts = new Map(
      Object.entries(verdicts).map(([id, v]) => [byId(id).body, v]),
    );
    replay.calls = 0;
    replay.seen = { 1: [], 2: [] };
    return runReviewEval({
      cases,
      brief: set.brief,
      route: plan.route,
      maxCostMicros,
      runtime,
      datasetVersion: set.datasetVersion,
      diagnose,
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
    expect(report.results).toHaveLength(26);
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
      "good-reply",
      "bad-profit-revenue",
      "bad-advice-savings",
      "bad-repeat-paraphrase",
      "bad-unbacked-day-one",
    ].map(byId);
    const report = await run(cases, {
      "good-reply": { 1: "revise", 2: "approve" },
      // The worst case: the copywriter ignores the instruction and round 2 approves.
      "bad-profit-revenue": { 1: "revise", 2: "approve" },
      "bad-advice-savings": { 1: "revise", 2: "revise" },
      "bad-repeat-paraphrase": { 1: "revise", 2: "reject" },
      // A live revise of an unbacked claim: the unchanged revision is rejected in round 2.
      "bad-unbacked-day-one": { 1: "revise", 2: "reject" },
    });
    expect(report.stoppedReason).toBeNull();
    const result = Object.fromEntries(report.results.map((r) => [r.caseId, r]));
    expect(result["good-reply"]!.verdict).toBe("approve");
    expect(result["bad-profit-revenue"]!.verdict).toBe("approve");
    // Round 2 has no further revision: anything but approve rejects.
    expect(result["bad-advice-savings"]!.verdict).toBe("reject");
    expect(result["bad-repeat-paraphrase"]!.verdict).toBe("reject");
    expect(result["bad-unbacked-day-one"]!.verdict).toBe("reject");
    for (const r of report.results) {
      expect(r.revised).toBe(true);
      expect(r.reviewCalls).toBe(2);
      expect(r.costMicros).toBe(6000);
      // The unchanged revision does not trip a duplicate check: the old draft is rejected.
      expect(r.deterministicProblems).toEqual([]);
      expect(r.asPlanned).toBe(true);
    }
    expect(replay.calls).toBe(10);
    // Round 2 judged exactly the original texts.
    expect(replay.seen[2].sort()).toEqual(cases.map((c) => c.body).sort());
    const outcome = evaluatePassRule(cases, report.results, null);
    expect(outcome.rules.noBadApproved).toBe(false);
    expect(outcome.rules.goodApprovedOrOwner).toBe(true);
    expect(outcome.pass).toBe(false);
  }, 120_000);

  it("collects both rounds' reasons for a diagnosis and writes them only under .runtime", async () => {
    const cases = ["good-join-now", "good-reply", "good-needs"].map(byId);
    const entries: CaseDiagnosis[] = [];
    const report = await run(
      cases,
      {
        "good-join-now": { 1: "approve" },
        "good-reply": { 1: "revise", 2: "reject" },
        "good-needs": { 1: "reject" },
      },
      plan.maxCostMicros,
      (entry) => entries.push(entry),
    );
    expect(report.stoppedReason).toBeNull();
    expect(entries.map((e) => e.caseId)).toEqual(cases.map((c) => c.id));
    const [approved, revised, rejected] = entries;
    expect(approved).toEqual({
      caseId: "good-join-now",
      label: "good",
      category: "good",
      verdict: "approve",
      errorCode: null,
      rounds: [
        {
          round: 1,
          verdict: "approve",
          modelVerdict: "approve",
          reasons: [],
          revisionInstructions: null,
          deterministicProblems: [],
          body: byId("good-join-now").body,
        },
      ],
    });
    expect(revised!.verdict).toBe("reject");
    expect(revised!.rounds).toEqual([
      {
        round: 1,
        verdict: "revise",
        modelVerdict: "revise",
        reasons: ["Synthetic reason."],
        revisionInstructions: "Synthetic instruction.",
        deterministicProblems: [],
        body: byId("good-reply").body,
      },
      {
        round: 2,
        verdict: "reject",
        modelVerdict: "reject",
        reasons: ["Synthetic reason."],
        revisionInstructions: null,
        deterministicProblems: [],
        // The worst-case copywriter keeps the body unchanged.
        body: byId("good-reply").body,
      },
    ]);
    expect(rejected!.rounds).toEqual([
      expect.objectContaining({
        round: 1,
        verdict: "reject",
        reasons: ["Synthetic reason."],
      }),
    ]);
    // The metrics report never carries the reasons.
    expect(JSON.stringify(report)).not.toContain("Synthetic reason");

    const evidenceDir = fileURLToPath(
      new URL("../../docs/evidence/", import.meta.url),
    );
    const evidenceBefore = (await readdir(evidenceDir)).sort();
    const root = await mkdtemp(join(tmpdir(), "orbit-diagnosis-"));
    try {
      const stamp = "2026-10-10T07-00-00Z";
      const paths = await writeDiagnosis(
        root,
        stamp,
        {
          mode: "diagnose-good",
          datasetVersion: report.datasetVersion,
          datasetHash: report.datasetHash,
          startedAt: report.startedAt,
          commit: "0".repeat(40),
          dirty: false,
          promptHash: plan.promptHash,
          stoppedReason: report.stoppedReason,
          cleanupError: report.cleanupError,
          cases: entries,
        },
        runtime.apiKey,
      );
      const base = join(root, DIAGNOSIS_DIR, `agent-review-diagnosis-${stamp}`);
      expect(DIAGNOSIS_DIR).toBe(".runtime");
      expect(paths).toEqual({ json: base + ".json", md: base + ".md" });
      // Owner-only files.
      expect((await stat(paths.json)).mode & 0o777).toBe(0o600);
      const written = JSON.parse(await readFile(paths.json, "utf8"));
      expect(written.note).toContain("DIAGNOSTIC");
      expect(written.result).toBe("DIAGNOSTIC");
      expect(written.cases).toEqual(entries);
      const markdown = await readFile(paths.md, "utf8");
      expect(markdown).toContain("DIAGNOSTIC — not a gate result");
      expect(markdown).toContain("Synthetic instruction.");
      expect(markdown).toContain(byId("good-reply").body);
      for (const text of [JSON.stringify(written), markdown])
        expect(text).not.toContain(runtime.apiKey);
      // Nothing else is written: only .runtime under the root, nothing in docs/evidence.
      expect(await readdir(root)).toEqual([DIAGNOSIS_DIR]);
      expect(existsSync(join(root, "docs"))).toBe(false);
      expect((await readdir(evidenceDir)).sort()).toEqual(evidenceBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("stops at the ceiling before a reservation it cannot afford", async () => {
    const cases = ["good-join-now", "good-invite"].map(byId);
    // Less than one review reservation: the first call is refused, nothing is sent.
    const report = await run(
      cases,
      { "good-join-now": { 1: "approve" } },
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
