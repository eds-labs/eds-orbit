import { describe, expect, it } from "vitest";
import { factClaimMatches } from "./fact-claims.ts";

const tagline = { key: "product.tagline", value: "AI assists. You decide." };

describe("fact claim matching", () => {
  it("accepts a verbatim quote of a multi-word value without key words", () => {
    expect(factClaimMatches("AI assists. You decide.", tagline)).toBe(true);
    expect(factClaimMatches("AI  assists.  You decide.", tagline)).toBe(true);
  });

  it("still rejects paraphrases and partial quotes", () => {
    expect(factClaimMatches("AI helps. You decide.", tagline)).toBe(false);
    expect(factClaimMatches("You decide.", tagline)).toBe(false);
    expect(
      factClaimMatches("AI assists. You decide. Guaranteed returns.", tagline),
    ).toBe(false);
  });

  it("does not treat a bare single-word value as a claim on its own", () => {
    expect(
      factClaimMatches("true", {
        key: "policy.no_profit_guarantee",
        value: "true",
      }),
    ).toBe(false);
  });
});
