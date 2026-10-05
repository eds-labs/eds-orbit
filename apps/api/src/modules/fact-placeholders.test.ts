import { describe, expect, it } from "vitest";
import {
  hasFactPlaceholder,
  resolveFactPlaceholders,
} from "./fact-placeholders.ts";
import { factClaimMatches } from "./fact-claims.ts";

const facts = [
  {
    id: "fact-control",
    value:
      "Users remain in control of their exchange accounts, wallets and trading decisions.",
  },
];

describe("fact placeholders", () => {
  it("inserts the exact verified value into body and claim", () => {
    const resolved = resolveFactPlaceholders(
      {
        title: "t",
        body: "Tools should support you.\n\n{{fact:fact-control}}\n\nExplore the beta",
        claims: [
          {
            kind: "fact",
            text: "{{fact:fact-control}}",
            factId: "fact-control",
          },
          { kind: "style", text: "Explore the beta" },
        ],
      },
      facts,
    );
    expect(resolved.body).toBe(
      "Tools should support you.\n\nUsers remain in control of their exchange accounts, wallets and trading decisions.\n\nExplore the beta",
    );
    expect(resolved.claims[0]).toEqual({
      kind: "fact",
      text: facts[0]!.value,
      factId: "fact-control",
    });
    expect(resolved.claims[1]).toEqual({
      kind: "style",
      text: "Explore the beta",
    });
    expect(resolved.body.includes(resolved.claims[0]!.text)).toBe(true);
  });

  it("does not double the closing punctuation and fills a missing factId", () => {
    const resolved = resolveFactPlaceholders(
      {
        body: "{{ fact:fact-control }}. More text.",
        claims: [{ kind: "fact", text: "{{fact:fact-control}}" }],
      },
      facts,
    );
    expect(resolved.body).toBe(`${facts[0]!.value} More text.`);
    expect(resolved.claims[0]).toMatchObject({ factId: "fact-control" });
  });

  it("keeps the subject clause around a single-word value", () => {
    // A bare "open" says nothing and fails claim review (production uLiquid,
    // 2026-10-05); the clause names what is open.
    const beta = {
      id: "fact-beta",
      key: "product.beta_access.status",
      value: "open",
    };
    const resolved = resolveFactPlaceholders(
      {
        body: "Beta access is {{fact:fact-beta}}. Request beta access",
        claims: [
          {
            kind: "fact",
            text: "Beta access is {{fact:fact-beta}}",
            factId: "fact-beta",
          },
        ],
      },
      [...facts, beta],
    );
    expect(resolved.body).toBe("Beta access is open. Request beta access");
    expect(resolved.claims[0]!.text).toBe("Beta access is open");
    expect(resolved.body.includes(resolved.claims[0]!.text)).toBe(true);
    expect(factClaimMatches(resolved.claims[0]!.text, beta)).toBe(true);
  });

  it("still uses a multi-word value alone as the claim text", () => {
    const resolved = resolveFactPlaceholders(
      {
        body: "Remember: {{fact:fact-control}}",
        claims: [{ kind: "fact", text: "Remember: {{fact:fact-control}}" }],
      },
      facts,
    );
    expect(resolved.claims[0]!.text).toBe(facts[0]!.value);
  });

  it("leaves unknown placeholders visible for claim review", () => {
    const output = {
      body: "{{fact:not-in-evidence}}",
      claims: [{ kind: "fact" as const, text: "{{fact:not-in-evidence}}" }],
    };
    const resolved = resolveFactPlaceholders(output, facts);
    expect(resolved).toEqual(output);
    expect(hasFactPlaceholder(resolved.body)).toBe(true);
    expect(hasFactPlaceholder("Plain text {not a placeholder}")).toBe(false);
  });
});
