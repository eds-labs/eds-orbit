import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { HandoffSession } from "./api";
import { EmbedView } from "./embed";
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
      ...over,
    } as never;
    return { deps, states };
  }

  it("requests a token, submits it and waits for the frame", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    expect(deps.submit).toHaveBeenCalledWith(session);
    expect(states.at(-1)).toEqual({ phase: "loading" });
    flow.loaded();
    expect(states.at(-1)).toEqual({ phase: "ready" });
  });

  it("never lets the token into a state", async () => {
    const { deps, states } = setup();
    startEmbed(deps).loaded();
    await flush();
    expect(JSON.stringify(states)).not.toContain(TOKEN);
  });

  it("ignores the frame's blank load before the submit", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    flow.loaded();
    expect(states).toEqual([{ phase: "requesting" }]);
    await flush();
    expect(states.at(-1)).toEqual({ phase: "loading" });
  });

  it("reports a frame that does not load in time", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(states.at(-1)).toEqual({ phase: "error", reason: "timeout" });
    flow.loaded();
    expect(states.at(-1)).toEqual({ phase: "error", reason: "timeout" });
  });

  it("does not time out after the frame loaded", async () => {
    const { deps, states } = setup();
    const flow = startEmbed(deps);
    await flush();
    flow.loaded();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(states.at(-1)).toEqual({ phase: "ready" });
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

describe("EmbedView", () => {
  const t = webmailText("en");
  const render = (state: EmbedState, locale: "en" | "de" = "en") =>
    renderToStaticMarkup(
      <EmbedView
        t={webmailText(locale)}
        state={state}
        address="info@example.com"
        onLoad={() => {}}
        onRetry={() => {}}
      />,
    );

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
