import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { authDb, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { maxFileBytes } from "../../../platform/files/files.ts";
import { publicIngressEnabled } from "../../../platform/http/webhooks.ts";
import { assertModuleEnabledFor } from "../../../platform/modules/enforcement.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { authorize } from "../../../platform/tenancy/permissions.ts";
import { audit, create, data, DomainError, update } from "../../../shared.ts";
import { requireSocial } from "../gate.ts";
import { SOCIAL_COMPOSE } from "../permissions.ts";
import { ingestMedia, sniffImage, type MediaView } from "./library.ts";

// Upload sessions for outside clients (MCP `social_media_upload`): an image
// too large for a JSON tool call goes as raw bytes to a one-time URL,
// `PUT /api/public/social/media-uploads/<token>`. The session is an Entity
// row of the project (kind below) bound to the member and client who opened
// it, the declared image type, and fifteen minutes. The token names the
// project, session and expiry under a 128-bit HMAC (key derived from
// AUTH_SECRET, its own label). The upload re-checks the member's current
// membership, module role and the module, then stores the bytes through
// the library like any upload. A session is used once; a failed upload
// returns it to pending, so the client may try again before it expires.

export const UPLOAD_SESSION_KIND = "social_media_upload";
/** Idempotency receipts of MCP media writes (media/mcp-tools.ts). */
export const MEDIA_RECEIPT_KIND = "social_media_receipt";
const LIFETIME_MS = 15 * 60_000;
const MAC_BYTES = 16;
const MIME_OF = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
export type UploadMime = (typeof MIME_OF)[keyof typeof MIME_OF];

export type UploadSessionData = {
  actorId: string;
  /** The MCP client id; "" for a call without one. */
  clientId: string;
  idempotencyKey: string;
  argsHash: string;
  name: string;
  mime: UploadMime;
  altText: string | null;
  status: "pending" | "processing" | "completed";
  expiresAt: string;
  mediaId?: string;
  duplicate?: boolean;
  lastErrorCode?: string;
};

export type UploadInstructions = {
  url: string;
  method: "PUT";
  headers: { "Content-Type": UploadMime };
  maxBytes: number;
  expiresAt: string;
};

/** Upload sessions need public ingress: the client sends the bytes from outside. */
export const uploadSessionsEnabled = () => publicIngressEnabled();

const key = () =>
  Buffer.from(hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), "orbit-social-upload-v1", 32));
const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest().subarray(0, MAC_BYTES);
const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The token of a session; deterministic, so a retried call gets the same URL. */
export function uploadToken(projectId: string, sessionId: string, expiresAt: Date): string {
  const ids = Buffer.concat([uuidBytes(projectId), uuidBytes(sessionId)]).toString("base64url");
  const expires = Math.floor(expiresAt.getTime() / 1000).toString(36);
  const payload = `${ids}.${expires}`;
  return `${payload}.${mac(payload).toString("base64url")}`;
}

/** The token's claims, or null when it is malformed, forged or expired. */
export function verifyUploadToken(token: string, now = new Date()): { projectId: string; sessionId: string } | null {
  if (token.length > 200) return null;
  const [ids, expires, signature, extra] = token.split(".");
  if (!ids || !expires || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  if (given.toString("base64url") !== signature) return null;
  const expected = mac(`${ids}.${expires}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const seconds = parseInt(expires, 36);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 <= now.getTime()) return null;
  const raw = Buffer.from(ids, "base64url");
  if (raw.length !== 32) return null;
  return { projectId: bytesUuid(raw.subarray(0, 16)), sessionId: bytesUuid(raw.subarray(16, 32)) };
}

const instructions = (scope: Pick<Scope, "projectId">, id: string, session: UploadSessionData): UploadInstructions => ({
  url: `${new URL(loadConfig().APP_ORIGIN).origin}/api/public/social/media-uploads/${uploadToken(scope.projectId, id, new Date(session.expiresAt))}`,
  method: "PUT",
  headers: { "Content-Type": session.mime },
  maxBytes: maxFileBytes(),
  expiresAt: session.expiresAt,
});

/** The member's session with this idempotency key from this client, if any. */
export function findUploadSession(tx: DbTx, scope: Scope, clientId: string | null, idempotencyKey: string) {
  return tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: UPLOAD_SESSION_KIND,
      AND: [
        { data: { path: ["actorId"], equals: scope.userId } },
        { data: { path: ["idempotencyKey"], equals: idempotencyKey } },
        { data: { path: ["clientId"], equals: clientId ?? "" } },
      ],
    },
  });
}

export type SessionState =
  | { status: "upload_required"; sessionId: string; upload: UploadInstructions }
  | { status: "completed"; sessionId: string; mediaId: string; duplicate: boolean }
  | { status: "expired"; sessionId: string };

function stateOf(scope: Scope, row: { id: string; data: unknown }, now = new Date()): SessionState {
  const session = data(row) as UploadSessionData;
  if (session.status === "completed" && session.mediaId)
    return { status: "completed", sessionId: row.id, mediaId: session.mediaId, duplicate: Boolean(session.duplicate) };
  if (Date.parse(session.expiresAt) <= now.getTime()) return { status: "expired", sessionId: row.id };
  return { status: "upload_required", sessionId: row.id, upload: instructions(scope, row.id, session) };
}

/**
 * Opens a session for one image, or returns the member's existing one for
 * the same idempotency key and arguments (another set of arguments under
 * the same key is a conflict).
 */
export async function openUploadSession(
  tx: DbTx,
  scope: Scope,
  input: { clientId: string | null; idempotencyKey: string; argsHash: string; name: string; mime: UploadMime; altText: string | null },
  now = new Date(),
): Promise<SessionState & { deduplicated: boolean }> {
  if (!uploadSessionsEnabled()) throw new DomainError("SOCIAL_UPLOAD_SESSION_UNAVAILABLE", 409);
  const old = await findUploadSession(tx, scope, input.clientId, input.idempotencyKey);
  if (old) {
    if ((data(old) as UploadSessionData).argsHash !== input.argsHash)
      throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", 409);
    return { ...stateOf(scope, old, now), deduplicated: true };
  }
  const session: UploadSessionData = {
    actorId: scope.userId,
    clientId: input.clientId ?? "",
    idempotencyKey: input.idempotencyKey,
    argsHash: input.argsHash,
    name: input.name,
    mime: input.mime,
    altText: input.altText,
    status: "pending",
    expiresAt: new Date(now.getTime() + LIFETIME_MS).toISOString(),
  };
  const row = await create(tx, scope, UPLOAD_SESSION_KIND, session);
  await audit(tx, scope, "social.media.upload_session_opened", row.id, { mime: input.mime });
  return { ...stateOf(scope, row, now), deduplicated: false };
}

/** The state of the member's own session; another member's or project's is 404. */
export async function uploadSessionState(tx: DbTx, scope: Scope, sessionId: string): Promise<SessionState> {
  const row = await tx.entity.findFirst({
    where: { id: sessionId, projectId: scope.projectId, kind: UPLOAD_SESSION_KIND },
  });
  if (!row || (data(row) as UploadSessionData).actorId !== scope.userId) throw new DomainError("NOT_FOUND", 404);
  return stateOf(scope, row);
}

const notFound = () => new DomainError("NOT_FOUND", 404);

/**
 * Receives the bytes of a session (the public PUT route). Every refusal of
 * the token or session is the same 404; image problems keep their codes.
 */
export async function receiveUpload(
  token: string,
  input: { bytes: Buffer; contentType: string },
  now = new Date(),
): Promise<MediaView & { duplicate: boolean }> {
  if (!uploadSessionsEnabled()) throw notFound();
  const claims = verifyUploadToken(token, now);
  if (!claims) throw notFound();
  const project = await authDb.project.findUnique({ where: { id: claims.projectId }, select: { workspaceId: true } });
  if (!project) throw notFound();
  const at = { workspaceId: project.workspaceId, projectId: claims.projectId };
  // Claim the session: pending and unexpired, moved to processing in one
  // versioned write, so two concurrent uploads cannot both store.
  const claimed = await scoped(at.workspaceId, at.projectId, async (tx) => {
    const row = await tx.entity.findFirst({
      where: { id: claims.sessionId, projectId: at.projectId, kind: UPLOAD_SESSION_KIND },
    });
    if (!row) return null;
    const session = data(row) as UploadSessionData;
    if (session.status !== "pending" || Date.parse(session.expiresAt) <= now.getTime()) return null;
    try {
      return { row: await update(tx, at, row, { ...session, status: "processing" }), session };
    } catch {
      return null;
    }
  });
  if (!claimed) throw notFound();
  const { session } = claimed;
  let row = claimed.row;
  const release = async (code: string) => {
    await scoped(at.workspaceId, at.projectId, async (tx) => {
      await update(tx, at, row, { ...session, status: "pending", lastErrorCode: code });
    }).catch(() => undefined);
  };
  try {
    // The member's rights now, not when the session was opened.
    const actor = await actorScope(at.workspaceId, at.projectId, session.actorId);
    if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    const scope = moduleScope(actor, "social");
    authorize(scope, SOCIAL_COMPOSE);
    await assertModuleEnabledFor(scope, "social");
    await scoped(scope.workspaceId, scope.projectId, (tx) => requireSocial(tx, scope));
    const declared = input.contentType.split(";")[0]!.trim().toLowerCase();
    if (declared !== session.mime && declared !== "application/octet-stream")
      throw new DomainError("SOCIAL_MEDIA_TYPE", 415);
    const kind = sniffImage(input.bytes);
    if (!kind || MIME_OF[kind] !== session.mime) throw new DomainError("SOCIAL_MEDIA_TYPE", 415);
    const { media, duplicate } = await ingestMedia(
      scope,
      { bytes: input.bytes, mime: session.mime, name: session.name },
      { reuseIdentical: true, altText: session.altText, source: "mcp_upload_session" },
    );
    await scoped(at.workspaceId, at.projectId, async (tx) => {
      row = await update(tx, at, row, {
        ...session,
        status: "completed",
        mediaId: media.id,
        duplicate,
        lastErrorCode: undefined,
      });
      await audit(tx, scope, "social.media.upload_session_completed", row.id, { duplicate });
    });
    return { ...media, duplicate };
  } catch (error) {
    await release(error instanceof DomainError ? error.code : "SOCIAL_UPLOAD_FAILED");
    throw error;
  }
}
