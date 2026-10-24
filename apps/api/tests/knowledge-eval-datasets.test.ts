import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { knowledgeEvaluateInput } from "../src/modules/knowledge/evaluation-tools.ts";

// The live RAG evaluation datasets in evals/knowledge are passed as they are
// to knowledge_evaluate (step evaluate): they must parse and meet the
// evaluation's coverage rules before anything is paid.

const DATASETS = [
  "evals/knowledge/familyplan-knowledge-2026-10-24.v1.json",
];

describe.each(DATASETS)("%s", (path) => {
  const dataset = JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
  it("is a valid knowledge_evaluate request", () => {
    const parsed = knowledgeEvaluateInput.parse({
      step: "evaluate",
      indexId: "00000000-0000-4000-8000-000000000000",
      confirmQueriesMayBeSentToOpenAI: true,
      ...dataset,
    });
    const cases = parsed.cases!;
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.length).toBeLessThanOrEqual(120);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.expectedChunkIds.length).length).toBeGreaterThanOrEqual(48);
    expect(
      cases.filter((c) => !c.expectedChunkIds.length && c.forbiddenChunkIds.length).length,
    ).toBeGreaterThanOrEqual(12);
  });
});
