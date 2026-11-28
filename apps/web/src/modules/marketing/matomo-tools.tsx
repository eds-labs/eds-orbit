"use client";
// Matomo report import and schedule (WP2.3b), moved unchanged from components/operator-tools.tsx.
import { useState } from "react";
import { action, ApiError, useMutation, when } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { DataForm, num, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError, useCollection } from "@/platform/ui/collection";
import {
  googleSearchReport,
  matomoReportLabel,
  matomoReports,
} from "./matomo-reports";

export function MatomoImport() {
  const { project, isOwner, refresh, locale } = useWorkspace();
  const de = locale === "de";
  const connectors = useCollection("connectors");
  const [open, setOpen] = useState(false);
  const [emptyImport, setEmptyImport] = useState(false);
  const mutation = useMutation(refresh);
  const available = (connectors.data?.items || []).filter(
    (c) => c.data.provider === "matomo" && c.data.status !== "revoked",
  );
  if (!isOwner) return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setEmptyImport(false);
          mutation.clear();
          setOpen(true);
        }}
      >
        {de ? "Aus Matomo importieren" : "Import from Matomo"}
      </Button>
      {open && (
        <Modal
          title={de ? "Aus Matomo importieren" : "Import from Matomo"}
          description={
            de
              ? "Der Import speichert zusammengefasste Werte. Google-Suchdaten setzen eine in Matomo verbundene Search Console voraus."
              : "The import stores aggregate metrics. Google Search data requires Search Console connected in Matomo."
          }
          onClose={() => setOpen(false)}
        >
          <ResourceError error={connectors.error} retry={connectors.refresh} />
          {emptyImport && (
            <Alert kind="warning">
              {de
                ? "Matomo hat für diesen Bericht und Tag keine Zeilen geliefert. Prüfe bei der Google-Websuche die Search-Console-Verbindung oder wähle einen älteren Tag."
                : "Matomo returned no rows for this report and day. For Google Web Search, check the Search Console connection or choose an earlier day."}
            </Alert>
          )}
          {!available.length ? (
            <Alert kind="warning">
              {de
                ? "Richte zuerst eine Matomo-Verbindung für dieses Projekt ein."
                : "Set up a Matomo connection for this project first."}
            </Alert>
          ) : (
            <DataForm
              fields={[
                {
                  name: "connectorId",
                  label: de ? "Matomo-Verbindung" : "Matomo connection",
                  type: "select",
                  required: true,
                  options: available.map((c) => ({
                    value: c.id,
                    label: String(c.data.baseUrl || c.id),
                  })),
                },
                {
                  name: "siteId",
                  label: de ? "Matomo-Website-ID" : "Matomo site ID",
                  type: "number",
                  required: true,
                  min: 1,
                  value:
                    available.length === 1
                      ? String(available[0]?.data.siteId ?? "")
                      : "",
                },
                {
                  name: "date",
                  label: de ? "Berichtsdatum" : "Report date",
                  required: true,
                  max: 10,
                  placeholder: "YYYY-MM-DD",
                  pattern: "[0-9]{4}-[0-9]{2}-[0-9]{2}",
                },
                {
                  name: "siteTimezone",
                  label: de ? "Zeitzone der Website" : "Matomo site timezone",
                  value: project.timezone,
                  required: true,
                  hint: de
                    ? "Muss der Zeitzone der Website in Matomo entsprechen."
                    : "Must match the reporting site’s timezone.",
                },
                {
                  name: "currency",
                  label: de
                    ? "Berichtswährung (ISO-Code)"
                    : "Reporting currency (ISO code)",
                  required: true,
                  value: "EUR",
                  max: 3,
                },
                {
                  name: "method",
                  label: de ? "Bericht" : "Aggregate report",
                  type: "select",
                  required: true,
                  value: "VisitsSummary.get",
                  options: matomoReports.map((method) => ({
                    value: method,
                    label: matomoReportLabel(method, de),
                  })),
                },
                {
                  name: "goalId",
                  label: de ? "Ziel-ID (optional)" : "Goal ID (optional)",
                  type: "number",
                  min: 1,
                  showWhen: { name: "method", values: ["Goals.get"] },
                },
                {
                  name: "confirm",
                  label: de
                    ? "Bericht aus der verbundenen Matomo-Instanz abrufen"
                    : "Read this aggregate report from the configured instance",
                  type: "checkbox",
                  required: true,
                },
              ]}
              pending={mutation.pending}
              error={mutation.error}
              submitLabel={de ? "Bericht abrufen" : "Read and import report"}
              onSubmit={(v) => {
                setEmptyImport(false);
                return mutation
                  .run(() =>
                    action<{ metricIds: string[] }>(
                      project.id,
                      "import-matomo",
                      {
                        connectorId: str(v, "connectorId"),
                        siteId: num(v, "siteId"),
                        date: str(v, "date"),
                        siteTimezone: str(v, "siteTimezone"),
                        currency: str(v, "currency").toUpperCase(),
                        method: str(v, "method"),
                        ...(str(v, "goalId")
                          ? { goalId: num(v, "goalId") }
                          : {}),
                      },
                    ).catch((error: unknown) => {
                      if (error instanceof ApiError) {
                        if (error.code === "MATOMO_SEARCH_REPORT_UNAVAILABLE")
                          throw new Error(
                            de
                              ? "Matomo stellt den Bericht zur Google-Websuche nicht bereit. Prüfe das Matomo-Plugin, die Search Console und die Leserechte für diese Website."
                              : "Matomo did not provide the Google Web Search report. Check the Matomo plugin, Search Console and read access for this site.",
                          );
                        if (error.code === "MATOMO_REPORT_UNAVAILABLE")
                          throw new Error(
                            de
                              ? "Matomo konnte den Bericht nicht liefern. Prüfe die Verbindung und die Leserechte."
                              : "Matomo could not provide the report. Check the connection and read access.",
                          );
                      }
                      throw error;
                    }),
                  )
                  .then((r) => {
                    if (!r) return;
                    if (r.metricIds.length) setOpen(false);
                    else setEmptyImport(true);
                  });
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
}

export function MatomoSchedule() {
  const { project, isOwner, refresh, locale } = useWorkspace();
  const de = locale === "de";
  const connectors = useCollection("connectors"),
    schedules = useCollection("matomo_schedules");
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  const available = (connectors.data?.items || []).filter(
    (c) => c.data.provider === "matomo" && c.data.status !== "revoked",
  );
  const current = schedules.data?.items[0]?.data as
    Record<string, unknown> | undefined;
  if (!isOwner) return null;
  const methods = Array.isArray(current?.methods)
    ? (current.methods as string[])
    : ["VisitsSummary.get", "Referrers.getCampaigns"];
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {de ? "Automatischer Abruf" : "Scheduled import"}
        {current?.enabled === true && <Badge tone="success">2×/Tag</Badge>}
      </Button>
      {open && (
        <Modal
          title={de ? "Matomo automatisch abrufen" : "Scheduled Matomo import"}
          description={
            de
              ? "Orbit liest zweimal täglich die Website-Berichte für gestern und heute. Für die Google-Websuche werden wegen der verzögerten Daten die letzten sieben abgeschlossenen Tage erneut gelesen."
              : "Orbit reads yesterday’s and today’s website reports twice a day. For Google Web Search, it rechecks the last seven closed days to account for delayed data."
          }
          onClose={() => setOpen(false)}
        >
          {typeof current?.lastRunAt === "string" && (
            <p className="panel-note">
              {de ? "Letzter Abruf" : "Last run"}:{" "}
              {when(current.lastRunAt, locale, project.timezone)}
            </p>
          )}
          {!available.length ? (
            <Alert kind="warning">
              {de
                ? "Richte zuerst eine Matomo-Verbindung ein."
                : "Configure a Matomo connector first."}
            </Alert>
          ) : (
            <DataForm
              fields={[
                {
                  name: "enabled",
                  label: de
                    ? "Automatischer Abruf aktiv"
                    : "Scheduled import on",
                  type: "checkbox",
                  value: current ? current.enabled === true : true,
                },
                {
                  name: "connectorId",
                  label: de ? "Matomo-Verbindung" : "Matomo connection",
                  type: "select",
                  required: true,
                  value: String(current?.connectorId ?? available[0]!.id),
                  options: available.map((c) => ({
                    value: c.id,
                    label: String(c.data.baseUrl || c.id),
                  })),
                },
                {
                  name: "siteId",
                  label: "Matomo site ID",
                  type: "number",
                  required: true,
                  min: 1,
                  value: String(
                    current?.siteId ?? available[0]!.data.siteId ?? "",
                  ),
                },
                {
                  name: "siteTimezone",
                  label: de ? "Zeitzone der Website" : "Site timezone",
                  required: true,
                  value: String(current?.siteTimezone ?? project.timezone),
                },
                {
                  name: "currency",
                  label: de ? "Währung (ISO)" : "Currency (ISO)",
                  required: true,
                  max: 3,
                  value: String(current?.currency ?? "EUR"),
                },
                ...matomoReports.map((method) => ({
                  name: method,
                  label: matomoReportLabel(method, de),
                  hint:
                    method === googleSearchReport
                      ? de
                        ? "Erfordert die in Matomo verbundene Google Search Console."
                        : "Requires Google Search Console connected in Matomo."
                      : undefined,
                  type: "checkbox" as const,
                  value: methods.includes(method),
                })),
              ]}
              pending={mutation.pending}
              error={mutation.error}
              submitLabel={de ? "Speichern" : "Save"}
              onSubmit={(v) =>
                mutation
                  .run(() =>
                    action(project.id, "configure-matomo-schedule", {
                      enabled: v.enabled === true,
                      connectorId: str(v, "connectorId"),
                      siteId: num(v, "siteId"),
                      siteTimezone: str(v, "siteTimezone"),
                      currency: str(v, "currency").toUpperCase(),
                      methods: matomoReports.filter((m) => v[m] === true),
                    }),
                  )
                  .then((r) => {
                    if (r) setOpen(false);
                  })
              }
            />
          )}
        </Modal>
      )}
    </>
  );
}
