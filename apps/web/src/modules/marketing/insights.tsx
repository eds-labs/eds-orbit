"use client";
import { PeriodicReports } from "./reports";
// Marketing analytics and memory views (WP2.3b), moved unchanged from components/management.tsx.
import { RecordDetail } from "@/platform/ui/record-detail";
import { marketingRecordActions } from "./record-actions";
import { useState } from "react";
import { MatomoImport, MatomoSchedule } from "./matomo-tools";
import { BarChart3, Brain, Plus, FlaskConical } from "lucide-react";
import {
  action,
  collectionPath,
  post,
  useMutation,
  value,
  when,
  type Entity,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  Tabs,
} from "@/components/ui/primitives";
import {
  DataForm,
  csv,
  dateField,
  iso,
  num,
  options,
  str,
  type FormField,
  type FormValues,
} from "@/platform/ui/form";
import { MetricCsvImport } from "@/modules/marketing/advanced";
import { useWorkspace } from "@/components/workspace-context";
import { ContentDetail } from "@/modules/marketing/work";
import {
  EntityRows,
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
export function Analytics() {
  const { t, locale, project, canEdit, refresh } = useWorkspace();
  const metrics = useCollection("metrics"),
    insights = useCollection("insights"),
    experiments = useCollection("experiments");
  const [csvImport, setCsvImport] = useState(false),
    [tab, setTab] = useState("metrics"),
    [add, setAdd] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const mutation = useMutation(refresh);
  return (
    <div className="marketing-analytics">
      <PageHead
        title={t("analytics")}
        description={
          locale === "de"
            ? "Messdaten mit Herkunft. Schlussfolgerungen mit Grenzen."
            : "Measured data with provenance. Conclusions with limits."
        }
      >
        {canEdit && (
          <>
            <MatomoImport />
            <MatomoSchedule />
            <Button variant="outline" onClick={() => setCsvImport(true)}>
              Import CSV
            </Button>
            <Button
              variant="outline"
              disabled={mutation.pending || !metrics.data?.items.length}
              onClick={() =>
                mutation.run(() => action(project.id, "analyze", {}))
              }
            >
              <BarChart3 data-icon="inline-start" />
              {locale === "de" ? "Daten auswerten" : "Analyze data"}
            </Button>
            <Button onClick={() => setAdd(true)}>
              <Plus data-icon="inline-start" />
              {tab === "experiments" ? "New experiment" : "Import metrics"}
            </Button>
          </>
        )}
      </PageHead>
      <PeriodicReports />
      <Tabs
        tabs={[
          {
            key: "metrics",
            label: locale === "de" ? "Messdaten" : "Measurements",
          },
          { key: "insights", label: "Insights" },
          {
            key: "experiments",
            label: locale === "de" ? "Experimente" : "Experiments",
          },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Alert>
        {locale === "de"
          ? "Klicks, Sitzungen und Zielaktionen sind verschiedene Größen. Fehlende Werte bleiben unbekannt."
          : "Clicks, sessions and target actions are separate measures. Missing data remains unknown."}
      </Alert>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && (
        <Alert kind="success">
          Analysis saved with its underlying metric references.
        </Alert>
      )}
      <ResourceError
        error={metrics.error || insights.error || experiments.error}
        retry={() => {
          metrics.refresh();
          insights.refresh();
          experiments.refresh();
        }}
      />
      {metrics.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {tab === "metrics" ? (
            metrics.data?.items.length ? (
              <MetricTable items={metrics.data.items} onSelect={setSelected} />
            ) : (
              <Empty
                icon={BarChart3}
                title={
                  locale === "de"
                    ? "Noch keine Messdaten"
                    : "No measurements yet"
                }
                description={
                  locale === "de"
                    ? "Verbinde Matomo oder importiere gekennzeichnete Messwerte."
                    : "Connect Matomo or import measurements with their source and period."
                }
              />
            )
          ) : tab === "insights" ? (
            insights.data?.items.length ? (
              <EntityRows
                items={insights.data.items}
                fields={["title", "status", "createdAt"]}
                onSelect={setSelected}
              />
            ) : (
              <Empty
                icon={Brain}
                title="No evidence-backed insights yet"
                description="Import measurements, then run an analysis."
              />
            )
          ) : experiments.data?.items.length ? (
            <EntityRows
              items={experiments.data.items}
              fields={["name", "primaryMetric", "status", "createdAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={FlaskConical}
              title="Define a question before choosing a winner"
              description="An experiment needs a primary metric, minimum data and a stopping rule."
            />
          )}
        </section>
      )}
      {add && (
        <Modal
          title={
            tab === "experiments" ? "New experiment" : "Import measurements"
          }
          onClose={() => setAdd(false)}
        >
          <DataForm
            fields={
              tab === "experiments"
                ? experimentFields()
                : metricFields(project.timezone)
            }
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={t("save")}
            onCancel={() => setAdd(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  post(
                    collectionPath(
                      project.id,
                      tab === "experiments" ? "experiments" : "metrics",
                    ),
                    tab === "experiments"
                      ? {
                          name: str(v, "name"),
                          hypothesis: str(v, "hypothesis"),
                          variants: csv(v, "variants"),
                          primaryMetric: str(v, "primaryMetric"),
                          minimumSample: num(v, "minimumSample"),
                          startAt: iso(v, "startAt"),
                          endAt: iso(v, "endAt"),
                          stopRule: str(v, "stopRule"),
                        }
                      : {
                          source: str(v, "source"),
                          externalId: str(v, "externalId"),
                          campaign: str(v, "campaign"),
                          periodStart: iso(v, "periodStart"),
                          periodEnd: iso(v, "periodEnd"),
                          timezone: str(v, "timezone"),
                          currency: str(v, "currency"),
                          impressions: nullable(v, "impressions"),
                          clicks: nullable(v, "clicks"),
                          sessions: nullable(v, "sessions"),
                          conversions: nullable(v, "conversions"),
                          costMicros: str(v, "cost")
                            ? Math.round(num(v, "cost") * 1_000_000)
                            : null,
                          sampleSize: num(v, "sampleSize"),
                          synthetic: v.synthetic === true,
                        },
                  ),
                )
                .then((result) => {
                  if (result) setAdd(false);
                })
            }
          />
        </Modal>
      )}
      {csvImport && <MetricCsvImport onClose={() => setCsvImport(false)} />}
      {selected && (
        <RecordDetail
          actions={marketingRecordActions}
          entity={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
function nullable(v: FormValues, key: string) {
  return str(v, key) === "" ? null : num(v, key);
}
function MetricTable({
  items,
  onSelect,
}: {
  items: Entity[];
  onSelect: (e: Entity) => void;
}) {
  const { locale, project } = useWorkspace();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {[
              "Source / campaign",
              "Period",
              "Impressions",
              "Clicks",
              "Sessions",
              "Conversions",
              "Spend",
              "Sample",
            ].map((v) => (
              <th key={v}>{v}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>
                <button className="row-button" onClick={() => onSelect(e)}>
                  {value(e, "source")}
                </button>
                <small>{value(e, "campaign")}</small>
                {e.data.synthetic === true && (
                  <Badge tone="warning">Synthetic</Badge>
                )}
              </td>
              <td>
                {when(e.data.periodStart, locale, project.timezone)}
                <small>
                  {when(e.data.periodEnd, locale, project.timezone)}
                </small>
              </td>
              <td>{value(e, "impressions")}</td>
              <td>{value(e, "clicks")}</td>
              <td>{value(e, "sessions")}</td>
              <td>{value(e, "conversions")}</td>
              <td>
                {e.data.costMicros === null
                  ? "—"
                  : `${Number(e.data.costMicros) / 1e6} ${value(e, "currency")}`}
              </td>
              <td>{value(e, "sampleSize")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function metricFields(timezone: string): FormField[] {
  return [
    {
      name: "source",
      label: "Source",
      type: "select",
      value: "csv",
      options: options(["csv", "matomo", "postiz", "manual_test"]),
    },
    { name: "externalId", label: "Stable source record ID", required: true },
    { name: "campaign", label: "Campaign", required: true },
    dateField("periodStart", "Period start (browser time)"),
    dateField("periodEnd", "Period end (browser time)"),
    {
      name: "timezone",
      label: "Source timezone",
      value: timezone,
      required: true,
    },
    { name: "currency", label: "Currency", required: true, placeholder: "EUR" },
    ...["impressions", "clicks", "sessions", "conversions"].map((name) => ({
      name,
      label: name,
      type: "number" as const,
      min: 0,
      hint: "Leave blank when unavailable.",
    })),
    {
      name: "cost",
      label: "Measured spend",
      type: "number",
      min: 0,
      step: "0.000001",
    },
    {
      name: "sampleSize",
      label: "Sample size",
      type: "number",
      min: 0,
      required: true,
    },
    {
      name: "synthetic",
      label: "These are synthetic test measurements",
      type: "checkbox",
    },
  ];
}
function experimentFields(): FormField[] {
  return [
    { name: "name", label: "Experiment name", required: true },
    {
      name: "hypothesis",
      label: "Hypothesis",
      type: "textarea",
      required: true,
    },
    { name: "variants", label: "Variants (comma separated)", required: true },
    {
      name: "primaryMetric",
      label: "Primary metric",
      type: "select",
      options: options(["clicks", "sessions", "conversions"]),
      required: true,
    },
    {
      name: "minimumSample",
      label: "Minimum sample size",
      type: "number",
      min: 30,
      required: true,
    },
    dateField("startAt", "Starts"),
    dateField("endAt", "Ends"),
    {
      name: "stopRule",
      label: "Stopping rule",
      type: "textarea",
      required: true,
      min: 5,
      hint: "Define this before observing the results.",
    },
  ];
}
export function Memory() {
  const { t, locale, project, canEdit, isOwner, refresh } = useWorkspace();
  const [tab, setTab] = useState("preferences"),
    [add, setAdd] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const preferences = useCollection("preferences"),
    insights = useCollection("insights"),
    history = useCollection("content");
  const mutation = useMutation(refresh);
  const items =
    tab === "preferences"
      ? preferences.data?.items
      : tab === "insights"
        ? insights.data?.items
        : history.data?.items.filter((e) =>
            ["approved", "published", "published_test", "completed"].includes(
              String(e.data.status),
            ),
          );
  return (
    <>
      <PageHead
        title={t("memory")}
        description={
          locale === "de"
            ? "Bewusstes Lernen. Klare Trennung von Fakten und Erfahrung."
            : "Deliberate learning. Facts and experience stay distinct."
        }
      >
        {isOwner && tab === "preferences" && (
          <Button onClick={() => setAdd(true)}>
            <Plus data-icon="inline-start" />
            {locale === "de" ? "Redaktionelle Regel" : "Editorial preference"}
          </Button>
        )}
      </PageHead>
      <Tabs
        tabs={[
          {
            key: "preferences",
            label:
              locale === "de"
                ? "Redaktionelle Regeln"
                : "Editorial preferences",
          },
          {
            key: "history",
            label: locale === "de" ? "Inhaltsverlauf" : "Content history",
          },
          { key: "insights", label: "Performance insights" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Alert>
        {locale === "de"
          ? "Eigene KI-Inhalte gelten nicht als unabhängige Faktenbelege. Memory verändert keine Berechtigungen oder Budgets."
          : "Generated content is never independent factual evidence. Memory cannot change permissions or budgets."}
      </Alert>
      <ResourceError
        error={preferences.error || history.error || insights.error}
        retry={() => {
          preferences.refresh();
          history.refresh();
          insights.refresh();
        }}
      />
      {preferences.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {items?.length ? (
            <EntityRows
              items={items}
              fields={
                tab === "preferences"
                  ? ["name", "status", "updatedAt"]
                  : ["title", "status", "createdAt"]
              }
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={Brain}
              title={
                locale === "de"
                  ? "Wissen, warum etwas funktioniert"
                  : "Remember what works, and why"
              }
              description={
                locale === "de"
                  ? "Bestätigte Regeln und belegte Erkenntnisse erscheinen hier."
                  : "Confirmed preferences and supported observations appear here."
              }
            />
          )}
        </section>
      )}
      {add && (
        <Modal
          title={
            locale === "de" ? "Redaktionelle Regel" : "Editorial preference"
          }
          onClose={() => setAdd(false)}
        >
          <DataForm
            fields={[
              { name: "name", label: t("name"), required: true },
              {
                name: "rule",
                label:
                  locale === "de"
                    ? "Regel oder Korrekturbeispiel"
                    : "Rule or correction example",
                type: "textarea",
                required: true,
              },
              dateField(
                "validUntil",
                locale === "de" ? "Prüfen bis" : "Review by",
              ),
              {
                name: "status",
                label: t("status"),
                type: "select",
                value: "proposed",
                options: options(
                  isOwner ? ["proposed", "confirmed"] : ["proposed"],
                ),
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel={t("save")}
            onCancel={() => setAdd(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  post(collectionPath(project.id, "preferences"), {
                    name: str(v, "name"),
                    rule: str(v, "rule"),
                    validUntil: iso(v, "validUntil"),
                    status: str(v, "status"),
                  }),
                )
                .then((result) => {
                  if (result) setAdd(false);
                })
            }
          />
        </Modal>
      )}
      {selected &&
        (tab === "history" ? (
          <ContentDetail entity={selected} onClose={() => setSelected(null)} />
        ) : (
          <RecordDetail
            actions={marketingRecordActions}
            entity={selected}
            onClose={() => setSelected(null)}
          />
        ))}
    </>
  );
}
