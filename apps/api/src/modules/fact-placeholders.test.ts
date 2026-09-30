import { describe, expect, it } from "vitest";
import {
  hasFactPlaceholder,
  resolveFactPlaceholders,
} from "./fact-placeholders.ts";

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
