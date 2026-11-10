"use client";
import { useEffect, useState } from "react";
import { put, useMutation, useResource, usd, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { aiErrorText, aiTasks, taskName } from "@/lib/ai-presets";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str, type FormField, type FormValues } from "@/platform/ui/form";
import { ASSISTANT_BUDGET_ANCHOR } from "@/platform/assistant/budget-notice";

// "Budget" and "Verbrauch" of an organization's AI area (plans/
// ai-central-management.md, phase C): one monthly budget for all projects,
// a cap per provider, the provider balances as last read, and the month's
// spend across projects. Since plan 2026-11-10 (WP2 B) three blocks show
// what limits apply: the organization's, the personal assistant's per
// member (with the members' usage as one sum) and each project's own
// spending authority, with state and origin. Organization owners only
// (decision D-6).

type Provider = "openai" | "anthropic";
type Level = "ok" | "warn" | "warn2" | "stopped" | null;
type Credit = { amountMicros: number; verifiedAt: string; note?: string };
type LimitState = "off" | "not_set" | "active";
type ProjectState = LimitState | "expired" | "invalid";
type Origin = { by: { id: string; name: string } | null; at: string } | null;
export type BudgetLevels = {
  organization: {
    state: LimitState;
    monthlyMicros: number | null;
    spentMicros: number;
    origin: Origin;
  };
  assistant: {
    /** ORBIT_PERSONAL_ASSISTANT is on. */
    available: boolean;
    state: LimitState;
    capMicros: number | null;
    perDayMicros: number | null;
    perAnswerMicros: number | null;
    /** All personal spaces of this month as one sum (ADR 0022). */
    usage: { spentMicros: number; unknownMicros: number; spaces: number };
    origin: Origin;
  };
  projects: {
    projectId: string;
    name: string;
    state: ProjectState;
    source: "platform" | "marketing_policy" | "none";
    monthlyBudgetMicros: number | null;
    dailyBudgetMicros: number | null;
    perRunBudgetMicros: number | null;
    endAt: string | null;
    spentMicros: number;
    origin: Origin;
  }[];
};
type BudgetView = {
  enabled: boolean;
  periodStart: string;
  budget: {
    monthlyMicros: number | null;
    /** The personal assistant's monthly cap per member (ADR 0022 D-09). */
    assistantPerUserMonthlyMicros?: number | null;
    providerCaps: Partial<Record<Provider, number>>;
    credits: Partial<Record<Provider, Credit>>;
    version: number;
  } | null;
  /** Absent from an older API. */
  levels?: BudgetLevels;
  spend: { spentMicros: number; reservedMicros: number; settledMicros: number; level: Level };
  providers: Record<Provider, { spentMicros: number; capMicros: number | null; level: Level }>;
  proposal: {
    providerCaps: Partial<Record<Provider, number>>;
    credits: Partial<Record<Provider, Credit>>;
    sources: { projectId: string; name: string; provider: Provider; stopMicros: number }[];
  };
};
type UsageRow = { key: string; spentMicros: number; unknownMicros: number; count: number };
type UsageView = {
  periodStart: string;
  projects: { projectId: string; name: string; spentMicros: number; unknownMicros: number; count: number }[];
  /** The personal spaces as one sum, never per user (ADR 0022). */
  assistants?: { spentMicros: number; unknownMicros: number; count: number; spaces: number };
  providers: UsageRow[];
  models: UsageRow[];
  tasks: UsageRow[];
};

const providerName: Record<Provider, string> = { anthropic: "Claude", openai: "OpenAI" };
const providers: Provider[] = ["anthropic", "openai"];

const text = {
  en: {
    title: "AI budget",
    intro:
      "One monthly budget for all projects of the organization and an optional cap per provider. Orbit stops a call before it would pass a limit; warnings at 75 % and 90 %.",
    off: "The organization's monthly budget and provider caps are saved but not applied on this installation yet, and spend is not counted against them. The personal assistant's cap per member applies regardless.",
    orgLevel: "Organization limit",
    orgHint: "One monthly amount for all projects of the organization, checked before every paid call.",
    assistantLevel: "Personal assistant per member",
    assistantLevelHint:
      "The only budget the personal assistant is paid from; project budgets never fund it. It applies whether or not the organization limit is switched on.",
    assistantUnavailable: "The personal assistant is switched off on this installation.",
    perAnswer: (answer: string, day: string) => `up to ${answer} per answer, ${day} per day`,
    assistantUsage: (spent: string, spaces: number) =>
      `${spent} this month across ${spaces} personal ${spaces === 1 ? "space" : "spaces"} (one sum, never per member)`,
    projectsLevel: "Project limits",
    projectsHint:
      "Each project's own AI spending authority (Settings → AI & budget in the project). A project call needs it and, while switched on, also fits the organization limit.",
    projectsEmpty: "No business projects yet.",
    projectLimits: (month: string, day: string, run: string) =>
      `${month} a month · ${day} a day · ${run} per run`,
    spentThisMonth: (spent: string) => `${spent} this month`,
    until: (date: string) => `until ${date}`,
    fromMarketing: "from the Marketing policy (rollback mode)",
    origin: (who: string, at: string) => `Set by ${who} on ${at}`,
    originAt: (at: string) => `Set on ${at}`,
    states: {
      organization: {
        off: "saved, not applied",
        not_set: "not set: no limit",
        active: "active",
      },
      assistant: {
        off: "USD 0: no paid answers",
        not_set: "not set: no paid answers",
        active: "active",
      },
      project: {
        off: "off",
        not_set: "no spending authority",
        active: "active",
        expired: "expired",
        invalid: "invalid",
      },
    },
    assistantsRow: (spaces: number) => `Personal assistants (${spaces} ${spaces === 1 ? "member" : "members"}, one sum)`,
    month: "This month",
    noLimit: "no limit",
    cap: "Cap",
    credit: "Balance at the provider",
    checked: "checked",
    levels: { ok: "", warn: "75 % reached", warn2: "90 % reached", stopped: "used up" },
    change: "Change",
    set: "Set budget",
    proposal: (list: string) =>
      `Your projects have their own provider budgets (${list}). Take them over as organization caps?`,
    adopt: "Use proposal",
    monthly: "Monthly budget for all projects (USD, empty: no limit)",
    capField: (p: string) => `Cap for ${p} per month (USD, empty: none)`,
    creditField: (p: string) => `Balance at ${p} as last read (USD, empty: unknown)`,
    creditHint: "Orbit cannot read the balance; it is shown with the date you enter it.",
    save: "Save",
    assistant: "Personal assistant per member",
    assistantNone: "none: no paid assistant turns",
    assistantField: "Monthly cap of the personal assistant per member (USD, empty: no paid assistant turns)",
    assistantHint:
      "Each member's assistant pays from their own personal space up to this amount a month; the organization budget counts it.",
    perMonth: "a month",
    usage: "AI usage",
    usageIntro: "Spend of the current month across projects: settled, open and unclear reservations.",
    unclear: "unclear",
    unclearHint:
      "Confirm unclear amounts in the project (Settings → AI & budget) after checking the provider's billing.",
    byProject: "By project",
    byProvider: "By provider",
    byModel: "By model",
    byTask: "By task",
    calls: "calls",
    empty: "No AI spend this month.",
  },
  de: {
    title: "KI-Budget",
    intro:
      "Ein Monatsbudget für alle Projekte der Organisation und optional eine Obergrenze pro Anbieter. Orbit stoppt einen Aufruf, bevor er ein Limit überschreiten würde; Warnungen bei 75 % und 90 %.",
    off: "Monatsbudget und Anbieter-Obergrenzen der Organisation werden auf dieser Installation gespeichert, aber noch nicht angewendet, und Ausgaben werden nicht dagegen gezählt. Die Obergrenze des persönlichen Assistenten pro Mitglied gilt trotzdem.",
    orgLevel: "Limit der Organisation",
    orgHint: "Ein Monatsbetrag für alle Projekte der Organisation, vor jedem bezahlten Aufruf geprüft.",
    assistantLevel: "Persönlicher Assistent pro Mitglied",
    assistantLevelHint:
      "Das einzige Budget, aus dem der persönliche Assistent bezahlt wird; Projektbudgets gelten dafür nie. Es gilt unabhängig davon, ob das Limit der Organisation eingeschaltet ist.",
    assistantUnavailable: "Der persönliche Assistent ist auf dieser Installation ausgeschaltet.",
    perAnswer: (answer: string, day: string) => `bis ${answer} pro Antwort, ${day} pro Tag`,
    assistantUsage: (spent: string, spaces: number) =>
      `${spent} diesen Monat über ${spaces} ${spaces === 1 ? "persönlichen Bereich" : "persönliche Bereiche"} (eine Summe, nie pro Mitglied)`,
    projectsLevel: "Limits der Projekte",
    projectsHint:
      "Die eigene KI-Ausgabefreigabe jedes Projekts (im Projekt unter Einstellungen → KI & Budget). Ein Projektaufruf braucht sie und muss, wenn eingeschaltet, auch in das Limit der Organisation passen.",
    projectsEmpty: "Noch keine Projekte.",
    projectLimits: (month: string, day: string, run: string) =>
      `${month} im Monat · ${day} am Tag · ${run} pro Lauf`,
    spentThisMonth: (spent: string) => `${spent} diesen Monat`,
    until: (date: string) => `bis ${date}`,
    fromMarketing: "aus der Marketing-Richtlinie (Rückfallmodus)",
    origin: (who: string, at: string) => `Festgelegt von ${who} am ${at}`,
    originAt: (at: string) => `Festgelegt am ${at}`,
    states: {
      organization: {
        off: "gespeichert, nicht angewendet",
        not_set: "nicht gesetzt: kein Limit",
        active: "aktiv",
      },
      assistant: {
        off: "0 USD: keine bezahlten Antworten",
        not_set: "nicht gesetzt: keine bezahlten Antworten",
        active: "aktiv",
      },
      project: {
        off: "aus",
        not_set: "keine Ausgabefreigabe",
        active: "aktiv",
        expired: "abgelaufen",
        invalid: "ungültig",
      },
    },
    assistantsRow: (spaces: number) =>
      `Persönliche Assistenten (${spaces} ${spaces === 1 ? "Mitglied" : "Mitglieder"}, eine Summe)`,
    month: "Dieser Monat",
    noLimit: "kein Limit",
    cap: "Obergrenze",
    credit: "Guthaben beim Anbieter",
    checked: "geprüft",
    levels: { ok: "", warn: "75 % erreicht", warn2: "90 % erreicht", stopped: "aufgebraucht" },
    change: "Ändern",
    set: "Budget festlegen",
    proposal: (list: string) =>
      `Deine Projekte haben eigene Anbieterbudgets (${list}). Als Obergrenzen der Organisation übernehmen?`,
    adopt: "Vorschlag übernehmen",
    monthly: "Monatsbudget für alle Projekte (USD, leer: kein Limit)",
    capField: (p: string) => `Obergrenze für ${p} pro Monat (USD, leer: keine)`,
    creditField: (p: string) => `Guthaben bei ${p}, zuletzt abgelesen (USD, leer: unbekannt)`,
    creditHint: "Orbit kann das Guthaben nicht abfragen; es wird mit dem Datum deiner Eingabe angezeigt.",
    save: "Speichern",
    assistant: "Persönlicher Assistent pro Mitglied",
    assistantNone: "keine: keine bezahlten Assistenten-Antworten",
    assistantField: "Monatliche Obergrenze des persönlichen Assistenten pro Mitglied (USD, leer: keine bezahlten Assistenten-Antworten)",
    assistantHint:
      "Der Assistent jedes Mitglieds bezahlt aus dessen persönlichem Bereich bis zu diesem Betrag im Monat; das Organisationsbudget zählt ihn mit.",
    perMonth: "im Monat",
    usage: "KI-Verbrauch",
    usageIntro: "Ausgaben des laufenden Monats über alle Projekte: abgerechnet, offen und unklar.",
    unclear: "unklar",
    unclearHint:
      "Unklare Beträge bestätigst du im jeweiligen Projekt (Einstellungen → KI & Budget), nachdem du die Abrechnung des Anbieters geprüft hast.",
    byProject: "Nach Projekt",
    byProvider: "Nach Anbieter",
    byModel: "Nach Modell",
    byTask: "Nach Aufgabe",
    calls: "Aufrufe",
    empty: "Diesen Monat keine KI-Ausgaben.",
  },
} as const;
type Text = (typeof text)["en" | "de"];
/** The panel texts of a locale (tests render the blocks with them). */
export const aiBudgetText = (locale: Locale): Text =>
  text[locale === "de" ? "de" : "en"];

function LevelBadge({ level, t }: { level: Level; t: Text }) {
  if (!level || level === "ok") return null;
  return <Badge tone={level === "stopped" ? "danger" : "warning"}>{t.levels[level]}</Badge>;
}

const stateTone = (state: ProjectState, limitIsOptional: boolean) =>
  state === "active"
    ? ("success" as const)
    : state === "not_set" && limitIsOptional
      ? ("neutral" as const)
      : ("warning" as const);

/** Who set a limit and when, if known. */
export function originText(origin: Origin, t: Text, locale: Locale) {
  if (!origin) return null;
  const at = when(origin.at, locale).split(",")[0] ?? origin.at;
  return origin.by ? t.origin(origin.by.name, at) : t.originAt(at);
}

/**
 * Scrolls to and focuses the assistant cap when the page was opened with
 * #assistant-budget (the personal assistant's notice links there).
 */
function useAssistantAnchor(ready: boolean) {
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    if (window.location.hash !== `#${ASSISTANT_BUDGET_ANCHOR}`) return;
    const target = document.getElementById(ASSISTANT_BUDGET_ANCHOR);
    target?.scrollIntoView?.({ block: "start" });
    target?.focus?.({ preventScroll: true });
  }, [ready]);
}

/** The three levels: organization, assistant per member, projects (WP2 B). */
export function BudgetLevelBlocks({
  levels,
  t,
  locale,
}: {
  levels: BudgetLevels;
  t: Text;
  locale: Locale;
}) {
  const { assistant } = levels;
  // Who set the cap only once there is one: an unset cap was set by nobody.
  const assistantOrigin =
    assistant.capMicros === null
      ? null
      : originText(assistant.origin, t, locale);
  return (
    <>
      <div
        className="capability-readiness"
        id={ASSISTANT_BUDGET_ANCHOR}
        tabIndex={-1}
        aria-labelledby={`${ASSISTANT_BUDGET_ANCHOR}-title`}
      >
        <h3 className="field-heading" id={`${ASSISTANT_BUDGET_ANCHOR}-title`}>
          {t.assistantLevel}
        </h3>
        <p className="panel-note">{t.assistantLevelHint}</p>
        {!assistant.available && <Alert>{t.assistantUnavailable}</Alert>}
        <div className="data-row">
          <div>
            <strong>{assistantCapText(assistant.capMicros, t)}</strong>
            {assistant.perAnswerMicros !== null && assistant.perDayMicros !== null && assistant.capMicros ? (
              <p>{t.perAnswer(usd(assistant.perAnswerMicros), usd(assistant.perDayMicros))}</p>
            ) : null}
            <p>{t.assistantUsage(usd(assistant.usage.spentMicros), assistant.usage.spaces)}</p>
            {assistantOrigin && <p>{assistantOrigin}</p>}
          </div>
          <Badge tone={stateTone(assistant.state, false)}>
            {t.states.assistant[assistant.state]}
          </Badge>
        </div>
      </div>
      <div className="capability-readiness">
        <h3 className="field-heading">{t.projectsLevel}</h3>
        <p className="panel-note">{t.projectsHint}</p>
        {levels.projects.length === 0 && <p className="panel-note">{t.projectsEmpty}</p>}
        {levels.projects.map((p) => {
          const origin = originText(p.origin, t, locale);
          return (
            <div className="data-row" key={p.projectId}>
              <div>
                <strong>{p.name}</strong>
                {p.monthlyBudgetMicros !== null && (
                  <p>
                    {t.projectLimits(
                      usd(p.monthlyBudgetMicros),
                      usd(p.dailyBudgetMicros),
                      usd(p.perRunBudgetMicros),
                    )}
                    {p.endAt ? ` · ${t.until(when(p.endAt, locale).split(",")[0] ?? p.endAt)}` : ""}
                  </p>
                )}
                <p>
                  {t.spentThisMonth(usd(p.spentMicros))}
                  {p.source === "marketing_policy" ? ` · ${t.fromMarketing}` : ""}
                </p>
                {origin && <p>{origin}</p>}
              </div>
              <Badge tone={stateTone(p.state, false)}>{t.states.project[p.state]}</Badge>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function AiBudgetPanel({ base, locale }: { base: string; locale: Locale }) {
  const t = text[locale === "de" ? "de" : "en"];
  const view = useResource<BudgetView>(`${base}/ai/budget`);
  const [editing, setEditing] = useState<"current" | "proposal" | null>(null);
  useAssistantAnchor(Boolean(view.data));
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ResourceError error={view.error} retry={view.refresh} />;
  const v = view.data;
  const proposed = providers.filter(
    (p) => v.proposal.providerCaps[p] !== undefined && v.budget?.providerCaps[p] === undefined,
  );
  const organization = v.levels?.organization;
  const organizationOrigin = organization ? originText(organization.origin, t, locale) : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
        <Button variant="outline" onClick={() => setEditing("current")}>
          {v.budget ? t.change : t.set}
        </Button>
      </div>
      {!v.enabled && <Alert kind="warning">{t.off}</Alert>}
      {proposed.length > 0 && (
        <Alert>
          {t.proposal(
            proposed.map((p) => `${providerName[p]} ${usd(v.proposal.providerCaps[p]!)}`).join(", "),
          )}{" "}
          <Button variant="outline" onClick={() => setEditing("proposal")}>
            {t.adopt}
          </Button>
        </Alert>
      )}
      <div className="capability-readiness">
        {v.levels && (
          <>
            <h3 className="field-heading">{t.orgLevel}</h3>
            <p className="panel-note">{t.orgHint}</p>
          </>
        )}
        <div className="data-row">
          <div>
            <strong>{t.month}</strong>
            <p>
              {usd(v.spend.spentMicros)} /{" "}
              {v.budget?.monthlyMicros == null ? t.noLimit : usd(v.budget.monthlyMicros)}
            </p>
            {organizationOrigin && <p>{organizationOrigin}</p>}
          </div>
          <LevelBadge level={v.spend.level} t={t} />
          {organization && (
            <Badge tone={stateTone(organization.state, true)}>
              {t.states.organization[organization.state]}
            </Badge>
          )}
        </div>
        {providers.map((p) => {
          const credit = v.budget?.credits[p];
          return (
            <div className="data-row" key={p}>
              <div>
                <strong>{providerName[p]}</strong>
                <p>
                  {usd(v.providers[p].spentMicros)} / {t.cap}{" "}
                  {v.providers[p].capMicros === null ? t.noLimit : usd(v.providers[p].capMicros!)}
                  {credit
                    ? ` · ${t.credit} ${usd(credit.amountMicros)} (${t.checked} ${when(credit.verifiedAt, locale).split(",")[0]})`
                    : ""}
                </p>
              </div>
              <LevelBadge level={v.providers[p].level} t={t} />
            </div>
          );
        })}
        {!v.levels && (
          <div className="data-row">
            <div>
              <strong>{t.assistant}</strong>
              <p>{assistantCapText(v.budget?.assistantPerUserMonthlyMicros, t)}</p>
            </div>
          </div>
        )}
      </div>
      {v.levels && <BudgetLevelBlocks levels={v.levels} t={t} locale={locale} />}
      {editing && (
        <BudgetForm
          base={base}
          locale={locale}
          view={v}
          useProposal={editing === "proposal"}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            view.refresh();
          }}
        />
      )}
    </section>
  );
}

/** The member cap as shown: an amount a month, or none. */
export function assistantCapText(micros: number | null | undefined, t: Text) {
  return micros == null ? t.assistantNone : `${usd(micros)} ${t.perMonth}`;
}

/** The cap field's value as micros; empty is null (no paid assistant turns). */
export function assistantCapMicros(values: FormValues): number | null {
  return microsOf(values, "assistant") ?? null;
}

/** The fields of the budget form; the assistant cap after the monthly budget. */
export function budgetFields(
  t: Text,
  view: Pick<BudgetView, "budget">,
  caps: Partial<Record<Provider, number>>,
  credits: Partial<Record<Provider, Credit>>,
): FormField[] {
  return [
    {
      name: "monthly",
      label: t.monthly,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(view.budget?.monthlyMicros),
    },
    {
      name: "assistant",
      label: t.assistantField,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(view.budget?.assistantPerUserMonthlyMicros),
      hint: t.assistantHint,
    },
    ...providers.map(
      (p): FormField => ({
        name: `cap-${p}`,
        label: t.capField(providerName[p]),
        type: "number",
        step: "0.01",
        min: 0,
        value: dollars(caps[p]),
      }),
    ),
    ...providers.map(
      (p): FormField => ({
        name: `credit-${p}`,
        label: t.creditField(providerName[p]),
        type: "number",
        step: "0.01",
        min: 0,
        value: dollars(credits[p]?.amountMicros),
        hint: t.creditHint,
      }),
    ),
  ];
}

const dollars = (micros: number | null | undefined) =>
  micros === null || micros === undefined ? "" : String(micros / 1_000_000);
const microsOf = (values: FormValues, key: string) => {
  const raw = str(values, key);
  return raw === "" ? undefined : Math.round(Number(raw) * 1_000_000);
};

function BudgetForm({
  base,
  locale,
  view,
  useProposal,
  onClose,
  onSaved,
}: {
  base: string;
  locale: Locale;
  view: BudgetView;
  useProposal: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = text[locale === "de" ? "de" : "en"];
  const mutation = useMutation(onSaved);
  const caps = { ...(view.budget?.providerCaps ?? {}), ...(useProposal ? view.proposal.providerCaps : {}) };
  const credits = { ...(useProposal ? view.proposal.credits : {}), ...(view.budget?.credits ?? {}) };
  const fields = budgetFields(t, view, caps, credits);
  return (
    <Modal title={t.title} onClose={onClose}>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={aiErrorText(mutation.error, locale)}
        submitLabel={t.save}
        cancelLabel={locale === "de" ? "Abbrechen" : "Cancel"}
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() => {
            const now = new Date().toISOString();
            const creditOf = (p: Provider) => {
              const amount = microsOf(values, `credit-${p}`);
              if (amount === undefined) return undefined;
              const known = credits[p];
              // An unchanged balance keeps the date it was read.
              return known && known.amountMicros === amount
                ? known
                : { amountMicros: amount, verifiedAt: now };
            };
            return put(`${base}/ai/budget`, {
              monthlyMicros: microsOf(values, "monthly") ?? null,
              assistantPerUserMonthlyMicros: assistantCapMicros(values),
              providerCaps: Object.fromEntries(
                providers.flatMap((p) => {
                  const cap = microsOf(values, `cap-${p}`);
                  return cap === undefined ? [] : [[p, cap]];
                }),
              ),
              credits: Object.fromEntries(
                providers.flatMap((p) => {
                  const credit = creditOf(p);
                  return credit ? [[p, credit]] : [];
                }),
              ),
            });
          })
        }
      />
    </Modal>
  );
}

function UsageList({
  title,
  rows,
  t,
  label = (key) => key,
}: {
  title: string;
  rows: UsageRow[];
  t: Text;
  label?: (key: string) => string;
}) {
  return (
    <div className="ai-usage-list">
      <h3 className="field-heading">{title}</h3>
      {rows.slice(0, 10).map((row) => (
        <div className="data-row" key={row.key}>
          <div>
            <strong>{label(row.key)}</strong>
            <p>
              {usd(row.spentMicros)} · {row.count} {t.calls}
              {row.unknownMicros > 0 ? ` · ${usd(row.unknownMicros)} ${t.unclear}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The "by project" rows: business projects, then the personal assistants
 * as one row (the API sums them, never per member; ADR 0022).
 */
export function usageProjectRows(v: UsageView, t: Text): UsageRow[] {
  const rows: UsageRow[] = v.projects.map((p) => ({
    key: p.name,
    spentMicros: p.spentMicros,
    unknownMicros: p.unknownMicros,
    count: p.count,
  }));
  if (v.assistants && v.assistants.count > 0)
    rows.push({
      key: t.assistantsRow(v.assistants.spaces),
      spentMicros: v.assistants.spentMicros,
      unknownMicros: v.assistants.unknownMicros,
      count: v.assistants.count,
    });
  return rows.sort((a, b) => b.spentMicros - a.spentMicros);
}

export function AiUsagePanel({ base, locale }: { base: string; locale: Locale }) {
  const t = text[locale === "de" ? "de" : "en"];
  const view = useResource<UsageView>(`${base}/ai/usage`);
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ResourceError error={view.error} retry={view.refresh} />;
  const v = view.data;
  const rows = usageProjectRows(v, t);
  const spent = rows.reduce((n, p) => n + p.spentMicros, 0);
  const unclear = rows.reduce((n, p) => n + p.unknownMicros, 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.usage}</h2>
          <p>{t.usageIntro}</p>
        </div>
      </div>
      {unclear > 0 && <Alert kind="warning">{t.unclearHint}</Alert>}
      {spent === 0 ? (
        <p className="panel-note">{t.empty}</p>
      ) : (
        <div className="settings-grid">
          <UsageList title={t.byProject} t={t} rows={rows} />
          <UsageList
            title={t.byProvider}
            t={t}
            rows={v.providers}
            label={(key) => providerName[key as Provider] ?? key}
          />
          <UsageList title={t.byModel} t={t} rows={v.models} />
          <UsageList
            title={t.byTask}
            t={t}
            rows={v.tasks}
            label={(key) => {
              const task = aiTasks.find((x) => x.id === key);
              return task ? taskName(task, locale) : key;
            }}
          />
        </div>
      )}
    </section>
  );
}
