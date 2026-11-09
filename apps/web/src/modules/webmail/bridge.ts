import type { ConvertReference } from "./api";

// The messages the embedded client may send to this page, mirrored from
// infra/webmail/poc/mock-bridge/contract.json and bridge-contract.ts (the web
// app cannot import server code). Roundcube renders untrusted mail, so
// anything that is not exactly one of these is dropped without a trace.

const CONVERT_TYPE = "orbit.webmail.convert";
const CONVERT_KEYS = ["folder", "type", "uid", "uidValidity"];
const READY_TYPE = "orbit.webmail.ready";
const READY_KEYS = ["type"];
const SESSION_LOST_TYPE = "orbit.webmail.session_lost";
const SESSION_LOST_KEYS = ["reason", "type"];
const MAX_FOLDER_LENGTH = 1000;

const SESSION_ENDED_REASONS = [
  "session_unknown",
  "session_revoked",
  "session_expired",
  "not_authorized",
  "no_session",
  "handoff_failed",
] as const;
const SESSION_KEPT_REASONS = ["mailbox_unavailable", "bridge_unavailable"] as const;

export type SessionKeptReason = (typeof SESSION_KEPT_REASONS)[number];
export type SessionLostReason =
  | (typeof SESSION_ENDED_REASONS)[number]
  | SessionKeptReason;

/** True when the Roundcube session survives and only a page could not be shown. */
export const sessionKept = (reason: SessionLostReason): reason is SessionKeptReason =>
  (SESSION_KEPT_REASONS as readonly string[]).includes(reason);

const knownReason = (value: unknown): value is SessionLostReason =>
  typeof value === "string" &&
  [...SESSION_ENDED_REASONS, ...SESSION_KEPT_REASONS].includes(
    value as SessionLostReason,
  );

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The object's fields, or null unless it has exactly these keys. */
function exactFields(
  data: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const keys = Object.keys(data).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    return null;
  return data as Record<string, unknown>;
}

/** The message's reference, or null unless the shape is exactly the contract's. */
export function parseConvertMessage(data: unknown): ConvertReference | null {
  const fields = exactFields(data, CONVERT_KEYS);
  if (!fields) return null;
  const { type, folder, uid, uidValidity } = fields;
  if (type !== CONVERT_TYPE) return null;
  if (
    typeof folder !== "string" ||
    folder.length === 0 ||
    folder.length > MAX_FOLDER_LENGTH
  )
    return null;
  if (!positiveInteger(uid) || !positiveInteger(uidValidity)) return null;
  return { folder, uid, uidValidity };
}

export type BridgeMessage =
  | { kind: "convert"; reference: ConvertReference }
  | { kind: "ready" }
  | { kind: "session_lost"; reason: SessionLostReason };

/** One of the contract's messages, or null for anything else. */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (exactFields(data, READY_KEYS)?.type === READY_TYPE)
    return { kind: "ready" };
  const lost = exactFields(data, SESSION_LOST_KEYS);
  if (lost?.type === SESSION_LOST_TYPE)
    return knownReason(lost.reason)
      ? { kind: "session_lost", reason: lost.reason }
      : null;
  const reference = parseConvertMessage(data);
  return reference ? { kind: "convert", reference } : null;
}

export type BridgeEvent = Pick<MessageEvent, "origin" | "source" | "data">;

/**
 * The message of an event from the embedded client. The origin alone is not
 * enough: the source must be this page's frame, so another window on the
 * webmail origin can neither open the dialog nor claim a session state.
 */
export function acceptBridgeEvent(
  event: BridgeEvent,
  expectedOrigin: string,
  frame: Window | null,
): BridgeMessage | null {
  if (!expectedOrigin || !frame) return null;
  if (event.origin !== expectedOrigin || event.source !== frame) return null;
  return parseBridgeMessage(event.data);
}

type MessageTarget = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

/** Listens to the embedded client; the returned function removes the listener. */
export function listenToBridge(
  target: MessageTarget,
  expectedOrigin: string,
  frame: () => Window | null,
  onMessage: (message: BridgeMessage) => void,
) {
  const listener = (event: MessageEvent) => {
    const message = acceptBridgeEvent(event, expectedOrigin, frame());
    if (message) onMessage(message);
  };
  target.addEventListener("message", listener);
  return () => target.removeEventListener("message", listener);
}

/**
 * The fallback link for a client that cannot post to this page:
 * ?mailbox=<id>&convert=1&folder=<folder>&uid=<uid>&uidValidity=<uidValidity>.
 * It only opens the dialog; nothing is submitted without the member's click.
 */
export function parseConvertLink(
  params: Pick<URLSearchParams, "get">,
): ConvertReference | null {
  if (params.get("convert") !== "1") return null;
  const number = (name: string) => {
    const value = params.get(name) ?? "";
    return /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  };
  return parseConvertMessage({
    type: CONVERT_TYPE,
    folder: params.get("folder"),
    uid: number("uid"),
    uidValidity: number("uidValidity"),
  });
}

export const CONVERT_LINK_PARAMS = ["convert", "folder", "uid", "uidValidity"];
