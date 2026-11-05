import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { currentAgentExecution } from "../../platform/agents/agent-execution.ts";
import type { ToolCatalogEntry } from "../../platform/agents/tools/registry.ts";
import { DomainError } from "../../shared.ts";
import { screenTicketText } from "./agent-events.ts";

// The Support side of a configured agent's tool call (ADR 0021 Phase 2,
// plan §2.4): which tickets an agent may touch, and the builder catalogue
// entries of the Support tools offered to agents. Outside an agent call
// every check here is a no-op, so MCP and the assistant behave as before.

/** Whether the call in progress runs for a configured agent. */
export const byAgent = () => currentAgentExecution() !== null;

/**
 * For an agent call: the ticket exists, its inbox is in agent mode, its
 * customer is no unverified widget visitor, and (unless `allowSensitive`)
 * neither its subject nor its latest customer message hits a hard rule.
 */
export async function assertAgentTicket(
  tx: DbTx,
  scope: Scope,
  ticketId: string,
  options: { allowSensitive?: boolean } = {},
) {
  if (!byAgent()) return;
  const ticket = await tx.supportTicket.findFirst({
    where: { id: ticketId, projectId: scope.projectId },
  });
  if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
  const inbox = await tx.supportInbox.findFirst({
    where: { id: ticket.inboxId, projectId: scope.projectId },
    select: { aiMode: true, archivedAt: true },
  });
  if (inbox?.aiMode !== "agent" || inbox.archivedAt)
    throw new DomainError("SUPPORT_AGENT_NOT_ENABLED", 409);
  if (ticket.channel === "widget") {
    const verified = await tx.supportContactIdentity.count({
      where: { contactId: ticket.contactId, channel: "widget" },
    });
    if (!verified) throw new DomainError("SUPPORT_AGENT_NOT_ENABLED", 409);
  }
  if (options.allowSensitive) return ticket;
  const latest = await tx.supportMessage.findFirst({
    where: { projectId: scope.projectId, ticketId, kind: "customer" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { bodyText: true },
  });
  if (screenTicketText(ticket.subject, latest?.bodyText ?? "").sensitive)
    throw new DomainError("SUPPORT_HARD_RULE", 409);
  return ticket;
}

const entry = (
  en: [string, string],
  de: [string, string],
  cost: "none" | "paid" = "none",
): ToolCatalogEntry => ({
  title: { en: en[0], de: de[0] },
  summary: { en: en[1], de: de[1] },
  dataClass: "customer_personal",
  cost,
});

/** Builder catalogue entries of the Support tools agents may use. */
export const SUPPORT_AGENT_CATALOG = {
  getTicket: entry(
    ["Read ticket", "Ticket fields and the first customer message, personal data removed."],
    ["Ticket lesen", "Ticketfelder und erste Kundennachricht, ohne personenbezogene Daten."],
  ),
  listMessages: entry(
    ["Read conversation", "The ticket's messages, personal data removed; internal notes only with the right to read them."],
    ["Verlauf lesen", "Nachrichten des Tickets ohne personenbezogene Daten; interne Notizen nur mit Leserecht."],
  ),
  customerContext: entry(
    ["Customer account", "Plan, features and limits of a verified customer, live from the product."],
    ["Kundenkonto", "Tarif, Funktionen und Limits eines verifizierten Kunden, live aus dem Produkt."],
  ),
  categories: entry(
    ["Ticket categories", "The project's configured Support categories."],
    ["Ticket-Kategorien", "Die konfigurierten Support-Kategorien des Projekts."],
  ),
  tags: entry(
    ["Ticket tags", "The project's configured Support tags."],
    ["Ticket-Tags", "Die konfigurierten Support-Tags des Projekts."],
  ),
  similar: entry(
    ["Similar tickets", "Recent tickets of the inbox with a similar subject or the same category: numbers and status only."],
    ["Ähnliche Tickets", "Neuere Tickets des Postfachs mit ähnlichem Betreff oder gleicher Kategorie: nur Nummern und Status."],
  ),
  triage: entry(
    ["AI triage", "Runs Support's triage: suggests language, category, priority and sentiment. Paid, within the agent's budget."],
    ["KI-Triage", "Führt die Support-Triage aus: schlägt Sprache, Kategorie, Priorität und Stimmung vor. Kostenpflichtig, im Budget des Agenten."],
    "paid",
  ),
  draft: entry(
    ["AI reply draft", "Runs Support's grounded draft with every check; stores a draft for a person or hands off. Paid, within the agent's budget."],
    ["KI-Antwortentwurf", "Führt den belegten Support-Entwurf mit allen Prüfungen aus; speichert einen Entwurf für einen Menschen oder übergibt. Kostenpflichtig, im Budget des Agenten."],
    "paid",
  ),
  applyTriage: entry(
    ["Apply triage", "Proposes priority, category and tags for the ticket; never status or assignee."],
    ["Triage übernehmen", "Schlägt Priorität, Kategorie und Tags für das Ticket vor; nie Status oder Zuständigkeit."],
  ),
  note: entry(
    ["Internal note", "Proposes an internal note, labelled as AI; never visible to the customer."],
    ["Interne Notiz", "Schlägt eine interne Notiz vor, als KI gekennzeichnet; nie für den Kunden sichtbar."],
  ),
  prepareReply: entry(
    ["Reply draft", "Proposes an editable reply draft; it is never sent by this."],
    ["Antwortentwurf", "Schlägt einen bearbeitbaren Antwortentwurf vor; dadurch wird nie etwas gesendet."],
  ),
  updateTicket: entry(
    ["Change ticket", "Proposes status, priority, category, tag or assignee changes; an owner decides, agents never resolve or close."],
    ["Ticket ändern", "Schlägt Status, Priorität, Kategorie, Tags oder Zuständigkeit vor; ein Owner entscheidet, Agenten lösen oder schließen nie."],
  ),
  handOff: entry(
    ["Hand to the team", "Stops automatic AI work on the ticket and tells the team, with a reason."],
    ["An das Team übergeben", "Beendet die automatische KI-Arbeit am Ticket und informiert das Team, mit Grund."],
  ),
  reportIssue: entry(
    ["Report as issue", "Proposes reporting the ticket as a product issue without the customer's identity; sensitive tickets need a person."],
    ["Als Problem melden", "Schlägt vor, das Ticket ohne Kundenidentität als Produktproblem zu melden; sensible Tickets brauchen einen Menschen."],
  ),
  sendReply: entry(
    ["Send reply (proposal)", "Proposes a customer reply; a person always decides it individually, no mandate or inbox setting can."],
    ["Antwort senden (Vorschlag)", "Schlägt eine Kundenantwort vor; ein Mensch entscheidet immer einzeln, kein Mandat und keine Postfachregel."],
  ),
} as const;
