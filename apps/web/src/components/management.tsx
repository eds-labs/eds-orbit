"use client";
import { AgentRuns } from "./agent-runs";
import { GoogleDriveSettings } from "./google-drive";
import { useState } from "react";
import {
  MatomoImport,
  MatomoSchedule,
  PostizVerification,
  WorkspacePause,
} from "./operator-tools";
import { SlackConfiguration, SlackDigest } from "./slack-connection";
import {
  ExperimentControls,
  MemoryLifecycleControls,
  RetentionControl,
  MetricCorrection,
} from "./lifecycle";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  Brain,
  CalendarDays,
  Check,
  CircleCheck,
  Download,
  FileText,
  Link2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Wallet,
  FlaskConical,
} from "lucide-react";
import {
  action,
  collectionPath,
  post,
  useMutation,
  useResource,
  usd,
  value,
  when,
  type Dashboard,
  type Entity,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  Status,
  Tabs,
} from "./ui/primitives";
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
} from "./form";
import {
  BrandApproval,
  MarketingProfileConfiguration,
  MetricCsvImport,
  PreferenceActions,
  ProjectAdministration,
} from "./advanced";
import { useWorkspace } from "./workspace-context";
import {
  ContentDetail,
  EntityRows,
  PageHead,
  ResourceError,
  useCollection,
} from "./work";
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
    <>
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
        <RecordDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
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
          <RecordDetail entity={selected} onClose={() => setSelected(null)} />
        ))}
    </>
  );
}
function PostizChannelAssignment({ connector }: { connector: Entity }) {
  const { project, locale, refresh } = useWorkspace();
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(connector.data.assignedIntegrationIds)
      ? connector.data.assignedIntegrationIds.map(String)
      : [],
  );
  const savedLong = Array.isArray(connector.data.xLongPostIntegrationIds)
    ? connector.data.xLongPostIntegrationIds.map(String)
    : [];
  const [longPosts, setLongPosts] = useState<string[]>(savedLong);
  const savedTimes: Record<string, string> =
    connector.data.postingTimes &&
    typeof connector.data.postingTimes === "object"
      ? (connector.data.postingTimes as Record<string, string>)
      : {};
  const [times, setTimes] = useState<Record<string, string>>(savedTimes);
  const effectiveTimes = Object.fromEntries(
    Object.entries(times).filter(
      ([id, time]) =>
        selected.includes(id) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
    ),
  );
  const mutation = useMutation(refresh);
  const channels = Array.isArray(connector.data.channels)
    ? (connector.data.channels as Record<string, unknown>[])
    : [];
  const assigned = Array.isArray(connector.data.assignedIntegrationIds)
    ? connector.data.assignedIntegrationIds.map(String)
    : [];
  const effectiveLong = longPosts.filter((id) => selected.includes(id));
  const changed =
    JSON.stringify([...selected].sort()) !==
      JSON.stringify([...assigned].sort()) ||
    JSON.stringify([...effectiveLong].sort()) !==
      JSON.stringify([...savedLong].sort()) ||
    JSON.stringify(Object.entries(effectiveTimes).sort()) !==
      JSON.stringify(Object.entries(savedTimes).sort());
  return (
    <div className="postiz-assignment">
      <strong>
        {locale === "de"
          ? `Kanäle für ${project.name}`
          : `Channels for ${project.name}`}
      </strong>
      <p>
        {locale === "de"
          ? "Nur ausdrücklich zugeordnete Konten können für dieses Projekt ausgewählt, verifiziert oder veröffentlicht werden."
          : "Only explicitly assigned accounts can be selected, verified, or published for this project."}
      </p>
      {channels.map((channel) => {
        const id = String(channel.id);
        return (
          <div key={id} className="postiz-assignment-channel">
            <label>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                disabled={Boolean(channel.disabled) || mutation.pending}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, id]
                      : current.filter((value) => value !== id),
                  )
                }
              />
              <span>
                {String(channel.name || id)} ·{" "}
                {String(channel.identifier || "unknown")} <small>({id})</small>
              </span>
            </label>
            {selected.includes(id) && (
              <label className="postiz-assignment-option">
                <span>
                  {locale === "de"
                    ? "Feste Uhrzeit pro Tag"
                    : "Daily posting time"}
                </span>
                <input
                  type="time"
                  value={times[id] ?? ""}
                  disabled={mutation.pending}
                  onChange={(event) =>
                    setTimes((current) => {
                      const next = { ...current };
                      if (event.target.value) next[id] = event.target.value;
                      else delete next[id];
                      return next;
                    })
                  }
                />
              </label>
            )}
            {channel.identifier === "x" && selected.includes(id) && (
              <label className="postiz-assignment-option">
                <input
                  type="checkbox"
                  checked={longPosts.includes(id)}
                  disabled={mutation.pending}
                  onChange={(event) =>
                    setLongPosts((current) =>
                      event.target.checked
                        ? [...current, id]
                        : current.filter((value) => value !== id),
                    )
                  }
                />
                <span>
                  {locale === "de"
                    ? "X Premium: lange Posts (bis 4.000 Zeichen)"
                    : "X Premium: long posts (up to 4,000 characters)"}
                </span>
              </label>
            )}
          </div>
        );
      })}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || mutation.pending}
        onClick={() =>
          mutation.run(() =>
            action(project.id, "postiz-assign-channels", {
              connectorId: connector.id,
              version: connector.version,
              integrationIds: selected,
              xLongPostIntegrationIds: effectiveLong,
              postingTimes: effectiveTimes,
            }),
          )
        }
      >
        {locale === "de" ? "Zuordnung speichern" : "Save assignment"}
      </Button>
    </div>
  );
}

export function Connectors() {
  const { t, locale, project, isOwner, refresh } = useWorkspace();
  const resource = useCollection("connectors");
  const [configure, setConfigure] = useState<string | null>(null);
  const mutation = useMutation(refresh);
  const providers = [
    {
      id: "postiz",
      name: "Postiz",
      description: "Social scheduling and publication reconciliation",
      capability: "Publish / reconcile",
    },
    {
      id: "matomo",
      name: "Matomo",
      description: "Website sessions and target actions",
      capability: "Read analytics",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Exceptions and accountable decisions",
      capability: "Notify / receive actions",
    },
  ];
  return (
    <>
      <PageHead
        title={t("connectors")}
        description={
          locale === "de"
            ? "Verbindungen mit überprüfbaren Fähigkeiten."
            : "Connections with capabilities you can verify."
        }
      />
      <Alert>
        {locale === "de"
          ? "Codex- und ChatGPT-Verbindungen stellen dieser Installation keine Zugangsdaten bereit."
          : "Codex and ChatGPT connections do not provide credentials to this installation."}
      </Alert>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <div className="connector-list">
          {providers.map((p) => {
            const e = resource.data?.items.find(
              (e) => e.data.provider === p.id && e.data.status !== "revoked",
            );
            return (
              <section className="connector" key={p.id}>
                <div className="connector-mark">
                  <Link2 />
                </div>
                <div className="connector-body">
                  <h2>{p.name}</h2>
                  <p>{p.description}</p>
                  <div className="detail-summary">
                    <Status
                      value={
                        e?.data.state || e?.data.status || "not_configured"
                      }
                    />
                    <span>{p.capability}</span>
                  </div>
                  {p.id === "slack" && (
                    <p>
                      Configuration alone does not prove delivery or signed
                      inbound actions.
                    </p>
                  )}
                  {e && (
                    <>
                      <small>
                        Last checked:{" "}
                        {when(
                          e.data.verifiedAt || e.data.lastCheckedAt,
                          locale,
                          project.timezone,
                        )}
                      </small>
                      {Array.isArray(e.data.blockers) && (
                        <p>{e.data.blockers.join(" · ")}</p>
                      )}
                      {p.id === "postiz" && (
                        <div className="connector-details">
                          <p>
                            <strong>API:</strong>{" "}
                            {String(e.data.baseUrl || "Not configured")}
                          </p>
                          <p>
                            <strong>Secret:</strong> Configured via server
                            storage
                          </p>
                          {Array.isArray(e.data.groups) &&
                            e.data.groups.length > 0 && (
                              <p>
                                <strong>Groups:</strong>{" "}
                                {e.data.groups
                                  .map((group: any) =>
                                    String(group.name || group.id),
                                  )
                                  .join(", ")}
                              </p>
                            )}
                          {Array.isArray(e.data.channels) &&
                          e.data.channels.length > 0 ? (
                            <ul aria-label="Connected Postiz channels">
                              {e.data.channels.map((channel: any) => (
                                <li key={String(channel.id)}>
                                  <strong>
                                    {String(channel.name || channel.id)}
                                  </strong>{" "}
                                  · {String(channel.identifier || "unknown")} ·{" "}
                                  {channel.disabled
                                    ? "Disconnected"
                                    : Array.isArray(
                                          e.data.assignedIntegrationIds,
                                        ) &&
                                        e.data.assignedIntegrationIds.includes(
                                          channel.id,
                                        )
                                      ? `Assigned to ${project.name}`
                                      : "Not assigned"}{" "}
                                  <small>({String(channel.id)})</small>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>No connected channels loaded.</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="connector-actions">
                  {isOwner && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => setConfigure(p.id)}
                      >
                        {e ? "Update connection" : "Configure"}
                      </Button>
                      {e &&
                        p.id === "slack" &&
                        e.data.confirmChannelMandate === true && (
                          <SlackDigest entity={e} />
                        )}
                      {e && p.id === "postiz" && (
                        <>
                          <PostizChannelAssignment
                            key={`${e.id}:${e.version}`}
                            connector={e}
                          />
                          <PostizVerification connector={e} />
                        </>
                      )}
                      {e && p.id !== "slack" && (
                        <Button
                          variant="ghost"
                          disabled={mutation.pending}
                          onClick={() =>
                            mutation.run(() =>
                              action(project.id, "connector-health", {
                                connectorId: e.id,
                              }),
                            )
                          }
                        >
                          <RefreshCw data-icon="inline-start" />
                          {p.id === "postiz"
                            ? "Test connection / refresh channels"
                            : "Check capabilities"}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </section>
            );
          })}
          <section className="connector">
            <div className="connector-mark">
              <FileText />
            </div>
            <div className="connector-body">
              <h2>Blog / file export</h2>
              <p>Reviewable Markdown packages for your website repository.</p>
              <div className="detail-summary">
                <Badge tone="blue">draft ready</Badge>
                <span>
                  Export only · deployment requires separate authorization
                </span>
              </div>
            </div>
            <Button asChild variant="outline">
              <Link href="/content">Open content</Link>
            </Button>
          </section>
          <section className="connector">
            <div className="connector-mark">
              <Wallet />
            </div>
            <div className="connector-body">
              <h2>Newsletter & ads</h2>
              <p>Drafts, variants and measurement imports are available.</p>
              <div className="detail-summary">
                <Badge>not configured</Badge>
                <span>
                  Live delivery and ad activation require a verified provider.
                </span>
              </div>
            </div>
            <Button asChild variant="outline">
              <Link href="/content">Open drafts</Link>
            </Button>
          </section>
        </div>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && (
        <Alert kind="success">
          Capability check recorded. Review the returned readiness state.
        </Alert>
      )}
      {configure === "slack" && (
        <SlackConfiguration onClose={() => setConfigure(null)} />
      )}
      {configure && configure !== "slack" && (
        <Modal
          title={`Connect ${configure}`}
          description="Credentials are sent to your own server and encrypted at rest. They are never returned to this screen."
          onClose={() => setConfigure(null)}
        >
          <DataForm
            fields={[
              {
                name: "baseUrl",
                label: "Service URL",
                type: "url",
                required: true,
              },
              {
                name: "credential",
                label: "Credential",
                type: "password",
                required: true,
              },
              ...(configure === "matomo"
                ? [{ name: "siteId", label: "Matomo site ID", required: true }]
                : []),
            ]}
            pending={mutation.pending}
            error={mutation.error}
            t={t}
            submitLabel="Save connection"
            onCancel={() => setConfigure(null)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "connector", {
                    provider: configure,
                    credential: String(v.credential),
                    ...(str(v, "baseUrl")
                      ? { baseUrl: str(v, "baseUrl") }
                      : {}),
                    ...(str(v, "siteId") ? { siteId: str(v, "siteId") } : {}),
                    ...(str(v, "channelId")
                      ? { channelId: str(v, "channelId") }
                      : {}),
                  }),
                )
                .then((result) => {
                  if (result) setConfigure(null);
                })
            }
          />
        </Modal>
      )}
    </>
  );
}
export function Operations() {
  const { t, locale, project, revision, isOwner, canEdit, refresh } =
    useWorkspace();
  const resource = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const jobs = useCollection("jobs");
  const runtime = useResource<{
    runtime: {
      worker: string;
      lastHeartbeat: string | null;
      queues: string[];
      observedAt: string;
    };
    pendingOutbox: number;
    connectorStates: Entity[];
    exceptions: Entity[];
  }>(collectionPath(project.id, `operations?revision=${revision}`));
  const [selected, setSelected] = useState<Entity | null>(null);
  const mutation = useMutation(refresh);
  const d = resource.data;
  return (
    <>
      <PageHead
        title={t("operations")}
        description={
          locale === "de"
            ? "Tatsächliche Läufe, klare Grenzen und kontrollierter Wiederanlauf."
            : "Actual runs, clear limits and controlled recovery."
        }
      >
        <WorkspacePause />
        <Button
          variant="outline"
          onClick={() => {
            resource.refresh();
            jobs.refresh();
            runtime.refresh();
          }}
        >
          <RefreshCw data-icon="inline-start" />
          {locale === "de" ? "Aktualisieren" : "Refresh"}
        </Button>
        {isOwner && (
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(() =>
                action(project.id, "pause", { paused: !d?.project.paused }),
              )
            }
          >
            <Pause data-icon="inline-start" />
            {d?.project.paused ? t("resume") : t("pause")}
          </Button>
        )}
      </PageHead>
      <ResourceError
        error={resource.error || jobs.error || runtime.error}
        retry={() => {
          resource.refresh();
          jobs.refresh();
          runtime.refresh();
        }}
      />
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && <Alert kind="success">Project state updated.</Alert>}
      {resource.loading ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="operations-band">
              <div>
                <span>Project execution</span>
                <Status value={d.project.paused ? "paused" : d.project.mode} />
              </div>
              <div>
                <span>Readiness</span>
                <Status value={d.readiness.state} />
              </div>
              <div>
                <span>Spend</span>
                <strong>{usd(d.budget.spentMicros)}</strong>
              </div>
              <div>
                <span>Reserved</span>
                <strong>{usd(d.budget.reservedMicros)}</strong>
              </div>
            </div>
            {runtime.data && (
              <section className="panel administration-panel">
                <div className="panel-head">
                  <div>
                    <h2>Worker and dispatch</h2>
                    <p>
                      Last observed{" "}
                      {when(
                        runtime.data.runtime.observedAt,
                        locale,
                        project.timezone,
                      )}
                    </p>
                  </div>
                  <Status value={runtime.data.runtime.worker} />
                </div>
                <dl className="detail-grid">
                  <dt>Worker heartbeat</dt>
                  <dd>
                    {when(
                      runtime.data.runtime.lastHeartbeat,
                      locale,
                      project.timezone,
                    )}
                  </dd>
                  <dt>Pending outbox</dt>
                  <dd>{runtime.data.pendingOutbox}</dd>
                  <dt>Queue classes</dt>
                  <dd>{runtime.data.runtime.queues.join(", ") || "—"}</dd>
                </dl>
                {runtime.data.runtime.worker !== "ready" && (
                  <Alert kind="warning">
                    The worker heartbeat is unavailable. Queued work is not
                    evidence of execution.
                  </Alert>
                )}
              </section>
            )}
            {d.readiness.blockers.length > 0 && (
              <Alert kind="warning">
                <strong>Required configuration</strong>
                <ul>
                  {d.readiness.blockers.map((s) => (
                    <li key={s}>{s.replaceAll("_", " ")}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <AgentRuns />
            <section className="panel">
              <div className="panel-head">
                <h2>Persistent jobs</h2>
                <Badge>{jobs.data?.items.length ?? "—"}</Badge>
              </div>
              {jobs.data?.items.length ? (
                <EntityRows
                  items={jobs.data.items}
                  fields={["topic", "resourceId", "status", "updatedAt"]}
                  onSelect={setSelected}
                />
              ) : (
                <Empty
                  icon={Activity}
                  title={locale === "de" ? "Noch keine Läufe" : "No runs yet"}
                  description={
                    locale === "de"
                      ? "Hier erscheinen persistente Jobs und ihr tatsächlicher Zustand."
                      : "Persistent jobs and their actual status will appear here."
                  }
                />
              )}
            </section>
          </>
        )
      )}
      {selected && (
        <Modal
          title={value(selected, "title", value(selected, "type", "Job"))}
          onClose={() => setSelected(null)}
        >
          <Status value={selected.data.status} />
          <dl className="detail-grid">
            {[
              "type",
              "attempts",
              "maxAttempts",
              "lastError",
              "createdAt",
              "completedAt",
            ].map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value(selected, key)}</dd>
              </div>
            ))}
          </dl>
          {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
          {canEdit &&
            ["failed", "blocked_dependency"].includes(
              String(selected.data.status),
            ) && (
              <div className="form-actions">
                <Button
                  disabled={mutation.pending}
                  onClick={() =>
                    mutation
                      .run(() =>
                        action(project.id, "retry", { jobId: selected.id }),
                      )
                      .then((result) => {
                        if (result) setSelected(null);
                      })
                  }
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry within limits
                </Button>
              </div>
            )}
        </Modal>
      )}
    </>
  );
}
export function ProjectSettings() {
  const { t, locale, project, revision, isOwner, identity, refresh } =
    useWorkspace();
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const policies = useCollection("policies");
  const [policy, setPolicy] = useState(false),
    [openAi, setOpenAi] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null),
    [tab, setTab] = useState("project");
  const d = dashboard.data;
  const de = locale === "de";
  return (
    <>
      <PageHead
        title={t("settings")}
        description={
          de
            ? "Dein Workspace. Deine Regeln."
            : "Your workspace. Your boundaries."
        }
      />
      <Tabs
        tabs={[
          { key: "project", label: de ? "Projekt" : "Project" },
          { key: "autopilot", label: "Autopilot" },
          {
            key: "policy",
            label: de ? "Richtlinie & Budget" : "Policy & budget",
          },
          { key: "brand", label: de ? "Marke" : "Brand" },
          { key: "integrations", label: de ? "Integrationen" : "Integrations" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <ResourceError
        error={dashboard.error || policies.error}
        retry={() => {
          dashboard.refresh();
          policies.refresh();
        }}
      />
      {tab === "project" && (
        <div className="settings-grid">
          <section className="panel">
            <div className="panel-head">
              <h2>{t("project")}</h2>
              <Badge>{project.role || "member"}</Badge>
            </div>
            <dl className="detail-grid">
              <dt>{t("name")}</dt>
              <dd>{project.name}</dd>
              <dt>{t("timezone")}</dt>
              <dd>{project.timezone}</dd>
              <dt>Content language</dt>
              <dd>{project.language.toUpperCase()}</dd>
              <dt>Signed in as</dt>
              <dd>
                {identity.user.name}
                <small>{identity.user.email}</small>
              </dd>
              <dt>Mode</dt>
              <dd>
                <Status value={d?.project.mode || project.mode} />
              </dd>
            </dl>
            <Button asChild variant="outline">
              <a href={`/api${collectionPath(project.id, "export")}`} download>
                <Download data-icon="inline-start" />
                {t("export")} project
              </a>
            </Button>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>
                {locale === "de"
                  ? "Autopilot-Bereitschaft"
                  : "Autopilot readiness"}
              </h2>
              {d && <Status value={d.readiness.state} />}
            </div>
            {d?.readiness.blockers.length ? (
              <ul className="checklist">
                {d.readiness.blockers.map((s) => (
                  <li key={s}>
                    <span className="checklist-dot" />
                    {s.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel-note">
                {dashboard.loading
                  ? "Checking…"
                  : "Readiness is scoped to verified capabilities."}
              </p>
            )}
            {d?.readiness.capabilities && (
              <div className="capability-readiness">
                {Object.entries(d.readiness.capabilities).map(
                  ([name, capability]) => (
                    <div className="data-row" key={name}>
                      <div>
                        <strong>
                          {name.charAt(0).toUpperCase() + name.slice(1)}
                        </strong>
                        {capability.liveBlocker && (
                          <p>{capability.liveBlocker.replaceAll("_", " ")}</p>
                        )}
                      </div>
                      <Status value={capability.state} />
                    </div>
                  ),
                )}
              </div>
            )}
            <div className="setup-links">
              <Link href="/knowledge">
                <BookOpenIcon />
                Add source rights and verified facts
              </Link>
              <Link href="/connectors">
                <Link2 />
                Verify connector capabilities
              </Link>
              <button onClick={() => setPolicy(true)} disabled={!isOwner}>
                <Wallet />
                Set budget and routine boundaries
              </button>
              <button onClick={() => setOpenAi(true)} disabled={!isOwner}>
                <Brain />
                Configure OpenAI
              </button>
            </div>
          </section>
        </div>
      )}
      {tab === "project" && <ProjectAdministration />}
      {tab === "autopilot" && <AutopilotSettings />}
      {tab === "policy" && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>
                {locale === "de"
                  ? "Versionierte Betriebsrichtlinie"
                  : "Versioned operating policy"}
              </h2>
              <p>
                {locale === "de"
                  ? "Ein Mandat ist konkret, zeitlich begrenzt und überprüfbar."
                  : "A mandate is specific, time-bounded and verifiable."}
              </p>
            </div>
            {isOwner && (
              <Button onClick={() => setPolicy(true)}>
                <Plus data-icon="inline-start" />
                New policy version
              </Button>
            )}
          </div>
          {policies.data?.items.length ? (
            <EntityRows
              items={policies.data.items}
              fields={["mode", "status", "createdAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={ShieldCheck}
              title="Observe is the safe starting point"
              description="No publishing mandate or paid model budget has been configured."
            />
          )}
        </section>
      )}
      {tab === "policy" && <RetentionControl />}
      {tab === "brand" && <BrandApproval />}
      {tab === "brand" && <MarketingProfileConfiguration />}
      {tab === "integrations" && <GoogleDriveSettings />}
      {tab === "integrations" && (
        <section className="panel">
          <div className="panel-head">
            <h2>OpenAI</h2>
            {isOwner && (
              <Button variant="outline" onClick={() => setOpenAi(true)}>
                <Brain data-icon="inline-start" />
                {de ? "Konfigurieren" : "Configure"}
              </Button>
            )}
          </div>
          <p className="panel-note">
            {de
              ? "Zugangsdaten, verifizierte Modelle und aktuelle Preise. Budgets bleiben Teil der Richtlinie."
              : "Credentials, verified models and current prices. Budgets stay part of the policy."}
          </p>
        </section>
      )}
      {policy && <PolicyEditor onClose={() => setPolicy(false)} />}
      {openAi && <OpenAiConfiguration onClose={() => setOpenAi(false)} />}
      {selected && (
        <RecordDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
const weekdays = {
  de: [
    "Sonntag",
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
  ],
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
};
function AutopilotSettings() {
  const { locale, project, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const settings = useCollection("autopilot_settings"),
    connectors = useCollection("connectors"),
    facts = useCollection("facts"),
    assets = useCollection("assets");
  const current = settings.data?.items[0]?.data as
    Record<string, unknown> | undefined;
  const connector = connectors.data?.items.find(
    (c) => c.data.provider === "postiz",
  );
  const assigned = new Set(
    Array.isArray(connector?.data.assignedIntegrationIds)
      ? connector.data.assignedIntegrationIds.map(String)
      : [],
  );
  const postingTimes = (connector?.data.postingTimes ?? {}) as Record<
    string,
    string
  >;
  const channels = (
    Array.isArray(connector?.data.channels) ? connector.data.channels : []
  ).filter((ch: Record<string, unknown>) => assigned.has(String(ch.id)));
  const factOptions = (facts.data?.items ?? []).filter(
    (f) =>
      f.data.status === "verified" &&
      f.data.publicUse === true &&
      f.data.valueType !== "url",
  );
  const assetOptions = (assets.data?.items ?? []).filter(
    (a) => a.data.usageApproved === true,
  );
  const [form, setForm] = useState<{
    enabled: boolean;
    channels: string[];
    factKeys: string[];
    assetIds: string[];
    planWeekday: number;
    planTime: string;
    startDate?: string;
  } | null>(null);
  const values = form ?? {
    enabled: current?.enabled === true,
    channels: Array.isArray(current?.channels)
      ? (current.channels as string[])
      : channels.map((ch: Record<string, unknown>) => String(ch.id)),
    factKeys: Array.isArray(current?.factKeys)
      ? (current.factKeys as string[])
      : factOptions.map((f) => String(f.data.key)),
    assetIds: Array.isArray(current?.assetIds)
      ? (current.assetIds as string[])
      : assetOptions.slice(0, 1).map((a) => a.id),
    planWeekday:
      typeof current?.planWeekday === "number" ? current.planWeekday : 0,
    planTime:
      typeof current?.planTime === "string" ? current.planTime : "12:00",
    ...(typeof current?.startDate === "string"
      ? { startDate: current.startDate }
      : {}),
  };
  const set = (patch: Partial<typeof values>) =>
    setForm({ ...values, ...patch });
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((v) => v !== id);
  const mutation = useMutation(() => {
    setForm(null);
    refresh();
  });
  if (settings.loading || connectors.loading || facts.loading)
    return <Loading />;
  return (
    <section className="panel autopilot-settings">
      <div className="panel-head">
        <div>
          <h2>Autopilot</h2>
          <p>
            {de
              ? "Orbit plant jede Woche einen Post pro Kanal und Tag zur festen Uhrzeit. Reine Fakten-Posts gehen nach bestandener Prüfung automatisch raus, Posts mit Werbetext warten auf deine Freigabe unter „Freigaben“."
              : "Orbit plans one post per channel and day at its fixed time every week. Fact-only posts go out after passing review; posts with marketing copy wait for your approval in Approvals."}
          </p>
        </div>
        <Status value={current?.enabled === true ? "enabled" : "disabled"} />
      </div>
      {project.mode !== "autopilot" && (
        <Alert kind="warning">
          {de
            ? "Der Autopilot plant erst, wenn die aktive Richtlinie im Modus „autopilot“ ist."
            : "Autopilot only plans while the active policy is in autopilot mode."}
        </Alert>
      )}
      <label className="review-confirm">
        <input
          type="checkbox"
          checked={values.enabled}
          disabled={!isOwner}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>{de ? "Autopilot aktiv" : "Autopilot enabled"}</span>
      </label>
      <fieldset className="autopilot-group">
        <legend>{de ? "Kanäle" : "Channels"}</legend>
        {channels.map((ch: Record<string, unknown>) => {
          const id = String(ch.id);
          return (
            <label key={id}>
              <input
                type="checkbox"
                checked={values.channels.includes(id)}
                disabled={!isOwner}
                onChange={(e) =>
                  set({
                    channels: toggle(values.channels, id, e.target.checked),
                  })
                }
              />
              <span>
                {String(ch.name)} · {String(ch.identifier)} ·{" "}
                {postingTimes[id]
                  ? `${de ? "täglich" : "daily"} ${postingTimes[id]}`
                  : de
                    ? "keine Uhrzeit (unter Verbindungen festlegen)"
                    : "no time (set it under Connections)"}
              </span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="autopilot-group">
        <legend>{de ? "Fakten im Wechsel" : "Rotating facts"}</legend>
        {factOptions.map((f) => {
          const key = String(f.data.key);
          return (
            <label key={f.id}>
              <input
                type="checkbox"
                checked={values.factKeys.includes(key)}
                disabled={!isOwner}
                onChange={(e) =>
                  set({
                    factKeys: toggle(values.factKeys, key, e.target.checked),
                  })
                }
              />
              <span>
                <strong>{key}</strong> — {String(f.data.value).slice(0, 120)}
              </span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="autopilot-group">
        <legend>{de ? "Bild" : "Image"}</legend>
        {assetOptions.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              checked={values.assetIds.includes(a.id)}
              disabled={!isOwner}
              onChange={(e) =>
                set({
                  assetIds: toggle(values.assetIds, a.id, e.target.checked),
                })
              }
            />
            <span>{value(a, "name", value(a, "title", a.id))}</span>
          </label>
        ))}
      </fieldset>
      <div className="autopilot-plan">
        <label>
          <span>{de ? "Wochenplanung am" : "Plan the week on"}</span>
          <select
            value={values.planWeekday}
            disabled={!isOwner}
            onChange={(e) => set({ planWeekday: Number(e.target.value) })}
          >
            {weekdays[de ? "de" : "en"].map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{de ? "Planen ab" : "Plan from"}</span>
          <input
            type="date"
            value={values.startDate ?? ""}
            disabled={!isOwner}
            onChange={(e) => {
              const { startDate: _drop, ...rest } = values;
              setForm(
                e.target.value ? { ...rest, startDate: e.target.value } : rest,
              );
            }}
          />
        </label>
        <label>
          <span>{de ? "um" : "at"}</span>
          <input
            type="time"
            value={values.planTime}
            disabled={!isOwner}
            onChange={(e) => set({ planTime: e.target.value })}
          />
        </label>
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {isOwner && (
        <Button
          disabled={mutation.pending || !form}
          onClick={() =>
            mutation.run(() =>
              action(project.id, "configure-autopilot", values),
            )
          }
        >
          {de ? "Speichern" : "Save"}
        </Button>
      )}
    </section>
  );
}
const BookOpenIcon = FileText;
type OpenAiConfigurationView = {
  configured: boolean;
  source: "orbit" | "environment" | "none";
  textKeyConfigured: boolean;
  imageKeyConfigured: boolean;
  dedicatedImageKeyConfigured: boolean;
  verifiedModels: string[];
  rateCard: Record<
    string,
    {
      inputMicrosPerMillion: number;
      outputMicrosPerMillion: number;
      cachedInputMicrosPerMillion?: number;
      cacheWriteMicrosPerMillion?: number;
      verifiedAt: string;
    }
  >;
  modelRoutes: {
    fast: string;
    standard: string;
    quality: string;
    escalation: string;
  };
  imageGeneration: {
    model: string;
    maxCostMicrosPerImage: number;
    pricingVerifiedAt?: string;
  };
  taskRoutes?: Partial<Record<TaskClass, StoredTaskRoute>>;
  effectiveRoutes?: Partial<
    Record<
      TaskClass,
      | (StoredTaskRoute & { price?: "current" | "missing" })
      | { error: "MODEL_CAPABILITY_NOT_VERIFIED" }
    >
  >;
  routeVersion?: number | null;
  updatedAt?: string;
};
const taskClasses = [
  { id: "chat_operator", label: "Chat operator", defaultTokens: 3000 },
  { id: "draft_social", label: "Social drafts", defaultTokens: 1800 },
  { id: "draft_blog", label: "Blog drafts", defaultTokens: 1800 },
  { id: "agent_strategy", label: "Agent strategy", defaultTokens: 1800 },
  { id: "agent_research", label: "Agent research", defaultTokens: 1800 },
  { id: "agent_analytics", label: "Agent analytics", defaultTokens: 1800 },
  { id: "agent_review", label: "Agent review", defaultTokens: 1800 },
] as const;
type TaskClass = (typeof taskClasses)[number]["id"];
const reasoningEffortValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type StoredTaskRoute = {
  model: string;
  reasoningEffort?: (typeof reasoningEffortValues)[number];
  maxOutputTokens: number;
};
function describeEffectiveRoute(
  route: NonNullable<OpenAiConfigurationView["effectiveRoutes"]>[TaskClass],
) {
  if (!route) return "Effective route: unknown.";
  if ("error" in route)
    return "Effective route: not verified. Add the model to the verified model IDs or clear the route.";
  const price =
    route.price === "missing"
      ? " No price for this model: runs are refused until the rate card has one."
      : "";
  return `Effective route: ${route.model} · ${route.reasoningEffort ?? "default effort"} · ${route.maxOutputTokens} max tokens.${price}`;
}
function OpenAiConfiguration({ onClose }: { onClose: () => void }) {
  const { project, refresh } = useWorkspace();
  const configuration = useResource<OpenAiConfigurationView>(
    collectionPath(project.id, "openai-configuration"),
  );
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const current = configuration.data;
  const fields: FormField[] = [
    {
      name: "apiKey",
      label:
        current?.source === "orbit"
          ? "OpenAI API key (leave blank to keep the current key)"
          : "Shared OpenAI API key (optional when an image key is entered)",
      type: "password",
      min: 20,
      max: 1000,
      hint: "Encrypted server-side. It is never displayed after saving.",
    },
    {
      name: "imageApiKey",
      label: current?.dedicatedImageKeyConfigured
        ? "Dedicated OpenAI image API key (leave blank to keep it)"
        : "Dedicated OpenAI image API key (optional)",
      type: "password",
      min: 20,
      max: 1000,
      hint: "Encrypted server-side. When blank, image generation uses the shared OpenAI key. A separate project key makes provider-side cost tracking easier.",
    },
    {
      name: "verifiedModels",
      label: "Verified model IDs (comma separated)",
      required: true,
      value: current?.verifiedModels.join(", ") ?? "",
      placeholder: "gpt-5.6-terra, text-embedding-3-small",
    },
    ...taskClasses.flatMap(({ id, label, defaultTokens }): FormField[] => {
      const stored = current?.taskRoutes?.[id];
      return [
        {
          name: `route-${id}-model`,
          heading: `${label} route`,
          label: `${label} model`,
          value: stored?.model ?? "",
          placeholder: "Leave empty to use the fallback tier",
          hint: describeEffectiveRoute(current?.effectiveRoutes?.[id]),
        },
        {
          name: `route-${id}-effort`,
          label: `${label} reasoning effort`,
          type: "select",
          value: stored?.reasoningEffort ?? "",
          options: [
            { value: "", label: "Default (not sent)" },
            ...reasoningEffortValues.map((value) => ({ value, label: value })),
          ],
        },
        {
          name: `route-${id}-max-tokens`,
          label: `${label} maximum output tokens`,
          type: "number",
          min: 256,
          max: 16000,
          step: "1",
          value: stored?.maxOutputTokens ?? defaultTokens,
          hint: "Used only when a model is entered (256 to 16000).",
        },
      ];
    }),
    ...(["fast", "standard", "quality", "escalation"] as const).map(
      (route, index): FormField => ({
        name: `model-${route}`,
        heading: index === 0 ? "Fallback tier models" : undefined,
        label: `${route.charAt(0).toUpperCase() + route.slice(1)} task model`,
        required: true,
        value: current?.modelRoutes?.[route] ?? "",
        hint:
          index === 0
            ? "Used by every task class that has no model entered above."
            : undefined,
      }),
    ),
    {
      name: "imageModel",
      label: "GPT Image 2.5 model",
      type: "select",
      value: current?.imageGeneration?.model || "gpt-image-2.5-flare",
      options: [
        {
          value: "gpt-image-2.5-flare",
          label: "GPT Image 2.5 Flare · fast generation",
        },
        {
          value: "gpt-image-2.5-sunburst",
          label: "GPT Image 2.5 Sunburst · precise editing",
        },
        {
          value: "gpt-image-2.5-flare-2026-09-08",
          label: "Flare · pinned 2026-09-08",
        },
        {
          value: "gpt-image-2.5-sunburst-2026-09-08",
          label: "Sunburst · pinned 2026-09-08",
        },
      ],
    },
    {
      name: "imageMaxCost",
      label: "Maximum reserved cost per image (USD; 0 disables)",
      type: "number",
      min: 0,
      max: 10,
      step: "0.001",
      value: (current?.imageGeneration?.maxCostMicrosPerImage || 0) / 1_000_000,
      required: true,
      hint: "This is a conservative per-image ceiling. Project daily, monthly and per-run budgets still apply.",
    },
    {
      name: "imagePricingVerifiedAt",
      label: "Image price ceiling verified at (ISO timestamp)",
      value: current?.imageGeneration?.pricingVerifiedAt || "",
      placeholder: "2026-09-19T12:00:00.000Z",
      hint: "Required when the per-image ceiling is above zero. Update it when the price changes.",
    },
    {
      name: "rateCard",
      label: "Current OpenAI rate card (JSON, USD micros per million tokens)",
      type: "textarea",
      required: true,
      value: JSON.stringify(current?.rateCard ?? {}, null, 2),
      hint: "Each model needs inputMicrosPerMillion, outputMicrosPerMillion and an ISO verifiedAt date. Optional: cachedInputMicrosPerMillion and cacheWriteMicrosPerMillion (defaults: input rate and 1.25x input).",
    },
  ];
  return (
    <Modal title="OpenAI configuration" onClose={onClose}>
      <p className="panel-note">
        {current?.configured
          ? `Configured through ${current.source}${current.updatedAt ? ` · updated ${when(current.updatedAt)}` : ""}.`
          : "No application OpenAI configuration is saved yet."}
        {current
          ? typeof current.routeVersion === "number"
            ? ` Route version ${current.routeVersion}.`
            : " Environment configuration."
          : ""}
        {current?.dedicatedImageKeyConfigured
          ? " A dedicated image key is active."
          : current?.imageKeyConfigured
            ? " Image generation uses the shared key."
            : " Image generation has no usable key."}
      </p>
      <Alert>
        A newly entered key replaces only its matching shared or image key for
        new work. Blank key fields keep saved keys. Existing budget,
        evidence-rights and policy checks still apply before any OpenAI call.
      </Alert>
      <DataForm
        key={current?.updatedAt ?? "openai-configuration-loading"}
        fields={fields}
        pending={mutation.pending || configuration.loading}
        error={mutation.error || configuration.error?.message}
        submitLabel="Save OpenAI configuration"
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() => {
            let rateCard: unknown;
            try {
              rateCard = JSON.parse(String(values.rateCard));
            } catch {
              throw new Error("RATE_CARD_JSON_INVALID");
            }
            const apiKey = String(values.apiKey).trim();
            const imageApiKey = String(values.imageApiKey).trim();
            return action(project.id, "openai-configure", {
              ...(apiKey ? { apiKey } : {}),
              ...(imageApiKey ? { imageApiKey } : {}),
              verifiedModels: String(values.verifiedModels)
                .split(",")
                .map((model) => model.trim())
                .filter(Boolean),
              rateCard,
              taskRoutes: Object.fromEntries(
                taskClasses.flatMap(({ id, defaultTokens }) => {
                  const model = String(values[`route-${id}-model`]).trim();
                  if (!model) return [];
                  const effort = String(values[`route-${id}-effort`]);
                  const maxOutputTokens =
                    Number(values[`route-${id}-max-tokens`]) || defaultTokens;
                  return [
                    [
                      id,
                      {
                        model,
                        ...(effort ? { reasoningEffort: effort } : {}),
                        maxOutputTokens,
                      },
                    ],
                  ];
                }),
              ),
              modelRoutes: {
                fast: String(values["model-fast"]),
                standard: String(values["model-standard"]),
                quality: String(values["model-quality"]),
                escalation: String(values["model-escalation"]),
              },
              imageGeneration: {
                model: String(values.imageModel),
                maxCostMicrosPerImage: Math.round(
                  Number(values.imageMaxCost) * 1_000_000,
                ),
                ...(String(values.imagePricingVerifiedAt).trim()
                  ? {
                      pricingVerifiedAt: new Date(
                        String(values.imagePricingVerifiedAt),
                      ).toISOString(),
                    }
                  : {}),
              },
            });
          })
        }
      />
    </Modal>
  );
}
function PolicyEditor({ onClose }: { onClose: () => void }) {
  const { project, t, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const fields: FormField[] = [
    {
      name: "mode",
      label: "Operating mode",
      type: "select",
      value: "observe",
      options: options(["observe", "assisted", "autopilot"]),
    },
    {
      name: "channels",
      label: "Authorized channels (comma separated)",
      required: true,
    },
    {
      name: "contentTypes",
      label: "Authorized content types (comma separated)",
      required: true,
      placeholder: "social, blog",
    },
    {
      name: "allowedOrigins",
      label: "Approved target origins (comma separated)",
      placeholder: "https://example.com",
    },
    dateField("startAt", "Mandate start"),
    dateField("endAt", "Mandate end"),
    {
      name: "maxPerDay",
      label: "Maximum publications per day",
      type: "number",
      min: 0,
      max: 20,
      required: true,
    },
    {
      name: "minIntervalMinutes",
      label: "Minimum spacing (minutes)",
      type: "number",
      min: 1,
      max: 1440,
      required: true,
    },
    {
      name: "dailyBudget",
      label: "Daily budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "monthlyBudget",
      label: "Monthly budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "perRunBudget",
      label: "Per-run budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "quietStart",
      label: "Quiet hours start (project hour 0–23)",
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "quietEnd",
      label: "Quiet hours end (project hour 0–23)",
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "approvedPaidTests",
      label: "Authorize paid test calls within these exact limits",
      type: "checkbox",
    },
    {
      name: "confirm",
      label:
        "I approve this exact version, its channels, dates and cost limits.",
      type: "checkbox",
      required: true,
    },
  ];
  return (
    <Modal
      title="New operating policy"
      description="Only a verified capability can act under this mandate. Infrastructure, new spending permissions and unrelated channels remain outside its scope."
      onClose={onClose}
    >
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        t={t}
        submitLabel="Save policy version"
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() =>
              post(collectionPath(project.id, "policies"), {
                mode: str(v, "mode"),
                channels: csv(v, "channels"),
                contentTypes: csv(v, "contentTypes"),
                allowedOrigins: csv(v, "allowedOrigins"),
                startAt: iso(v, "startAt"),
                endAt: iso(v, "endAt"),
                maxPerDay: num(v, "maxPerDay"),
                minIntervalMinutes: num(v, "minIntervalMinutes"),
                dailyBudgetMicros: Math.round(
                  num(v, "dailyBudget") * 1_000_000,
                ),
                monthlyBudgetMicros: Math.round(
                  num(v, "monthlyBudget") * 1_000_000,
                ),
                perRunBudgetMicros: Math.round(
                  num(v, "perRunBudget") * 1_000_000,
                ),
                approvedPaidTests: v.approvedPaidTests === true,
                ...(str(v, "quietStart")
                  ? { quietStart: num(v, "quietStart") }
                  : {}),
                ...(str(v, "quietEnd") ? { quietEnd: num(v, "quietEnd") } : {}),
              }),
            )
            .then(() => {})
        }
      />
    </Modal>
  );
}
function RecordDetail({
  entity,
  onClose,
}: {
  entity: Entity;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(entity);
  return (
    <Modal
      title={value(current, "name", value(current, "title", current.kind))}
      onClose={onClose}
      wide
    >
      <div className="detail-summary">
        <Status value={current.data.status} />
        <Badge>Version {current.version}</Badge>
      </div>
      <dl className="record-detail">
        {Object.entries(current.data)
          .filter(
            ([key]) =>
              !["credential", "secret", "token", "password"].some((k) =>
                key.toLowerCase().includes(k),
              ),
          )
          .map(([key, v]) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
              <dd>
                {v === null ? (
                  "Not available"
                ) : typeof v === "object" ? (
                  <pre>{JSON.stringify(v, null, 2)}</pre>
                ) : (
                  String(v)
                )}
              </dd>
            </div>
          ))}
      </dl>
      {current.kind === "preferences" || current.kind === "preference" ? (
        <PreferenceActions entity={current} onDone={onClose} />
      ) : null}
      {current.kind === "experiments" && (
        <ExperimentControls entity={current} onUpdate={setCurrent} />
      )}
      {["preferences", "insights"].includes(current.kind) && (
        <MemoryLifecycleControls entity={current} onDone={onClose} />
      )}
      {current.kind === "metrics" && (
        <MetricCorrection entity={current} onDone={onClose} />
      )}
    </Modal>
  );
}
