"use client";
// The agent builder (ADR 0021, plan WP1.8): one page with anchored
// sections, used to create an agent and to edit its draft. Every value is
// checked again by the server on save and on activation; the builder only
// offers what the catalogue says the member may grant.
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { patch, post, useResource, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { moduleLabel } from "@/platform/shell/approval-presentation";
import { AppLink } from "@/platform/ui/app-link";
import type { AgentSetup } from "@/platform/shell/types";
import { agentPaths, errorCode, useAgentAction } from "./api";
import {
  activationBody,
  agentHref,
  configProblems,
  defaultConfig,
  microsToUsdText,
  setModule,
  setTool,
  usdToMicros,
} from "./logic";
import { AgentError, ReviewDiff, ToolCatalog } from "./parts";
import { modeHint, modeText, weekdayText } from "./text";
import type {
  AgentConfig,
  AgentMode,
  AgentTemplate,
  AgentView,
  Catalog,
  ScheduleTrigger,
  Trigger,
} from "./types";

export const BUILDER_SECTIONS = [
  ["basics", { en: "Basics", de: "Grundlagen" }],
  ["instructions", { en: "Instructions", de: "Anweisungen" }],
  ["capabilities", { en: "Capabilities", de: "Fähigkeiten" }],
  ["knowledge", { en: "Knowledge", de: "Wissen" }],
  ["triggers", { en: "Triggers", de: "Auslöser" }],
  ["model", { en: "Model & limits", de: "Modell & Grenzen" }],
  ["budget", { en: "Budget", de: "Budget" }],
  ["autonomy", { en: "Autonomy", de: "Autonomie" }],
  ["review", { en: "Review & activate", de: "Prüfen & aktivieren" }],
] as const;

const MODES: AgentMode[] = ["read", "draft", "execute"];
const MAX_TRIGGERS = 5;

type Templates = { items: AgentTemplate[] };

/**
 * Loads the catalogue and templates, then renders the form. `agent` is the
 * agent whose draft is edited; without it a new agent is created from
 * `templateKey` (null: a blank agent).
 */
export function AgentBuilder({
  agent,
  templateKey,
  onSaved,
}: {
  agent?: AgentView;
  templateKey?: string | null;
  onSaved?: (agent: AgentView) => void;
}) {
  const { project, locale } = useWorkspace();
  const catalog = useResource<Catalog>(agentPaths.catalog(project.id));
  const templates = useResource<Templates>(agentPaths.templates(project.id));
  if (catalog.loading || templates.loading) return <Loading />;
  if (catalog.error || !catalog.data)
    return <AgentError code={errorCode(catalog.error)} locale={locale} />;
  const key = agent ? (agent.draft ?? agent.active)?.templateKey : templateKey;
  const template = templates.data?.items.find((t) => t.key === key) ?? null;
  if (!agent && templateKey && !template)
    return (
      <Alert kind="error">
        {locale === "de"
          ? "Diese Vorlage gibt es nicht (mehr)."
          : "This template does not exist (any more)."}
      </Alert>
    );
  return (
    <BuilderForm
      key={agent ? `${agent.id}:${agent.version}` : (templateKey ?? "blank")}
      agent={agent}
      template={template}
      catalog={catalog.data}
      onSaved={onSaved}
    />
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="panel agents-section"
      id={`agent-${id}`}
      aria-labelledby={`agent-${id}-title`}
    >
      <div className="panel-head">
        <div>
          <h2 id={`agent-${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="agents-section-body">{children}</div>
    </section>
  );
}

const sectionTitle = (
  key: (typeof BUILDER_SECTIONS)[number][0],
  locale: Locale,
) => BUILDER_SECTIONS.find(([k]) => k === key)![1][locale];

function BuilderForm({
  agent,
  template,
  catalog,
  onSaved,
}: {
  agent?: AgentView;
  template: AgentTemplate | null;
  catalog: Catalog;
  onSaved?: (agent: AgentView) => void;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const de = locale === "de";
  const initial = useMemo(
    () => (agent ? (agent.draft ?? agent.active)! : defaultConfig(template)),
    [agent, template],
  );
  const [config, setConfig] = useState<AgentConfig>(initial);
  const [monthly, setMonthly] = useState(
    microsToUsdText(initial.budget.monthlyCeilingMicros),
  );
  const [perRun, setPerRun] = useState(
    microsToUsdText(initial.budget.runCeilingMicros),
  );
  const [touched, setTouched] = useState(false);
  const save = useAgentAction();
  const activate = useAgentAction();
  const sources = useResource<{ items: Entity[] }>(
    `/projects/${encodeURIComponent(project.id)}/sources`,
  );
  const others = useResource<{ items: AgentView[] }>(
    agentPaths.list(project.id),
  );
  const base = shell.hrefOf("agents");
  const readOnly = !isOwner || agent?.status === "disabled";
  const guard = template?.guard;
  // A module's guided setup for its template, when creating (Phase 2).
  const setup =
    !agent && template ? shell.agentSetups?.[template.key] : undefined;
  const [guided, setGuided] = useState(Boolean(setup));

  const update = (next: AgentConfig | ((c: AgentConfig) => AgentConfig)) => {
    setTouched(true);
    setConfig(next);
  };
  const budgetMonthly = usdToMicros(monthly);
  const budgetRun = usdToMicros(perRun);
  const final: AgentConfig = {
    ...config,
    budget: {
      monthlyCeilingMicros: budgetMonthly ?? 0,
      runCeilingMicros: budgetRun ?? 0,
    },
  };
  const problems = configProblems(final, locale);
  const selectableModules = catalog.modules.filter(
    (m) => m.enabled && m.access,
  );

  async function submit() {
    if (problems.length || readOnly) return;
    const saved = await save.run(() =>
      agent
        ? patch<AgentView>(agentPaths.agent(project.id, agent.id), {
            version: agent.version,
            config: final,
          })
        : post<AgentView>(agentPaths.list(project.id), {
            templateKey: final.templateKey,
            config: final,
          }),
    );
    if (!saved) return;
    setTouched(false);
    if (agent) onSaved?.(saved);
    else
      router.push(`${agentHref(base, saved.id, "configuration")}#agent-review`);
  }

  async function activateDraft() {
    if (!agent) return;
    const body = activationBody(agent);
    if (!body) return;
    const done = await activate.run(() =>
      post<AgentView>(
        agentPaths.action(project.id, agent.id, "activate"),
        body,
      ),
    );
    if (done) onSaved?.(done);
  }

  const lockedInstructions = guard?.lockedInstructions ?? "";
  const eventChoices = catalog.events.filter(
    (e) => e.module === "platform" || config.modules.includes(e.module),
  );
  const settingsHref = shell.settingsHref("ai");

  if (setup && guided)
    return (
      <GuidedSetup
        template={template!}
        setup={setup}
        config={config}
        locale={locale}
        readOnly={readOnly}
        onChange={update}
        monthly={monthly}
        perRun={perRun}
        onMonthly={setMonthly}
        onPerRun={setPerRun}
        problems={problems}
        pending={save.pending}
        code={save.code}
        onSubmit={() => void submit()}
        onShowAll={() => setGuided(false)}
      />
    );

  return (
    <div className="agents-builder">
      <nav
        className="agents-builder-nav"
        aria-label={de ? "Abschnitte" : "Sections"}
      >
        <ol>
          {BUILDER_SECTIONS.map(([key, label]) => (
            <li key={key}>
              <a href={`#agent-${key}`}>{label[locale]}</a>
            </li>
          ))}
        </ol>
      </nav>
      <form
        className="agents-builder-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {readOnly && (
          <Alert>
            {agent?.status === "disabled"
              ? de
                ? "Ein deaktivierter Agent kann nicht mehr bearbeitet werden. Dupliziere ihn für eine neue Fassung."
                : "A disabled agent can no longer be edited. Duplicate it for a new version."
              : de
                ? "Nur Projekt-Owner können Agenten bearbeiten. Du siehst die Konfiguration."
                : "Only project owners can edit agents. You are viewing the configuration."}
          </Alert>
        )}
        <fieldset disabled={readOnly} className="agents-fieldset">
          <Section
            id="basics"
            title={sectionTitle("basics", locale)}
            description={
              template
                ? `${de ? "Vorlage" : "Template"}: ${template.title[locale]} · ${template.summary[locale]}`
                : de
                  ? "Ein leerer Agent ohne Vorlage."
                  : "A blank agent without a template."
            }
          >
            <label className="agents-field">
              <span>{de ? "Name" : "Name"}</span>
              <input
                className="input"
                required
                maxLength={80}
                value={config.name}
                onChange={(e) => update({ ...config, name: e.target.value })}
              />
            </label>
            <label className="agents-field">
              <span>{de ? "Beschreibung" : "Description"}</span>
              <textarea
                className="input textarea"
                maxLength={500}
                rows={3}
                value={config.description}
                onChange={(e) =>
                  update({ ...config, description: e.target.value })
                }
              />
            </label>
            {!agent && (
              <p className="agents-note">
                <AppLink href={`${base}/new`}>
                  {de ? "Andere Vorlage wählen" : "Choose another template"}
                </AppLink>
              </p>
            )}
          </Section>

          <Section
            id="instructions"
            title={sectionTitle("instructions", locale)}
            description={
              de
                ? "Was der Agent tun soll. Die Plattform setzt ihre eigenen Regeln davor."
                : "What the agent should do. The platform puts its own rules before them."
            }
          >
            {lockedInstructions && (
              <div className="agents-locked">
                <p className="agents-field-title">
                  {de
                    ? "Fester Teil der Vorlage (nicht änderbar)"
                    : "Fixed part of the template (read-only)"}
                </p>
                <pre
                  tabIndex={0}
                  aria-label={
                    de
                      ? "Feste Anweisungen der Vorlage"
                      : "Fixed template instructions"
                  }
                >
                  {lockedInstructions}
                </pre>
              </div>
            )}
            <label className="agents-field">
              <span>{de ? "Deine Anweisungen" : "Your instructions"}</span>
              <textarea
                className="input textarea"
                maxLength={6000}
                rows={8}
                value={config.instructions}
                onChange={(e) =>
                  update({ ...config, instructions: e.target.value })
                }
              />
              <small>{config.instructions.length} / 6000</small>
            </label>
          </Section>

          <Section
            id="capabilities"
            title={sectionTitle("capabilities", locale)}
            description={
              de
                ? "Zuerst die Module, dann die Tools. Du kannst nur vergeben, was du selbst darfst."
                : "Modules first, then tools. You can only grant what you may do yourself."
            }
          >
            <fieldset className="agents-choices">
              <legend>
                {de ? "Module (höchstens 5)" : "Modules (at most 5)"}
              </legend>
              {catalog.modules.map((m) => {
                const checked = config.modules.includes(m.id);
                const usable = m.enabled && m.access;
                return (
                  <label key={m.id} className="agents-check">
                    <input
                      type="checkbox"
                      className="input"
                      checked={checked}
                      disabled={
                        !usable || (!checked && config.modules.length >= 5)
                      }
                      onChange={(e) =>
                        update((c) =>
                          setModule(c, m.id, e.target.checked, catalog.tools),
                        )
                      }
                    />
                    <span>
                      {moduleLabel(m.id, de)}
                      {!m.enabled &&
                        ` · ${de ? "ausgeschaltet" : "switched off"}`}
                      {m.enabled &&
                        !m.access &&
                        ` · ${de ? "kein Zugriff" : "no access"}`}
                    </span>
                  </label>
                );
              })}
              {!selectableModules.length && (
                <p className="agents-note">
                  {de
                    ? "Kein Modul ist für dich verfügbar."
                    : "No module is available to you."}
                </p>
              )}
            </fieldset>
            <p className="agents-field-title">
              {de ? "Tools (höchstens 24)" : "Tools (at most 24)"}
            </p>
            <ToolCatalog
              tools={catalog.tools}
              config={config}
              guard={guard}
              locale={locale}
              readOnly={readOnly}
              onToggle={(name, on) => {
                if (on && config.tools.length >= 24) return;
                update((c) => setTool(c, name, on));
              }}
            />
          </Section>

          <Section
            id="knowledge"
            title={sectionTitle("knowledge", locale)}
            description={
              de
                ? "Optional: welche Wissensquellen und Zielgruppen der Agent nutzt. Ohne Auswahl gelten die Regeln seiner Tools."
                : "Optional: which knowledge sources and audiences the agent uses. Without a selection its tools' rules apply."
            }
          >
            <KnowledgeChoice
              config={config}
              locale={locale}
              sources={sources.data?.items ?? null}
              onChange={(knowledge) => update({ ...config, knowledge })}
            />
          </Section>

          <Section
            id="triggers"
            title={sectionTitle("triggers", locale)}
            description={
              de
                ? `Wann der Agent startet (höchstens ${MAX_TRIGGERS}). Uhrzeiten gelten in der Zeitzone des Projekts (${project.timezone}). Zeitpläne und Ereignisse brauchen die eingeschaltete Automatisierung.`
                : `When the agent starts (at most ${MAX_TRIGGERS}). Times are in the project's timezone (${project.timezone}). Schedules and events need automation to be switched on.`
            }
          >
            <TriggerEditor
              triggers={config.triggers}
              events={eventChoices}
              locale={locale}
              onChange={(triggers) => update({ ...config, triggers })}
            />
          </Section>

          <Section
            id="model"
            title={sectionTitle("model", locale)}
            description={
              de
                ? "Ohne Angabe nutzt der Agent die Modellroute für eigene Agenten. Ein anderes Modell nimmt der Server nur an, wenn es verifiziert ist."
                : "Without a value the agent uses the model route for custom agents. The server accepts another model only when it is verified."
            }
          >
            <label className="agents-field">
              <span>{de ? "Modell (optional)" : "Model (optional)"}</span>
              <input
                className="input"
                maxLength={120}
                placeholder={de ? "Standardroute" : "Default route"}
                value={config.model.override ?? ""}
                onChange={(e) =>
                  update({
                    ...config,
                    model: {
                      override: e.target.value.trim()
                        ? e.target.value.trim()
                        : null,
                    },
                  })
                }
              />
            </label>
            <div className="agents-grid">
              <NumberField
                label={
                  de
                    ? "Modellaufrufe je Ausführung"
                    : "Model calls per execution"
                }
                min={1}
                max={8}
                value={config.limits.maxModelCalls}
                onChange={(n) =>
                  update({
                    ...config,
                    limits: { ...config.limits, maxModelCalls: n },
                  })
                }
              />
              <NumberField
                label={
                  de ? "Tool-Aufrufe je Ausführung" : "Tool calls per execution"
                }
                min={0}
                max={16}
                value={config.limits.maxToolCalls}
                onChange={(n) =>
                  update({
                    ...config,
                    limits: { ...config.limits, maxToolCalls: n },
                  })
                }
              />
              <NumberField
                label={
                  de ? "Höchstdauer in Sekunden" : "Maximum duration in seconds"
                }
                min={30}
                max={300}
                value={config.limits.wallSeconds}
                onChange={(n) =>
                  update({
                    ...config,
                    limits: { ...config.limits, wallSeconds: n },
                  })
                }
              />
              <NumberField
                label={de ? "Ausführungen pro Tag" : "Executions per day"}
                min={1}
                max={500}
                value={config.limits.maxRunsPerDay}
                onChange={(n) =>
                  update({
                    ...config,
                    limits: { ...config.limits, maxRunsPerDay: n },
                  })
                }
              />
              <NumberField
                label={de ? "Gleichzeitige Ausführungen" : "Executions at once"}
                min={1}
                max={3}
                value={config.limits.maxConcurrent}
                onChange={(n) =>
                  update({
                    ...config,
                    limits: { ...config.limits, maxConcurrent: n },
                  })
                }
              />
            </div>
          </Section>

          <Section
            id="budget"
            title={sectionTitle("budget", locale)}
            description={
              de
                ? "Obergrenzen in USD. Alle aktiven Agenten zusammen dürfen das monatliche KI-Ausgabenlimit des Projekts nicht überschreiten."
                : "Ceilings in USD. All active agents together may not exceed the project's monthly AI spending limit."
            }
          >
            <BudgetFields
              monthly={monthly}
              perRun={perRun}
              locale={locale}
              onMonthly={(v) => {
                setTouched(true);
                setMonthly(v);
              }}
              onPerRun={(v) => {
                setTouched(true);
                setPerRun(v);
              }}
            />
          </Section>

          <Section
            id="autonomy"
            title={sectionTitle("autonomy", locale)}
            description={
              de
                ? "Wie weit der Agent selbst handeln darf. Veröffentlichen, Versenden und Kundenantworten brauchen immer eine Freigabe."
                : "How far the agent may act on its own. Publishing, sending and customer replies always need an approval."
            }
          >
            <fieldset className="agents-choices">
              <legend>{de ? "Modus" : "Mode"}</legend>
              {MODES.map((mode) => {
                const above =
                  guard?.maxMode !== undefined &&
                  MODES.indexOf(mode) > MODES.indexOf(guard.maxMode);
                return (
                  <label key={mode} className="agents-check">
                    <input
                      type="radio"
                      name="agent-mode"
                      className="input"
                      checked={config.mode === mode}
                      disabled={above}
                      onChange={() => update({ ...config, mode })}
                    />
                    <span>
                      <strong>{modeText(mode, locale)}</strong> ·{" "}
                      {modeHint(mode, locale)}
                      {above &&
                        ` (${de ? "von der Vorlage ausgeschlossen" : "excluded by the template"})`}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="agents-note">
              {de
                ? "Einzelne Vorschläge dieses Agenten ohne Einzelfreigabe erlaubst du unter "
                : "To let single proposals of this agent run without a decision each time, use "}
              <AppLink href={settingsHref}>
                {de
                  ? "Einstellungen → KI & Budget → Agentenberechtigungen"
                  : "Settings → AI & budget → Agent permissions"}
              </AppLink>
              .
            </p>
            <fieldset className="agents-choices">
              <legend>{de ? "Benachrichtigen" : "Notify"}</legend>
              {(["sponsor", "agent_managers"] as const).map((who) => (
                <label key={who} className="agents-check">
                  <input
                    type="checkbox"
                    className="input"
                    checked={config.outputs.notify.includes(who)}
                    onChange={(e) =>
                      update({
                        ...config,
                        outputs: {
                          ...config.outputs,
                          notify: e.target.checked
                            ? [...config.outputs.notify, who]
                            : config.outputs.notify.filter((n) => n !== who),
                        },
                      })
                    }
                  />
                  <span>
                    {who === "sponsor"
                      ? de
                        ? "Den Sponsor (wer aktiviert hat)"
                        : "The sponsor (who activated it)"
                      : de
                        ? "Alle Owner des Projekts"
                        : "All project owners"}
                  </span>
                </label>
              ))}
              <label className="agents-field">
                <span>{de ? "Bei Fehlern" : "On failure"}</span>
                <select
                  className="input"
                  value={config.outputs.onFailure}
                  onChange={(e) =>
                    update({
                      ...config,
                      outputs: {
                        ...config.outputs,
                        onFailure: e.target.value as "notify" | "silent",
                      },
                    })
                  }
                >
                  <option value="notify">
                    {de ? "Benachrichtigen" : "Notify"}
                  </option>
                  <option value="silent">{de ? "Still" : "Silent"}</option>
                </select>
              </label>
            </fieldset>
            <DelegateChoice
              config={config}
              self={agent?.id}
              agents={others.data?.items ?? null}
              locale={locale}
              onChange={(delegateTo) => update({ ...config, delegateTo })}
            />
          </Section>
        </fieldset>

        {problems.length > 0 && !readOnly && (
          <Alert kind="warning">
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        <AgentError code={save.code} locale={locale} />
        {!readOnly && (
          <div className="agents-actions">
            <Button
              type="submit"
              disabled={save.pending || problems.length > 0}
            >
              {agent
                ? de
                  ? "Entwurf speichern"
                  : "Save draft"
                : de
                  ? "Agent als Entwurf anlegen"
                  : "Create agent as draft"}
            </Button>
            {touched && agent && (
              <span className="agents-note" role="status">
                {de ? "Ungespeicherte Änderungen" : "Unsaved changes"}
              </span>
            )}
          </div>
        )}
      </form>

      <Section
        id="review"
        title={sectionTitle("review", locale)}
        description={
          de
            ? "Was sich gegenüber der aktiven Version ändert. Die Aktivierung gilt genau für diesen Entwurf (Prüfsumme) und macht dich zum Sponsor."
            : "What changes against the active version. Activation applies to exactly this draft (hash) and makes you its sponsor."
        }
      >
        {!agent ? (
          <p className="agents-note">
            {de
              ? "Lege den Agenten zuerst als Entwurf an."
              : "Create the agent as a draft first."}
          </p>
        ) : (
          <ReviewActivate
            agent={agent}
            locale={locale}
            canActivate={isOwner && !touched && agent.status !== "disabled"}
            unsaved={touched}
            pending={activate.pending}
            code={activate.code}
            onActivate={activateDraft}
          />
        )}
      </Section>
    </div>
  );
}

/** The monthly and per-execution ceilings in USD, as text fields. */
export function BudgetFields({
  monthly,
  perRun,
  locale,
  onMonthly,
  onPerRun,
}: {
  monthly: string;
  perRun: string;
  locale: Locale;
  onMonthly(value: string): void;
  onPerRun(value: string): void;
}) {
  const de = locale === "de";
  return (
    <div className="agents-grid">
      <label className="agents-field">
        <span>{de ? "Pro Monat (USD)" : "Per month (USD)"}</span>
        <input
          className="input"
          inputMode="decimal"
          value={monthly}
          aria-invalid={usdToMicros(monthly) === null || undefined}
          onChange={(e) => onMonthly(e.target.value)}
        />
      </label>
      <label className="agents-field">
        <span>{de ? "Je Ausführung (USD)" : "Per execution (USD)"}</span>
        <input
          className="input"
          inputMode="decimal"
          value={perRun}
          aria-invalid={usdToMicros(perRun) === null || undefined}
          onChange={(e) => onPerRun(e.target.value)}
        />
      </label>
    </div>
  );
}

/**
 * A template's guided setup (ADR 0021 Phase 2): the module's steps, then
 * the budget and the create step. The agent is created as a draft; the
 * owner reviews and activates it on the agent's page as for every agent.
 * "All settings" switches to the full builder with the same values.
 */
export function GuidedSetup({
  template,
  setup,
  config,
  locale,
  readOnly,
  onChange,
  monthly,
  perRun,
  onMonthly,
  onPerRun,
  problems,
  pending,
  code,
  onSubmit,
  onShowAll,
}: {
  template: AgentTemplate;
  setup: AgentSetup;
  config: AgentConfig;
  locale: Locale;
  readOnly: boolean;
  onChange(next: AgentConfig): void;
  monthly: string;
  perRun: string;
  onMonthly(value: string): void;
  onPerRun(value: string): void;
  problems: string[];
  pending: boolean;
  code: string | null;
  onSubmit(): void;
  onShowAll(): void;
}) {
  const de = locale === "de";
  const budgetStep = setup.steps.length + 1;
  return (
    <form
      className="agents-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Section
        id="guided"
        title={`${de ? "Geführte Einrichtung" : "Guided setup"}: ${template.title[locale]}`}
        description={template.summary[locale]}
      >
        <fieldset disabled={readOnly} className="agents-fieldset">
          <ol className="agents-guided">
            {setup.steps.map((step, i) => (
              <li key={step.key}>
                <p className="agents-field-title">
                  {i + 1}. {step.title[locale]}
                </p>
                <step.component
                  config={config}
                  locale={locale}
                  disabled={readOnly}
                  onChange={onChange}
                />
              </li>
            ))}
            <li>
              <p className="agents-field-title">
                {budgetStep}. {de ? "Budget wählen" : "Choose the budget"}
              </p>
              <BudgetFields
                monthly={monthly}
                perRun={perRun}
                locale={locale}
                onMonthly={onMonthly}
                onPerRun={onPerRun}
              />
            </li>
            <li>
              <p className="agents-field-title">
                {budgetStep + 1}. {de ? "Anlegen" : "Create"}
              </p>
              <p className="agents-note">
                {de
                  ? "Der Agent wird als Entwurf angelegt. Danach prüfst und aktivierst du ihn als Owner; erst dann arbeitet er."
                  : "The agent is created as a draft. You then review and activate it as an owner; only then does it work."}
              </p>
            </li>
          </ol>
        </fieldset>
        {problems.length > 0 && !readOnly && (
          <Alert kind="warning">
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        <AgentError code={code} locale={locale} />
        <div className="agents-actions">
          {!readOnly && (
            <Button type="submit" disabled={pending || problems.length > 0}>
              {de ? "Agent als Entwurf anlegen" : "Create agent as draft"}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onShowAll}>
            {de ? "Alle Einstellungen" : "All settings"}
          </Button>
        </div>
      </Section>
    </form>
  );
}

/** The review of the saved draft against the active version, with the activation. */
export function ReviewActivate({
  agent,
  locale,
  canActivate,
  unsaved,
  pending,
  code,
  onActivate,
}: {
  agent: AgentView;
  locale: Locale;
  canActivate: boolean;
  unsaved?: boolean;
  pending?: boolean;
  code?: string | null;
  onActivate(): void;
}) {
  const de = locale === "de";
  const body = activationBody(agent);
  return (
    <div className="agents-review">
      <ReviewDiff active={agent.active} draft={agent.draft} locale={locale} />
      {agent.activation && (
        <p className="agents-note">
          {de ? "Aktive Version" : "Active version"} {agent.activation.version}{" "}
          · <span className="agents-hash">{agent.activation.configHash}</span>
        </p>
      )}
      {body ? (
        <>
          <p className="agents-field-title">
            {de ? "Prüfsumme des Entwurfs" : "Draft hash"}
          </p>
          <p className="agents-hash" data-testid="draft-hash">
            {body.configHash}
          </p>
          {unsaved && (
            <Alert kind="warning">
              {de
                ? "Speichere deine Änderungen zuerst; aktiviert wird nur der gespeicherte Entwurf."
                : "Save your changes first; only the saved draft is activated."}
            </Alert>
          )}
          <AgentError code={code} locale={locale} />
          {canActivate && (
            <Button type="button" disabled={pending} onClick={onActivate}>
              {agent.activation
                ? de
                  ? `Als Version ${agent.activation.version + 1} aktivieren`
                  : `Activate as version ${agent.activation.version + 1}`
                : de
                  ? "Aktivieren"
                  : "Activate"}
            </Button>
          )}
        </>
      ) : (
        <p className="agents-note">
          {de
            ? "Es gibt keinen Entwurf zum Aktivieren."
            : "There is no draft to activate."}
        </p>
      )}
    </div>
  );
}

function NumberField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange(n: number): void;
}) {
  return (
    <label className="agents-field">
      <span>
        {label} ({min}–{max})
      </span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
    </label>
  );
}

function KnowledgeChoice({
  config,
  locale,
  sources,
  onChange,
}: {
  config: AgentConfig;
  locale: Locale;
  sources: Entity[] | null;
  onChange(knowledge: AgentConfig["knowledge"]): void;
}) {
  const de = locale === "de";
  const k = config.knowledge ?? {};
  const set = (next: NonNullable<AgentConfig["knowledge"]>) => {
    const clean: NonNullable<AgentConfig["knowledge"]> = {};
    if (next.sourceIds?.length) clean.sourceIds = next.sourceIds;
    if (next.audiences?.length) clean.audiences = next.audiences;
    onChange(clean.sourceIds || clean.audiences ? clean : null);
  };
  const toggle = <T,>(list: T[] | undefined, item: T, on: boolean) =>
    on ? [...(list ?? []), item] : (list ?? []).filter((x) => x !== item);
  return (
    <>
      <fieldset className="agents-choices">
        <legend>{de ? "Zielgruppen" : "Audiences"}</legend>
        {(["all", "marketing", "support"] as const).map((audience) => (
          <label key={audience} className="agents-check">
            <input
              type="checkbox"
              className="input"
              checked={Boolean(k.audiences?.includes(audience))}
              onChange={(e) =>
                set({
                  ...k,
                  audiences: toggle(k.audiences, audience, e.target.checked),
                })
              }
            />
            <span>
              {audience === "all"
                ? de
                  ? "Alle"
                  : "All"
                : moduleLabel(audience, de)}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="agents-choices">
        <legend>
          {de ? "Quellen (höchstens 50)" : "Sources (at most 50)"}
        </legend>
        {sources === null ? (
          <p className="agents-note">
            {de
              ? "Die Quellen des Wissensmoduls sind hier nicht abrufbar (Modul aus oder kein Zugriff)."
              : "The knowledge module's sources cannot be listed here (module off or no access)."}
          </p>
        ) : !sources.length ? (
          <p className="agents-note">
            {de ? "Noch keine Quellen." : "No sources yet."}
          </p>
        ) : (
          <div className="agents-scroll-list">
            {sources.map((source) => {
              const checked = Boolean(k.sourceIds?.includes(source.id));
              return (
                <label key={source.id} className="agents-check">
                  <input
                    type="checkbox"
                    className="input"
                    checked={checked}
                    disabled={!checked && (k.sourceIds?.length ?? 0) >= 50}
                    onChange={(e) =>
                      set({
                        ...k,
                        sourceIds: toggle(
                          k.sourceIds,
                          source.id,
                          e.target.checked,
                        ),
                      })
                    }
                  />
                  <span>{String(source.data.name ?? source.id)}</span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>
    </>
  );
}

function DelegateChoice({
  config,
  self,
  agents,
  locale,
  onChange,
}: {
  config: AgentConfig;
  self?: string;
  agents: AgentView[] | null;
  locale: Locale;
  onChange(ids: string[]): void;
}) {
  const de = locale === "de";
  const choices = (agents ?? []).filter(
    (a) => a.id !== self && a.status !== "disabled",
  );
  if (!choices.length && !config.delegateTo.length) return null;
  return (
    <fieldset className="agents-choices">
      <legend>
        {de
          ? "Darf Arbeit weitergeben an (höchstens 5)"
          : "May hand work to (at most 5)"}
      </legend>
      {choices.map((a) => {
        const checked = config.delegateTo.includes(a.id);
        return (
          <label key={a.id} className="agents-check">
            <input
              type="checkbox"
              className="input"
              checked={checked}
              disabled={!checked && config.delegateTo.length >= 5}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...config.delegateTo, a.id]
                    : config.delegateTo.filter((id) => id !== a.id),
                )
              }
            />
            <span>{a.name}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

const newSchedule = (): ScheduleTrigger => ({
  kind: "schedule",
  rhythm: "daily",
  times: ["09:00"],
});

/** Edits the trigger list: manual, schedules (daily, weekly, interval) and events. */
export function TriggerEditor({
  triggers,
  events,
  locale,
  onChange,
}: {
  triggers: Trigger[];
  events: Catalog["events"];
  locale: Locale;
  onChange(triggers: Trigger[]): void;
}) {
  const de = locale === "de";
  const replace = (i: number, t: Trigger) =>
    onChange(triggers.map((x, j) => (j === i ? t : x)));
  const remove = (i: number) => onChange(triggers.filter((_, j) => j !== i));
  const full = triggers.length >= MAX_TRIGGERS;
  return (
    <div className="agents-triggers">
      {!triggers.length && (
        <p className="agents-note">
          {de
            ? "Ohne Auslöser startet der Agent nie."
            : "Without a trigger the agent never starts."}
        </p>
      )}
      {triggers.map((trigger, i) => (
        <fieldset key={i} className="agents-trigger">
          <legend>
            {trigger.kind === "manual"
              ? de
                ? "Von Hand"
                : "By hand"
              : trigger.kind === "schedule"
                ? de
                  ? "Zeitplan"
                  : "Schedule"
                : de
                  ? "Ereignis"
                  : "Event"}
          </legend>
          {trigger.kind === "manual" && (
            <p className="agents-note">
              {de
                ? "Owner und Editoren können den Agenten auf seiner Seite starten."
                : "Owners and editors can start the agent from its page."}
            </p>
          )}
          {trigger.kind === "schedule" && (
            <ScheduleFields
              trigger={trigger}
              locale={locale}
              onChange={(t) => replace(i, t)}
            />
          )}
          {trigger.kind === "event" && (
            <div className="agents-grid">
              <label className="agents-field">
                <span>{de ? "Ereignis" : "Event"}</span>
                <select
                  className="input"
                  value={trigger.type}
                  onChange={(e) =>
                    replace(i, { ...trigger, type: e.target.value })
                  }
                >
                  {!events.some((e) => e.type === trigger.type) && (
                    <option value={trigger.type}>{trigger.type}</option>
                  )}
                  {events.map((e) => (
                    <option key={e.type} value={e.type}>
                      {e.title[locale]}
                      {e.sensitive
                        ? de
                          ? " (personenbezogen)"
                          : " (personal data)"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="agents-field">
                <span>
                  {de
                    ? "Zusammenfassen über Sekunden (0–3600)"
                    : "Debounce seconds (0–3600)"}
                </span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={3600}
                  value={trigger.debounceSeconds}
                  onChange={(e) =>
                    replace(i, {
                      ...trigger,
                      debounceSeconds: Math.min(
                        3600,
                        Math.max(0, Math.round(Number(e.target.value) || 0)),
                      ),
                    })
                  }
                />
              </label>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => remove(i)}
          >
            {de ? "Auslöser entfernen" : "Remove trigger"}
          </Button>
        </fieldset>
      ))}
      <div className="agents-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full || triggers.some((t) => t.kind === "manual")}
          onClick={() => onChange([...triggers, { kind: "manual" }])}
        >
          {de ? "Von Hand" : "By hand"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full}
          onClick={() => onChange([...triggers, newSchedule()])}
        >
          {de ? "Zeitplan" : "Schedule"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full || !events.length}
          onClick={() =>
            onChange([
              ...triggers,
              {
                kind: "event",
                type: events[0]!.type,
                filter: {},
                debounceSeconds: 0,
              },
            ])
          }
        >
          {de ? "Ereignis" : "Event"}
        </Button>
      </div>
      {!events.length && (
        <p className="agents-note">
          {de
            ? "Für die gewählten Module gibt es keine auslösbaren Ereignisse."
            : "The chosen modules declare no events an agent can start on."}
        </p>
      )}
    </div>
  );
}

function ScheduleFields({
  trigger,
  locale,
  onChange,
}: {
  trigger: ScheduleTrigger;
  locale: Locale;
  onChange(t: ScheduleTrigger): void;
}) {
  const de = locale === "de";
  const setRhythm = (rhythm: ScheduleTrigger["rhythm"]) =>
    onChange(
      rhythm === "interval"
        ? {
            kind: "schedule",
            rhythm,
            times: [],
            everyMinutes: trigger.everyMinutes ?? 240,
          }
        : rhythm === "weekly"
          ? {
              kind: "schedule",
              rhythm,
              times: trigger.times.length ? trigger.times : ["09:00"],
              days: trigger.days?.length ? trigger.days : [1],
            }
          : {
              kind: "schedule",
              rhythm,
              times: trigger.times.length ? trigger.times : ["09:00"],
            },
    );
  return (
    <>
      <label className="agents-field">
        <span>{de ? "Rhythmus" : "Rhythm"}</span>
        <select
          className="input"
          value={trigger.rhythm}
          onChange={(e) =>
            setRhythm(e.target.value as ScheduleTrigger["rhythm"])
          }
        >
          <option value="daily">{de ? "Täglich" : "Daily"}</option>
          <option value="weekly">{de ? "Wöchentlich" : "Weekly"}</option>
          <option value="interval">
            {de ? "In Abständen" : "At intervals"}
          </option>
        </select>
      </label>
      {trigger.rhythm === "interval" ? (
        <label className="agents-field">
          <span>
            {de ? "Alle Minuten (60–1440)" : "Every minutes (60–1440)"}
          </span>
          <input
            className="input"
            type="number"
            min={60}
            max={1440}
            value={trigger.everyMinutes ?? 240}
            onChange={(e) =>
              onChange({
                ...trigger,
                everyMinutes: Math.min(
                  1440,
                  Math.max(60, Math.round(Number(e.target.value) || 60)),
                ),
              })
            }
          />
        </label>
      ) : (
        <>
          <div className="agents-times">
            {trigger.times.map((time, j) => (
              <div key={j} className="agents-time">
                <label className="agents-field">
                  <span>{de ? `Uhrzeit ${j + 1}` : `Time ${j + 1}`}</span>
                  <input
                    className="input"
                    type="time"
                    step={60}
                    value={time}
                    onChange={(e) =>
                      onChange({
                        ...trigger,
                        times: trigger.times.map((t, k) =>
                          k === j ? e.target.value : t,
                        ),
                      })
                    }
                  />
                </label>
                {trigger.times.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={
                      de ? `Uhrzeit ${j + 1} entfernen` : `Remove time ${j + 1}`
                    }
                    onClick={() =>
                      onChange({
                        ...trigger,
                        times: trigger.times.filter((_, k) => k !== j),
                      })
                    }
                  >
                    {de ? "Entfernen" : "Remove"}
                  </Button>
                )}
              </div>
            ))}
            {trigger.times.length < 4 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({
                    ...trigger,
                    times: [...trigger.times, "17:00"].filter(
                      (t, k, all) => all.indexOf(t) === k,
                    ),
                  })
                }
              >
                {de ? "Uhrzeit hinzufügen" : "Add time"}
              </Button>
            )}
          </div>
          {trigger.rhythm === "weekly" && (
            <fieldset className="agents-days">
              <legend>{de ? "Tage" : "Days"}</legend>
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <label key={day} className="agents-check">
                  <input
                    type="checkbox"
                    className="input"
                    checked={Boolean(trigger.days?.includes(day))}
                    onChange={(e) =>
                      onChange({
                        ...trigger,
                        days: e.target.checked
                          ? [...(trigger.days ?? []), day].sort()
                          : (trigger.days ?? []).filter((d) => d !== day),
                      })
                    }
                  />
                  <span>{weekdayText(day, locale)}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
    </>
  );
}
