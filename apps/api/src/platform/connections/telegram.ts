import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import { z } from "zod";
import {
  authDb,
  scoped,
  type DbTx,
  type Prisma,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  ConnectorError,
  createTelegramClient,
  type FetchLike,
  type TelegramButton,
} from "../../../../../packages/connectors/src/index.ts";
import {
  audit,
  constantEqual,
  data,
  decrypt,
  DomainError,
  encrypt,
  entity,
  update,
  credentialKey,
} from "../../shared.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { pauseProject } from "../governance/pause.ts";
import {
  ownerEnabled,
  registeredTelegramCallback,
  telegramContributorEnabled,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import type { TelegramCallback } from "./types.ts";
import type { DirectWebhookProvider } from "../modules/contributions.ts";

/**
 * The owner's private Orbit Telegram bot (Orbit Agents, spec §10).
 *
 * Setup: the owner enters a @BotFather token; Orbit registers the webhook
 * `${APP_ORIGIN}/api/telegram/<projectId>/<connectionId>` with a per-connection
 * secret and shows a one-time link code (10 min). `/start <code>` from a private chat
 * binds that chat to the owner who created the code and records `linkedAt`;
 * an agent review counts only if it was made after that time (R50).
 *
 * Storage (`telegram_connections`, deliberately not a generic collection):
 * the token only encrypted with CREDENTIAL_KEY, the webhook secret and the
 * link code only as SHA-256 hashes. A project has at most one connection that
 * is not disabled; connecting again disables the older ones. The webhook path
 * names the project because row-level security hides Entity rows until the
 * project is known (R59). A disabled row keeps its secret hash, so a late
 * update is still authenticated before it is ignored.
 *
 * Webhook: the secret header is compared in constant time; a wrong one is
 * answered 401 and audited. Updates from any chat or user other than the
 * bound ones are ignored and audited. `/pause` asks for an inline
 * confirmation (`pause:<token>`) first. Resuming is only possible in Orbit.
 *
 * Buttons (WP2.5a): `callback_data` is routed by its prefix to the handler
 * the platform or a module registered (`telegram.callbacks`); marketing's
 * Stop (`stop:<token>`) withdraws an assignment post before handoff (spec
 * §9). Callback tokens are HMACs under a key derived from AUTH_SECRET;
 * repeated clicks give the same result.
 */
const KIND = "telegram_connections";
const LINK_CODE_MS = 10 * 60000;
const PAUSE_CONFIRM_MS = 10 * 60000;
const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Audit actor for webhook events not (yet) tied to a verified owner.
const WEBHOOK_ACTOR = "telegram-webhook";

type Connection = Awaited<ReturnType<typeof entity>>;
export type TelegramStatus = "none" | "pending" | "linked" | "disabled";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function owner(scope: Scope) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
}

/**
 * Bot routes and the webhook exist only while the bot is on: ORBIT_TELEGRAM
 * when set (ADR 0015), else a contributor's switch (marketing, with Orbit
 * Agents on), so production keeps its behaviour until the flag is set.
 */
export function telegramEnabled() {
  const flag = loadConfig().ORBIT_TELEGRAM;
  return flag ? flag === "true" : telegramContributorEnabled();
}

/**
 * The project's linked Telegram chat, or null: the newest linked row
 * (createdAt, then id, descending; connecting again disables older rows, so
 * there is at most one), and only while the user it is bound to is still an
 * owner of the project by current membership (R61). A removed or downgraded
 * owner means no connected bot: agent approvals lose their authority and no
 * previews go out.
 */
export async function linkedTelegramConnection(tx: DbTx, scope: Scope) {
  const row = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      data: { path: ["status"], equals: "linked" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const linkedUserId = data(row).linkedUserId;
  if (!row || typeof linkedUserId !== "string" || !linkedUserId) return null;
  const linkedOwner = await actorScope(
    scope.workspaceId,
    scope.projectId,
    linkedUserId,
  );
  return linkedOwner?.role === "owner" ? row : null;
}

/**
 * A client for the bot of a linked connection and the chat it is bound to,
 * for the notification sender (Task 13). The decrypted token stays inside
 * the client; it is never returned or logged. Null when the credential is
 * gone or unusable.
 */
export function telegramSender(
  row: Connection,
  options: { fetch?: FetchLike } = {},
) {
  const token = tokenOf(row);
  const chatId = data(row).chatId;
  if (!token || (typeof chatId !== "string" && typeof chatId !== "number"))
    return null;
  try {
    return {
      chatId,
      client: createTelegramClient({ token, fetch: options.fetch }),
    };
  } catch {
    return null;
  }
}

/** Connections that are not disabled, newest first. */
async function activeConnections(tx: DbTx, scope: Scope) {
  return (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: KIND,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
  ).filter((row) => data(row).status !== "disabled");
}

/** Owner-only status: no token, secret or code, ever. */
export async function telegramStatus(tx: DbTx, scope: Scope) {
  owner(scope);
  const newest = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const d = data(newest);
  return {
    status: (newest ? d.status : "none") as TelegramStatus,
    linkedAt: d.status === "linked" ? (d.linkedAt ?? null) : null,
  };
}

/** A disabled row keeps no usable credential or code. */
function disabled(row: Connection, by: string, reason: string) {
  return {
    ...data(row),
    status: "disabled",
    encryptedToken: null,
    linkCodeHash: null,
    linkCodeExpiresAt: null,
    disabledAt: new Date().toISOString(),
    disabledBy: by,
    disabledReason: reason,
  };
}
function tokenOf(row: Connection) {
  try {
    const value = data(row).encryptedToken;
    return typeof value === "string" ? decrypt(value, credentialKey()) : null;
  } catch {
    return null;
  }
}
/** Best effort: an old bot stops calling Orbit. A failure changes nothing here. */
async function forgetWebhooks(tokens: string[], fetch?: FetchLike) {
  for (const token of new Set(tokens))
    await createTelegramClient({ token, fetch })
      .deleteWebhook()
      .catch(() => undefined);
}

function connectorFailure(error: unknown): never {
  if (error instanceof ConnectorError) {
    if (error.code === "PROVIDER_AUTH")
      throw new DomainError("TELEGRAM_TOKEN_REJECTED", 400);
    if (error.code === "INVALID_TELEGRAM_WEBHOOK")
      throw new DomainError("TELEGRAM_WEBHOOK_URL_INVALID", 409);
  }
  throw new DomainError("TELEGRAM_UNAVAILABLE", 502);
}

/**
 * Owner only. Registers the webhook first, then stores the connection and
 * disables older ones: a token Telegram refuses changes nothing. Returns only
 * the one-time link code and its expiry.
 */
export async function connectTelegram(
  scope: Scope,
  input: unknown,
  options: { fetch?: FetchLike } = {},
) {
  owner(scope);
  const parsed = z
    .object({ token: z.string().max(200) })
    .strict()
    .safeParse(input);
  // The token never appears in a validation error.
  if (!parsed.success || !TOKEN.test(parsed.data.token))
    throw new DomainError("INVALID_TELEGRAM_TOKEN", 400);
  const token = parsed.data.token;
  const connectionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const linkCode = randomBytes(9).toString("base64url");
  const url = `${loadConfig().APP_ORIGIN.replace(/\/+$/, "")}/api/telegram/${scope.projectId}/${connectionId}`;
  try {
    await createTelegramClient({ token, fetch: options.fetch }).setWebhook(
      url,
      secret,
    );
  } catch (error) {
    connectorFailure(error);
  }
  const expiresAt = new Date(Date.now() + LINK_CODE_MS).toISOString();
  const replaced = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const previous: string[] = [];
      for (const row of await activeConnections(tx, scope)) {
        const old = tokenOf(row);
        if (old && old !== token) previous.push(old);
        await update(tx, scope, row, disabled(row, scope.userId, "REPLACED"));
      }
      const value = {
        status: "pending",
        encryptedToken: encrypt(token, credentialKey()),
        webhookSecretHash: sha256(secret),
        chatId: null,
        telegramUserId: null,
        linkCodeHash: sha256(linkCode),
        linkCodeExpiresAt: expiresAt,
        linkedUserId: null,
        createdBy: scope.userId,
      } as Prisma.InputJsonValue;
      await tx.entity.create({
        data: {
          id: connectionId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: KIND,
          data: value,
        },
      });
      await tx.entityVersion.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          entityId: connectionId,
          version: 1,
          data: value,
        },
      });
      await audit(tx, scope, "telegram.connect", connectionId, {
        replaced: previous.length,
        linkCodeExpiresAt: expiresAt,
      });
      return previous;
    },
  );
  await forgetWebhooks(replaced, options.fetch);
  return { linkCode, expiresAt };
}

/** Owner only. Disables every connection of the project and removes the webhook. */
export async function disconnectTelegram(
  scope: Scope,
  options: { fetch?: FetchLike } = {},
) {
  owner(scope);
  const tokens = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const found: string[] = [];
      for (const row of await activeConnections(tx, scope)) {
        const token = tokenOf(row);
        if (token) found.push(token);
        await update(
          tx,
          scope,
          row,
          disabled(row, scope.userId, "DISCONNECTED"),
        );
        await audit(tx, scope, "telegram.disconnect", row.id);
      }
      return found;
    },
  );
  await forgetWebhooks(tokens, options.fetch);
  return { status: "none" as TelegramStatus, linkedAt: null };
}

// --- Callback tokens -------------------------------------------------------

/** Own key for bot callbacks, derived from AUTH_SECRET (never the session key itself). */
const callbackKey = () =>
  createHmac("sha256", loadConfig().AUTH_SECRET)
    .update("orbit-telegram-callback-v1")
    .digest();
/**
 * The 128-bit MAC of a callback message (22 base64url characters), which
 * keeps signed data within Telegram's 64 bytes. Modules sign their own
 * callback data with it; each signs a message format of its own, so a
 * token of one kind never verifies as another.
 */
export const callbackMac = (message: string) =>
  createHmac("sha256", callbackKey())
    .update(message)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
const mac = callbackMac;
/** A UUID as 22 base64url characters, for callback data. */
export const compactUuid = (uuid: string) =>
  Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
/** The UUID of `compactUuid`, or null for anything else. */
export function expandUuid(compact: string) {
  const hex = Buffer.from(compact, "base64url").toString("hex");
  if (hex.length !== 32 || compactUuid(hex) !== compact) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Confirmation of `/pause`: HMAC(`pause:projectId:nonce`); the nonce carries its time. */
function pauseCallbackData(projectId: string, now = Date.now()) {
  const nonce = `${Math.floor(now / 1000).toString(36)}.${randomBytes(9).toString("base64url")}`;
  return `pause:${nonce}.${mac(`pause:${projectId}:${nonce}`)}`;
}
function readPause(value: string, projectId: string, now = Date.now()) {
  const match =
    /^pause:([0-9a-z]{1,10})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{22})$/.exec(
      value,
    );
  if (!match) return null;
  const nonce = `${match[1]}.${match[2]}`;
  if (!constantEqual(match[3]!, mac(`pause:${projectId}:${nonce}`)))
    return null;
  const issued = parseInt(match[1]!, 36) * 1000;
  return issued <= now + 60000 && now - issued <= PAUSE_CONFIRM_MS
    ? { nonce }
    : "expired";
}

// --- Webhook ---------------------------------------------------------------

const telegramId = z.union([
  z.number().int(),
  z.string().regex(/^-?\d{1,20}$/),
]);
const chat = z.object({ id: telegramId, type: z.string().max(20) });
const user = z.object({ id: telegramId });
const update_ = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat,
      from: user.optional(),
      text: z.string().max(4096).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(128),
      from: user,
      message: z.object({ chat }).optional(),
      data: z.string().max(64).optional(),
    })
    .optional(),
});

type Reply =
  | { kind: "message"; text: string; buttons?: TelegramButton[] }
  | { kind: "answer"; id: string; text: string };
export type TelegramWebhookResult = { status: 200 | 401; handled: string };

const TEXT = {
  linked: "Verbunden. Orbit schickt dir hier Vorschauen mit Stop-Knopf.",
  alreadyLinked: "Bereits verbunden.",
  badCode: "Code ungültig oder abgelaufen. Neuen Code in Orbit erzeugen.",
  linkHint:
    "Zum Verbinden den Code aus Orbit senden: /start CODE oder nur den Code.",
  privateOnly: "Bitte im privaten Chat mit dem Bot verbinden.",
  help: "Vorschauen kommen automatisch. Befehl: /pause",
  confirmPause:
    "Projekt wirklich pausieren? Es geht nichts mehr raus. Fortsetzen nur in Orbit.",
  pauseButton: "Ja, pausieren",
  paused: "Projekt pausiert. Fortsetzen nur in Orbit.",
  alreadyPaused: "Projekt ist bereits pausiert.",
  pauseExpired: "Bestätigung abgelaufen. Bitte /pause erneut senden.",
  ownerOnly: "Nur der Owner kann pausieren.",
  noAccess: "Keine Berechtigung mehr für dieses Projekt.",
  invalid: "Ungültige Aktion.",
};

// A link code sent on its own: one base64url word (the code is 12 characters).
const LINK_CODE = /^[A-Za-z0-9_-]{8,64}$/;

/** `/start CODE` or `/start@bot CODE`; `/pause`, `/pause@bot`. */
const command = (text: string | undefined) => {
  const match =
    /^\/([a-z]+)(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S{1,64}))?\s*$/.exec(
      (text ?? "").trim(),
    );
  return match ? { name: match[1]!, argument: match[2] ?? null } : null;
};

/**
 * Handles one webhook call. Every state change and audit commits before any
 * reply is sent; replies go out afterwards and their failures change nothing.
 * Never throws for bad input: an unknown project, an unknown connection, a
 * connection of another project or a wrong secret → 401 (the same answer for
 * each), all else → 200 so Telegram does not redeliver.
 */
export async function handleTelegramWebhook(
  input: {
    /** Given by the platform's hooks route: it must be the project's. */
    workspaceId?: string;
    projectId: string;
    connectionId: string;
    secret: unknown;
    body: unknown;
  },
  options: { fetch?: FetchLike; log?: (code: string) => void } = {},
): Promise<TelegramWebhookResult> {
  const unknown = { status: 401 as const, handled: "unknown_connection" };
  // Both path segments are checked before any database access.
  if (!UUID.test(input.projectId) || !UUID.test(input.connectionId))
    return unknown;
  const projectId = input.projectId.toLowerCase();
  const connectionId = input.connectionId.toLowerCase();
  const project = await authDb.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) return unknown;
  if (
    input.workspaceId !== undefined &&
    input.workspaceId.toLowerCase() !== project.workspaceId
  )
    return unknown;
  const system: Scope = {
    workspaceId: project.workspaceId,
    projectId,
    userId: WEBHOOK_ACTOR,
    role: "viewer",
  };
  const outcome = await scoped(
    system.workspaceId,
    system.projectId,
    async (tx) => {
      const row = await tx.entity.findFirst({
        where: {
          id: connectionId,
          kind: KIND,
          workspaceId: system.workspaceId,
          projectId,
        },
      });
      if (!row) return unknown;
      const c = data(row);
      const presented = typeof input.secret === "string" ? input.secret : "";
      if (
        typeof c.webhookSecretHash !== "string" ||
        !constantEqual(sha256(presented), c.webhookSecretHash)
      ) {
        await audit(tx, system, "telegram.webhook_rejected", row.id, {
          reason: presented ? "SECRET_MISMATCH" : "SECRET_MISSING",
        });
        return { status: 401 as const, handled: "secret" };
      }
      if (c.status === "disabled")
        return { status: 200 as const, handled: "disabled" };
      const parsed = update_.safeParse(input.body);
      if (!parsed.success)
        return { status: 200 as const, handled: "malformed" };
      const token = tokenOf(row);
      if (!token) return { status: 200 as const, handled: "no_credential" };
      const u = parsed.data;
      const replies: Reply[] = [];
      const done = (handled: string) => ({
        status: 200 as const,
        handled,
        token,
        chatId: String(
          u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? "",
        ),
        replies,
      });
      const chatId = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
      const fromId = u.message?.from?.id ?? u.callback_query?.from.id;
      const updateType = u.callback_query
        ? "callback_query"
        : u.message
          ? "message"
          : "other";

      if (c.status === "pending") {
        if (!u.message || fromId === undefined) return done("pending_ignored");
        // `/start CODE`, or the code on its own; anything else gets a hint
        // (Telegram's Start button sends a bare `/start`).
        const start = command(u.message.text);
        const text = (u.message.text ?? "").trim();
        const presentedCode =
          start?.name === "start"
            ? start.argument
            : LINK_CODE.test(text)
              ? text
              : null;
        if (!presentedCode) {
          replies.push({ kind: "message", text: TEXT.linkHint });
          return done("link_hint");
        }
        const valid =
          typeof c.linkCodeHash === "string" &&
          constantEqual(sha256(presentedCode), c.linkCodeHash) &&
          Date.parse(c.linkCodeExpiresAt ?? "") > Date.now();
        if (!valid) {
          await audit(tx, system, "telegram.link_rejected", row.id, {
            reason: "CODE_INVALID_OR_EXPIRED",
          });
          replies.push({ kind: "message", text: TEXT.badCode });
          return done("link_rejected");
        }
        if (u.message.chat.type !== "private") {
          await audit(tx, system, "telegram.link_rejected", row.id, {
            reason: "CHAT_NOT_PRIVATE",
          });
          replies.push({ kind: "message", text: TEXT.privateOnly });
          return done("link_rejected");
        }
        // The chat is bound to the owner who created the code, if still owner.
        const creator = await actorScope(
          system.workspaceId,
          system.projectId,
          String(c.createdBy),
        );
        if (creator?.role !== "owner") {
          await audit(tx, system, "telegram.link_rejected", row.id, {
            reason: "OWNER_REQUIRED",
          });
          replies.push({ kind: "message", text: TEXT.noAccess });
          return done("link_rejected");
        }
        await update(tx, creator, row, {
          ...c,
          status: "linked",
          chatId: String(chatId),
          telegramUserId: String(fromId),
          linkedUserId: creator.userId,
          linkedAt: new Date().toISOString(),
          linkCodeHash: null,
          linkCodeExpiresAt: null,
        });
        await audit(tx, creator, "telegram.linked", row.id);
        replies.push({ kind: "message", text: TEXT.linked });
        return done("linked");
      }

      // Linked: only the bound private chat and its user act.
      if (
        chatId === undefined ||
        String(chatId) !== c.chatId ||
        String(fromId) !== c.telegramUserId
      ) {
        await audit(tx, system, "telegram.foreign_chat_ignored", row.id, {
          updateType,
        });
        return done("foreign_chat");
      }
      const actor = await actorScope(
        system.workspaceId,
        system.projectId,
        String(c.linkedUserId),
      );

      // The bot acts with the linked owner's current role, never more.
      if (!actor) {
        if (u.callback_query)
          replies.push({
            kind: "answer",
            id: u.callback_query.id,
            text: TEXT.noAccess,
          });
        else replies.push({ kind: "message", text: TEXT.noAccess });
        return done("no_access");
      }

      if (u.message) {
        const cmd = command(u.message.text);
        if (cmd?.name === "start")
          replies.push({ kind: "message", text: TEXT.alreadyLinked });
        else if (cmd?.name === "pause") {
          const current = await tx.project.findUniqueOrThrow({
            where: { id: system.projectId },
          });
          if (current.paused)
            replies.push({ kind: "message", text: TEXT.alreadyPaused });
          else if (actor.role !== "owner")
            replies.push({ kind: "message", text: TEXT.ownerOnly });
          else
            replies.push({
              kind: "message",
              text: TEXT.confirmPause,
              buttons: [
                {
                  text: TEXT.pauseButton,
                  callbackData: pauseCallbackData(system.projectId),
                },
              ],
            });
        } else replies.push({ kind: "message", text: TEXT.help });
        return done("message");
      }

      const callback = u.callback_query;
      if (!callback) return done("other");
      const answer = (text: string) =>
        replies.push({ kind: "answer", id: callback.id, text });
      const value = callback.data ?? "";
      // Routed by prefix to the platform's or a module's handler (WP2.5a).
      const prefix = /^([a-z]{1,16}):/.exec(value)?.[1];
      const handler = prefix ? registeredTelegramCallback(prefix) : undefined;
      if (prefix && handler) {
        // A disabled module's buttons do nothing (WP2.4).
        const result = ownerEnabled(
          handler.owner,
          await enabledModules(tx, actor),
        )
          ? await handler.handle(tx, actor, value, { connectionId: row.id })
          : null;
        if (!result) {
          await audit(tx, actor, "telegram.callback_rejected", row.id, {
            action: prefix,
          });
          answer(TEXT.invalid);
          return done("callback_rejected");
        }
        answer(result.answer);
        return done(result.handled);
      }
      await audit(tx, actor, "telegram.callback_rejected", row.id, {
        action: "unknown",
      });
      answer(TEXT.invalid);
      return done("callback_rejected");
    },
  );

  if (!("replies" in outcome) || !outcome.replies.length)
    return { status: outcome.status, handled: outcome.handled };
  const client = createTelegramClient({
    token: outcome.token,
    fetch: options.fetch,
  });
  for (const reply of outcome.replies)
    try {
      if (reply.kind === "answer")
        await client.answerCallbackQuery(reply.id, reply.text);
      else await client.sendMessage(outcome.chatId, reply.text, reply.buttons);
    } catch (error) {
      // A lost reply is only shown; it never repeats or undoes the action.
      options.log?.(
        error instanceof ConnectorError ? error.code : "TELEGRAM_REPLY_FAILED",
      );
    }
  return { status: outcome.status, handled: outcome.handled };
}

/**
 * The platform's `pause:` button: confirms `/pause` within 10 minutes.
 * Only an owner pauses; resuming is only possible in Orbit.
 */
export const pauseCallback: TelegramCallback = async (
  tx,
  actor,
  value,
  { connectionId },
) => {
  const pause = readPause(value, actor.projectId);
  if (!pause) return null;
  const current = await tx.project.findUniqueOrThrow({
    where: { id: actor.projectId },
  });
  if (current.paused)
    return { handled: "already_paused", answer: TEXT.alreadyPaused };
  if (pause === "expired")
    return { handled: "pause_expired", answer: TEXT.pauseExpired };
  if (actor.role !== "owner")
    return { handled: "pause_forbidden", answer: TEXT.ownerOnly };
  // The bot confirms the pause itself; no second notice.
  await pauseProject(tx, actor, true, { notify: false });
  await audit(tx, actor, "telegram.pause", connectionId, {
    nonce: pause.nonce,
  });
  return { handled: "paused", answer: TEXT.paused };
};

/**
 * The bot's webhook through the platform's hooks route (WP4.2 follow-up):
 * `/api/hooks/telegram/<workspaceId>/<projectId>/<connectionId>`, the same
 * handler and secret check as `/api/telegram/<projectId>/<connectionId>`,
 * which stays the registered URL until the cutover (docs/PUBLIC_INGRESS.md).
 */
export const telegramWebhook: DirectWebhookProvider = {
  direct: true,
  bodies: ["json"],
  async handle(input) {
    if (!telegramEnabled()) return { status: 404 };
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      body = undefined;
    }
    const result = await handleTelegramWebhook(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        connectionId: input.connectionId,
        secret: input.headers["x-telegram-bot-api-secret-token"],
        body,
      },
      { fetch: input.fetch },
    );
    return { status: result.status };
  },
};
