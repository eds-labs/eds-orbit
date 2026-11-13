"use client";
import { ShellContext } from "@/platform/shell/shell-context";
import { languagesOf } from "@/platform/project-settings/project-configuration";
import { languageName } from "@/platform/project-settings/catalog";
import { projectSettingsText } from "@/platform/project-settings/texts";
import { settingsSectionHref } from "@/platform/shell/settings-nav";
import { AppLink } from "@/platform/ui/app-link";
import { AgentRuns } from "./agent-runs";
import { AiCostDiagnosis } from "./ai-cost-diagnosis";
import { operationsBudget, operationsText } from "./operations-text";
import { blockerReason } from "@/lib/readiness-text";
import { useContext, useState } from "react";
import { WorkspacePause } from "./operator-tools";
import { TelegramConnection } from "./telegram-connection";
import { EmailConnection } from "./email-connection";
import { CustomerContextConnection } from "./customer-context-connection";
import {
  Activity,
  Brain,
  Download,
  FileText,
  Link2,
  Pause,
  RefreshCw,
} from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
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
} from "./ui/primitives";
import { DataForm, str } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import { GrantedConnections } from "./granted-connections";
import {
  EntityRows,
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { capabilityLabel, liveBlockerText } from "@/lib/capability-text";
/** The connections section of the settings center, whose frame shows the section head. */
export function Connectors() {
  const { t, locale, project, isOwner, refresh } = useWorkspace();
  const resource = useCollection("connectors");
  const [configure, setConfigure] = useState<string | null>(null);
  const mutation = useMutation(refresh);
  // Providers and extra cards come from the modules (WP2.3b).
  const contributed = useContext(ShellContext)?.connectors;
  const providers = contributed?.providers ?? [];
  const extras = contributed?.extras ?? [];
  const configuring = providers.find((p) => p.id === configure);
  return (
    <>
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
                  {p.note && <p>{p.note}</p>}
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
                      {p.Details && <p.Details connector={e} />}
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
                      {e && p.Actions && <p.Actions connector={e} />}
                      {e && p.checkLabel && (
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
                          {p.checkLabel}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </section>
            );
          })}
          <GrantedConnections connectors={resource.data?.items ?? []} />
          <TelegramConnection />
          <EmailConnection groupByServer />
          <CustomerContextConnection />
          {extras.map((Extra, index) => (
            <Extra key={index} />
          ))}
        </div>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && (
        <Alert kind="success">
          Capability check recorded. Review the returned readiness state.
        </Alert>
      )}
      {configuring?.Configure && (
        <configuring.Configure onClose={() => setConfigure(null)} />
      )}
      {configure && !configuring?.Configure && (
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
              ...(configuring?.fields ?? []),
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
/** Whether Marketing is on in the open project; true while unknown. */
function useMarketingOn() {
  const modules = useContext(ShellContext)?.modules;
  return modules ? modules.some((m) => m.id === "marketing" && m.enabled) : true;
}

export function Operations() {
  const marketingOn = useMarketingOn();
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
  const ops = operationsText(locale);
  const aiMonth = d ? operationsBudget(d.budget, locale) : null;
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
      {mutation.success && <Alert kind="success">{ops.stateUpdated}</Alert>}
      {resource.loading ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="operations-band">
              <div>
                <span>{ops.execution}</span>
                {/* The mode is Marketing's (ADR 0015, E-6). */}
                <Status
                  value={
                    d.project.paused
                      ? "paused"
                      : marketingOn
                        ? d.project.mode
                        : "active"
                  }
                />
              </div>
              <div>
                <span>{ops.readiness}</span>
                <Status value={d.readiness.state} />
              </div>
              {/* This UTC month, as the monthly limit counts it (WP2 C). */}
              <div>
                <span>{ops.spend}</span>
                <strong>{aiMonth?.spend}</strong>
                {aiMonth?.since && <small>{aiMonth.since}</small>}
              </div>
              <div>
                <span>{ops.open}</span>
                <strong>{aiMonth?.open}</strong>
                {aiMonth?.split && <small>{aiMonth.split}</small>}
              </div>
            </div>
            {runtime.data && (
              <section className="panel administration-panel">
                <div className="panel-head">
                  <div>
                    <h2>{ops.worker}</h2>
                    <p>
                      {ops.lastObserved}{" "}
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
                  <dt>{ops.heartbeat}</dt>
                  <dd>
                    {when(
                      runtime.data.runtime.lastHeartbeat,
                      locale,
                      project.timezone,
                    )}
                  </dd>
                  <dt>{ops.outbox}</dt>
                  <dd>{runtime.data.pendingOutbox}</dd>
                  <dt>{ops.queues}</dt>
                  <dd>{runtime.data.runtime.queues.join(", ") || "—"}</dd>
                </dl>
                {runtime.data.runtime.worker !== "ready" && (
                  <Alert kind="warning">{ops.workerDown}</Alert>
                )}
              </section>
            )}
            <AiCostDiagnosis />
            {d.readiness.blockers.length > 0 && (
              <Alert kind="warning">
                <strong>
                  {locale === "de"
                    ? "Erforderliche Konfiguration"
                    : "Required configuration"}
                </strong>
                <ul>
                  {d.readiness.blockers.map((s) => (
                    <li key={s}>{blockerReason(locale, s)}</li>
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
/**
 * The project's facts, the caller's role and the export. The project
 * settings page and the settings center both show it; the caller passes the
 * dashboard it loaded, so the page keeps its single request.
 */
export function ProjectSummaryPanel({ dashboard }: { dashboard: Dashboard | null }) {
  const marketingOn = useMarketingOn();
  const { locale, project, identity } = useWorkspace();
  const pt = projectSettingsText(locale);
  const roleText = (role?: string) =>
    pt(
      role === "owner"
        ? "roleOwner"
        : role === "editor"
          ? "roleEditor"
          : role === "viewer"
            ? "roleViewer"
            : "roleMember",
    );
  const d = dashboard;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{pt("projectHeading")}</h2>
          <p>{pt("projectHint")}</p>
        </div>
        <Badge>{roleText(project.role)}</Badge>
      </div>
      <dl className="detail-grid">
        <dt>{pt("name")}</dt>
        <dd>{project.name}</dd>
        <dt>{pt("timezone")}</dt>
        <dd>{project.timezone}</dd>
        <dt>{pt("defaultLanguage")}</dt>
        <dd>
          {languageName(project.language, locale)}
          <small>
            {languagesOf(project)
              .map((code) => languageName(code, locale))
              .join(" · ")}
          </small>
        </dd>
        <dt>{pt("signedInAs")}</dt>
        <dd>
          {identity.user.name}
          <small>{identity.user.email}</small>
        </dd>
        {/* Marketing's autonomy mode, only while it is on (E-6). */}
        {marketingOn && (
          <>
            <dt>{pt("mode")}</dt>
            <dd>
              <Status value={d?.project.mode || project.mode} />
            </dd>
          </>
        )}
      </dl>
      <Button asChild variant="outline">
        <a
          href={`/api${collectionPath(project.id, "export")}`}
          download
        >
          <Download data-icon="inline-start" />
          {pt("exportProject")}
        </a>
      </Button>
    </section>
  );
}

/** Autopilot readiness with the links that resolve its blockers. */
export function ProjectReadinessPanel({
  dashboard,
  loading,
}: {
  dashboard: Dashboard | null;
  loading: boolean;
}) {
  const { locale, isOwner } = useWorkspace();
  const shell = useContext(ShellContext);
  const setupLinks = shell?.setupLinks ?? [];
  const sectionHref = (key: string) =>
    shell ? shell.settingsHref(key) : settingsSectionHref("", key);
  const de = locale === "de";
  const d = dashboard;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {de ? "Autopilot-Bereitschaft" : "Autopilot readiness"}
        </h2>
        {d && <Status value={d.readiness.state} />}
      </div>
      {d?.readiness.blockers.length ? (
        <ul className="checklist">
          {d.readiness.blockers.map((s) => (
            <li key={s}>
              <span className="checklist-dot" />
              {blockerReason(locale, s)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-note">
          {loading
            ? de
              ? "Wird geprüft…"
              : "Checking…"
            : de
              ? "Die Bereitschaft richtet sich nach verifizierten Fähigkeiten."
              : "Readiness is scoped to verified capabilities."}
        </p>
      )}
      {d?.readiness.capabilities && (
        <div className="capability-readiness">
          {Object.entries(d.readiness.capabilities).map(
            ([name, capability]) => (
              <div className="data-row" key={name}>
                <div>
                  <strong>{capabilityLabel(locale, name)}</strong>
                  {/* A sentence; the raw code only as a tooltip. */}
                  {capability.liveBlocker && (
                    <p title={capability.liveBlocker}>
                      {liveBlockerText(
                        locale,
                        capability.liveBlocker,
                      )}
                    </p>
                  )}
                </div>
                <Status value={capability.state} />
              </div>
            ),
          )}
        </div>
      )}
      <div className="setup-links">
        <AppLink href="/knowledge">
          <BookOpenIcon />
          {de
            ? "Quellenrechte und verifizierte Fakten ergänzen"
            : "Add source rights and verified facts"}
        </AppLink>
        <AppLink href="/connectors">
          <Link2 />
          {de
            ? "Verbindungen und ihre Fähigkeiten prüfen"
            : "Verify connector capabilities"}
        </AppLink>
        {setupLinks.map((Link, index) => (
          <Link key={index} />
        ))}
        {/* One place for AI settings (plan phase 3.3). */}
        {isOwner && (
          <AppLink href={sectionHref("ai")}>
            <Brain />
            {de ? "KI & Budget einrichten" : "Set up AI & budget"}
          </AppLink>
        )}
      </div>
    </section>
  );
}
const BookOpenIcon = FileText;
