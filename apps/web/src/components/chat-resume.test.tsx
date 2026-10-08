import { describe, expect, it } from "vitest";
import { runToFollow } from "./chat-resume";

const detail = (conversationId: string, status: string) => ({
  conversation: { id: conversationId },
  runs: [{ id: "run", status }],
});

describe("run to follow", () => {
  it("follows an unfinished reply of the open conversation", () => {
    expect(runToFollow(detail("a", "queued"), "a", "")?.id).toBe("run");
  });

  it("ignores the previous conversation's reply after switching", () => {
    // Production 2026-10-06: "Neuer Chat" showed "Orbit arbeitet…" of the
    // conversation left behind, because its data was still loaded.
    expect(runToFollow(detail("a", "queued"), "", "")).toBeNull();
    expect(runToFollow(detail("a", "queued"), "b", "")).toBeNull();
  });

  it("follows nothing when a reply is followed or all are finished", () => {
    expect(runToFollow(detail("a", "queued"), "a", "other")).toBeNull();
    expect(runToFollow(detail("a", "succeeded"), "a", "")).toBeNull();
    expect(runToFollow(null, "a", "")).toBeNull();
  });
});
