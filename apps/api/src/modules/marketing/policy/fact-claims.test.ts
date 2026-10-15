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

  // Production uLiquid, 2026-10-14: natural clauses failed with
  // FACT_VALUE_MISMATCH, so drafts read like "key: false" notes.
  const custody = { key: "product.custody_model", value: "non_custodial" };
  const token = {
    key: "product.token_required_for_standard_services",
    value: "false",
  };
  const usdc = { key: "pricing.payment_in_usdc", value: "true" };

  it("accepts a possessive and a value written with hyphens", () => {
    expect(
      factClaimMatches("uLiquid Desk's custody model is non-custodial", custody),
    ).toBe(true);
    expect(
      factClaimMatches("The custody model of uLiquid Desk is non custodial", custody),
    ).toBe(true);
  });

  it("still rejects a clause with a word outside the fact", () => {
    expect(
      factClaimMatches("The custody model is fully insured and non-custodial", custody),
    ).toBe(false);
    expect(factClaimMatches("The custody model is custodial", custody)).toBe(
      false,
    );
  });

  it("accepts a plain clause for a false fact only when it is negated", () => {
    expect(
      factClaimMatches("A token is not required for standard Desk services", token),
    ).toBe(true);
    expect(
      factClaimMatches("No token is required for standard services", token),
    ).toBe(true);
    expect(
      factClaimMatches("A token is required for standard Desk services", token),
    ).toBe(false);
  });

  it("accepts a plain clause for a true fact only without a negation", () => {
    expect(factClaimMatches("Payment is in USDC", usdc)).toBe(true);
    expect(factClaimMatches("Payment is not in USDC", usdc)).toBe(false);
  });

  it("does not count a negation that belongs to the fact's subject", () => {
    const guarantee = { key: "policy.no_profit_guarantee", value: "true" };
    expect(factClaimMatches("There is no profit guarantee", guarantee)).toBe(
      false,
    );
    expect(factClaimMatches("No profit guarantee", guarantee)).toBe(true);
    expect(factClaimMatches("No profit guarantee is not given", guarantee)).toBe(
      false,
    );
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
