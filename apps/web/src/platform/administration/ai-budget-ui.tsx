"use client";
import { useState } from "react";
import { put, useMutation, useResource, usd, when } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { aiErrorText, aiTasks, taskName } from "@/lib/ai-presets";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str, type FormField, type FormValues } from "@/platform/ui/form";

// "Budget" and "Verbrauch" of an organization's AI area (plans/
// ai-central-management.md, phase C): one monthly budget for all projects,
// a cap per provider, the provider balances as last read, and the month's
// spend across projects. Organization owners only (decision D-6).

type Provider = "openai" | "anthropic";
type Level = "ok" | "warn" | "warn2" | "stopped" | null;
type Credit = { amountMicros: number; verifiedAt: string; note?: string };
type BudgetView = {
  enabled: boolean;
  periodStart: string;
  budget: {
    monthlyMicros: number | null;
    providerCaps: Partial<Record<Provider, number>>;
    credits: Partial<Record<Provider, Credit>>;
    version: number;
  } | null;
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
    off: "Not switched on for this installation yet: limits are saved but not applied, and spend is not counted.",
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
    off: "Für diese Installation noch nicht eingeschaltet: Limits werden gespeichert, aber nicht angewendet, und Ausgaben werden nicht gezählt.",
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

function LevelBadge({ level, t }: { level: Level; t: Text }) {
  if (!level || level === "ok") return null;
  return <Badge tone={level === "stopped" ? "danger" : "warning"}>{t.levels[level]}</Badge>;
}

export function AiBudgetPanel({ base, locale }: { base: string; locale: Locale }) {
  const t = text[locale === "de" ? "de" : "en"];
  const view = useResource<BudgetView>(`${base}/ai/budget`);
  const [editing, setEditing] = useState<"current" | "proposal" | null>(null);
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ResourceError error={view.error} retry={view.refresh} />;
  const v = view.data;
  const proposed = providers.filter(
    (p) => v.proposal.providerCaps[p] !== undefined && v.budget?.providerCaps[p] === undefined,
  );
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
        <div className="data-row">
          <div>
            <strong>{t.month}</strong>
            <p>
              {usd(v.spend.spentMicros)} /{" "}
              {v.budget?.monthlyMicros == null ? t.noLimit : usd(v.budget.monthlyMicros)}
            </p>
          </div>
          <LevelBadge level={v.spend.level} t={t} />
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
      </div>
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
  const fields: FormField[] = [
    {
      name: "monthly",
      label: t.monthly,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(view.budget?.monthlyMicros),
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
  return (
    <Modal title={t.title} onClose={onClose}>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={aiErrorText(mutation.error, locale)}
        submitLabel={t.save}
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
    <div>
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

export function AiUsagePanel({ base, locale }: { base: string; locale: Locale }) {
  const t = text[locale === "de" ? "de" : "en"];
  const view = useResource<UsageView>(`${base}/ai/usage`);
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ResourceError error={view.error} retry={view.refresh} />;
  const v = view.data;
  const spent = v.projects.reduce((n, p) => n + p.spentMicros, 0);
  const unclear = v.projects.reduce((n, p) => n + p.unknownMicros, 0);
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
          <UsageList
            title={t.byProject}
            t={t}
            rows={v.projects.map((p) => ({ ...p, key: p.name }))}
          />
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
