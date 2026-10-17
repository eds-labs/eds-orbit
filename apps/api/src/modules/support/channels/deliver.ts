import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { queueEmailMessage } from "./email.ts";

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
  if (ticket.channel === "email")
    return queueEmailMessage(tx, scope, ticket, message, options);
  // The widget (WP5.4) reads messages from the timeline; nothing to queue.
  return "pending";
}
