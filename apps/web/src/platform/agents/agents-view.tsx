"use client";
// The project's agents (ADR 0021, plan WP1.8), a platform page at
// /p/:projectId/agents that owns its subpaths: the overview, the builder
// for a new agent (/new?template=), one agent with its tabs (/<id>?tab=)
// and one execution (/<id>/executions/<workOrderId>).
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, Plus } from "lucide-react";
import { post, useResource, usd, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  Alert,
  Button,
  Empty,
  Loading,
  Modal,
  Tabs,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { PageHead } from "@/platform/ui/collection";
import { AppLink } from "@/platform/ui/app-link";
import { NotFound } from "@/platform/shell/not-found";
import { agentPaths, errorCode, requestId, useAgentAction } from "./api";
import { AgentBuilder, ReviewActivate } from "./builder";
import { ExecutionDetail, ExecutionList, personText } from "./executions";
import {
  activationBody,
  agentFigures,
  agentHref,
  agentsPlace,
  agentTab,
  executionHref,
  fieldValueText,
  type AgentTab,
} from "./logic";
import {
  AgentError,
  AgentStatusBadge,
  ToolCatalog,
  WorkStatusBadge,
} from "./parts";
import { agentErrorText, modeText } from "./text";
import type {
  AgentTemplate,
  AgentVersionRow,
  AgentView,
  Catalog,
  WorkOrderPage,
  WorkOrderView,
} from "./types";

export function AgentsView() {
  const pathname = usePathname() || "";
  const place = agentsPlace(pathname);
  if (place.view === "list") return <AgentsOverview />;
  if (place.view === "new") return <NewAgent />;
  if (place.view === "agent") return <AgentDetail agentId={place.agentId} />;
  if (place.view === "execution")
    return (
      <ExecutionDetail
        agentId={place.agentId}
        workOrderId={place.workOrderId}
      />
    );
  return <AgentsNotFound />;
}

function AgentsNotFound() {
  const { t } = useWorkspace();
  const shell = useShell();
  return <NotFound t={t} homeHref={shell.hrefOf("agents")} />;
}

/** The page's answer when the API refuses: switched off, no access or another error. */
export function AgentsUnavailable({
  code,
  locale,
}: {
  code: string;
  locale: Locale;
}) {
  const de = locale === "de";
  if (code === "NOT_FOUND")
    return (
      <Empty
        icon={Bot}
        title={de ? "Agenten sind nicht verfügbar" : "Agents are not available"}
        description={agentErrorText("AGENT_PLATFORM_DISABLED", locale)}
      />
    );
  if (code === "FORBIDDEN" || code === "OWNER_REQUIRED")
    return (
      <Empty
        icon={Bot}
        title={de ? "Kein Zugriff" : "No access"}
        description={
          de
            ? "Agenten sehen nur Owner und Editoren des Projekts."
            : "Only the project's owners and editors can see agents."
        }
      />
    );
  return <AgentError code={code} locale={locale} />;
}

const head = (locale: Locale) => ({
  title: locale === "de" ? "Agenten" : "Agents",
  description:
    locale === "de"
      ? "Eigene Agenten dieses Projekts: was sie dürfen, wann sie laufen und was sie kosten."
      : "This project's own agents: what they may do, when they run and what they cost.",
});

function AgentsOverview() {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const list = useResource<{ items: AgentView[] }>(agentPaths.list(project.id));
  const page = useResource<WorkOrderPage>(
    agentPaths.workOrders(project.id, { limit: 100 }),
  );
  const figures = agentFigures(page.data);
  const items = list.data?.items ?? [];
  const names = new Map(items.map((a) => [a.id, a.name]));
  return (
    <>
      <PageHead {...head(locale)}>
        <AppLink
          className="button button-outline"
          href={`/o/${encodeURIComponent(project.workspaceId)}/agents`}
        >
          {de ? "Alle Projekte" : "All projects"}
        </AppLink>
        {isOwner && !list.error && (
          <AppLink className="button button-primary" href={`${base}/new`}>
            <Plus aria-hidden="true" />
            {de ? "Neuer Agent" : "New agent"}
          </AppLink>
        )}
      </PageHead>
      {list.loading && !list.data && <Loading />}
      {list.error && (
        <AgentsUnavailable code={errorCode(list.error)} locale={locale} />
      )}
      {list.data && !items.length && (
        <Empty
          icon={Bot}
          title={de ? "Noch keine Agenten" : "No agents yet"}
          description={
            isOwner
              ? de
                ? "Lege einen Agenten aus einer Vorlage oder leer an. Er bleibt ein Entwurf, bis du ihn aktivierst."
                : "Create an agent from a template or blank. It stays a draft until you activate it."
              : de
                ? "Owner des Projekts können Agenten anlegen."
                : "Project owners can create agents."
          }
        />
      )}
      {items.length > 0 && (
        <section className="panel" aria-labelledby="agents-list-title">
          <div className="panel-head">
            <div>
              <h2 id="agents-list-title">{de ? "Agenten" : "Agents"}</h2>
              <p>
                {de
                  ? "Letzte Ausführung, Fehler der letzten 24 Stunden und Ausgaben dieses Monats aus den neuesten 100 Ausführungen."
                  : "Last execution, failures in the last 24 hours and this month's spend from the newest 100 executions."}
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{de ? "Name" : "Name"}</th>
                  <th scope="col">{de ? "Status" : "Status"}</th>
                  <th scope="col">{de ? "Modus" : "Mode"}</th>
                  <th scope="col">
                    {de ? "Letzte Ausführung" : "Last execution"}
                  </th>
                  <th scope="col">{de ? "Fehler 24 h" : "Failures 24 h"}</th>
                  <th scope="col">{de ? "Diesen Monat" : "This month"}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((agent) => {
                  const f = figures.byAgent.get(agent.id);
                  const config = agent.active ?? agent.draft;
                  const spent = f
                    ? f.monthSpentMicros
                    : figures.completeMonth
                      ? 0
                      : null;
                  return (
                    <tr key={agent.id}>
                      <td>
                        <AppLink href={agentHref(base, agent.id)}>
                          {agent.name}
                        </AppLink>
                        {agent.draft && agent.active && (
                          <small>
                            {de
                              ? "Ungespeicherter Entwurf vorhanden"
                              : "Has an unactivated draft"}
                          </small>
                        )}
                      </td>
                      <td>
                        <AgentStatusBadge
                          status={agent.status}
                          locale={locale}
                        />
                      </td>
                      <td>{config ? modeText(config.mode, locale) : "—"}</td>
                      <td>
                        {f?.lastRun ? (
                          <>
                            <AppLink
                              href={executionHref(base, agent.id, f.lastRun.id)}
                            >
                              {when(
                                f.lastRun.createdAt,
                                locale,
                                project.timezone,
                              )}
                            </AppLink>{" "}
                            <WorkStatusBadge
                              status={f.lastRun.status}
                              locale={locale}
                            />
                          </>
                        ) : page.data ? (
                          de ? (
                            "Noch nie"
                          ) : (
                            "Never"
                          )
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {page.data
                          ? `${f?.failures24h ?? 0}${figures.complete24h ? "" : "+"}`
                          : "—"}
                      </td>
                      <td>
                        {spent === null ? "—" : usd(spent)}
                        {agent.active && (
                          <small>
                            {de ? "Obergrenze" : "Ceiling"}{" "}
                            {usd(agent.active.budget.monthlyCeilingMicros)}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {items.length > 0 && <ExecutionList agentNames={names} />}
    </>
  );
}

function NewAgent() {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const template = useSearchParams()?.get("template") ?? null;
  const templates = useResource<{ items: AgentTemplate[] }>(
    agentPaths.templates(project.id),
  );
  return (
    <>
      <p>
        <AppLink className="back-link" href={base}>
          ← {de ? "Alle Agenten" : "All agents"}
        </AppLink>
      </p>
      <PageHead
        title={de ? "Neuer Agent" : "New agent"}
        description={
          de
            ? "Ein neuer Agent ist ein Entwurf. Er läuft erst, wenn du ihn prüfst und aktivierst."
            : "A new agent is a draft. It runs only once you review and activate it."
        }
      />
      {!isOwner ? (
        <Alert>{agentErrorText("OWNER_REQUIRED", locale)}</Alert>
      ) : templates.error ? (
        <AgentsUnavailable code={errorCode(templates.error)} locale={locale} />
      ) : template === null ? (
        templates.loading ? (
          <Loading />
        ) : (
          <section className="panel" aria-labelledby="agent-template-title">
            <div className="panel-head">
              <div>
                <h2 id="agent-template-title">
                  {de ? "Vorlage wählen" : "Choose a template"}
                </h2>
                <p>
                  {de
                    ? "Vorlagen der Module bringen Voreinstellungen und feste Regeln mit."
                    : "Module templates bring defaults and fixed rules."}
                </p>
              </div>
            </div>
            <ul className="agents-templates">
              <li>
                <AppLink
                  className="agents-template"
                  href={`${base}/new?template=blank`}
                >
                  <strong>{de ? "Leerer Agent" : "Blank agent"}</strong>
                  <span>
                    {de
                      ? "Alles selbst festlegen."
                      : "Set everything yourself."}
                  </span>
                </AppLink>
              </li>
              {(templates.data?.items ?? []).map((t) => (
                <li key={t.key}>
                  <AppLink
                    className="agents-template"
                    href={`${base}/new?template=${encodeURIComponent(t.key)}`}
                  >
                    <strong>{t.title[locale]}</strong>
                    <span>{t.summary[locale]}</span>
                  </AppLink>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <AgentBuilder templateKey={template === "blank" ? null : template} />
      )}
    </>
  );
}

function AgentDetail({ agentId }: { agentId: string }) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const tab = agentTab(useSearchParams()?.get("tab"));
  const resource = useResource<AgentView>(
    agentPaths.agent(project.id, agentId),
  );
  const agent = resource.data;
  const tabs: Array<{ key: AgentTab; label: string }> = [
    { key: "overview", label: de ? "Übersicht" : "Overview" },
    { key: "configuration", label: de ? "Konfiguration" : "Configuration" },
    { key: "versions", label: de ? "Versionen" : "Versions" },
    { key: "executions", label: de ? "Ausführungen" : "Executions" },
  ];
  return (
    <>
      <p>
        <AppLink className="back-link" href={base}>
          ← {de ? "Alle Agenten" : "All agents"}
        </AppLink>
      </p>
      {resource.loading && !agent && <Loading />}
      {resource.error && (
        <AgentsUnavailable code={errorCode(resource.error)} locale={locale} />
      )}
      {agent && (
        <>
          <PageHead
            title={agent.name}
            description={
              (agent.active ?? agent.draft)?.description ||
              (de ? "Ohne Beschreibung." : "No description.")
            }
          >
            <AgentStatusBadge status={agent.status} locale={locale} />
          </PageHead>
          <Tabs
            tabs={tabs}
            value={tab}
            onChange={(key) => router.replace(agentHref(base, agent.id, key))}
          />
          <div
            role="tabpanel"
            aria-label={tabs.find((t) => t.key === tab)!.label}
          >
            {tab === "overview" && (
              <AgentOverviewTab agent={agent} onChanged={resource.refresh} />
            )}
            {tab === "configuration" && (
              <AgentBuilder agent={agent} onSaved={resource.refresh} />
            )}
            {tab === "versions" && (
              <AgentVersions agent={agent} onChanged={resource.refresh} />
            )}
            {tab === "executions" && <ExecutionList agentId={agent.id} />}
          </div>
        </>
      )}
    </>
  );
}

type Confirm = "duplicate" | "disable" | "run" | null;

function AgentOverviewTab({
  agent,
  onChanged,
}: {
  agent: AgentView;
  onChanged(): void;
}) {
  const { project, locale, isOwner, canEdit, identity } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const de = locale === "de";
  const base = shell.hrefOf("agents");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [goal, setGoal] = useState("");
  const action = useAgentAction();
  const catalog = useResource<Catalog>(agentPaths.catalog(project.id));
  const config = agent.active ?? agent.draft;
  const manual = Boolean(
    agent.active?.triggers.some((t) => t.kind === "manual"),
  );
  const canStart = canEdit && agent.status === "active" && manual;

  async function status(kind: "pause" | "resume" | "disable") {
    const done = await action.run(() =>
      post<AgentView>(agentPaths.action(project.id, agent.id, kind), {
        version: agent.version,
      }),
    );
    if (done) {
      setConfirm(null);
      onChanged();
    }
  }
  async function duplicate() {
    const copy = await action.run(() =>
      post<AgentView>(agentPaths.action(project.id, agent.id, "duplicate"), {}),
    );
    if (copy) router.push(agentHref(base, copy.id, "configuration"));
  }
  async function run() {
    const started = await action.run(() =>
      post<WorkOrderView>(agentPaths.runs(project.id, agent.id), {
        requestId: requestId(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      }),
    );
    if (started) router.push(executionHref(base, agent.id, started.id));
  }

  return (
    <div className="agents-stack">
      <section className="panel" aria-labelledby="agent-summary-title">
        <div className="panel-head">
          <div>
            <h2 id="agent-summary-title">{de ? "Übersicht" : "Overview"}</h2>
            <p>
              {agent.status === "draft"
                ? de
                  ? "Noch nie aktiviert. Prüfe und aktiviere den Entwurf unter Konfiguration."
                  : "Never activated. Review and activate the draft under Configuration."
                : agent.draft
                  ? de
                    ? "Es läuft die aktive Version; ein geänderter Entwurf wartet auf die Aktivierung."
                    : "The active version runs; a changed draft waits for activation."
                  : de
                    ? "Es läuft die aktive Version."
                    : "The active version runs."}
            </p>
          </div>
          <div className="page-actions agents-wrap">
            {canStart && (
              <Button onClick={() => setConfirm("run")}>
                {de ? "Jetzt ausführen" : "Run now"}
              </Button>
            )}
            {isOwner &&
              (agent.status === "active" ||
                agent.status === "budget_exhausted") && (
                <Button
                  variant="outline"
                  disabled={action.pending}
                  onClick={() => status("pause")}
                >
                  {de ? "Pausieren" : "Pause"}
                </Button>
              )}
            {isOwner &&
              (agent.status === "paused" ||
                agent.status === "budget_exhausted") && (
                <Button
                  variant="outline"
                  disabled={action.pending}
                  onClick={() => status("resume")}
                >
                  {de ? "Fortsetzen" : "Resume"}
                </Button>
              )}
            {isOwner && (
              <Button variant="outline" onClick={() => setConfirm("duplicate")}>
                {de ? "Duplizieren" : "Duplicate"}
              </Button>
            )}
            {isOwner && agent.status !== "disabled" && (
              <Button
                variant="destructive"
                onClick={() => setConfirm("disable")}
              >
                {de ? "Deaktivieren" : "Disable"}
              </Button>
            )}
          </div>
        </div>
        <div className="agents-section-body">
          {!confirm && <AgentError code={action.code} locale={locale} />}
          {canEdit && agent.status === "active" && !manual && (
            <p className="agents-note">
              {de
                ? "Dieser Agent hat keinen manuellen Auslöser und startet nur über Zeitplan oder Ereignis."
                : "This agent has no manual trigger and starts only by schedule or event."}
            </p>
          )}
          <dl className="agents-facts">
            <div>
              <dt>{de ? "Modus" : "Mode"}</dt>
              <dd>{fieldValueText("mode", config, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Auslöser" : "Triggers"}</dt>
              <dd>
                {fieldValueText(
                  "triggers",
                  agent.active ?? agent.draft,
                  locale,
                )}
              </dd>
            </div>
            <div>
              <dt>{de ? "Budget" : "Budget"}</dt>
              <dd>{fieldValueText("budget", config, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Module" : "Modules"}</dt>
              <dd>{fieldValueText("modules", config, locale)}</dd>
            </div>
            <div>
              <dt>{de ? "Aktive Version" : "Active version"}</dt>
              <dd>
                {agent.activation
                  ? `${agent.activation.version} · ${when(agent.activation.activatedAt, locale, project.timezone)}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{de ? "Sponsor" : "Sponsor"}</dt>
              <dd>
                {personText(
                  agent.activation?.sponsorUserId,
                  identity.user.id,
                  locale,
                )}
              </dd>
            </div>
          </dl>
          <h3 className="agents-subhead">{de ? "Tools" : "Tools"}</h3>
          {catalog.data && config ? (
            <ToolCatalog
              tools={catalog.data.tools.filter((t) =>
                config.tools.includes(t.name),
              )}
              config={config}
              locale={locale}
              readOnly
            />
          ) : (
            <p className="agents-note">
              {fieldValueText("tools", config, locale)}
            </p>
          )}
        </div>
      </section>
      {confirm === "run" && (
        <Modal
          title={de ? "Agent jetzt ausführen" : "Run the agent now"}
          description={
            de
              ? `Die Ausführung handelt für dich und den Sponsor und kostet höchstens ${usd(agent.active?.budget.runCeilingMicros)}.`
              : `The execution acts for you and the sponsor and costs at most ${usd(agent.active?.budget.runCeilingMicros)}.`
          }
          onClose={() => setConfirm(null)}
        >
          <form
            className="agents-modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <label className="agents-field">
              <span>{de ? "Ziel (optional)" : "Goal (optional)"}</span>
              <textarea
                className="input textarea"
                rows={4}
                maxLength={2000}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <AgentError code={action.code} locale={locale} />
            <div className="agents-actions">
              <Button type="submit" disabled={action.pending}>
                {de ? "Ausführen" : "Run"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirm(null)}
              >
                {de ? "Abbrechen" : "Cancel"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {confirm === "duplicate" && (
        <Modal
          title={de ? "Agent duplizieren?" : "Duplicate the agent?"}
          description={
            de
              ? "Die Kopie ist ein neuer Entwurf mit derselben Konfiguration, ohne Weitergabe an andere Agenten. Sie läuft erst nach ihrer eigenen Aktivierung."
              : "The copy is a new draft with the same configuration, without handing work to other agents. It runs only after its own activation."
          }
          onClose={() => setConfirm(null)}
        >
          <AgentError code={action.code} locale={locale} />
          <div className="agents-actions">
            <Button disabled={action.pending} onClick={duplicate}>
              {de ? "Duplizieren" : "Duplicate"}
            </Button>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {de ? "Abbrechen" : "Cancel"}
            </Button>
          </div>
        </Modal>
      )}
      {confirm === "disable" && (
        <Modal
          title={de ? "Agent deaktivieren?" : "Disable the agent?"}
          description={
            de
              ? "Ein deaktivierter Agent startet nie wieder und kann nicht mehr bearbeitet werden. Seine Ausführungen bleiben sichtbar. Für eine neue Fassung duplizierst du ihn."
              : "A disabled agent never starts again and can no longer be edited. Its executions stay visible. Duplicate it for a new version."
          }
          onClose={() => setConfirm(null)}
        >
          <AgentError code={action.code} locale={locale} />
          <div className="agents-actions">
            <Button
              variant="destructive"
              disabled={action.pending}
              onClick={() => status("disable")}
            >
              {de ? "Endgültig deaktivieren" : "Disable for good"}
            </Button>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {de ? "Abbrechen" : "Cancel"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AgentVersions({
  agent,
  onChanged,
}: {
  agent: AgentView;
  onChanged(): void;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const de = locale === "de";
  const versions = useResource<{ items: AgentVersionRow[] }>(
    agentPaths.versions(project.id, agent.id),
  );
  const activate = useAgentAction();
  return (
    <div className="agents-stack">
      <section className="panel" aria-labelledby="agent-review-title">
        <div className="panel-head">
          <div>
            <h2 id="agent-review-title">
              {de
                ? "Entwurf gegen aktive Version"
                : "Draft against active version"}
            </h2>
          </div>
        </div>
        <div className="agents-section-body">
          <ReviewActivate
            agent={agent}
            locale={locale}
            canActivate={isOwner && agent.status !== "disabled"}
            pending={activate.pending}
            code={activate.code}
            onActivate={async () => {
              const body = activationBody(agent);
              if (!body) return;
              const done = await activate.run(() =>
                post<AgentView>(
                  agentPaths.action(project.id, agent.id, "activate"),
                  body,
                ),
              );
              if (done) onChanged();
            }}
          />
        </div>
      </section>
      <section className="panel" aria-labelledby="agent-versions-title">
        <div className="panel-head">
          <div>
            <h2 id="agent-versions-title">
              {de ? "Gespeicherte Versionen" : "Stored versions"}
            </h2>
            <p>
              {de
                ? "Jede Speicherung, Aktivierung und Statusänderung, neueste zuerst."
                : "Every save, activation and status change, newest first."}
            </p>
          </div>
        </div>
        {versions.loading && !versions.data && <Loading />}
        {versions.error && (
          <AgentError code={errorCode(versions.error)} locale={locale} />
        )}
        {versions.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{de ? "Stand" : "Revision"}</th>
                  <th scope="col">{de ? "Status" : "Status"}</th>
                  <th scope="col">
                    {de ? "Aktivierte Version" : "Activated version"}
                  </th>
                  <th scope="col">{de ? "Zeitpunkt" : "When"}</th>
                </tr>
              </thead>
              <tbody>
                {versions.data.items.map((row) => (
                  <tr key={row.version}>
                    <td>{row.version}</td>
                    <td>
                      <AgentStatusBadge status={row.status} locale={locale} />
                    </td>
                    <td>{row.activationVersion ?? "—"}</td>
                    <td>{when(row.createdAt, locale, project.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
