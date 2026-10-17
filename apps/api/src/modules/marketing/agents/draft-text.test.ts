import { describe, expect, it } from "vitest";
import {
  DRAFT_INSTRUCTION_TEXT,
  instructionTextInstruction,
  instructionTextOffenses,
  instructionTextProblems,
} from "./draft-text.ts";

const post =
  "uLiquid Desk brings markets, paper trading and bots into one place.\n\nCreate your beta account";

describe("text addressed to a reviewer instead of the reader", () => {
  it("finds notes, bracketed directions and placeholders", () => {
    for (const text of [
      "[Note to reviewer: add the launch date here]",
      "Note to the editor: the CTA comes last.",
      "Reviewer: please check the tone.",
      "NOTE: replace with the final link",
      "TODO: add hashtags",
      "(Note: keep this paragraph short)",
      "[insert screenshot]",
      "[...]",
      "Fees are low […] for everyone.",
      "<add link here>",
      "As requested in the revision instructions, the CTA is now last.",
      "This draft follows the brief.",
    ]) {
      expect(instructionTextProblems(`${post}\n\n${text}`), text).toEqual([
        DRAFT_INSTRUCTION_TEXT,
      ]);
      expect(instructionTextOffenses(`${post}\n\n${text}`).length, text).toBe(
        1,
      );
    }
  });

  it("leaves a finished post alone", () => {
    for (const text of [
      post,
      "Have a note for us? Ask in the community.",
      "Read the docs [EN] and join us.",
      "Trade smarter (no bots required).",
      "Our editors' picks for October.",
      "#uLiquid #Trading",
    ])
      expect(instructionTextProblems(text), text).toEqual([]);
  });

  it("names what to remove in the revision instruction", () => {
    const instruction = instructionTextInstruction(
      `${post}\n\n[Note to reviewer: add the launch date here]`,
    );
    expect(instruction).toContain(
      '"[Note to reviewer: add the launch date here]"',
    );
    expect(instruction).toMatch(/finished post/);
  });
});
