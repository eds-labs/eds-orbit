import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  createPublicKey,
  revokePublicKey,
} from "../../platform/http/public-api.ts";
import type {
  PublicRoute,
  PublicRouteContext,
} from "../../platform/modules/contributions.ts";
import {
  audit,
  create,
  credentialKey,
  data,
  decrypt,
  DomainError,
  update,
} from "../../shared.ts";
import {
  conversationChanged,
  conversationStream,
  ticketEvent,
} from "./common.ts";
import { requireSupport } from "./gate.ts";
import { notifyHandoff } from "./automations.ts";
import { loadInbox } from "./inboxes.ts";
import {
  appendCustomerMessage,
  createTicket,
  resolveContact,
} from "./tickets.ts";

// The livechat widget's public API (WP5.4), mounted by the platform at
// /api/public/support/<publicKey>/... with the key's CORS and a bearer
// session. A session becomes a visitor by /identify: anonymous with an
// e-mail they typed (never matched to other contacts), or a host-app user
// whose id the app's backend signed with the inbox's widget secret. A
// visitor sees only their own conversations; internal notes and AI drafts
// never leave Orbit.

export const WIDGET_SESSION_KIND = "support_widget_sessions";
/** A visitor seen this recently counts as online: replies stay in the widget. */
const ONLINE_MS = 120_000;
// Abuse caps (WP5.8): conversations per anonymous session, and customer
// messages per conversation in ten minutes.
const MAX_ANONYMOUS_CONVERSATIONS = 5;
const MAX_MESSAGES_PER_10_MIN = 20;

/** The inbox's public key for the widget; a new one revokes the old one. */
export async function enableWidgetKey(scope: Scope, inboxId: string) {
  const inbox = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSupport(tx, scope);
    return loadInbox(tx, scope, inboxId);
  });
  if (inbox.archivedAt) throw new DomainError("INBOX_ARCHIVED", 409);
  if (!inbox.channels.includes("widget") || !inbox.allowedOrigins.length)
    throw new DomainError("INBOX_HAS_NO_WIDGET", 409);
  if (inbox.publicClientKeyId)
    await revokePublicKey(scope, inbox.publicClientKeyId).catch(
      () => undefined,
    );
  const key = await createPublicKey(scope, {
    moduleId: "support",
    allowedOrigins: inbox.allowedOrigins,
  });
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await tx.supportInbox.update({
      where: { id: inboxId },
      data: { publicClientKeyId: key.id, version: inbox.version + 1 },
    });
    await audit(tx, scope, "support.inbox.widget_key", inboxId, {
      inboxId,
      keyId: key.id,
    });
  });
  return { publicKey: key.publicKey, keyId: key.id };
}

type Visitor = {
  id: string;
  sessionId: string;
  inboxId: string;
  contactId: string | null;
  verified: boolean;
  ticketIds: string[];
};

/** The live widget inbox of the session's key, or 404. */
async function inboxOfKey(tx: DbTx, scope: Scope, keyId: string) {
  const inbox = await tx.supportInbox.findFirst({
    where: {
      projectId: scope.projectId,
      publicClientKeyId: keyId,
      archivedAt: null,
    },
  });
  if (!inbox || !inbox.channels.includes("widget"))
    throw new DomainError("NOT_FOUND", 404);
  return inbox;
}

async function visitorRow(tx: DbTx, scope: Scope, sessionId: string) {
  return tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: WIDGET_SESSION_KIND,
      data: { path: ["sessionId"], equals: sessionId },
    },
  });
}

/** The session's visitor; touches lastSeenAt so replies know who is online. */
async function visitorOf(
  tx: DbTx,
  ctx: PublicRouteContext,
  touch = false,
): Promise<Visitor> {
  await requireSupport(tx, ctx.scope);
  const inbox = await inboxOfKey(tx, ctx.scope, ctx.session.keyId);
  const row = await visitorRow(tx, ctx.scope, ctx.session.id);
  if (!row)
    return {
      id: "",
      sessionId: ctx.session.id,
      inboxId: inbox.id,
      contactId: null,
      verified: false,
      ticketIds: [],
    };
  // Last seen, at most once a minute and without a new version: a stream
  // reconnects every 39 s and polling runs every 5 s (review fix 12).
  const seen = Date.parse(String(data(row).lastSeenAt ?? "")) || 0;
  if (touch && Date.now() - seen > 60_000)
    await tx.entity.update({
      where: { id: row.id },
      data: {
        data: { ...data(row), lastSeenAt: new Date().toISOString() } as never,
      },
    });
  const d = data(row);
  return {
    id: row.id,
    sessionId: ctx.session.id,
    inboxId: inbox.id,
    contactId: d.contactId ?? null,
    verified: d.verified === true,
    ticketIds: Array.isArray(d.ticketIds) ? d.ticketIds : [],
  };
}

/** A ticket the visitor may see: theirs as verified user, else the session's. */
async function visibleTicket(
  tx: DbTx,
  scope: Scope,
  visitor: Visitor,
  ticketId: unknown,
) {
  const id = z.uuid().safeParse(ticketId);
  if (!id.success || !visitor.contactId)
    throw new DomainError("TICKET_NOT_FOUND", 404);
  const ticket = await tx.supportTicket.findFirst({
    where: {
      id: id.data,
      projectId: scope.projectId,
      inboxId: visitor.inboxId,
      contactId: visitor.contactId,
    },
  });
  if (!ticket || (!visitor.verified && !visitor.ticketIds.includes(ticket.id)))
    throw new DomainError("TICKET_NOT_FOUND", 404);
  return ticket;
}

const CUSTOMER_KINDS = ["customer", "agent_reply", "ai_reply", "system"];

/** The conversation as the customer sees it, numbered from 1. */
async function customerMessages(tx: DbTx, scope: Scope, ticketId: string) {
  const rows = await tx.supportMessage.findMany({
    where: {
      projectId: scope.projectId,
      ticketId,
      visibleToCustomer: true,
      kind: { in: CUSTOMER_KINDS },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((m, i) => ({
    id: i + 1,
    from: m.kind === "customer" ? "customer" : "agent",
    bodyText: m.bodyText,
    createdAt: m.createdAt.toISOString(),
  }));
}

const identifyInput = z
  .object({
    email: z.email().max(254).optional(),
    name: z.string().trim().max(200).optional(),
    locale: z.string().max(20).optional(),
    externalUserId: z.string().min(1).max(200).optional(),
    signature: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

function signatureValid(secret: string, userId: string, signature: string) {
  const expected = createHmac("sha256", secret).update(userId).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function identify(ctx: PublicRouteContext) {
  const input = identifyInput.parse(ctx.body);
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx);
    const inbox = await loadInbox(tx, ctx.scope, visitor.inboxId);
    let contactId: string;
    let verified = false;
    if (input.externalUserId) {
      if (
        !input.signature ||
        !inbox.widgetSecretEnc ||
        !signatureValid(
          decrypt(inbox.widgetSecretEnc, credentialKey()),
          input.externalUserId,
          input.signature,
        )
      ) {
        await audit(
          tx,
          ctx.scope,
          "support.widget.signature_invalid",
          inbox.id,
          {
            inboxId: inbox.id,
          },
        );
        throw new DomainError("SIGNATURE_INVALID", 403);
      }
      // The app signs the user id only; its e-mail stays a claim.
      contactId = await resolveContact(tx, ctx.scope, inbox.id, "widget", {
        externalUserId: input.externalUserId,
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
      });
      verified = true;
    } else {
      if (!input.email) throw new DomainError("EMAIL_REQUIRED", 400);
      // Anonymous: a contact of this session only, never merged by e-mail.
      contactId =
        visitor.contactId && !visitor.verified
          ? visitor.contactId
          : (
              await tx.supportContact.create({
                data: {
                  id: randomUUID(),
                  workspaceId: ctx.scope.workspaceId,
                  projectId: ctx.scope.projectId,
                  claimedEmail: input.email.trim().toLowerCase(),
                  name: input.name || null,
                  locale: input.locale || null,
                },
              })
            ).id;
    }
    const fields = {
      sessionId: ctx.session.id,
      keyId: ctx.session.keyId,
      inboxId: inbox.id,
      contactId,
      verified,
      ticketIds: visitor.contactId === contactId ? visitor.ticketIds : [],
      lastSeenAt: new Date().toISOString(),
    };
    const row = await visitorRow(tx, ctx.scope, ctx.session.id);
    if (row) await update(tx, ctx.scope, row, { ...data(row), ...fields });
    else await create(tx, ctx.scope, WIDGET_SESSION_KIND, fields);
    return { verified };
  });
}

async function listConversations(ctx: PublicRouteContext) {
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx, true);
    if (!visitor.contactId) return { items: [] };
    const tickets = await tx.supportTicket.findMany({
      where: {
        projectId: ctx.scope.projectId,
        inboxId: visitor.inboxId,
        contactId: visitor.contactId,
        mergedIntoTicketId: null,
        ...(visitor.verified ? {} : { id: { in: visitor.ticketIds } }),
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return {
      items: tickets.map((t) => ({
        ticketId: t.id,
        number: t.number,
        subject: t.subject,
        status: t.status,
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  });
}

const openInput = z
  .object({
    subject: z.string().trim().max(200).optional(),
    bodyText: z.string().trim().min(1).max(5000),
  })
  .strict();

async function openConversation(ctx: PublicRouteContext) {
  const input = openInput.parse(ctx.body);
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx, true);
    if (!visitor.contactId) throw new DomainError("IDENTITY_REQUIRED", 409);
    if (
      !visitor.verified &&
      visitor.ticketIds.length >= MAX_ANONYMOUS_CONVERSATIONS
    )
      throw new DomainError("TOO_MANY_CONVERSATIONS", 429);
    const created = await createTicket(tx, ctx.scope, {
      inboxId: visitor.inboxId,
      channel: "widget",
      contactId: visitor.contactId,
      inbound: {
        externalId: null,
        contact: {},
        subject: input.subject || input.bodyText.split("\n")[0]!.slice(0, 80),
        bodyText: input.bodyText,
        attachments: [],
      },
    });
    const row = (await visitorRow(tx, ctx.scope, ctx.session.id))!;
    await update(tx, ctx.scope, row, {
      ...data(row),
      ticketIds: [...visitor.ticketIds, created.ticketId].slice(-50),
    });
    return { ticketId: created.ticketId, number: created.number };
  });
}

async function readMessages(ctx: PublicRouteContext) {
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx, true);
    const ticket = await visibleTicket(
      tx,
      ctx.scope,
      visitor,
      ctx.query.ticket,
    );
    const after = Number(ctx.query.after ?? 0) || 0;
    const items = await customerMessages(tx, ctx.scope, ticket.id);
    return {
      status: ticket.status,
      items: items.filter((m) => m.id > after),
    };
  });
}

const sendInput = z
  .object({ ticketId: z.uuid(), bodyText: z.string().trim().min(1).max(5000) })
  .strict();

async function sendMessage(ctx: PublicRouteContext) {
  const input = sendInput.parse(ctx.body);
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx, true);
    const ticket = await visibleTicket(tx, ctx.scope, visitor, input.ticketId);
    const recent = await tx.supportMessage.count({
      where: {
        ticketId: ticket.id,
        kind: "customer",
        createdAt: { gte: new Date(Date.now() - 600_000) },
      },
    });
    if (recent >= MAX_MESSAGES_PER_10_MIN)
      throw new DomainError("MESSAGE_RATE_LIMIT", 429);
    await appendCustomerMessage(tx, ctx.scope, ticket, {
      bodyText: input.bodyText,
      channel: "widget",
      externalId: null,
    });
    return { ok: true };
  });
}

const handoffInput = z.object({ ticketId: z.uuid() }).strict();

/** "Talk to a human": the ticket leaves any AI handling and opens for agents. */
async function handoff(ctx: PublicRouteContext) {
  const input = handoffInput.parse(ctx.body);
  return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
    const visitor = await visitorOf(tx, ctx, true);
    const ticket = await visibleTicket(tx, ctx.scope, visitor, input.ticketId);
    if (ticket.aiState === "handed_off") return { ok: true };
    const status = ["new", "pending_customer", "resolved", "closed"].includes(
      ticket.status,
    )
      ? "open"
      : ticket.status;
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        aiState: "handed_off",
        status,
        ...(status !== ticket.status
          ? { resolvedAt: null, closedAt: null }
          : {}),
      },
    });
    await ticketEvent(tx, ctx.scope, {
      ticketId: ticket.id,
      type: "handoff",
      actorKind: "contact",
      actorId: ticket.contactId,
      before: { aiState: ticket.aiState, status: ticket.status },
      after: { aiState: "handed_off", status },
    });
    conversationChanged(tx, ctx.scope, ticket.id);
    await notifyHandoff(
      tx,
      ctx.scope,
      await tx.supportTicket.findFirstOrThrow({ where: { id: ticket.id } }),
    );
    return { ok: true };
  });
}

/** The conversation's stream: authorizes once, then replays by message number. */
async function streamConversation(ctx: PublicRouteContext) {
  const ticket = await scoped(
    ctx.scope.workspaceId,
    ctx.scope.projectId,
    async (tx) => {
      const visitor = await visitorOf(tx, ctx, true);
      return visibleTicket(tx, ctx.scope, visitor, ctx.query.ticket);
    },
  );
  return {
    projectId: ctx.scope.projectId,
    stream: conversationStream(ticket.id),
    async replay(after: number | null) {
      return scoped(ctx.scope.workspaceId, ctx.scope.projectId, async (tx) => {
        const current = await tx.supportTicket.findFirstOrThrow({
          where: { id: ticket.id },
        });
        const items = await customerMessages(tx, ctx.scope, ticket.id);
        return {
          events: items
            .filter((m) => m.id > (after ?? 0))
            .map((m) => ({ id: m.id, event: "message", data: m })),
          done:
            current.status === "closed" || Boolean(current.mergedIntoTicketId),
        };
      });
    },
  };
}

/** Whether the ticket's contact has a widget session seen in the last minutes. */
export async function visitorOnline(tx: DbTx, scope: Scope, contactId: string) {
  const since = new Date(Date.now() - ONLINE_MS).toISOString();
  const rows = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: WIDGET_SESSION_KIND,
      data: { path: ["contactId"], equals: contactId },
    },
  });
  return rows.some((row) => String(data(row).lastSeenAt ?? "") >= since);
}

const streamOnly = async () => {
  throw new DomainError("STREAM_ONLY", 400);
};

/** The widget's public routes. */
export const widgetRoutes: readonly PublicRoute[] = [
  { method: "POST", path: "/identify", handler: identify },
  { method: "GET", path: "/conversations", handler: listConversations },
  { method: "POST", path: "/conversations", handler: openConversation },
  { method: "GET", path: "/messages", handler: readMessages },
  { method: "POST", path: "/messages", handler: sendMessage },
  { method: "POST", path: "/handoff", handler: handoff },
  {
    method: "GET",
    path: "/stream",
    handler: streamOnly,
    stream: streamConversation,
  },
];
