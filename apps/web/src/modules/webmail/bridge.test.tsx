import { describe, expect, it, vi } from "vitest";
import {
  acceptBridgeEvent,
  listenToBridge,
  parseBridgeMessage,
  parseConvertLink,
  parseConvertMessage,
  sessionKept,
} from "./bridge";

const ORIGIN = "https://webmail.orbit.example.com";
const frame = {} as Window;
const other = {} as Window;
const good = { type: "orbit.webmail.convert", mailboxId: "m1", folder: "INBOX", uid: 12, uidValidity: 99 };
const reference = { folder: "INBOX", uid: 12, uidValidity: 99 };
const request = { mailboxId: "m1", reference };

describe("convert message shape", () => {
  it("accepts exactly the contract's message", () => {
    expect(parseConvertMessage(good)).toEqual(request);
  });

  it("reads it the same way as a bridge message", () => {
    expect(parseBridgeMessage(good)).toEqual({ kind: "convert", ...request });
  });

  it.each([
    ["null", null],
    ["a string", JSON.stringify(good)],
    ["an array", [good]],
    ["an unknown type", { ...good, type: "orbit.webmail.other" }],
    ["an extra key", { ...good, subject: "hello" }],
    ["a missing key", { type: good.type, mailboxId: "m1", folder: "INBOX", uid: 12 }],
    ["the message without a mailbox", { type: good.type, folder: "INBOX", uid: 12, uidValidity: 99 }],
    ["an empty mailbox", { ...good, mailboxId: "" }],
    ["a mailbox that is not text", { ...good, mailboxId: 7 }],
    ["a null mailbox", { ...good, mailboxId: null }],
    ["a mailbox that is too long", { ...good, mailboxId: "x".repeat(101) }],
    ["an empty folder", { ...good, folder: "" }],
    ["a folder that is too long", { ...good, folder: "x".repeat(1001) }],
    ["a folder that is not text", { ...good, folder: 7 }],
    ["uid zero", { ...good, uid: 0 }],
    ["a negative uid", { ...good, uid: -1 }],
    ["a fractional uid", { ...good, uid: 1.5 }],
    ["a uid as text", { ...good, uid: "12" }],
    ["an unsafe uidValidity", { ...good, uidValidity: 2 ** 53 }],
  ])("rejects %s", (_name, data) => {
    expect(parseConvertMessage(data)).toBeNull();
  });
});

describe("ready and session_lost shapes", () => {
  const ready = { type: "orbit.webmail.ready" };
  const lost = (reason: unknown) => ({ type: "orbit.webmail.session_lost", reason });

  it("accepts ready", () => {
    expect(parseBridgeMessage(ready)).toEqual({ kind: "ready" });
  });

  it.each([
    "session_unknown",
    "session_revoked",
    "session_expired",
    "not_authorized",
    "no_session",
    "handoff_failed",
    "mailbox_unavailable",
    "bridge_unavailable",
  ])("accepts the reason %s", (reason) => {
    expect(parseBridgeMessage(lost(reason))).toEqual({ kind: "session_lost", reason });
  });

  it("tells the reasons that keep the session from those that end it", () => {
    expect(sessionKept("mailbox_unavailable")).toBe(true);
    expect(sessionKept("bridge_unavailable")).toBe(true);
    expect(sessionKept("session_expired")).toBe(false);
    expect(sessionKept("not_authorized")).toBe(false);
  });

  it.each([
    ["ready with an extra key", { ...ready, session: "x" }],
    ["session_lost without a reason", { type: "orbit.webmail.session_lost" }],
    ["an unknown reason", lost("server_on_fire")],
    ["a prototype key as reason", lost("constructor")],
    ["a reason that is not text", lost(7)],
    ["session_lost with an extra key", { ...lost("no_session"), detail: "x" }],
    ["a look-alike type", { type: "orbit.webmail.ready2" }],
    ["convert's fields on ready", { type: "orbit.webmail.ready", folder: "INBOX", uid: 1, uidValidity: 2 }],
  ])("ignores %s", (_name, data) => {
    expect(parseBridgeMessage(data)).toBeNull();
  });
});

describe("bridge events", () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({ origin: ORIGIN, source: frame, data: good, ...over }) as unknown as MessageEvent;

  it("accepts the frame's message from the exact origin", () => {
    expect(acceptBridgeEvent(event(), ORIGIN, frame)).toEqual({ kind: "convert", ...request });
  });

  it.each([
    ["ready", { type: "orbit.webmail.ready" }],
    ["session_lost", { type: "orbit.webmail.session_lost", reason: "no_session" }],
  ])("holds %s to the same origin and source checks", (_name, data) => {
    expect(acceptBridgeEvent(event({ data }), ORIGIN, frame)).not.toBeNull();
    expect(acceptBridgeEvent(event({ data, origin: "https://evil.example.com" }), ORIGIN, frame)).toBeNull();
    expect(acceptBridgeEvent(event({ data, source: other }), ORIGIN, frame)).toBeNull();
    expect(acceptBridgeEvent(event({ data }), ORIGIN, null)).toBeNull();
  });

  it.each([
    ["another origin", { origin: "https://evil.example.com" }],
    ["a look-alike origin", { origin: `${ORIGIN}.evil.example.com` }],
    ["the http variant", { origin: "http://webmail.orbit.example.com" }],
    ["the null origin", { origin: "null" }],
    ["another window", { source: other }],
    ["no source", { source: null }],
    ["a wrong shape", { data: { ...good, extra: true } }],
  ])("ignores %s", (_name, over) => {
    expect(acceptBridgeEvent(event(over), ORIGIN, frame)).toBeNull();
  });

  it("accepts nothing without a frame or an origin", () => {
    expect(acceptBridgeEvent(event(), ORIGIN, null)).toBeNull();
    expect(acceptBridgeEvent(event({ origin: "" }), "", frame)).toBeNull();
  });

  const post = (target: EventTarget, over: Record<string, unknown>) =>
    target.dispatchEvent(
      Object.assign(new Event("message"), { origin: ORIGIN, source: frame, data: good, ...over }),
    );

  it("calls back for a valid event only and stops after removal", () => {
    const target = new EventTarget();
    const onMessage = vi.fn();
    const stop = listenToBridge(target as never, ORIGIN, () => frame, onMessage);

    post(target, { origin: "https://evil.example.com" });
    post(target, { source: other });
    post(target, { data: "nonsense" });
    expect(onMessage).not.toHaveBeenCalled();

    post(target, {});
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ kind: "convert", ...request });

    stop();
    post(target, {});
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("checks against the frame of the moment", () => {
    const target = new EventTarget();
    const onMessage = vi.fn();
    let current: Window | null = other;
    listenToBridge(target as never, ORIGIN, () => current, onMessage);
    post(target, {});
    expect(onMessage).not.toHaveBeenCalled();
    current = frame;
    post(target, {});
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe("the fallback link", () => {
  it("reads the mailbox and the reference", () => {
    const params = new URLSearchParams("mailbox=m1&convert=1&folder=INBOX&uid=12&uidValidity=99");
    expect(parseConvertLink(params)).toEqual(request);
  });

  it.each([
    "convert=1&folder=INBOX&uid=12&uidValidity=99",
    "mailbox=&convert=1&folder=INBOX&uid=12&uidValidity=99",
    "mailbox=m1&folder=INBOX&uid=12&uidValidity=99",
    "mailbox=m1&convert=1&uid=12&uidValidity=99",
    "mailbox=m1&convert=1&folder=INBOX&uid=012&uidValidity=99",
    "mailbox=m1&convert=1&folder=INBOX&uid=1e3&uidValidity=99",
    "mailbox=m1&convert=1&folder=INBOX&uid=12",
  ])("ignores %s", (query) => {
    expect(parseConvertLink(new URLSearchParams(query))).toBeNull();
  });
});
