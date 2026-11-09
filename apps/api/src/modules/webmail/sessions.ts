import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  scoped,
  scopedRead,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { connectionVerified } from "../../platform/connections/connections.ts";
import {
  ensureIngested,
  mailServerTargets,
  type IngestSelection,
} from "../../platform/email/shared-client.ts";
import { assertModuleEnabled } from "../../platform/modules/enforcement.ts";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../platform/tenancy/module-roles.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  capabilitiesOf,
  effectiveCapabilities,
  grantOf,
  loadMailbox,
  operatingState,
  ownerAdmits,
  requireCapability,
  sessionCapabilities,
} from "./access.ts";
import {
  handoffConsumeError,
  sessionAuthorizeError,
  type BarrierSelection,
  type SessionBarrierResponse,
  type WebmailCapability,
} from "./bridge-contract.ts";
import { webmailActive } from "./gate.ts";
import { WEBMAIL_USE } from "./permissions.ts";
import {
  handleToken,
  handoffToken,
  verifyHandle,
  verifyHandoff,
  type WebmailClaims,
} from "./tokens.ts";

// Webmail sessions (ADR 0026): one member on one mailbox. An authenticated
// Orbit request opens the row and a one-time handoff; the bridge consumes it
// for a handle; every Roundcube request is then authorized again. The row is
// what revokes a session, and it ends with its Better Auth session.

const HANDOFF_MS = 60_000;
const SESSION_MS = 8 * 3600_000;
const TOUCH_EVERY_MS = 60_000;
// Below the plugin's five-second timeout, so a refusal arrives as a refusal.
const BARRIER_TIMEOUT_MS = 4_000;
const MAX_BARRIER_UIDS = 5_000;
const MAX_UID = 4_294_967_295;
// Members share one Roundcube user, so only these rows say who sent or removed
// mail. Exact names, as the plugin's policy compares them, with the variants
// Roundcube dispatches to the same handlers, and what each needs. Everything
// else stays a read: a request here would otherwise wait for the project lock.
const ATTRIBUTED_ACTIONS: ReadonlyMap<string, WebmailCapability> = new Map([
  ["send", "send"],
  ["bounce", "send"],
  ["move", "organize"],
  ["delete", "organize"],
  ["DELETE", "organize"],
  ["expunge", "organize"],
  ["folder-expunge", "organize"],
  ["folder_expunge", "organize"],
  ["purge", "organize"],
  ["folder-purge", "organize"],
  ["folder_purge", "organize"],
]);

export type ConsumeError = z.infer<typeof handoffConsumeError>;
export type AuthorizeError = z.infer<typeof sessionAuthorizeError>;

/** A refusal of the bridge: the plugin sees the status and the contract's code. */
export class BridgeRefusal extends Error {
  constructor(
    public code: ConsumeError | AuthorizeError,
    public status: number,
  ) {
    super(code);
  }
}

const REFUSAL_STATUS: Record<AuthorizeError, number> = {
  session_unknown: 401,
  session_revoked: 401,
  session_expired: 401,
  not_authorized: 403,
  mailbox_unavailable: 409,
};
const refuse = (code: AuthorizeError) =>
  new BridgeRefusal(code, REFUSAL_STATUS[code]);

export const webmailOrigin = () => new URL(loadConfig().WEBMAIL_ORIGIN).origin;

/** Revokes a member's open sessions on a mailbox; returns how many. */
export async function revokeMemberSessions(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  mailboxId: string,
  userId: string,
  reason: string,
) {
  const { count } = await tx.webmailSession.updateMany({
    where: {
      projectId: scope.projectId,
      mailboxId,
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return count;
}

/** Revokes every open session on a mailbox. */
export async function revokeMailboxSessions(
  tx: DbTx,
  scope: Pick<Scope, "projectId">,
  mailboxId: string,
  reason: string,
) {
  await tx.webmailSession.updateMany({
    where: { projectId: scope.projectId, mailboxId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
}

/**
 * Opens a session for a member with `canRead`, ending their earlier ones on
 * this mailbox, and returns the form the page posts into the iframe.
 */
export async function openSession(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  authSessionId: string,
  now = new Date(),
) {
  const { mailbox, connection } = await requireCapability(
    tx,
    scope,
    mailboxId,
    "read",
  );
  if (!mailbox.enabled || !connectionVerified(connection.status))
    throw new DomainError("WEBMAIL_MAILBOX_UNAVAILABLE", 409);
  await revokeMemberSessions(tx, scope, mailboxId, scope.userId, "superseded");
  const handoffExpiresAt = new Date(now.getTime() + HANDOFF_MS);
  const row = await tx.webmailSession.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      mailboxId,
      userId: scope.userId,
      authSessionId,
      handoffExpiresAt,
      expiresAt: new Date(now.getTime() + SESSION_MS),
    },
  });
  await audit(tx, scope, "webmail.session.opened", row.id, { mailboxId });
  return {
    action: `${webmailOrigin()}/`,
    fields: {
      _task: "login",
      _action: "login",
      _orbit_handoff: handoffToken(
        {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          sessionId: row.id,
        },
        handoffExpiresAt,
      ),
    },
    expiresAt: handoffExpiresAt.toISOString(),
  };
}

/** Consumes a handoff exactly once and returns the session's handle. */
export async function consumeHandoff(
  input: { token: string; origin: string },
  now = new Date(),
) {
  if (input.origin !== new URL(loadConfig().APP_ORIGIN).origin)
    throw new BridgeRefusal("origin_mismatch", 403);
  const verdict = verifyHandoff(input.token, now);
  if (verdict.status === "invalid")
    throw new BridgeRefusal("token_invalid", 410);
  if (verdict.status === "expired")
    throw new BridgeRefusal("token_expired", 410);
  const { claims } = verdict;
  return scoped(claims.workspaceId, claims.projectId, async (tx) => {
    const { count } = await tx.webmailSession.updateMany({
      where: {
        id: claims.sessionId,
        projectId: claims.projectId,
        handoffConsumedAt: null,
        handoffExpiresAt: { gt: now },
        revokedAt: null,
      },
      data: { handoffConsumedAt: now, lastSeenAt: now },
    });
    const row = await tx.webmailSession.findFirst({
      where: { id: claims.sessionId, projectId: claims.projectId },
    });
    if (count !== 1 || !row) {
      if (!row || row.revokedAt) throw new BridgeRefusal("token_invalid", 410);
      throw new BridgeRefusal(
        row.handoffConsumedAt ? "token_consumed" : "token_expired",
        410,
      );
    }
    return {
      ok: true as const,
      handle: handleToken(claims, row.expiresAt),
      user: `mb-${row.mailboxId}@orbit.invalid`,
    };
  });
}

/** Whether the Better Auth session behind a webmail session is still alive. */
async function authSessionAlive(
  authSessionId: string,
  userId: string,
  now: Date,
) {
  const session = await authDb.session.findFirst({
    where: { id: authSessionId, userId, expiresAt: { gt: now } },
    select: { user: { select: { banned: true } } },
  });
  return session !== null && !session.user.banned;
}

// One write per session and process at a time; the conditional update keeps
// it to one a minute. It takes the project lock, so it never delays a request.
const touching = new Set<string>();
function touch(claims: WebmailClaims, now: Date) {
  if (touching.has(claims.sessionId)) return;
  touching.add(claims.sessionId);
  const cutoff = new Date(now.getTime() - TOUCH_EVERY_MS);
  void scoped(claims.workspaceId, claims.projectId, (tx) =>
    tx.webmailSession.updateMany({
      where: {
        id: claims.sessionId,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: cutoff } }],
      },
      data: { lastSeenAt: now },
    }),
  )
    .catch(() => undefined)
    .finally(() => touching.delete(claims.sessionId));
}

type SessionAccess = {
  scope: Scope;
  mailboxId: string;
  connectionId: string;
  connection: Record<string, unknown>;
  mailboxDisplayName: string | null;
  capabilities: WebmailCapability[];
};

/**
 * Every check of a Roundcube request. The reads avoid the project lock: a
 * long writer of the project must not stall a request with a short timeout.
 */
async function sessionAccess(
  handle: string,
  now: Date,
): Promise<SessionAccess> {
  const verdict = verifyHandle(handle, now);
  if (verdict.status === "invalid") throw refuse("session_unknown");
  if (verdict.status === "expired") throw refuse("session_expired");
  const { claims } = verdict;
  const access = await scopedRead(
    claims.workspaceId,
    claims.projectId,
    async (tx) => {
      const session = await tx.webmailSession.findFirst({
        where: { id: claims.sessionId, projectId: claims.projectId },
      });
      if (!session || !session.handoffConsumedAt)
        throw refuse("session_unknown");
      if (session.revokedAt) throw refuse("session_revoked");
      if (session.expiresAt.getTime() <= now.getTime())
        throw refuse("session_expired");
      if (!(await authSessionAlive(session.authSessionId, session.userId, now)))
        throw refuse("session_revoked");
      const fresh = await actorScope(
        claims.workspaceId,
        claims.projectId,
        session.userId,
      );
      if (!fresh) throw refuse("not_authorized");
      const scope = effectiveScope(fresh);
      if (!(await moduleOn(tx, scope))) throw refuse("not_authorized");
      const found = await loadMailbox(tx, scope, session.mailboxId);
      if (!found) throw refuse("mailbox_unavailable");
      if (!found.mailbox.enabled) throw refuse("mailbox_unavailable");
      const grant = await grantOf(tx, scope, session.mailboxId, session.userId);
      if (!grant?.canRead) throw refuse("not_authorized");
      if (!connectionVerified(found.connection.status))
        throw refuse("mailbox_unavailable");
      if (!ownerAdmits(fresh, found.connection)) throw refuse("not_authorized");
      return {
        scope,
        lastSeenAt: session.lastSeenAt,
        mailboxId: session.mailboxId,
        connectionId: found.mailbox.emailConnectionId,
        connection: found.connection,
        mailboxDisplayName: found.mailbox.displayName,
        capabilities: sessionCapabilities(
          effectiveCapabilities(
            capabilitiesOf(grant),
            await operatingState(tx, scope),
          ),
        ),
      };
    },
  );
  if (
    !access.lastSeenAt ||
    now.getTime() - access.lastSeenAt.getTime() >= TOUCH_EVERY_MS
  )
    touch(claims, now);
  return access;
}

/** The member's scope in webmail, or a refusal without access to the module. */
function effectiveScope(fresh: Scope) {
  try {
    const scope = moduleScope(fresh, "webmail");
    if (!can(scope, WEBMAIL_USE)) throw refuse("not_authorized");
    return scope;
  } catch (error) {
    if (error instanceof DomainError) throw refuse("not_authorized");
    throw error;
  }
}

async function moduleOn(tx: DbTx, scope: Scope) {
  if (!(await webmailActive(tx, scope))) return false;
  try {
    await assertModuleEnabled(tx, scope, "webmail");
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

/** One content-free row naming the member behind a mutating Roundcube action. */
function attribute(access: SessionAccess, action: string) {
  const { scope, mailboxId } = access;
  return scoped(scope.workspaceId, scope.projectId, (tx) =>
    audit(tx, scope, "webmail.mail.action", mailboxId, {
      task: "mail",
      action,
    }),
  );
}

/** `session/authorize`: the capabilities and this request's mail servers. */
export async function authorizeSession(
  input: { handle: string; task: string; action: string },
  now = new Date(),
) {
  const access = await sessionAccess(input.handle, now);
  let servers;
  try {
    servers = await mailServerTargets(access.connection);
  } catch {
    throw refuse("mailbox_unavailable");
  }
  // Only for what the plugin will let run, and fail closed: no action without
  // its row. A member without the right cannot make the bridge take the lock.
  const required =
    input.task === "mail" ? ATTRIBUTED_ACTIONS.get(input.action) : undefined;
  if (required && access.capabilities.includes(required))
    await attribute(access, input.action).catch(() => {
      throw refuse("mailbox_unavailable");
    });
  const email = String(access.connection.fromAddress ?? "");
  return {
    ok: true as const,
    capabilities: access.capabilities,
    projectId: access.scope.projectId,
    email,
    displayName:
      access.mailboxDisplayName ?? String(access.connection.fromName ?? email),
    imap: servers.imap,
    smtp: servers.smtp,
  };
}

/** Roundcube's selection as UIDs; null when it cannot be vetted or is too big. */
export function ingestSelection(
  selection: BarrierSelection,
): IngestSelection | null {
  if (selection.type === "all") return { all: true };
  const uids = new Set<number>();
  for (const item of selection.uids) {
    const [first, last = first] = item.split(":").map(Number) as [
      number,
      number?,
    ];
    const low = Math.min(first, last);
    const high = Math.max(first, last);
    if (low < 1 || high > MAX_UID || high - low >= MAX_BARRIER_UIDS)
      return null;
    for (let uid = low; uid <= high; uid++) uids.add(uid);
    if (uids.size > MAX_BARRIER_UIDS) return null;
  }
  return { uids: [...uids] };
}

/**
 * `session/barrier`, before Roundcube removes messages from the INBOX: only
 * `ok` lets the action run. The plugin has already resolved an empty folder
 * to the INBOX; other folders are not fetched by Orbit, so nothing can be lost.
 * A mark-deleted is attributed here: authorize sees only "mark", which is
 * mostly reading, and the flag that tells them apart reaches only this call.
 */
export async function sessionBarrier(
  input: {
    handle: string;
    operation: string;
    folder: string;
    selection: BarrierSelection;
  },
  now = new Date(),
): Promise<SessionBarrierResponse> {
  const access = await sessionAccess(input.handle, now);
  if (!access.capabilities.includes("organize")) throw refuse("not_authorized");
  const result = await barrierResult(access, input);
  if (result.status !== "ok" || input.operation !== "mark_deleted")
    return result;
  return attribute(access, "mark-deleted").then(
    () => result,
    () => ({ status: "retry", reason: "audit_failed" }),
  );
}

async function barrierResult(
  access: SessionAccess,
  input: { folder: string; selection: BarrierSelection },
): Promise<SessionBarrierResponse> {
  if (input.folder !== "" && input.folder.toLowerCase() !== "inbox")
    return { status: "ok" };
  const selection = ingestSelection(input.selection);
  if (!selection) return { status: "retry", reason: "selection_too_large" };
  try {
    return await ensureIngested(access.scope, access.connectionId, selection, {
      timeoutMs: BARRIER_TIMEOUT_MS,
    });
  } catch {
    return { status: "retry", reason: "ingest_failed" };
  }
}

/** `session/end`: Roundcube logged out or destroyed its session. */
export async function endSession(
  input: { handle: string; reason: string },
  now = new Date(),
) {
  const verdict = verifyHandle(input.handle, now);
  if (verdict.status === "invalid") throw refuse("session_unknown");
  if (verdict.status === "expired") return { ok: true as const };
  const { claims } = verdict;
  await scoped(claims.workspaceId, claims.projectId, (tx) =>
    tx.webmailSession.updateMany({
      where: {
        id: claims.sessionId,
        projectId: claims.projectId,
        revokedAt: null,
      },
      data: { revokedAt: now, revokeReason: input.reason },
    }),
  );
  return { ok: true as const };
}
