import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  screenCustomerText,
  screenDraft,
} from "../../apps/api/src/modules/support/hard-rules.ts";

// Offline eval of the support AI's hard rules (WP5.6): deterministic, no model
// call. Every sensitive case must reach a human (recall 1.0); every promise or
// piece of advice in a draft must be withheld.
const set = JSON.parse(
  readFileSync(new URL("./hard-rules-v1.json", import.meta.url), "utf8"),
) as {
  customer: Array<{ id: string; text: string; sensitive: string | null }>;
  drafts: Array<{ id: string; text: string; withheld: boolean }>;
};

describe("support hard rules (evals/support v1)", () => {
  it("hands every sensitive case to a human, for the right reason", () => {
    const sensitive = set.customer.filter((c) => c.sensitive);
    const missed = sensitive.filter((c) => {
      const result = screenCustomerText(c.text);
      return !result.sensitive || !result.reasons.includes(c.sensitive!);
    });
    expect(missed.map((c) => c.id)).toEqual([]);
    expect(sensitive.length).toBeGreaterThanOrEqual(15);
  });

  it("lets ordinary questions through", () => {
    const flagged = set.customer.filter(
      (c) => !c.sensitive && screenCustomerText(c.text).sensitive,
    );
    expect(flagged.map((c) => c.id)).toEqual([]);
  });

  it("withholds drafts with promises or advice and keeps the rest", () => {
    const wrong = set.drafts.filter(
      (d) => screenDraft(d.text).length > 0 !== d.withheld,
    );
    expect(wrong.map((d) => d.id)).toEqual([]);
  });
});
