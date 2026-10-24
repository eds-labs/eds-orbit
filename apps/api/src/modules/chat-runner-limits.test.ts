import { describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES, staticChatBytes } from "./chat-runner.ts";

describe("chat input limit", () => {
  it("leaves room for the conversation when every tool is loaded", () => {
    // Production uLiquid, 2026-10-12: after the assignment tools grew
    // (shared posts, format, banner), a request to change an assignment
    // stopped with CHAT_CONTEXT_LIMIT before Orbit could answer.
    // FamilyPlan, 2026-10-24: a Claude chat (every tool sent in full, with
    // the MCP features on) stopped after three model calls. The worst case,
    // every feature on, must leave room for tool results and the answer.
    expect(MAX_INPUT_BYTES - staticChatBytes()).toBeGreaterThanOrEqual(48_000);
  });
});
