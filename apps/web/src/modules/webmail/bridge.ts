import type { ConvertReference } from "./api";

// The only message the embedded client may send to this page, mirrored from
// webmailConvertMessage in apps/api/src/modules/webmail/bridge-contract.ts
// (the web app cannot import server code). Roundcube renders untrusted mail,
// so anything that is not exactly this is dropped without a trace.

const MESSAGE_TYPE = "orbit.webmail.convert";
const MESSAGE_KEYS = ["folder", "type", "uid", "uidValidity"];
const MAX_FOLDER_LENGTH = 1000;

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The message's reference, or null unless the shape is exactly the contract's. */
export function parseConvertMessage(data: unknown): ConvertReference | null {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const keys = Object.keys(data).sort();
  if (
    keys.length !== MESSAGE_KEYS.length ||
    keys.some((key, index) => key !== MESSAGE_KEYS[index])
  )
    return null;
  const { type, folder, uid, uidValidity } = data as Record<string, unknown>;
  if (type !== MESSAGE_TYPE) return null;
  if (
    typeof folder !== "string" ||
    folder.length === 0 ||
    folder.length > MAX_FOLDER_LENGTH
  )
    return null;
  if (!positiveInteger(uid) || !positiveInteger(uidValidity)) return null;
  return { folder, uid, uidValidity };
}

export type BridgeEvent = Pick<MessageEvent, "origin" | "source" | "data">;

/**
 * The reference of an event from the embedded client. The origin alone is not
 * enough: the source must be this page's frame, so another window on the
 * webmail origin cannot open the dialog.
 */
export function acceptBridgeEvent(
  event: BridgeEvent,
  expectedOrigin: string,
  frame: Window | null,
): ConvertReference | null {
  if (!expectedOrigin || !frame) return null;
  if (event.origin !== expectedOrigin || event.source !== frame) return null;
  return parseConvertMessage(event.data);
}

type MessageTarget = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

/** Listens for takeover requests; the returned function removes the listener. */
export function listenForConvert(
  target: MessageTarget,
  expectedOrigin: string,
  frame: () => Window | null,
  onConvert: (reference: ConvertReference) => void,
) {
  const listener = (event: MessageEvent) => {
    const reference = acceptBridgeEvent(event, expectedOrigin, frame());
    if (reference) onConvert(reference);
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
    type: MESSAGE_TYPE,
    folder: params.get("folder"),
    uid: number("uid"),
    uidValidity: number("uidValidity"),
  });
}

export const CONVERT_LINK_PARAMS = ["convert", "folder", "uid", "uidValidity"];
