import { afterAll, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase } from "../../packages/db/src/index.ts";
import type { OpenAiRuntimeConfig } from "../../packages/ai/src/index.ts";

// Offline only: the provider is replaced by recorded outputs; no network call is made.
const replay = vi.hoisted(() => ({
  generate: null as null | ((params: any) => Promise<unknown>),
  workspaceIds: [] as string[],
}));
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
  generate: vi.fn(async (params: any) => {
    if (!replay.generate) throw new Error("REPLAY_NOT_CONFIGURED");
    return replay.generate(params);
  }),
}));
import {
  datasetHash,
  parseFixtures,
  recordedGenerate,
  renderMarkdown,
  runEval,
  type EvalCandidate,
} from "./harness.ts";
import raw from "./fixtures-v1.json" with { type: "json" };

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const fixtures = parseFixtures(raw);
const labels = [
  "good",
  "unresolved_placeholder",
  "double_cta",
  "over_limit",
] as const;
const candidates: EvalCandidate[] = labels.map((label) => ({
  label,
  route: { model: `offline-${label}`, maxOutputTokens: 1800 },
}));
const verifiedAt = new Date().toISOString();
const rate = {
  inputMicrosPerMillion: 1000,
  outputMicrosPerMillion: 4000,
  verifiedAt,
};
const runtime: OpenAiRuntimeConfig = {
  // Synthetic placeholder; generate is mocked and never sees a provider.
  apiKey: "synthetic-offline-eval-key-not-real",
  verifiedModels: candidates.map((candidate) => candidate.route.model),
  rateCard: {
    ...Object.fromEntries(
      candidates.map((candidate) => [candidate.route.model, rate]),
    ),
    "text-embedding-3-small": rate,
  },
};
const xCases = fixtures.cases.filter((item) => item.channel.provider === "x");

describe.skipIf(!enabled)(
  "Offline generation eval on the real review path",
  () => {
    afterAll(async () => {
      await closeDatabase();
    });

    it("scores recorded outputs with the production review gate", async () => {
      const cases = xCases.slice(0, 3);
      expect(cases).toHaveLength(3);
      replay.generate = recordedGenerate(cases, candidates);
      const report = await runEval({
        cases,
        candidates,
        repetitions: 1,
        maxCostMicros: 1_000_000,
        runtime,
        datasetVersion: fixtures.datasetVersion,
      });
      expect(report.results).toHaveLength(12);
      expect(report.results.every((result) => result.errorCode === null)).toBe(
        true,
      );
      const summary = (label: string) =>
        report.summary.find((row) => row.candidate === label)!;
      expect(summary("good")).toMatchObject({ runs: 3, passRate: 1 });
      expect(summary("good").problemCounts).toEqual({});
      expect(summary("good").costPerAcceptedMicros).toBe(
        Math.round(summary("good").totalCostMicros / 3),
      );
      const problems = (label: string) =>
        report.results.filter((result) => result.candidate === label);
      for (const result of problems("unresolved_placeholder")) {
        expect(result.valid).toBe(false);
        expect(result.problems).toContain("FACT_PLACEHOLDER_UNRESOLVED");
      }
      for (const result of problems("double_cta")) {
        expect(result.valid).toBe(false);
        expect(result.problems).toContain("MULTIPLE_PRIMARY_CTAS");
      }
      for (const result of problems("over_limit")) {
        expect(result.valid).toBe(false);
        expect(result.problems).toContain("CHANNEL_LIMIT_EXCEEDED");
      }
      for (const label of labels.slice(1))
        expect(summary(label)).toMatchObject({
          runs: 3,
          passRate: 0,
          costPerAcceptedMicros: null,
        });
      for (const result of report.results) {
        expect(result.costMicros).toBe(result.settledMicros);
        expect(result.costMicros).toBeGreaterThan(0);
        expect(result.inputTokens).toBeGreaterThan(0);
        expect(result.outputTokens).toBeGreaterThan(0);
        expect(result.durationMs).toEqual(expect.any(Number));
      }
      expect(report.datasetHash).toBe(
        datasetHash(cases, candidates, 1, 1_000_000),
      );
      expect(report.stoppedReason).toBeNull();
      // The synthetic workspace and owner are removed again.
      expect(
        await authDb.workspace.findUnique({
          where: { id: report.workspaceId },
        }),
      ).toBeNull();
      const markdown = renderMarkdown(report);
      const summaryRows = markdown
        .split("## Summary")[1]!
        .split("\n## ")[0]!
        .split("\n")
        .filter((line) => /^\| (?!Candidate|---)/.test(line));
      expect(summaryRows).toHaveLength(candidates.length);
      for (const candidate of candidates)
        expect(
          summaryRows.some((line) => line.startsWith(`| ${candidate.label} |`)),
        ).toBe(true);
    }, 180_000);

    it("accepts every recorded good output of the fixture set", async () => {
      const good = candidates.slice(0, 1);
      replay.generate = recordedGenerate(fixtures.cases, good);
      const report = await runEval({
        cases: fixtures.cases,
        candidates: good,
        repetitions: 1,
        maxCostMicros: 1_000_000,
        runtime,
        datasetVersion: fixtures.datasetVersion,
      });
      expect(
        report.results.map((result) => [result.caseId, result.problems]),
      ).toEqual(fixtures.cases.map((item) => [item.id, []]));
      expect(report.summary[0]).toMatchObject({ runs: 8, passRate: 1 });
    }, 180_000);

    it("stops on a budget refusal and still reports completed runs", async () => {
      const cases = xCases.slice(0, 2);
      const good = candidates.slice(0, 1);
      replay.generate = recordedGenerate(cases, good);
      // Input is free, so a generation reserves exactly maxOutputTokens (1,800)
      // and a query embedding 1 (settled at the mocked 7). The first run fits
      // (7 + 1,800); the second no longer fits the remaining budget.
      const outputOnly = {
        inputMicrosPerMillion: 0,
        cachedInputMicrosPerMillion: 0,
        cacheWriteMicrosPerMillion: 0,
        outputMicrosPerMillion: 1_000_000,
        verifiedAt,
      };
      const report = await runEval({
        cases,
        candidates: good,
        repetitions: 2,
        maxCostMicros: 1_810,
        runtime: {
          ...runtime,
          rateCard: {
            [good[0]!.route.model]: outputOnly,
            "text-embedding-3-small": outputOnly,
          },
        },
        datasetVersion: fixtures.datasetVersion,
      });
      // The harness lowers the per-run limit to the remaining budget, so the
      // journal refuses the second estimate as above the per-run limit.
      expect(report.stoppedReason).toBe("BUDGET_NOT_APPROVED");
      expect(report.results).toHaveLength(2);
      expect(report.results[0]).toMatchObject({ valid: true, errorCode: null });
      expect(report.results[1]).toMatchObject({
        valid: false,
        errorCode: "BUDGET_NOT_APPROVED",
        costMicros: null,
      });
      expect(
        await authDb.workspace.findUnique({
          where: { id: report.workspaceId },
        }),
      ).toBeNull();
    }, 180_000);

    it("stops on a reservation whose cost is unknown", async () => {
      // No over_limit recording exists for Telegram: the replay throws like a
      // provider failure, so the reservation settles as unknown.
      const cases = fixtures.cases.filter(
        (item) => item.id === "telegram-en-onboarding",
      );
      const ordered = [candidates[3]!, candidates[0]!];
      replay.generate = recordedGenerate(cases, ordered);
      const report = await runEval({
        cases,
        candidates: ordered,
        repetitions: 1,
        maxCostMicros: 1_000_000,
        runtime,
        datasetVersion: fixtures.datasetVersion,
      });
      expect(report.stoppedReason).toBe("RESERVATION_UNKNOWN");
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({
        candidate: "over_limit",
        valid: false,
        errorCode: "MODEL_OUTCOME_OR_COST_UNKNOWN",
        costMicros: null,
        settledMicros: null,
      });
      expect(
        await authDb.workspace.findUnique({
          where: { id: report.workspaceId },
        }),
      ).toBeNull();
    }, 180_000);
  },
);

describe("Dataset hash", () => {
  it("is stable and sensitive to the cost ceiling", () => {
    const cases = fixtures.cases;
    const first = datasetHash(cases, candidates, 2, 5_000_000);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(datasetHash(structuredClone(cases), candidates, 2, 5_000_000)).toBe(
      first,
    );
    // Key order does not matter: the JSON is canonical.
    const reordered = candidates.map((candidate) => ({
      route: { maxOutputTokens: 1800, model: candidate.route.model },
      label: candidate.label,
    }));
    expect(datasetHash(cases, reordered, 2, 5_000_000)).toBe(first);
    expect(datasetHash(cases, candidates, 2, 4_000_000)).not.toBe(first);
    expect(datasetHash(cases, candidates, 1, 5_000_000)).not.toBe(first);
  });

  it("parses the fixture set: 8 cases with 2 to 4 facts each", () => {
    expect(fixtures.cases).toHaveLength(8);
    for (const item of fixtures.cases) {
      expect(item.facts.length).toBeGreaterThanOrEqual(2);
      expect(item.facts.length).toBeLessThanOrEqual(4);
      expect(item.recorded?.good).toBeDefined();
    }
    expect(
      fixtures.cases.filter((item) => item.contentType === "blog"),
    ).toHaveLength(1);
    expect(
      fixtures.cases.filter((item) => item.id.startsWith("negative-")),
    ).toHaveLength(2);
  });
});
