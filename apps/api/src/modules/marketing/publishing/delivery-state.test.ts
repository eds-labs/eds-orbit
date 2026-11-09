import { describe, expect, it } from "vitest";
import { deliveryOf } from "./delivery-state.ts";

const content = (status: string) => ({ status });

describe("deliveryOf", () => {
  it("never reads a finished draft as delivered", () => {
    expect(deliveryOf(content("draft"), null, true).state).toBe("generated");
    expect(deliveryOf(content("needs_review"), null, true).state).toBe("awaiting_approval");
    expect(deliveryOf(content("reviewed"), null, true).state).toBe("approved");
    expect(deliveryOf(content("rejected"), null, true).state).toBe("rejected");
  });

  it("separates waiting for Social, scheduled there and published", () => {
    const reviewed = content("reviewed");
    expect(deliveryOf(reviewed, { status: "intent_created" }, true)).toEqual({ state: "handoff_pending", errorCode: null });
    expect(deliveryOf(reviewed, { status: "intent_created", socialPostId: "p" }, true).state).toBe("scheduled");
    expect(deliveryOf(reviewed, { status: "scheduled_remote" }, true).state).toBe("scheduled");
    expect(deliveryOf(reviewed, { status: "published" }, true).state).toBe("published");
  });

  it("names the error of a failed or refused delivery", () => {
    const reviewed = content("reviewed");
    expect(deliveryOf(reviewed, { status: "blocked_dependency", blockers: ["SLOT_EXPIRED"] }, true)).toEqual({ state: "failed", errorCode: "SLOT_EXPIRED" });
    expect(deliveryOf(reviewed, { status: "failed", reason: "SOCIAL_SLOT_EXPIRED" }, true)).toEqual({ state: "failed", errorCode: "SOCIAL_SLOT_EXPIRED" });
    expect(deliveryOf(reviewed, { status: "intent_created", socialHold: { state: "failed", code: "SOCIAL_VALIDATION_FAILED" } }, true)).toEqual({
      state: "handoff_pending",
      errorCode: "SOCIAL_VALIDATION_FAILED",
    });
  });

  it("keeps a Postiz publication approved until Postiz has it", () => {
    expect(deliveryOf(content("reviewed"), { status: "intent_created" }, false).state).toBe("approved");
  });
});
