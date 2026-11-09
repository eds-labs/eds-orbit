"use client";
import type { ReactNode } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { Alert } from "@/components/ui/primitives";
import type { Entity } from "@/lib/api";
import type { KnowledgeCopy } from "./workspace-text";

// Shared by the Knowledge pages, so that none of them has to import another.

export type Summary = {
  enabled: boolean;
  profile: Record<string, any>;
  drafts: Entity[];
  runs: Entity[];
  proposals: Entity[];
  facts: Entity[];
  sources: Entity[];
};
export type Preview = {
  id: string;
  commit: string | null;
  partial: boolean;
  skipped: number;
  files: { path: string; characters: number }[];
  characters: number;
  modelRequired: boolean;
};
/** Whether an analysis is still under way, as opposed to having ended. */
export const analysisRunning = (status: string) =>
  ["queued", "analyzing"].includes(status);
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="knowledge-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** The plain sentence for an error or blocker code, in the owner's language. */
export function knowledgeErrorText(
  code: string,
  t: KnowledgeCopy,
  de: boolean,
) {
  // ApiError.message is humanized by the transport; worker errors retain codes.
  const normalizedCode = code.replaceAll(" ", "_");
  const known: Record<string, string> = {
    KNOWLEDGE_OUTPUT_LIMIT: de
      ? "Die Modellantwort wurde am Antwortlimit abgeschnitten. Es wurde kein Wissen übernommen. Erstelle eine neue Vorschau mit weniger Dateien oder passe das Antwortlimit der Analyse-Route an."
      : "The model response reached its output limit. No knowledge was accepted. Preview fewer files or adjust the analysis route's output limit.",
    MODEL_CAPABILITY_NOT_VERIFIED: de
      ? "Die Analyse-Route verwendet ein nicht freigegebenes Modell. Prüfe unter Einstellungen → KI den Standardprovider und die Aufgaben-Routen."
      : "The analysis route uses an unverified model. Check the default provider and task routes under Settings → AI.",
    VERIFIED_PRICE_CONFIGURATION_REQUIRED: de
      ? "Für das ausgewählte Modell fehlt ein aktueller verifizierter Preis. Prüfe die KI-Einstellungen."
      : "The selected model needs a current verified price. Check AI settings.",
    GITHUB_INVALID_PRIVATE_KEY: de
      ? "Füge den vollständigen Inhalt der privaten PEM-Datei ein, einschließlich BEGIN- und END-Zeile. Ein SHA256-Fingerabdruck reicht nicht aus."
      : "Paste the complete private PEM file, including its BEGIN and END lines. A SHA256 fingerprint is not sufficient.",
    KNOWLEDGE_MODEL_NOT_CONFIGURED: de
      ? "Für die KI-Analyse fehlt ein eingerichteter Modellanbieter. Hinterlege den Zugang unter Einstellungen → KI."
      : "AI analysis needs a configured model provider. Add its credentials under Settings → AI.",
    KNOWLEDGE_PREVIEW_EXPIRED: t.previewExpired,
    KNOWLEDGE_ANALYSIS_IN_PROGRESS: de
      ? "Eine KI-Analyse läuft bereits. Warte ihren Abschluss ab und versuche es danach erneut."
      : "An AI analysis is already running. Wait for it to finish, then try again.",
    KNOWLEDGE_FILE_TYPE_UNSUPPORTED: t.fileHint,
    KNOWLEDGE_FILE_SIZE_INVALID: t.fileHint,
    KNOWLEDGE_OUTPUT_INVALID: de
      ? "Die Analyse lieferte keine gültigen Vorschläge. Prüfe die Dateiauswahl und starte eine neue Analyse."
      : "The analysis returned invalid proposals. Review the file selection and start a new analysis.",
    KNOWLEDGE_EVIDENCE_INVALID: de
      ? "Ein Vorschlag konnte nicht durch die angegebenen Textstellen belegt werden. Prüfe die Quelle und starte eine neue Analyse."
      : "A proposal could not be matched to its quoted evidence. Review the source and start a new analysis.",
    VERSION_CONFLICT: de
      ? "Dieser Eintrag wurde inzwischen geändert. Lade die Seite neu und prüfe den aktuellen Stand."
      : "This entry changed. Reload and review the current version.",
    POLICY_REQUIRED: de
      ? "Für KI-Analysen fehlt eine KI-Ausgabenfreigabe. Ein Owner legt sie unter Einstellungen → KI & Budget fest."
      : "AI analysis needs an AI spending authority. An owner sets it under Settings → AI & budget.",
    // The consent is the start button; what remains is a source closed to AI.
    MODEL_USE_FORBIDDEN: de
      ? "KI-Funktionen dürfen diese Inhalte nicht lesen. Erlaube es bei der Quelle oder wähle eine andere Verwendung."
      : "AI features may not read this content. Allow it on the source or choose another use.",
    GITHUB_NOT_CONFIGURED: t.githubSetupHint,
    GITHUB_RECONNECT_REQUIRED: de
      ? "GitHub-Zugriff fehlt oder wurde entzogen. Verbinde dein Konto erneut."
      : "GitHub access is missing or revoked. Reconnect your account.",
    GITHUB_ACCESS_OR_RATE_LIMIT: de
      ? "GitHub verweigert den Abruf oder begrenzt Anfragen. Prüfe die Repository-Freigabe und versuche es später erneut."
      : "GitHub denied access or limited requests. Check repository permissions and try later.",
    KNOWLEDGE_COST_UNKNOWN: de
      ? "Der Modellaufruf hat einen unklaren Ausgang. Prüfe zuerst die Kosten in den Einstellungen; starte keine weitere Analyse."
      : "The model call has an uncertain outcome. Reconcile costs in Settings before another analysis.",
    KNOWLEDGE_NO_READABLE_FILES: de
      ? "Aus deiner Auswahl ließ sich nichts lesen. Wähle andere Seiten oder Dateien aus."
      : "Nothing in your selection could be read. Select other pages or files.",
    KNOWLEDGE_SENSITIVE_TEXT_EXCLUDED: de
      ? "Der Inhalt enthält mögliche Zugangsdaten. Entferne sie vor dem Import."
      : "Content contains possible credentials. Remove them before importing.",
    KNOWLEDGE_EVIDENCE_CHANGED: t.previewExpired,
    KNOWLEDGE_REFRESH_REQUIRED: t.previewExpired,
    KNOWLEDGE_ANALYSIS_FAILED: de
      ? "Die Analyse konnte nicht abgeschlossen werden. Es wurde kein Wissen übernommen. Prüfe die KI-Einstellungen und starte die Analyse erneut."
      : "The analysis could not be completed. No knowledge was accepted. Check AI settings and start the analysis again.",
    KNOWLEDGE_MODEL_REJECTED: de
      ? "Der Modellanbieter hat die Anfrage abgelehnt. Es sind keine Kosten entstanden. Prüfe das Modell unter Einstellungen → KI."
      : "The model provider rejected the request. No cost was incurred. Check the model under Settings → AI.",
    KNOWLEDGE_DEPENDENCY_CHANGED: de
      ? "Projekt, Budgetfreigabe oder KI-Einstellungen wurden während der Analyse geändert. Starte die Analyse erneut."
      : "The project, spending authority or AI settings changed during the analysis. Start the analysis again.",
    KNOWLEDGE_RUN_ACTIVE: de
      ? "Für diese Quelle läuft bereits eine Analyse. Warte ihren Abschluss ab."
      : "An analysis is already running for this source. Wait for it to finish.",
    DOCUMENT_TOO_LARGE: de
      ? "Das Dokument ist zu groß. Erlaubt sind 1 MB und 100.000 Zeichen."
      : "The document is too large. The limits are 1 MB and 100,000 characters.",
    PROJECT_PAUSED: de
      ? "Das Projekt ist pausiert. Setze es fort und starte die Analyse erneut."
      : "The project is paused. Resume it and start the analysis again.",
    KNOWLEDGE_RESTORE_UNAVAILABLE: de
      ? "Diese Aussage lässt sich nicht mehr wiederherstellen, weil ihre Quelle endgültig widerrufen wurde. Analysiere die Quelle neu."
      : "This statement can no longer be restored because its source was revoked for good. Analyze the source again.",
    KNOWLEDGE_NO_PAGES: de
      ? "Es ist keine Seite ausgewählt oder unter dieser Adresse zu finden. Wähle mindestens eine Seite aus."
      : "No page is selected or could be found at this address. Select at least one page.",
    KNOWLEDGE_SITE_ROOT_CHANGED: de
      ? "Diese Quelle ist an eine andere Adresse gebunden. Lege für die neue Adresse eine eigene Quelle an."
      : "This source belongs to a different address. Add a separate source for the new address.",
    KNOWLEDGE_SITE_URL_INVALID: de
      ? "Diese Adresse lässt sich nicht lesen. Gib eine öffentliche Adresse an, die mit https:// beginnt."
      : "This address cannot be read. Enter a public address starting with https://.",
    KNOWLEDGE_SITE_URL_REQUIRED: de
      ? "Gib die Adresse der Website an."
      : "Enter the address of the website.",
    KNOWLEDGE_SOURCE_UNAVAILABLE: de
      ? "Diese Quelle gibt es nicht mehr oder sie ist pausiert. Prüfe sie unter „Quellen“."
      : "This source no longer exists or is paused. Check it under “Sources”.",
    KNOWLEDGE_NO_AUDIENCE: de
      ? "Wähle mindestens Marketing oder Support aus, sonst könnte niemand den Inhalt verwenden."
      : "Select Marketing or Support at least, otherwise nothing could use this content.",
    KNOWLEDGE_TEXT_TOO_LONG: de
      ? "Als eine Aussage geht ein Text nur bis 1.000 Zeichen. Wähle eine andere Verwendung oder kürze ihn."
      : "A single statement can have at most 1,000 characters. Choose another use or shorten the text.",
    POLICY_INTERVAL_INVALID: de
      ? "Der Zeitraum der KI-Ausgabenfreigabe ist ungültig: Das Ende liegt vor dem Beginn. Ein Owner korrigiert ihn unter Einstellungen → KI & Budget."
      : "The period of the AI spending authority is invalid: its end is before its start. An owner corrects it under Settings → AI & budget.",
    CURRENT_PRICE_REQUIRED: de
      ? "Für das ausgewählte Modell ist der hinterlegte Preis nicht mehr aktuell. Aktualisiere ihn unter Einstellungen → KI."
      : "The stored price for the selected model is out of date. Update it under Settings → AI.",
    ROUTE_EFFORT_UNSUPPORTED: de
      ? "Das ausgewählte Modell unterstützt die eingestellte Denkstufe nicht. Passe die Route „Wissensanalyse“ unter Einstellungen → KI an."
      : "The selected model does not support the configured reasoning effort. Adjust the “Knowledge analysis” route under Settings → AI.",
    PAID_MANDATE_EXPIRED: de
      ? "Die KI-Ausgabenfreigabe ist abgelaufen. Ein Owner verlängert sie unter Einstellungen → KI & Budget."
      : "The AI spending authority has expired. An owner renews it under Settings → AI & budget.",
    BUDGET_NOT_APPROVED: de
      ? "Für KI-Ausgaben ist noch kein Budget freigegeben. Ein Owner gibt es unter Einstellungen → KI & Budget frei."
      : "No budget has been approved for AI spending yet. An owner approves it under Settings → AI & budget.",
    BUDGET_EXCEEDED: de
      ? "Das KI-Budget reicht für diese Analyse nicht aus. Erhöhe es unter Einstellungen → KI & Budget oder wähle weniger Inhalte aus."
      : "The AI budget does not cover this analysis. Raise it under Settings → AI & budget or select less content.",
    PROVIDER_BUDGET_STOP: de
      ? "Für diesen Modellanbieter sind die KI-Ausgaben gestoppt. Prüfe das Anbieter-Budget unter Einstellungen → KI & Budget."
      : "AI spending is stopped for this model provider. Check the provider budget under Settings → AI & budget.",
    KNOWLEDGE_EDIT_UNAVAILABLE: de
      ? "Diese Aussage lässt sich gerade nicht bearbeiten, weil sie oder ihre Quelle nicht mehr aktiv ist. Lade die Seite neu."
      : "This statement cannot be edited because it or its source is no longer active. Reload the page.",
  };
  const budget = /BUDGET|COST_ESTIMATE|MODEL_NOT|RATE_CARD/.test(
    normalizedCode,
  );
  return (
    known[normalizedCode] ??
    (budget
      ? de
        ? "Modell oder Budget ist nicht bereit. Prüfe die KI-Einstellungen und die Budgetfreigabe."
        : "The model or budget is not ready. Check AI settings and budget approval."
      : `${t.errorPrefix} ${t.retry}.`)
  );
}

export function WorkspaceError({
  code,
  t,
}: {
  code: string;
  t: KnowledgeCopy;
}) {
  const { locale } = useWorkspace();
  return (
    <Alert kind="error">{knowledgeErrorText(code, t, locale === "de")}</Alert>
  );
}
