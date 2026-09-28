import { describe, expect, it } from "vitest";
import {
  DUPLICATE_DRAFT_SIMILARITY,
  draftSimilarity,
} from "./draft-similarity.ts";

describe("draft similarity", () => {
  it("treats reworded copies of the same post as duplicates", () => {
    expect(
      draftSimilarity(
        "Users remain in control of their exchange accounts, wallets and trading decisions. Explore the beta",
        "Users remain in control of their exchange accounts, wallets and trading decisions!\n\nExplore the beta https://desk.uliquid.vip/en/register",
      ),
    ).toBeGreaterThanOrEqual(DUPLICATE_DRAFT_SIMILARITY);
  });

  it("keeps drafts with a different angle apart", () => {
    expect(
      draftSimilarity(
        "Users remain in control of their exchange accounts, wallets and trading decisions. Explore the beta",
        "Paper trading lets you test strategies without risking funds. Explore the beta",
      ),
    ).toBeLessThan(DUPLICATE_DRAFT_SIMILARITY);
  });

  it("ignores empty text", () => {
    expect(draftSimilarity("", "Explore the beta")).toBe(0);
  });
});
