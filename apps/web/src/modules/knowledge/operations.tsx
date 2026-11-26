"use client";

import { useWorkspace } from "@/components/workspace-context";
import { Alert, Badge, Button } from "@/components/ui/primitives";
import { action, useMutation, when } from "@/lib/api";
import { AppLink } from "@/platform/ui/app-link";
import { useShell } from "@/platform/shell/shell-context";
import type { Summary } from "./workspace-parts";
import { knowledgeCopy } from "./workspace-text";
import { WorkspaceError } from "./workspace-parts";

export function KnowledgeOperations({
  data,
  refresh,
  settings = false,
}: {
  data: Summary;
  refresh: () => void;
  settings?: boolean;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const de = locale === "de";
  const ops = data.operations;
  if (!ops) return null;
  const indexIssue = ops.issues.find((issue) => issue.subject === "index");
  const state =
    indexIssue && ops.status?.state !== "refreshing"
      ? "action_required"
      : ops.status?.state;
  const states = {
    current: de ? "Aktuell" : "Current",
    waiting: de ? "Wartet auf Aktualisierung" : "Waiting for refresh",
    refreshing: de ? "Wird aktualisiert" : "Refreshing",
    action_required: de ? "Eingriff nötig" : "Action required",
    manual: de ? "Automatik aus" : "Automatic refresh off",
  };
  const fields = [
    [
      "monitoring",
      de
        ? "Betriebsstatus und Telegram-Problemberichte"
        : "Health overview and Telegram alerts",
    ],
    [
      "reviewExperience",
      de
        ? "Vereinfachter Import und Prüfliste"
        : "Simplified import and reviews",
    ],
    [
      "automation",
      de
        ? "Automatisierte Belegpflege und Quellenabrufe"
        : "Automated evidence maintenance and source refresh",
    ],
  ] as const;
  if (!settings && !ops.monitoring) return null;
  return (
    <section
      className="panel stack-gap"
      aria-label={de ? "Wissensbetrieb" : "Knowledge operations"}
    >
      <h2>{de ? "Wissensbetrieb" : "Knowledge operations"}</h2>
      {state && ops.status && (
        <div role="status">
          <Badge
            tone={
              state === "current"
                ? "success"
                : state === "action_required"
                  ? "danger"
                  : "neutral"
            }
          >
            {states[state]}
          </Badge>
          {ops.status.lastSuccessAt && (
            <p>
              {de ? "Letzte erfolgreiche Prüfung" : "Last successful check"} ·{" "}
              {when(ops.status.lastSuccessAt, locale)}
            </p>
          )}
          {ops.status.nextAttemptAt && state === "waiting" && (
            <p>
              {de ? "Nächster Versuch" : "Next attempt"} ·{" "}
              {when(ops.status.nextAttemptAt, locale)}
            </p>
          )}
          {ops.status.stage && (
            <p>
              {
                (
                  {
                    embedding: de
                      ? "Wissensabschnitte werden verarbeitet."
                      : "Processing knowledge passages.",
                    questions: de
                      ? "Testfragen werden vorbereitet."
                      : "Preparing test questions.",
                    evaluation: de
                      ? "Der Suchindex wird geprüft."
                      : "Checking the search index.",
                  } as Record<string, string>
                )[ops.status.stage]
              }
            </p>
          )}
          {ops.status.marketingBlocked && (
            <p>
              {de
                ? "Neue Marketing-Freigaben warten auf eine gültige Indexprüfung."
                : "New marketing approvals need a valid index check."}
            </p>
          )}
        </div>
      )}
      {ops.issues.map((issue) => (
        <div key={issue.id}>
          <Alert kind="warning">{de ? issue.label.de : issue.label.en}</Alert>
          <p>
            Telegram ·{" "}
            {(
              {
                pending: de ? "wartet" : "pending",
                sent: de ? "zugestellt" : "delivered",
                failed: de ? "fehlgeschlagen" : "failed",
                unknown: de ? "Zustellung unklar" : "delivery uncertain",
                skipped: de ? "übersprungen" : "skipped",
                unavailable: de ? "nicht verbunden" : "unavailable",
              } as Record<string, string>
            )[issue.telegram] ?? issue.telegram}
          </p>
          <AppLink className="text-link" href={issue.href}>
            {de ? "Problem prüfen" : "Check issue"}
          </AppLink>
        </div>
      ))}
      {(ops.pending > 0 || ops.changed > 0) && (
        <AppLink className="text-link" href={shell.hrefOf("knowledge-review")}>
          {de
            ? `${ops.changed} geändert · ${ops.pending} neu`
            : `${ops.changed} changed · ${ops.pending} new`}
        </AppLink>
      )}
      {!settings && isOwner && (
        <AppLink
          className="text-link"
          href={shell.hrefOf("knowledge-health") + "?expert=1"}
        >
          {de ? "Index und Einstellungen ansehen" : "View index and settings"}
        </AppLink>
      )}
      {settings && isOwner && (
        <fieldset className="stack-gap">
          <legend>
            {de ? "Funktionen für dieses Projekt" : "Features for this project"}
          </legend>
          <p>
            {de
              ? "Telegram nutzt den verknüpften privaten Projektbot. Automatische KI-Nutzung und GitHub-Abrufe erfordern eigene Freigaben."
              : "Telegram uses the linked private project bot. Automated AI and GitHub reads require their own approval."}
          </p>
          {fields.map(([key, label]) => (
            <Button
              key={key}
              variant="outline"
              aria-pressed={ops[key]}
              disabled={mutation.pending}
              onClick={() =>
                mutation.run(() =>
                  action(project.id, "knowledge-operations-settings", {
                    [key]: !ops[key],
                  }),
                )
              }
            >
              {label} · {ops[key] ? (de ? "An" : "On") : de ? "Aus" : "Off"}
            </Button>
          ))}
          {mutation.error && (
            <WorkspaceError code={mutation.error} t={knowledgeCopy[locale]} />
          )}
        </fieldset>
      )}
    </section>
  );
}
