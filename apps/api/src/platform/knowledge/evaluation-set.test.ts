import { describe, expect, it } from "vitest";
import {
  buildEvaluationCases,
  selectPassages,
  type Passage,
} from "./evaluation-set.ts";

const passage = (
  n: number,
  publicEligible = true,
  language = "de",
): Passage => ({
  chunkId: `c${n}`,
  title: `Doc ${n}`,
  heading: "",
  text: `Passage ${n}`,
  language,
  publicEligible,
});

describe("generated evaluation sets", () => {
  it("asks one question per passage of a large corpus, at most 100", () => {
    const many = Array.from({ length: 112 }, (_, i) => passage(i));
    const { selected, perPassage } = selectPassages(many);
    expect(perPassage).toBe(1);
    expect(selected).toHaveLength(100);
    expect(new Set(selected.map((p) => p.chunkId)).size).toBe(100);
  });

  it("asks more questions per passage of a small corpus to reach 48", () => {
    const few = Array.from({ length: 20 }, (_, i) => passage(i));
    expect(selectPassages(few)).toMatchObject({ perPassage: 3 });
    expect(selectPassages(few).selected).toHaveLength(20);
  });

  it("builds internal positives, public-leak negatives for internal passages, and language negatives to reach 12", () => {
    const passages = [
      ...Array.from({ length: 50 }, (_, i) => passage(i)),
      ...Array.from({ length: 4 }, (_, i) => passage(100 + i, false)),
    ];
    const questions = passages.map((p) => ({
      chunkId: p.chunkId,
      question: `Frage zu ${p.title}?`,
    }));
    const { cases, kinds } = buildEvaluationCases(passages, questions);
    const positives = cases.filter((c) => kinds[c.id] === "positive");
    const leaks = cases.filter((c) => kinds[c.id] === "public_leak");
    const language = cases.filter((c) => kinds[c.id] === "language");
    expect(positives).toHaveLength(54);
    expect(positives[0]).toEqual({
      id: "q1",
      query: "Frage zu Doc 0?",
      expectedChunkIds: ["c0"],
      forbiddenChunkIds: [],
      language: "de",
      purpose: "internal",
    });
    // An internal passage must not be found by a public question.
    expect(leaks).toHaveLength(4);
    expect(leaks[0]).toMatchObject({
      expectedChunkIds: [],
      forbiddenChunkIds: ["c100"],
      purpose: "public",
    });
    // A question in another language must not find its passage.
    expect(language).toHaveLength(8);
    expect(language[0]).toMatchObject({
      forbiddenChunkIds: ["c0"],
      language: "en",
      purpose: "internal",
    });
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("ignores questions about passages outside the set", () => {
    const { cases } = buildEvaluationCases(
      [passage(1)],
      [
        { chunkId: "c1", question: "Gilt das?" },
        { chunkId: "unknown", question: "Und das?" },
      ],
    );
    expect(cases.map((c) => c.query)).toEqual(["Gilt das?", "Gilt das?"]);
  });
});
