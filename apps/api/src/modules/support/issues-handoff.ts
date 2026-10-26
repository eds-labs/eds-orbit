import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { EventSubscription } from "../../platform/events/types.ts";
import { handOff } from "../../platform/handoffs/handoffs.ts";
import { activeLinks, linksOf } from "../../platform/links/links.ts";
import { redact } from "../../platform/privacy/redact.ts";
import { audit, DomainError } from "../../shared.ts";
import { withPlaceholders } from "./ai.ts";
import { ticketEvent } from "./common.ts";
import { supportActive } from "./gate.ts";
import { screenCustomerText } from "./hard-rules.ts";

// Reporting a ticket as a product issue (ADR 0018, WP3.6) and hearing back
// when its fix is released. Support hands the ticket to the issue center's
// `issues.report` target through the platform's handoff registry, so it
// imports nothing of that module. Only text an agent wrote or confirmed
// leaves the ticket, with the contact's name and addresses removed; the
// ticket itself stays as it was. A release leaves an internal note and an
// attention item; the customer hears from an agent, never automatically.

const ISSUE_TYPE = "issues.issue";
const TICKET_TYPE = "support.ticket";
const TARGET = "issues.report";

const previewInput = z.object({ messageIds: z.array(z.uuid()).min(1).max(20) }).strict();
const reportInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    symptoms: z.string().trim().max(4000).default(""),
    type: z.enum(["bug", "feature_request", "improvement", "technical_problem"]).optional(),
    severity: z.enum(["s1_critical", "s2_major", "s3_minor", "s4_trivial"]).optional(),
    components: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).max(20).default([]),
    /** A report on an existing issue instead of a new one. */
    issueId: z.uuid().optional(),
    /** The agent confirmed the text although the ticket touches a sensitive topic. */
    acknowledgeSensitive: z.boolean().default(false),
  })
  .strict();

async function ticketWithContact(tx: DbTx, scope: Scope, id: string) {
  const ticket = await tx.supportTicket.findFirst({ where: { id, projectId: scope.projectId } });
  if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
  if (ticket.mergedIntoTicketId) throw new DomainError("TICKET_MERGED", 409);
  const contact = ticket.contactId
    ? await tx.supportContact.findFirst({ where: { id: ticket.contactId, projectId: scope.projectId } })
    : null;
  return { ticket, contact: contact ?? ({} as { name?: string | null; email?: string | null; claimedEmail?: string | null }) };
}

/** The contact's identity removed: placeholders, then strict redaction. */
function strip(text: string, contact: { name?: string | null; email?: string | null; claimedEmail?: string | null }) {
  const names = contact.name ? [contact.name] : [];
  return redact(withPlaceholders(text, contact), { names });
}

/**
 * The selected messages as an agent would hand them in: customer-visible
 * messages only, identity removed and redacted, with the sensitive topics
 * the hard rules find.
 */
export async function previewIssueReport(tx: DbTx, scope: Scope, ticketId: string, raw: unknown) {
  const input = previewInput.parse(raw);
  const { contact } = await ticketWithContact(tx, scope, ticketId);
  const messages = await tx.supportMessage.findMany({
    where: { projectId: scope.projectId, ticketId, id: { in: input.messageIds }, visibleToCustomer: true },
    orderBy: { createdAt: "asc" },
  });
  const text = messages.map((m) => m.bodyText.trim()).join("\n\n");
  const { text: symptoms, counts } = strip(text, contact);
  return { symptoms: symptoms.slice(0, 4000), redaction: counts, sensitive: screenCustomerText(text).reasons };
}

/**
 * Hands the ticket in as a report. A ticket whose customer messages touch
 * a sensitive topic (hard rules) needs the agent's acknowledgement.
 */
export async function reportTicketAsIssue(tx: DbTx, scope: Scope, ticketId: string, raw: unknown) {
  const input = reportInput.parse(raw);
  const { ticket, contact } = await ticketWithContact(tx, scope, ticketId);
  const customer = await tx.supportMessage.findMany({
    where: { projectId: scope.projectId, ticketId, kind: "customer" },
    select: { bodyText: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const reasons = screenCustomerText([input.title, input.symptoms, ...customer.map((m) => m.bodyText)].join("\n")).reasons;
  if (reasons.length && !input.acknowledgeSensitive)
    throw new DomainError("SUPPORT_ISSUE_SENSITIVE_ACK_REQUIRED", 409);
  const names = [contact.name].filter((n): n is string => Boolean(n));
  const { target } = await handOff(
    tx,
    scope,
    TARGET,
    { type: TICKET_TYPE, id: ticket.id },
    {
      title: strip(input.title, contact).text,
      symptoms: strip(input.symptoms, contact).text,
      type: input.type,
      severity: input.severity,
      components: input.components,
      issueId: input.issueId,
      names,
    },
    { kind: "user", id: scope.userId },
  );
  await audit(tx, scope, "support.ticket.reported_as_issue", ticket.id, {
    ticketId: ticket.id,
    issueId: target.id,
    sensitive: reasons.length > 0,
  });
  return { issueId: target.id };
}

/** The issues a ticket was reported in, as the member may see them. */
export async function ticketIssues(tx: DbTx, scope: Scope, ticketId: string) {
  const links = await linksOf(tx, scope, { type: TICKET_TYPE, id: ticketId });
  return links.filter((l) => l.object.type === ISSUE_TYPE && l.relation === "reported_in");
}

const NOTE = (key: string) =>
  `Fix released to production: ${key}. Please let the customer know.\nFix in Produktion freigegeben: ${key}. Bitte informiere den Kunden.`;

/**
 * An issue's fix reached production (`issues.issue.released`): each ticket
 * it was reported in gets an internal note and an `issue_released` event,
 * which the attention items show until an agent replies. No customer
 * message is sent.
 */
export const issueReleasedSubscriber: EventSubscription = {
  name: "support.issue_released",
  types: ["issues.issue.released"],
  async handler(tx, scope, event) {
    if (!(await supportActive(tx, scope))) return;
    const number = Number(event.data.number);
    const key = Number.isInteger(number) && number > 0 ? `ISS-${number}` : "an issue";
    const links = (await activeLinks(tx, scope, { type: ISSUE_TYPE, id: event.subject.id })).filter(
      (l) => l.relation === "reported_in" && l.targetType === TICKET_TYPE,
    );
    for (const link of links) {
      const ticket = await tx.supportTicket.findFirst({ where: { projectId: scope.projectId, id: link.targetId } });
      if (!ticket) continue;
      // A merged ticket's conversation lives on in its destination.
      const target = ticket.mergedIntoTicketId ?? ticket.id;
      const seen = await tx.supportTicketEvent.findFirst({
        where: { projectId: scope.projectId, ticketId: target, type: "issue_released", after: { path: ["eventId"], equals: event.id } },
      });
      if (seen) continue;
      await tx.supportMessage.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          ticketId: target,
          kind: "system",
          bodyText: NOTE(key),
          channel: "internal",
          visibleToCustomer: false,
        },
      });
      await ticketEvent(tx, scope, {
        ticketId: target,
        type: "issue_released",
        actorKind: "system",
        actorId: null,
        after: { issueId: event.subject.id, number, eventId: event.id },
      });
      await tx.supportTicket.update({ where: { id: target }, data: { updatedAt: new Date() } });
    }
  },
};
