"use client";
import { ShellContext } from "@/platform/shell/shell-context";
import { RetentionControl } from "./retention-control";
import { ModuleSettings } from "./module-settings";
import {
  ProjectAdministration,
  ProjectMembers,
} from "./project-administration";
import { useSearchParams } from "next/navigation";
import {
  collectSettingsTabs,
  groupSettings,
  platformSettingsTabs,
  sectionFromSearch,
  SettingsNav,
} from "@/platform/shell/settings-nav";
import { AppLink } from "@/platform/ui/app-link";
import { AgentRuns } from "./agent-runs";
import { GoogleDriveSettings } from "./google-drive";
import {
  ConnectedApps,
  type McpGrant,
} from "@/platform/connect/connected-apps";
import { Fragment, useContext, useEffect, useState } from "react";
import { WorkspacePause } from "./operator-tools";
import { TelegramConnection } from "./telegram-connection";
import { EmailConnection } from "./email-connection";
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
} from "./ui/primitives";
import { DataForm, options, str, type FormField } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";
import {
  EntityRows,
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
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
          <TelegramConnection />
          <EmailConnection />
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
  const [openAi, setOpenAi] = useState(false);
  // The caller's connected MCP apps. The routes exist only while the OAuth
  // server is on (404 otherwise), and then the section is not offered.
  const grants = useResource<{ grants: McpGrant[] }>("/mcp-grants");
  const appsAvailable = Boolean(
    grants.data || (grants.error && grants.error.status !== 404),
  );
  // A reload empties the resource for a moment; the section must not vanish then.
  const [appsSeen, setAppsSeen] = useState(false);
  useEffect(() => {
    if (appsAvailable) setAppsSeen(true);
  }, [appsAvailable]);
  const connectedApps = appsAvailable || appsSeen;
  const d = dashboard.data;
  const de = locale === "de";
  const shell = useContext(ShellContext);
  const setupLinks = shell?.setupLinks ?? [];
  // Module sections (WP2.3b). Their hooks run on every render in registry
  // order, which never changes while the app runs.
  const modules = (shell?.settings ?? []).map((section) => ({
    section,
    shown: section.useSection(),
  }));
  // Grouped by module (UI restructure §5.4); the open section is the URL's
  // ?section=, so links and back/forward change it without a remount, and an
  // unknown or hidden one (e.g. assignments before they answer) is "project".
  const groups = groupSettings(
    collectSettingsTabs(
      platformSettingsTabs({ isOwner, connectedApps }),
      modules.map(({ section, shown }) => ({ tab: section.tab, shown })),
    ),
    shell?.modules ?? [],
  );
  const tab = sectionFromSearch(
    useSearchParams()?.toString() ?? "",
    groups.flatMap((g) => g.tabs.map((s) => s.key)),
  );
  const settingsHref = shell?.hrefOf("settings") ?? "";
  const sectionHref = (key: string) =>
    key === "project" ? settingsHref : `${settingsHref}?section=${key}`;
  function select(key: string) {
    const url = new URL(window.location.href);
    if (key === "project") url.searchParams.delete("section");
    else url.searchParams.set("section", key);
    // The Google Drive callback's marker has done its job once a section is picked.
    url.searchParams.delete("googleDrive");
    window.history.replaceState(null, "", url);
  }
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
      <div className="settings-layout">
        <SettingsNav
          groups={groups}
          value={tab}
          hrefOf={sectionHref}
          onSelect={select}
          locale={locale}
        />
        <div className="settings-content">
          <ResourceError error={dashboard.error} retry={dashboard.refresh} />
          {modules.map(({ section, shown }, index) =>
            shown?.notice ? (
              <Fragment key={index}>{shown.notice}</Fragment>
            ) : null,
          )}
          {modules
            .filter(({ section, shown }) => shown && section.tab.key === tab)
            .sort((a, b) => a.section.order - b.section.order)
            .map(({ shown }, index) => (
              <Fragment key={index}>{shown!.content}</Fragment>
            ))}
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
                  <a
                    href={`/api${collectionPath(project.id, "export")}`}
                    download
                  >
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
                              <p>
                                {capability.liveBlocker.replaceAll("_", " ")}
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
                    Add source rights and verified facts
                  </AppLink>
                  <AppLink href="/connectors">
                    <Link2 />
                    Verify connector capabilities
                  </AppLink>
                  {setupLinks.map((Link, index) => (
                    <Link key={index} />
                  ))}
                  <button onClick={() => setOpenAi(true)} disabled={!isOwner}>
                    <Brain />
                    Configure OpenAI
                  </button>
                </div>
              </section>
            </div>
          )}
          {tab === "project" && <ProjectAdministration />}
          {tab === "members" && <ProjectMembers />}
          {tab === "retention" && <RetentionControl />}
          {tab === "modules" && <ModuleSettings />}
          {tab === "apps" && <ConnectedApps mine={grants} />}
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
        </div>
      </div>
      {openAi && <OpenAiConfiguration onClose={() => setOpenAi(false)} />}
    </>
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
  { id: "agent_strategy", label: "Agent strategy", defaultTokens: 3000 },
  { id: "agent_research", label: "Agent research", defaultTokens: 3000 },
  { id: "agent_analytics", label: "Agent analytics", defaultTokens: 1800 },
  { id: "agent_review", label: "Agent review", defaultTokens: 1800 },
  { id: "support_triage", label: "Support triage", defaultTokens: 800 },
  { id: "support_draft", label: "Support draft reply", defaultTokens: 1800 },
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
