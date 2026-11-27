import { describe, expect, it } from "vitest";
import {
  buildEvaluationCases,
  groundedAnswerQuoteHash,
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

  it("credits the same grounded answer in other eligible passages regardless of sampling", () => {
    const answer =
      "Family members can open the shared shopping list from the household dashboard.";
    const original = {
      ...passage(1, false, "en"),
      text: `Shopping list setup\n\n${answer}`,
    };
    const exactCopy = { ...original, chunkId: "c2", publicEligible: true };
    const sameAnswer = {
      ...passage(3, true, "en"),
      text: `First choose a household. ${answer} You can then add an item.`,
    };
    const differentLanguage = { ...sameAnswer, chunkId: "c4", language: "de" };
    const alteredAnswer = {
      ...sameAnswer,
      chunkId: "c5",
      text: answer.replace("can open", "cannot open"),
    };
    const fragmentOnly = {
      ...sameAnswer,
      chunkId: "c6",
      text: `The instructions say that ${answer}`,
    };

    const answerQuoteHash = groundedAnswerQuoteHash(original.text, answer);
    expect(answerQuoteHash).toBeDefined();
    const { cases } = buildEvaluationCases(
      [
        original,
        exactCopy,
        sameAnswer,
        differentLanguage,
        alteredAnswer,
        fragmentOnly,
      ],
      [
        {
          chunkId: original.chunkId,
          question: "Where do I find my household's grocery list?",
          answerQuoteHash,
        },
      ],
    );

    expect(cases[0]?.expectedChunkIds).toEqual(["c1", "c2", "c3"]);
    expect(cases[1]).toMatchObject({
      purpose: "public",
      expectedChunkIds: [],
      forbiddenChunkIds: ["c1"],
    });
  });

  it("keeps older questions and refuses to credit an ungrounded answer quote", () => {
    const first = passage(1, true, "en");
    const other = {
      ...passage(2, true, "en"),
      text: "Family members can open the shared shopping list from the household dashboard.",
    };
    const { cases } = buildEvaluationCases(
      [first, { ...first, chunkId: "exact-copy" }, other],
      [
        {
          chunkId: first.chunkId,
          question: "What does the first passage cover?",
        },
        {
          chunkId: first.chunkId,
          question: "What is in the first passage?",
          answerQuoteHash: groundedAnswerQuoteHash(other.text, other.text),
        },
      ],
    );
    expect(groundedAnswerQuoteHash(first.text, other.text)).toBeUndefined();
    expect(
      groundedAnswerQuoteHash(other.text, other.text.slice(0, -1)),
    ).toBeUndefined();
    expect(cases.slice(0, 2).map((c) => c.expectedChunkIds)).toEqual([
      ["c1", "exact-copy"],
      ["c1", "exact-copy"],
    ]);
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
