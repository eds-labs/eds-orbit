import { describe, expect, it } from "vitest";
import {
  factGuardrailConflict,
  PROHIBITED_FACT_LANGUAGE,
  withinGuardrails,
} from "./fact-guardrails.ts";

// Production uLiquid, 2026-10-16 (run 63f76b22): strategy built a post on
// this fact although the profile forbids webhook promotion; the review asked
// to drop the webhook and the copywriter abstained.
const notifications = "in-app, Telegram and webhook where enabled";

describe("facts against the profile's guardrails", () => {
  it("flags a value that names what a negative guardrail forbids", () => {
    for (const guardrail of [
      "No webhook promotion",
      "Do not promote webhooks.",
      "Never mention webhooks or API keys",
      "Avoid webhook integrations",
      "Keine Webhook-Werbung",
    ])
      expect(factGuardrailConflict(notifications, [guardrail])).toBe(guardrail);
  });

  it("leaves a value alone that the guardrail does not concern", () => {
    expect(
      factGuardrailConflict("in-app and Telegram", ["No webhook promotion"]),
    ).toBeNull();
    // Generic guardrails name no subject of their own.
    expect(
      factGuardrailConflict("Claims are reviewed by the team", [
        "No unsupported claims",
      ]),
    ).toBeNull();
    // Rules that forbid nothing are not read as a ban.
    expect(
      factGuardrailConflict(notifications, [
        "Keep a calm, concrete tone about webhooks",
      ]),
    ).toBeNull();
  });

  it("needs every word of one forbidden subject", () => {
    expect(
      factGuardrailConflict("Returns are processed weekly", [
        "No guaranteed returns",
      ]),
    ).toBeNull();
    expect(
      factGuardrailConflict("Guaranteed returns on every trade", [
        "No guaranteed returns",
      ]),
    ).toBe("No guaranteed returns");
  });

  it("flags the profile's prohibited language without a guardrail", () => {
    expect(factGuardrailConflict("A risk-free way to trade", [])).toBe(
      PROHIBITED_FACT_LANGUAGE,
    );
  });

  it("keeps only the facts within the guardrails, in order", () => {
    const rows = [
      { key: "a", value: "open for product teams" },
      { key: "b", value: notifications },
      { key: "c", value: { amount: "12", currency: "USDC" } },
    ];
    expect(
      withinGuardrails(rows, ["No webhook promotion"], (row) =>
        String((row.value as any)?.amount ?? row.value),
      ).map((row) => row.key),
    ).toEqual(["a", "c"]);
  });
});
