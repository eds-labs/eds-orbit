import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { publishEvent } from "../../platform/events/events.ts";
import type { TriggerableEventDeclaration } from "../../platform/events/types.ts";
import { screenCustomerText } from "./hard-rules.ts";

// Support domain events for configured agents (ADR 0021 Phase 2, WP2.1).
// Content-free: ids, the channel and three booleans, never a subject, a
// message or an address. The agent reads the ticket later through its
// tools, under its principal and with the privacy wrapper.

export const SUPPORT_TICKET_CREATED = "support.ticket.created";
export const SUPPORT_MESSAGE_RECEIVED = "support.message.received";
/** The subject type of a ticket in links, events and work orders. */
export const SUPPORT_TICKET_SUBJECT = "support.ticket";

const filter = z.strictObject({
  inboxIds: z.array(z.uuid()).min(1).max(20).optional(),
  channels: z.array(z.enum(["email", "widget"])).min(1).max(2).optional(),
});
type Filter = z.infer<typeof filter>;

/**
 * Whether a Support event may start an agent with this filter. Never for a
 * hard-rule hit, an unverified widget visitor or an inbox that is not in
 * agent mode; no filter can lift these exclusions.
 */
export function supportEventMatches(f: Filter, data: Record<string, unknown>) {
  if (data.hardRuleHit !== false || data.agentMode !== true) return false;
  if (data.channel === "widget" && data.verifiedIdentity !== true) return false;
  if (f.inboxIds && !f.inboxIds.includes(String(data.inboxId))) return false;
  if (f.channels && !f.channels.includes(data.channel as "email" | "widget"))
    return false;
  return true;
}

const declaration = (en: string, de: string): TriggerableEventDeclaration => ({
  title: { en, de },
  subject: SUPPORT_TICKET_SUBJECT,
  filter,
  sensitive: true,
  matches: supportEventMatches,
});

export const supportTriggers = {
  [SUPPORT_TICKET_CREATED]: declaration("New ticket", "Neues Ticket"),
  [SUPPORT_MESSAGE_RECEIVED]: declaration(
    "New customer message",
    "Neue Kundennachricht",
  ),
};

/** Hard rules on all customer text a model would see: the subject and the message (T2-3). */
export function screenTicketText(subject: string, body: string) {
  return screenCustomerText(`${subject}\n${body}`);
}

type TicketFacts = {
  id: string;
  inboxId: string;
  contactId: string;
  channel: string;
  subject: string;
};

/** Publishes a ticket's creation or a new customer message, in the caller's transaction. */
export async function publishSupportMessageEvent(
  tx: DbTx,
  scope: Scope,
  type: typeof SUPPORT_TICKET_CREATED | typeof SUPPORT_MESSAGE_RECEIVED,
  ticket: TicketFacts,
  message: { id: string; bodyText: string },
) {
  const [inbox, verified] = await Promise.all([
    tx.supportInbox.findFirst({
      where: { id: ticket.inboxId, projectId: scope.projectId },
      select: { aiMode: true },
    }),
    ticket.channel === "widget"
      ? tx.supportContactIdentity.count({
          where: { contactId: ticket.contactId, channel: "widget" },
        })
      : Promise.resolve(0),
  ]);
  await publishEvent(tx, scope, {
    type,
    subject: { type: SUPPORT_TICKET_SUBJECT, id: ticket.id },
    actor: { kind: "system", id: null },
    origin: "support",
    data: {
      ticketId: ticket.id,
      ...(type === SUPPORT_MESSAGE_RECEIVED ? { messageId: message.id } : {}),
      inboxId: ticket.inboxId,
      channel: ticket.channel,
      verifiedIdentity: verified > 0,
      hardRuleHit: screenTicketText(ticket.subject, message.bodyText).sensitive,
      agentMode: inbox?.aiMode === "agent",
    },
  });
}
