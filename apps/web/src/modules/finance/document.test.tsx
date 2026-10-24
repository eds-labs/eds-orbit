import { describe, expect, it } from "vitest";
import { awaitsExtraction, canRetry, lastErrorOf } from "./document";

describe("finance document extraction actions", () => {
  it("offers the AI extraction for a document that arrived with AI off", () => {
    const waiting = { status: "needs_review" as const, flags: ["ai_off"] };
    expect(awaitsExtraction(waiting)).toBe(true);
    expect(canRetry(waiting)).toBe(true);
  });

  it("offers it after a failed answer or the daily ceiling, not for long or finished documents", () => {
    expect(canRetry({ status: "needs_review" as const, flags: ["extraction_failed"] })).toBe(true);
    expect(canRetry({ status: "needs_review" as const, flags: ["ai_ceiling"] })).toBe(true);
    expect(canRetry({ status: "needs_review" as const, flags: ["ai_off", "too_long"] })).toBe(false);
    expect(canRetry({ status: "needs_review" as const, flags: ["low_confidence"] })).toBe(false);
    expect(canRetry({ status: "booked" as const, flags: ["ai_off"] })).toBe(false);
    expect(canRetry({ status: "failed" as const, flags: [] })).toBe(true);
  });

  it("reads the last failure the server kept", () => {
    expect(
      lastErrorOf({
        extraction: {
          processing: {
            lastErrorCode: "FINANCE_OUTPUT_NOT_VALID",
            lastErrorAt: "2026-10-24T15:40:00.000Z",
          },
        },
      }),
    ).toEqual({
      lastErrorCode: "FINANCE_OUTPUT_NOT_VALID",
      lastErrorAt: "2026-10-24T15:40:00.000Z",
    });
    expect(lastErrorOf({ extraction: null })).toBeNull();
  });
});
