"use client";
import { usd } from "@/lib/api";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";

const names = [
  "support_send_reply",
  "support_add_note",
  "support_update_ticket",
  "support_prepare_reply",
  "support_generate_reply",
];
export const supportDecisionRenderer: ActionRequestRenderer = {
  accepts: (item) => Boolean(item.summary?.operation),
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation;
    const reply = item.actionType === "support.mcp.support_send_reply";
    const titles: Record<string, string> = {
      "support.mcp.support_send_reply": de
        ? "Antwort an Kunden senden"
        : "Send customer reply",
      "support.mcp.support_add_note": de
        ? "Interne Notiz speichern"
        : "Save internal note",
      "support.mcp.support_update_ticket": de
        ? "Ticket ändern"
        : "Update ticket",
      "support.mcp.support_prepare_reply": de
        ? "Antwortentwurf speichern"
        : "Save reply draft",
      "support.mcp.support_generate_reply": de
        ? "KI-Antwortentwurf erstellen"
        : "Generate AI reply draft",
    };
    const destination = op.approvalContext;
    return (
      <article className="action-request">
        <h3>{titles[item.actionType]}</h3>
        {item.costCeilingMicros > 0 && (
          <p>
            {de ? "Höchstkosten" : "Maximum cost"}:{" "}
            {usd(item.costCeilingMicros)}
          </p>
        )}
        <AppLink
          href={`/p/${encodeURIComponent(project.id)}/support/tickets?ticket=${encodeURIComponent(op.ticketId)}`}
        >
          {de ? "Ticket öffnen" : "Open ticket"}
          {destination?.ticketNumber ? ` #${destination.ticketNumber}` : ""}
        </AppLink>
        {destination?.recipient && (
          <p>
            {de ? "Empfänger" : "Recipient"}: {destination.recipient}
          </p>
        )}
        {typeof op.bodyText === "string" && (
          <blockquote
            className="chat-package-draft"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {op.bodyText}
          </blockquote>
        )}
        {!op.bodyText && (
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(op).filter(
                  ([key]) => !["approvalContext", "ticketId"].includes(key),
                ),
              ),
              null,
              2,
            )}
          </pre>
        )}
        <p className="panel-note">
          {reply
            ? de
              ? "Die Freigabe plant diese Nachricht einmalig zum Versand ein."
              : "Approval queues this exact message for delivery once."
            : de
              ? "Die Freigabe führt diese Aktion für das Ticket aus."
              : "Approval executes this action for the ticket."}
        </p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {reply
              ? de
                ? "Antwort senden"
                : "Send reply"
              : de
                ? "Freigeben"
                : "Approve"}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => decide("reject")}
          >
            {de ? "Ablehnen" : "Reject"}
          </Button>
        </div>
      </article>
    );
  },
};
export const supportActionRequests = Object.fromEntries(
  names.map((name) => [`support.mcp.${name}`, supportDecisionRenderer]),
);
