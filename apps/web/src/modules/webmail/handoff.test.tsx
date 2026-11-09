import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { HandoffSession } from "./api";
import { dispatchBridgeMessage, EmbedView } from "./embed";
import {
  createEndQueue,
  failureOf,
  FRAME_NAME,
  FRAME_SANDBOX,
  holdReferrerPolicy,
  LOAD_TIMEOUT_MS,
  startEmbed,
  submitHandoff,
  type EmbedDeps,
  type EmbedState,
} from "./handoff";
import { webmailText } from "./labels";

const ORIGIN = "https://webmail.orbit.example.com";
const TOKEN = "one-time-token-value";
const session: HandoffSession = {
  action: `${ORIGIN}/`,
  fields: { _task: "login", _action: "login", _orbit_handoff: TOKEN },
  expiresAt: "2026-11-09T12:00:00.000Z",
};

/** Only what submitHandoff and holdReferrerPolicy touch. */
function fakeDocument() {
  const inBody: any[] = [];
  const inHead: any[] = [];
  const submitted: Array<{ form: any; values: Record<string, string> }> = [];
  const element = (tag: string) => {
    const el: any = {
      tag,
      children: [] as any[],
      append(...children: any[]) {
        el.children.push(...children);
      },
      remove() {
        for (const list of [inBody, inHead]) {
          const at = list.indexOf(el);
          if (at >= 0) list.splice(at, 1);
        }
      },
      submit() {
        submitted.push({
          form: { method: el.method, action: el.action, target: el.target, connected: inBody.includes(el) },
          values: Object.fromEntries(el.children.map((c: any) => [c.name, c.value])),
        });
      },
    };
    return el;
  };
  const doc = {
    createElement: element,
    body: { append: (el: any) => inBody.push(el) },
    head: { append: (el: any) => inHead.push(el) },
  };
  return { doc: doc as unknown as Document, inBody, inHead, submitted };
}

describe("submitHandoff", () => {
  it("posts every field into the named frame", () => {
    const { doc, submitted } = fakeDocument();
    submitHandoff(doc, FRAME_NAME, session);
    expect(submitted).toEqual([
      {
        form: { method: "post", action: session.action, target: FRAME_NAME, connected: true },
        values: session.fields,
      },
    ]);
  });

  it("leaves no token in the document after the submit", () => {
    const { doc, inBody } = fakeDocument();
    const created: any[] = [];
    const original = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      const el = original(tag);
      created.push(el);
      return el;
    }) as never;
    submitHandoff(doc, FRAME_NAME, session);
    expect(inBody).toEqual([]);
    expect(created.filter((el) => el.tag === "input").map((el) => el.value)).toEqual(["", "", ""]);
  });

  it("clears the form even when the submit throws", () => {
    const { doc, inBody } = fakeDocument();
    const original = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      const el: any = original(tag);
      if (tag === "form")
        el.submit = () => {
          throw new Error("blocked");
        };
      return el;
    }) as never;
    expect(() => submitHandoff(doc, FRAME_NAME, session)).toThrow("blocked");
    expect(inBody).toEqual([]);
  });
});

describe("holdReferrerPolicy", () => {
  it("opens the policy for the embed and restores the app's on release", () => {
    const { doc, inHead } = fakeDocument();
    const release = holdReferrerPolicy(doc);
    const meta = inHead[0];
    expect(meta.name).toBe("referrer");
    expect(meta.content).toBe("strict-origin-when-cross-origin");
    release();
    expect(meta.content).toBe("same-origin");
    expect(inHead).toEqual([]);
  });
});

describe("failureOf", () => {
  it.each([
    [new ApiError("WEBMAIL_DISABLED", 404), "disabled"],
    [new ApiError("WEBMAIL_MAILBOX_NOT_FOUND", 404), "no_access"],
    [new ApiError("FORBIDDEN", 403), "no_access"],
    [new ApiError("WEBMAIL_MAILBOX_UNAVAILABLE", 409), "unavailable"],
    [new ApiError("BAD_GATEWAY", 502), "unavailable"],
    [new ApiError("INTERNAL", 500), "token"],
    [new TypeError("network"), "token"],
  ])("maps %s", (error, expected) => {
    expect(failureOf(error)).toBe(expected);
  });
});

describe("startEmbed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = () => vi.advanceTimersByTimeAsync(0);

  function setup(over: Partial<EmbedDeps> = {}) {
    const states: EmbedState[] = [];
    const deps: EmbedDeps & {
      create: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    } = {
      origin: ORIGIN,
      queue: createEndQueue(),
      create: vi.fn(async () => session),
      submit: vi.fn(),
      end: vi.fn(async () => undefined),
      onState: (state: EmbedState) => states.push(state),
      onWithdrawn: vi.fn(),
      ...over,
    } as never;
    return { deps, states };
  }

  it("requests a token, submits it and waits for the client", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    expect(deps.submit).toHaveBeenCalledWith(session);
    expect(states.at(-1)).toEqual({ phase: "loading" });
    flow.ready();
    expect(states.at(-1)).toEqual({ phase: "ready" });
  });

  it("never lets the token into a state", async () => {
    const { deps, states } = setup();
    startEmbed(deps).ready();
    await flush();
    expect(JSON.stringify(states)).not.toContain(TOKEN);
  });

  it("ignores messages before the submit", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    flow.ready();
    flow.sessionLost("no_session");
    expect(states).toEqual([{ phase: "requesting" }]);
    await flush();
    expect(states.at(-1)).toEqual({ phase: "loading" });
  });

  it("times out when ready never arrives", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(states.at(-1)).toEqual({ phase: "error", reason: "timeout" });
    flow.ready();
    expect(states.at(-1)).toEqual({ phase: "error", reason: "timeout" });
  });

  it("ready clears the timeout", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(states.at(-1)).toEqual({ phase: "ready" });
  });

  it("takes repeated ready messages as one", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    flow.ready();
    flow.ready();
    expect(states.filter((s) => s.phase === "ready")).toHaveLength(1);
  });

  it.each(["session_unknown", "session_revoked", "session_expired", "no_session", "handoff_failed"] as const)(
    "ends the frame on %s and stops the timeout",
    async (reason) => {
      const { deps, states } = setup();
      const flow = startEmbed(deps);
      await flush();
      flow.sessionLost(reason);
      expect(states.at(-1)).toEqual({ phase: "ended", reason });
      expect(deps.onWithdrawn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
      expect(states.at(-1)).toEqual({ phase: "ended", reason });
    },
  );

  it("stays ended whatever the client still sends", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.sessionLost("session_expired");
    flow.ready();
    flow.sessionLost("bridge_unavailable");
    expect(states.at(-1)).toEqual({ phase: "ended", reason: "session_expired" });
  });

  it("hands not_authorized to the page instead of offering a reopen", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    const before = states.length;
    flow.sessionLost("not_authorized");
    flow.sessionLost("not_authorized");
    expect(deps.onWithdrawn).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(before);
  });

  it.each(["mailbox_unavailable", "bridge_unavailable"] as const)(
    "keeps the session and shows a banner on %s",
    async (reason) => {
      const { deps, states } = setup();
      const flow = startEmbed(deps);
      await flush();
      flow.ready();
      flow.sessionLost(reason);
      expect(states.at(-1)).toEqual({ phase: "ready", banner: reason });
      expect(deps.end).not.toHaveBeenCalled();
    },
  );

  it("a temporary problem during opening reveals the frame and stops the timeout", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.sessionLost("bridge_unavailable");
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(states.at(-1)).toEqual({ phase: "ready", banner: "bridge_unavailable" });
  });

  it("a later ready clears the banner", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    flow.sessionLost("mailbox_unavailable");
    flow.ready();
    expect(states.at(-1)).toEqual({ phase: "ready" });
  });

  it("retrying from the banner clears it without a new token", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    flow.sessionLost("mailbox_unavailable");
    flow.clearBanner();
    expect(states.at(-1)).toEqual({ phase: "ready" });
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("replaces the frame when the session moved to another mailbox", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.ready();
    flow.sessionMoved();
    expect(states.at(-1)).toEqual({ phase: "ended", reason: "session_moved" });
    flow.ready();
    expect(states.at(-1)).toEqual({ phase: "ended", reason: "session_moved" });
  });

  it("stops the timeout when the session moved while opening", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.sessionMoved();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(states.at(-1)).toEqual({ phase: "ended", reason: "session_moved" });
  });

  it("ignores a moved session before the submit and after leaving", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    flow.sessionMoved();
    expect(states).toEqual([{ phase: "requesting" }]);
    await flush();
    flow.cancel();
    const before = states.length;
    flow.sessionMoved();
    expect(states).toHaveLength(before);
  });

  it("ignores messages after leaving", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.cancel();
    const before = states.length;
    flow.ready();
    flow.sessionLost("not_authorized");
    expect(states).toHaveLength(before);
    expect(deps.onWithdrawn).not.toHaveBeenCalled();
  });

  it("reports a failed token request and does not end what never began", async () => {
    const { deps, states } = setup({
      create: vi.fn(async () => {
        throw new ApiError("WEBMAIL_MAILBOX_NOT_FOUND", 404);
      }),
    });
    const flow = startEmbed(deps);
    await flush();
    expect(states.at(-1)).toEqual({ phase: "error", reason: "no_access" });
    expect(deps.submit).not.toHaveBeenCalled();
    flow.cancel();
    await flush();
    expect(deps.end).not.toHaveBeenCalled();
  });

  it("sends the token to the webmail origin only", async () => {
    const { deps, states } = setup({
      create: vi.fn(async () => ({ ...session, action: "https://evil.example.com/" })),
    });
    startEmbed(deps);
    await flush();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ phase: "error", reason: "token" });
  });

  it("reports a submit the browser refused", async () => {
    const { deps, states } = setup({
      submit: vi.fn(() => {
        throw new Error("blocked");
      }),
    });
    startEmbed(deps);
    await flush();
    expect(states.at(-1)).toEqual({ phase: "error", reason: "token" });
  });

  it("does not submit a token that arrives after leaving, and ends its session", async () => {
    let resolve!: (value: HandoffSession) => void;
    const { deps } = setup({
      create: vi.fn(() => new Promise<HandoffSession>((r) => (resolve = r))),
    });
    const flow = startEmbed(deps);
    await flush();
    flow.cancel();
    await flush();
    expect(deps.end).not.toHaveBeenCalled();
    resolve(session);
    await flush();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.end).toHaveBeenCalledTimes(1);
  });

  it("fetches a new token per attempt and ends the old session first", async () => {
    const order: string[] = [];
    let finishEnd!: () => void;
    const queue = createEndQueue();
    const first = setup({
      queue,
      create: vi.fn(async () => {
        order.push("create a");
        return session;
      }),
      end: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push("end a");
            finishEnd = () => {
              order.push("end a done");
              resolve();
            };
          }),
      ),
    });
    const second = setup({
      queue,
      create: vi.fn(async () => {
        order.push("create b");
        return session;
      }),
    });
    const flow = startEmbed(first.deps);
    await flush();
    flow.cancel();
    startEmbed(second.deps);
    await flush();
    expect(order).toEqual(["create a", "end a"]);
    finishEnd();
    await flush();
    expect(order).toEqual(["create a", "end a", "end a done", "create b"]);
    expect(second.deps.submit).toHaveBeenCalledTimes(1);
  });

  it("opens the next session even when ending the old one failed", async () => {
    const queue = createEndQueue();
    const first = setup({
      queue,
      end: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    const second = setup({ queue });
    const flow = startEmbed(first.deps);
    await flush();
    flow.cancel();
    startEmbed(second.deps);
    await flush();
    expect(second.deps.create).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchBridgeMessage", () => {
  const flow = () => ({ ready: vi.fn(), sessionLost: vi.fn(), sessionMoved: vi.fn() });
  const reference = { folder: "INBOX", uid: 1, uidValidity: 2 };
  const convert = (mailboxId: string) => ({ kind: "convert" as const, mailboxId, reference });

  it("routes each message", () => {
    const f = flow();
    const onConvert = vi.fn();
    dispatchBridgeMessage({ kind: "ready" }, "m1", f, onConvert);
    dispatchBridgeMessage({ kind: "session_lost", reason: "no_session" }, "m1", f, onConvert);
    dispatchBridgeMessage(convert("m1"), "m1", f, onConvert);
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.sessionLost).toHaveBeenCalledWith("no_session");
    expect(onConvert).toHaveBeenCalledWith(reference);
    expect(f.sessionMoved).not.toHaveBeenCalled();
  });

  it("does not open the dialog for another mailbox's message", () => {
    const f = flow();
    const onConvert = vi.fn();
    dispatchBridgeMessage(convert("m2"), "m1", f, onConvert);
    expect(onConvert).not.toHaveBeenCalled();
    expect(f.sessionMoved).toHaveBeenCalledTimes(1);
  });

  it("reports the moved session to a member who cannot convert too", () => {
    const f = flow();
    dispatchBridgeMessage(convert("m2"), "m1", f, null);
    expect(f.sessionMoved).toHaveBeenCalledTimes(1);
  });

  it("still tracks the session for a member who cannot convert", () => {
    const f = flow();
    dispatchBridgeMessage(convert("m1"), "m1", f, null);
    dispatchBridgeMessage({ kind: "ready" }, "m1", f, null);
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.sessionMoved).not.toHaveBeenCalled();
  });
});

describe("EmbedView", () => {
  const t = webmailText("en");
  const render = (state: EmbedState, locale: "en" | "de" = "en") =>
    renderToStaticMarkup(
      <EmbedView
        t={webmailText(locale)}
        state={state}
        address="info@example.com"
        onRetry={() => {}}
        onBannerRetry={() => {}}
      />,
    );

  it("shows the browser hint only until the client is up", () => {
    expect(render({ phase: "loading" })).toContain(t.embed.hint);
    expect(render({ phase: "ready" })).not.toContain(t.embed.hint);
  });

  it("says the session belongs to another mailbox, in both languages", () => {
    expect(render({ phase: "ended", reason: "session_moved" })).toContain("another mailbox");
    expect(render({ phase: "ended", reason: "session_moved" }, "de")).toContain("anderen Postfach");
  });

  it.each(["session_unknown", "session_revoked", "session_expired", "no_session", "handoff_failed", "session_moved"] as const)(
    "replaces the frame with a notice and a reopen for %s",
    (reason) => {
      const html = render({ phase: "ended", reason });
      expect(html).not.toContain("<iframe");
      expect(html).toContain(t.embed.ended[reason]);
      expect(html).toContain(t.embed.reopen);
      expect(html).not.toContain(reason);
    },
  );

  it.each(["mailbox_unavailable", "bridge_unavailable"] as const)(
    "keeps the frame under a banner with a retry for %s",
    (reason) => {
      const html = render({ phase: "ready", banner: reason });
      expect(html).toContain("<iframe");
      expect(html).toContain(t.embed.banner[reason]);
      expect(html).toContain(t.retry);
      expect(html).not.toContain(t.embed.opening);
    },
  );

  it("shows no banner without a problem", () => {
    expect(render({ phase: "ready" })).not.toContain(t.retry);
  });

  it("no longer depends on the frame's load event", () => {
    expect(render({ phase: "loading" })).not.toContain("onload");
  });

  it("sandboxes the frame without a source and without a referrer attribute", () => {
    const html = render({ phase: "loading" });
    expect(html).toContain(`sandbox="${FRAME_SANDBOX}"`);
    expect(html).toContain(`name="${FRAME_NAME}"`);
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/);
    expect(html).not.toContain("referrerpolicy");
    expect(html).toContain(t.embed.opening);
  });

  it("removes the cover once the frame is ready", () => {
    expect(render({ phase: "ready" })).not.toContain(t.embed.opening);
  });

  it.each(["disabled", "no_access", "token", "unavailable", "timeout"] as const)(
    "replaces the frame with words and a retry for %s",
    (reason) => {
      const html = render({ phase: "error", reason });
      expect(html).not.toContain("<iframe");
      expect(html).toContain(t.embed.failure[reason]);
      expect(html).toContain(t.retry);
    },
  );

  it("names Safari when the frame does not load, in both languages", () => {
    expect(render({ phase: "error", reason: "timeout" })).toContain("Safari");
    expect(render({ phase: "error", reason: "timeout" }, "de")).toContain("Safari");
  });
});
