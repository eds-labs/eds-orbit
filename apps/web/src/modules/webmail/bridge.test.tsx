import { describe, expect, it, vi } from "vitest";
import {
  acceptBridgeEvent,
  listenForConvert,
  parseConvertLink,
  parseConvertMessage,
} from "./bridge";

const ORIGIN = "https://webmail.orbit.example.com";
const frame = {} as Window;
const other = {} as Window;
const good = { type: "orbit.webmail.convert", folder: "INBOX", uid: 12, uidValidity: 99 };
const reference = { folder: "INBOX", uid: 12, uidValidity: 99 };

describe("convert message shape", () => {
  it("accepts exactly the contract's message", () => {
    expect(parseConvertMessage(good)).toEqual(reference);
  });

  it.each([
    ["null", null],
    ["a string", JSON.stringify(good)],
    ["an array", [good]],
    ["an unknown type", { ...good, type: "orbit.webmail.other" }],
    ["an extra key", { ...good, subject: "hello" }],
    ["a missing key", { type: good.type, folder: "INBOX", uid: 12 }],
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

describe("bridge events", () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({ origin: ORIGIN, source: frame, data: good, ...over }) as unknown as MessageEvent;

  it("accepts the frame's message from the exact origin", () => {
    expect(acceptBridgeEvent(event(), ORIGIN, frame)).toEqual(reference);
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
    const onConvert = vi.fn();
    const stop = listenForConvert(target as never, ORIGIN, () => frame, onConvert);

    post(target, { origin: "https://evil.example.com" });
    post(target, { source: other });
    post(target, { data: "nonsense" });
    expect(onConvert).not.toHaveBeenCalled();

    post(target, {});
    expect(onConvert).toHaveBeenCalledTimes(1);
    expect(onConvert).toHaveBeenCalledWith(reference);

    stop();
    post(target, {});
    expect(onConvert).toHaveBeenCalledTimes(1);
  });

  it("checks against the frame of the moment", () => {
    const target = new EventTarget();
    const onConvert = vi.fn();
    let current: Window | null = other;
    listenForConvert(target as never, ORIGIN, () => current, onConvert);
    post(target, {});
    expect(onConvert).not.toHaveBeenCalled();
    current = frame;
    post(target, {});
    expect(onConvert).toHaveBeenCalledTimes(1);
  });
});

describe("the fallback link", () => {
  it("reads the reference", () => {
    const params = new URLSearchParams("convert=1&folder=INBOX&uid=12&uidValidity=99");
    expect(parseConvertLink(params)).toEqual(reference);
  });

  it.each([
    "folder=INBOX&uid=12&uidValidity=99",
    "convert=1&uid=12&uidValidity=99",
    "convert=1&folder=INBOX&uid=012&uidValidity=99",
    "convert=1&folder=INBOX&uid=1e3&uidValidity=99",
    "convert=1&folder=INBOX&uid=12",
  ])("ignores %s", (query) => {
    expect(parseConvertLink(new URLSearchParams(query))).toBeNull();
  });
});
