import { describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES, staticChatBytes } from "./chat-runner.ts";

describe("chat input limit", () => {
  it("leaves room for the conversation when every tool is loaded", () => {
    // Production uLiquid, 2026-10-12: after the assignment tools grew
    // (shared posts, format, banner), a request to change an assignment
    // stopped with CHAT_CONTEXT_LIMIT before Orbit could answer.
    expect(MAX_INPUT_BYTES - staticChatBytes()).toBeGreaterThanOrEqual(24_000);
  });
});
