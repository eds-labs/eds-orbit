"use client";
import { useState } from "react";
import {
  MatomoImport,
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
                        <PostizVerification connector={e} />
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
                          Check capabilities
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
    [selected, setSelected] = useState<Entity | null>(null);
  const d = dashboard.data;
  return (
    <>
      <PageHead
        title={t("settings")}
        description={
          locale === "de"
            ? "Dein Workspace. Deine Regeln."
            : "Your workspace. Your boundaries."
        }
      />
      <ResourceError
        error={dashboard.error || policies.error}
        retry={() => {
          dashboard.refresh();
          policies.refresh();
        }}
      />
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
      <RetentionControl />
      <BrandApproval />
      <ProjectAdministration />
      <Alert>
        OpenAI credentials, verified models and current prices can be managed
        here by an owner. The approved daily, monthly and per-run limits remain
        versioned operating-policy controls. Neither setting enables paid calls
        or Autopilot by itself.
      </Alert>
      {policy && <PolicyEditor onClose={() => setPolicy(false)} />}
      {openAi && <OpenAiConfiguration onClose={() => setOpenAi(false)} />}
      {selected && (
        <RecordDetail entity={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
const BookOpenIcon = FileText;
type OpenAiConfigurationView = {
  configured: boolean;
  source: "orbit" | "environment" | "none";
  verifiedModels: string[];
  rateCard: Record<
    string,
    {
      inputMicrosPerMillion: number;
      outputMicrosPerMillion: number;
      verifiedAt: string;
    }
  >;
  modelRoutes: { fast: string; standard: string; quality: string; escalation: string };
  updatedAt?: string;
};
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
      label: current?.source === "orbit"
        ? "OpenAI API key (leave blank to keep the current key)"
        : "OpenAI API key",
      type: "password",
      required: current?.source !== "orbit",
      min: 20,
      max: 1000,
      hint: "Encrypted server-side. It is never displayed after saving.",
    },
    {
      name: "verifiedModels",
      label: "Verified model IDs (comma separated)",
      required: true,
      value: current?.verifiedModels.join(", ") ?? "",
      placeholder: "gpt-5.6-terra, text-embedding-3-small",
    },
    ...(["fast", "standard", "quality", "escalation"] as const).map((route) => ({
      name: `model-${route}`,
      label: `${route.charAt(0).toUpperCase() + route.slice(1)} task model`,
      required: true,
      value: current?.modelRoutes?.[route] ?? "",
    })),
    {
      name: "rateCard",
      label: "Current OpenAI rate card (JSON, USD micros per million tokens)",
      type: "textarea",
      required: true,
      value: JSON.stringify(current?.rateCard ?? {}, null, 2),
      hint: "Each model needs inputMicrosPerMillion, outputMicrosPerMillion and an ISO verifiedAt date.",
    },
  ];
  return (
    <Modal title="OpenAI configuration" onClose={onClose}>
      <p className="panel-note">
        {current?.configured
          ? `Configured through ${current.source}${current.updatedAt ? ` · updated ${when(current.updatedAt)}` : ""}.`
          : "No application OpenAI configuration is saved yet."}
      </p>
      <Alert>
        Saving replaces the key immediately for new work. Existing budget,
        evidence-rights and policy checks still apply before any OpenAI call.
      </Alert>
      <DataForm
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
            return action(project.id, "openai-configure", {
              ...(apiKey ? { apiKey } : {}),
              verifiedModels: String(values.verifiedModels)
                .split(",")
                .map((model) => model.trim())
                .filter(Boolean),
              rateCard,
              modelRoutes: {
                fast: String(values["model-fast"]),
                standard: String(values["model-standard"]),
                quality: String(values["model-quality"]),
                escalation: String(values["model-escalation"]),
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
