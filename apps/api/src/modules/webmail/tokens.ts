import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

// Handoff (60 s, one use) and handle (8 h) tokens of a webmail session, in
// the form of social/media/upload-sessions.ts. The workspace, project and
// session ids travel under a 128-bit HMAC with a key derived from AUTH_SECRET
// per token type, so a forged token dies here, before any database access,
// and no secret is stored. The row is what revokes them.

const HANDOFF_LABEL = "orbit-webmail-handoff-v1";
const HANDLE_LABEL = "orbit-webmail-handle-v1";
const MAC_BYTES = 16;
const MAX_LENGTH = 400;
const ID_BYTES = 16;

export type WebmailClaims = {
  workspaceId: string;
  projectId: string;
  sessionId: string;
};

export type TokenCheck =
  | { status: "ok"; claims: WebmailClaims }
  | { status: "invalid" }
  | { status: "expired" };

const mac = (label: string, payload: string) =>
  createHmac(
    "sha256",
    Buffer.from(
      hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), label, 32),
    ),
  )
    .update(payload)
    .digest()
    .subarray(0, MAC_BYTES);

const uuidBytes = (uuid: string) =>
  Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function sign(label: string, claims: WebmailClaims, expiresAt: Date) {
  const ids = Buffer.concat(
    [claims.workspaceId, claims.projectId, claims.sessionId].map(uuidBytes),
  ).toString("base64url");
  const expires = Math.floor(expiresAt.getTime() / 1000).toString(36);
  const payload = `${ids}.${expires}`;
  return `${payload}.${mac(label, payload).toString("base64url")}`;
}

function check(label: string, token: string, now: Date): TokenCheck {
  if (token.length > MAX_LENGTH) return { status: "invalid" };
  const [ids, expires, signature, extra] = token.split(".");
  if (!ids || !expires || !signature || extra !== undefined)
    return { status: "invalid" };
  const given = Buffer.from(signature, "base64url");
  if (given.toString("base64url") !== signature) return { status: "invalid" };
  const expected = mac(label, `${ids}.${expires}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { status: "invalid" };
  const raw = Buffer.from(ids, "base64url");
  const seconds = parseInt(expires, 36);
  if (raw.length !== 3 * ID_BYTES || !Number.isSafeInteger(seconds))
    return { status: "invalid" };
  if (seconds * 1000 <= now.getTime()) return { status: "expired" };
  return {
    status: "ok",
    claims: {
      workspaceId: bytesUuid(raw.subarray(0, ID_BYTES)),
      projectId: bytesUuid(raw.subarray(ID_BYTES, 2 * ID_BYTES)),
      sessionId: bytesUuid(raw.subarray(2 * ID_BYTES)),
    },
  };
}

export const handoffToken = (claims: WebmailClaims, expiresAt: Date) =>
  sign(HANDOFF_LABEL, claims, expiresAt);
export const handleToken = (claims: WebmailClaims, expiresAt: Date) =>
  sign(HANDLE_LABEL, claims, expiresAt);

export const verifyHandoff = (token: string, now = new Date()) =>
  check(HANDOFF_LABEL, token, now);
export const verifyHandle = (token: string, now = new Date()) =>
  check(HANDLE_LABEL, token, now);
