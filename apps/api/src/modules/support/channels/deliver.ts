import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { queueEmailMessage } from "./email.ts";
import { visitorOnline } from "../widget.ts";
import { conversationChanged } from "../common.ts";

type TicketRow = Awaited<ReturnType<DbTx["supportTicket"]["findFirstOrThrow"]>>;
type MessageRow = Awaited<
  ReturnType<DbTx["supportMessage"]["findFirstOrThrow"]>
>;

/**
 * Hands a customer-visible message to its ticket's channel, in the caller's
 * transaction. Returns the delivery state the message starts with. The
 * channel jobs send it; nothing here talks to a provider.
 */
export async function deliverMessage(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
  message: MessageRow,
  options: { automatic?: boolean } = {},
): Promise<string> {
  const markSent = async () => {
    await tx.supportMessage.update({
      where: { id: message.id },
      data: { deliveryState: "sent" },
    });
    conversationChanged(tx, scope, ticket.id);
    return "sent";
  };
  if (ticket.channel === "email")
    return queueEmailMessage(tx, scope, ticket, message, options);
  // The widget shows the message at once while the visitor is online;
  // otherwise it falls back to e-mail when the contact has an address.
  if (await visitorOnline(tx, scope, ticket.contactId)) return markSent();
  const contact = await tx.supportContact.findFirst({
    where: { id: ticket.contactId, deletedAt: null },
  });
  const to = contact?.email ?? contact?.claimedEmail;
  if (to) {
    const state = await queueEmailMessage(tx, scope, ticket, message, {
      ...options,
      to,
    });
    if (state === "pending") return state;
  }
  // Nobody to mail: the message waits in the widget for the visitor.
  return markSent();
}
