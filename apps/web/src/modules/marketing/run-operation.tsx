"use client";
import { AppLink } from "@/platform/ui/app-link";
const cost = (micros: number) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);

export type RunOperation = {
  state: string;
  lifecycle: string;
  degraded: boolean;
  complete: boolean;
  costs: {
    settledMicros: number;
    heldMicros: number;
    unknownMicros: number;
    releasedMicros: number;
    complete: boolean;
  };
  issues?: Array<{
    taskId: string;
    stepKey: string;
    status: string;
    code: string;
    optional: boolean;
  }>;
  recovery: Array<{ action: string; href: string }>;
};
const states: Record<string, [string, string]> = {
  planned: ["Planned", "Geplant"],
  running: ["Running", "Läuft"],
  done: ["Completed", "Abgeschlossen"],
  partial: ["Partially completed", "Teilweise abgeschlossen"],
  canceled: ["Canceled", "Abgebrochen"],
  degraded: [
    "Degraded: optional input or deliverable missing",
    "Eingeschränkt: optionale Eingabe oder Ergebnis fehlt",
  ],
  failed: [
    "Failed: required work or delivery failed",
    "Fehlgeschlagen: Pflichtschritt oder Übergabe fehlgeschlagen",
  ],
  blocked: ["Blocked", "Blockiert"],
  awaiting_owner: ["Your approval required", "Deine Freigabe erforderlich"],
  outcome_unknown: [
    "Outcome unknown: reconcile before continuing",
    "Ergebnis unklar: vor dem Fortsetzen abgleichen",
  ],
};
const actions: Record<string, [string, string]> = {
  reconcile_outcome: [
    "Check outcome; do not resend",
    "Ergebnis abgleichen; nicht erneut senden",
  ],
  review_content: ["Review waiting content", "Wartende Inhalte prüfen"],
  inspect_delivery: ["Check delivery blockers", "Übergabeblocker prüfen"],
  inspect_run: [
    "Inspect failed work; retain completed work",
    "Fehler prüfen; erledigte Arbeit behalten",
  ],
  resume_project: ["Check project pause", "Projektpause prüfen"],
};
/** Shared display for live saved evidence; links open existing guarded controls. */
export function RunOperationView({
  operation: o,
  de,
}: {
  operation?: RunOperation;
  de: boolean;
}) {
  if (!o) return null;
  const text = (values: Record<string, [string, string]>, key: string) =>
    values[key]?.[de ? 1 : 0] ?? key;
  return (
    <div className="chat-package-note">
      <p>
        <strong>{text(states, o.state)}</strong> ·{" "}
        {de ? "Ausführung" : "Execution"}: {text(states, o.lifecycle)}
      </p>
      {o.degraded && o.state !== "degraded" && (
        <p>{text(states, "degraded")}</p>
      )}
      <p>
        {de ? "Abgerechnet" : "Settled"}: {cost(o.costs.settledMicros)} ·{" "}
        {de ? "Reserviert" : "Held"}: {cost(o.costs.heldMicros)} ·{" "}
        {de
          ? "Ungeklärte Kosten (reservierter Betrag)"
          : "Unknown cost (reserved exposure)"}
        : {cost(o.costs.unknownMicros)}
      </p>
      {o.issues && o.issues.length > 0 && (
        <ul>
          {o.issues.map((i) => (
            <li key={i.taskId}>
              {i.stepKey}: {i.status} · {i.code}
            </li>
          ))}
        </ul>
      )}
      {!o.complete && (
        <p>
          {de
            ? "Unvollständige Daten; Summen sind nur Teilsummen."
            : "Incomplete evidence; totals are partial."}
        </p>
      )}
      {o.recovery.length > 0 && (
        <ul>
          {o.recovery.map((r) => (
            <li key={r.action}>
              <AppLink href={r.href}>{text(actions, r.action)}</AppLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
