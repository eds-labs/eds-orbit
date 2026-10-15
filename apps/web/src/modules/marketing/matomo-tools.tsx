"use client";
// Matomo report import and schedule (WP2.3b), moved unchanged from components/operator-tools.tsx.
import { useState } from "react";
import { action, useMutation, value, when } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { DataForm, num, options, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError, useCollection } from "@/platform/ui/collection";
export function MatomoImport() {
  const { project, isOwner, refresh } = useWorkspace();
  const connectors = useCollection("connectors");
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  const available = (connectors.data?.items || []).filter(
    (c) => c.data.provider === "matomo" && c.data.status !== "revoked",
  );
  if (!isOwner) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Import from Matomo
      </Button>
      {open && (
        <Modal
          title="Import from Matomo"
          description="An authenticated, aggregate-only read from your configured Matomo instance. Raw visitors, user IDs and search terms are not imported."
          onClose={() => setOpen(false)}
        >
          <ResourceError error={connectors.error} retry={connectors.refresh} />
          {!available.length ? (
            <Alert kind="warning">
              Configure a Matomo connector first. Existing CSV and manual
              measurements remain available.
            </Alert>
          ) : (
            <DataForm
              fields={[
                {
                  name: "connectorId",
                  label: "Matomo connection",
                  type: "select",
                  required: true,
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
                },
                {
                  name: "date",
                  label: "Report date (YYYY-MM-DD)",
                  required: true,
                  max: 10,
                  placeholder: "2026-09-01",
                },
                {
                  name: "siteTimezone",
                  label: "Matomo site timezone",
                  value: project.timezone,
                  required: true,
                  hint: "Must match the reporting site's timezone.",
                },
                {
                  name: "currency",
                  label: "Reporting currency (ISO code)",
                  required: true,
                  value: "EUR",
                  max: 3,
                },
                {
                  name: "method",
                  label: "Aggregate report",
                  type: "select",
                  required: true,
                  value: "VisitsSummary.get",
                  options: options([
                    "VisitsSummary.get",
                    "Referrers.getCampaigns",
                    "Actions.getPageUrls",
                    "Goals.get",
                  ]),
                },
                {
                  name: "goalId",
                  label: "Goal ID (optional)",
                  type: "number",
                  min: 1,
                  showWhen: { name: "method", values: ["Goals.get"] },
                },
                {
                  name: "confirm",
                  label:
                    "Read this aggregate report from the configured instance",
                  type: "checkbox",
                  required: true,
                },
              ]}
              pending={mutation.pending}
              error={mutation.error}
              submitLabel="Read and import report"
              onSubmit={(v) =>
                mutation
                  .run(() =>
                    action(project.id, "import-matomo", {
                      connectorId: str(v, "connectorId"),
                      siteId: num(v, "siteId"),
                      date: str(v, "date"),
                      siteTimezone: str(v, "siteTimezone"),
                      currency: str(v, "currency").toUpperCase(),
                      method: str(v, "method"),
                      ...(str(v, "goalId") ? { goalId: num(v, "goalId") } : {}),
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

const matomoReports = [
  "VisitsSummary.get",
  "Referrers.getCampaigns",
  "Actions.getPageUrls",
  "Goals.get",
] as const;
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
              ? "Einmal speichern: Orbit liest danach zweimal täglich die Berichte von gestern und heute. Ein erneutes Lesen korrigiert Werte, es entstehen keine Doppelten."
              : "Save once: Orbit then reads yesterday's and today's reports twice a day. Re-reading corrects values instead of duplicating them."
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
                  label: method,
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
