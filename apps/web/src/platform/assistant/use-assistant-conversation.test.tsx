import { describe, expect, it } from "vitest";
import { messageBody, type ChatRun } from "./api";
import {
  canSend,
  conversationReducer,
  initialConversation,
  initialConversationId,
  type ConversationAction,
  type ConversationState,
} from "./use-assistant-conversation";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const run = (over: Partial<ChatRun> = {}): ChatRun => ({
  id: "run-1",
  status: "running",
  partialText: "",
  errorCode: null,
  sequence: 1,
  ...over,
});
const apply = (state: ConversationState, ...actions: ConversationAction[]) =>
  actions.reduce(conversationReducer, state);

describe("the conversation state machine (WP3.8)", () => {
  it("sends: busy, the created conversation, then the accepted run", () => {
    const start = initialConversation("space-1");
    const busy = apply(start, { type: "busy" });
    expect(busy.pending).toBe(true);
    expect(canSend(busy, "Hello")).toBe(false);
    const accepted = apply(
      busy,
      { type: "created", conversationId: C1 },
      { type: "accepted", runId: "run-1" },
    );
    expect(accepted).toMatchObject({
      conversationId: C1,
      pending: false,
      activeRunId: "run-1",
      stream: { id: "run-1", status: "queued", partialText: "" },
      historyRevision: 1,
      detailRevision: 1,
    });
    // While the reply runs, nothing else is sent.
    expect(canSend(accepted, "Again")).toBe(false);
  });

  it("follows snapshots and stops at a terminal one, reloading once", () => {
    const following = apply(initialConversation("p1"), {
      type: "accepted",
      runId: "run-1",
    });
    const streaming = apply(following, {
      type: "snapshot",
      run: run({ partialText: "Hal", sequence: 2 }),
    });
    expect(streaming.stream?.partialText).toBe("Hal");
    expect(streaming.activeRunId).toBe("run-1");
    const done = apply(streaming, {
      type: "snapshot",
      run: run({ status: "failed", errorCode: "CHAT_TOOL_LIMIT", sequence: 3 }),
    });
    expect(done.activeRunId).toBe("");
    expect(done.stream?.errorCode).toBe("CHAT_TOOL_LIMIT");
    expect(done.detailRevision).toBe(streaming.detailRevision + 1);
    expect(canSend(done, "Next")).toBe(true);
  });

  it("ignores late events of another run and older sequences", () => {
    const state = apply(
      initialConversation("p1"),
      { type: "accepted", runId: "run-1" },
      { type: "snapshot", run: run({ partialText: "new", sequence: 5 }) },
    );
    expect(
      apply(state, {
        type: "snapshot",
        run: run({ id: "run-0", status: "succeeded" }),
      }),
    ).toBe(state);
    expect(
      apply(state, {
        type: "snapshot",
        run: run({ partialText: "old", sequence: 4 }),
      }),
    ).toBe(state);
  });

  it("resumes an unfinished run of a loaded conversation, never a second one", () => {
    const opened = apply(initialConversation("p1"), {
      type: "open",
      conversationId: C1,
    });
    const resumed = apply(opened, { type: "follow", run: run() });
    expect(resumed.activeRunId).toBe("run-1");
    expect(apply(resumed, { type: "follow", run: run({ id: "run-2" }) })).toBe(
      resumed,
    );
  });

  it("opening, starting new and archiving the open conversation drop the run", () => {
    const busy = apply(
      initialConversation("p1"),
      { type: "open", conversationId: C1 },
      { type: "follow", run: run() },
      { type: "error", error: "x" },
    );
    expect(apply(busy, { type: "open", conversationId: C2 })).toMatchObject({
      conversationId: C2,
      activeRunId: "",
      stream: null,
      error: "",
    });
    expect(apply(busy, { type: "new" })).toMatchObject({
      conversationId: "",
      activeRunId: "",
    });
    expect(
      apply(busy, { type: "archived", conversationId: C1 }).conversationId,
    ).toBe("");
    expect(
      apply(busy, { type: "archived", conversationId: C2 }).conversationId,
    ).toBe(C1);
  });

  it("keeps a failure as the error line and unlocks sending", () => {
    const failed = apply(
      initialConversation("p1"),
      { type: "busy" },
      { type: "failed", error: "Das Projekt ist pausiert." },
    );
    expect(failed).toMatchObject({
      pending: false,
      error: "Das Projekt ist pausiert.",
    });
    expect(canSend(failed, "  ")).toBe(false);
    expect(canSend(failed, "Retry")).toBe(true);
  });

  it("resets only for another chat (the personal space of another organization)", () => {
    const busy = apply(
      initialConversation("space-1"),
      { type: "open", conversationId: C1 },
      { type: "follow", run: run() },
    );
    expect(
      apply(busy, { type: "reset", projectId: "space-2", conversationId: "" }),
    ).toEqual(initialConversation("space-2"));
  });
});

describe("the first conversation and the send body", () => {
  it("prefers a valid deep link, else the stored one", () => {
    expect(
      initialConversationId(
        `https://orbit.test/p/p1/assistant?conversation=${C1}`,
        C2,
      ),
    ).toBe(C1);
    expect(
      initialConversationId("https://orbit.test/assistant?conversation=x", C2),
    ).toBe(C2);
    expect(initialConversationId(null, C2)).toBe(C2);
    expect(initialConversationId(null, "garbage")).toBe("");
  });

  it("adds the personal hints only when given", () => {
    expect(messageBody("Hi", "req-1")).toEqual({
      text: "Hi",
      clientRequestId: "req-1",
    });
    expect(
      messageBody("Hi", "req-1", {
        focusProjectId: "p2",
        pageContext: { projectId: "p2", route: "/p/p2/support/tickets" },
      }),
    ).toEqual({
      text: "Hi",
      clientRequestId: "req-1",
      focusProjectId: "p2",
      pageContext: { projectId: "p2", route: "/p/p2/support/tickets" },
    });
  });
});
