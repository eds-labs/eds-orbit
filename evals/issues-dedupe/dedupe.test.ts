import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lexicalScore } from "../../apps/api/src/modules/issues/duplicates.ts";
import { defaultIssuesSettings } from "../../apps/api/src/modules/issues/settings.ts";

// Offline eval of the issue center's lexical duplicate stage (ADR 0018
// WP3.7): deterministic, no model call. For each new report the corpus is
// ranked by `lexicalScore`; a true duplicate must be among the top five
// candidates above the project's default threshold (recall@5 >= 0.8).
type Item = { id: string; title: string; summary: string; components: string[] };
const set = JSON.parse(readFileSync(new URL("./pairs-v1.json", import.meta.url), "utf8")) as {
  issues: Item[];
  queries: Array<Item & { duplicateOf: string | null }>;
};
const threshold = defaultIssuesSettings().dedupe.suggestThreshold;
const now = new Date("2026-10-26T12:00:00Z");
const seen = new Date("2026-10-20T12:00:00Z");

function candidates(query: Item) {
  return set.issues
    .map((issue) => ({
      id: issue.id,
      ...lexicalScore({ ...query, lastSeenAt: now }, { ...issue, lastSeenAt: seen }, now),
    }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

describe("issue duplicates, lexical stage (evals/issues-dedupe v1)", () => {
  it("has at least 60 labelled pairs in German and English", () => {
    expect(set.queries.length).toBeGreaterThanOrEqual(60);
    expect(set.queries.filter((q) => q.duplicateOf).length).toBeGreaterThanOrEqual(40);
  });

  it("finds true duplicates among the top five candidates (recall@5 >= 0.8)", () => {
    const duplicates = set.queries.filter((q) => q.duplicateOf);
    const missed = duplicates.filter((q) => !candidates(q).some((c) => c.id === q.duplicateOf));
    const recall = 1 - missed.length / duplicates.length;
    // Shown in the test output for the record.
    console.info(`issues-dedupe v1: recall@5 ${recall.toFixed(3)}; missed ${missed.map((q) => q.id).join(", ") || "none"}`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it("suggests little for reports that duplicate nothing", () => {
    const unrelated = set.queries.filter((q) => !q.duplicateOf);
    const suggested = unrelated.filter((q) => candidates(q).length > 0);
    console.info(`issues-dedupe v1: ${suggested.length}/${unrelated.length} unrelated reports got a suggestion`);
    expect(suggested.length / unrelated.length).toBeLessThanOrEqual(0.2);
  });

  it("ranks the true duplicate first in most cases", () => {
    const duplicates = set.queries.filter((q) => q.duplicateOf);
    const first = duplicates.filter((q) => candidates(q)[0]?.id === q.duplicateOf).length;
    console.info(`issues-dedupe v1: top-1 ${(first / duplicates.length).toFixed(3)}`);
    expect(first / duplicates.length).toBeGreaterThanOrEqual(0.7);
  });
});
