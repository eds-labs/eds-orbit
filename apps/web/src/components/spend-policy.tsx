"use client";
import { useState } from "react";
import { CalendarClock, Coins, Wallet } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  usd,
  when,
} from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal, Status } from "./ui/primitives";
import { DataForm, str, type FormField } from "@/platform/ui/form";
import { Metric } from "@/platform/ui/metric";
import { useWorkspace } from "./workspace-context";

// Settings → AI & budget (ADR 0015): the project's AI spending authority.
// It belongs to the platform, so it is here with or without Marketing.
// Every paid model call of every module is reserved against it; module caps
// (Support, Finance) and provider budgets apply on top.

type Limits = {
  startAt: string;
  endAt: string;
  approvedPaidTests: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  perRunBudgetMicros: number;
};
type Profile = "off" | "test" | "normal" | "monthly" | "custom";
// The form's choices: monthly amounts (D-4) besides the profiles.
type Choice = "off" | "monthly-10" | "monthly-50" | "monthly" | "test" | "custom";
type OrgLevel = "ok" | "warn" | "warn2" | "stopped" | null;
type SpendPolicyView = {
  record: ({ id: string; version: number; profile?: Profile } & Record<
    string,
    unknown
  >) | null;
  source: "platform" | "marketing_policy" | "none";
  effective: Limits | null;
  active: boolean;
  problem: string | null;
  usage: { monthMicros: number; todayMicros: number };
  // The organization's budget the project draws on (phase C), while on.
  organization?: {
    monthlyMicros: number | null;
    spentMicros: number;
    level: OrgLevel;
    providers: Record<
      "openai" | "anthropic",
      { capMicros: number | null; spentMicros: number; level: OrgLevel }
    >;
  } | null;
};

const text = {
  en: {
    title: "AI spending authority",
    intro:
      "Every paid AI call (assistant, Support, Finance, knowledge search and Marketing) needs this approval. When a limit is reached, Orbit stops before the call; nothing is sent and nothing is charged.",
    active: "Paid AI allowed",
    inactive: "Paid AI not allowed",
    sources: {
      platform: "Set here.",
      marketing_policy:
        "Taken from the Marketing policy until you save it here once.",
      none: "Not set yet: no paid AI call runs.",
    },
    month: "Spent this month",
    today: "Spent today",
    limits: "Limits",
    window: "Valid until",
    change: "Change",
    set: "Set up",
    profile: "Profile",
    profiles: {
      off: "Off: no paid AI",
      "monthly-10": "USD 10 per month",
      "monthly-50": "USD 50 per month",
      monthly: "Own monthly amount",
      test: "Test: USD 1 per day, 10 per month, 0.50 per run, 14 days",
      custom: "Advanced: every limit and the validity",
    },
    profileHint:
      "A monthly amount applies for a year: a day may use a tenth of it, one run at most a day's share and never more than USD 2. Module limits (Support, Finance) and the organization's budget apply on top.",
    amount: "Per month (USD)",
    organization: "Organization budget this month",
    orgNone: "no monthly limit",
    orgLevels: { ok: "", warn: "75 % reached", warn2: "90 % reached", stopped: "used up" },
    startAt: "Valid from",
    endAt: "Valid until",
    approved: "Allow paid AI use",
    approvedHint: "Without it, every paid call is refused even within the limits.",
    daily: "Per day (USD)",
    monthly: "Per month (USD, from the 1st, UTC)",
    perRun: "Per run (USD): the most a single task may reserve",
    save: "Save spending authority",
    modal: "AI spending authority",
    saved: "Every save creates a new version and is recorded in the audit log.",
  },
  de: {
    title: "KI-Ausgabenfreigabe",
    intro:
      "Jeder bezahlte KI-Aufruf (Assistent, Support, Finanzen, Wissenssuche und Marketing) braucht diese Freigabe. Ist ein Limit erreicht, stoppt Orbit vor dem Aufruf; es wird nichts gesendet und nichts berechnet.",
    active: "Bezahlte KI erlaubt",
    inactive: "Bezahlte KI nicht erlaubt",
    sources: {
      platform: "Hier festgelegt.",
      marketing_policy:
        "Aus der Marketing-Richtlinie übernommen, bis du sie hier einmal speicherst.",
      none: "Noch nicht festgelegt: kein bezahlter KI-Aufruf läuft.",
    },
    month: "Ausgaben diesen Monat",
    today: "Ausgaben heute",
    limits: "Limits",
    window: "Gültig bis",
    change: "Ändern",
    set: "Einrichten",
    profile: "Profil",
    profiles: {
      off: "Aus: keine bezahlte KI",
      "monthly-10": "10 USD pro Monat",
      "monthly-50": "50 USD pro Monat",
      monthly: "Eigener Monatsbetrag",
      test: "Test: 1 USD pro Tag, 10 pro Monat, 0,50 pro Lauf, 14 Tage",
      custom: "Erweitert: alle Limits und die Gültigkeit",
    },
    profileHint:
      "Ein Monatsbetrag gilt ein Jahr: pro Tag ein Zehntel davon, pro Lauf höchstens ein Tagesanteil und nie mehr als 2 USD. Modul-Limits (Support, Finanzen) und das Budget der Organisation gelten zusätzlich.",
    amount: "Pro Monat (USD)",
    organization: "Budget der Organisation diesen Monat",
    orgNone: "kein Monatslimit",
    orgLevels: { ok: "", warn: "75 % erreicht", warn2: "90 % erreicht", stopped: "aufgebraucht" },
    startAt: "Gültig ab",
    endAt: "Gültig bis",
    approved: "Bezahlte KI-Nutzung erlauben",
    approvedHint:
      "Ohne diese Freigabe wird jeder bezahlte Aufruf abgelehnt, auch innerhalb der Limits.",
    daily: "Pro Tag (USD)",
    monthly: "Pro Monat (USD, ab dem 1., UTC)",
    perRun: "Pro Lauf (USD): höchstens so viel darf eine einzelne Aufgabe reservieren",
    save: "Ausgabenfreigabe speichern",
    modal: "KI-Ausgabenfreigabe",
    saved: "Jede Speicherung legt eine neue Version an und wird im Audit-Log festgehalten.",
  },
} as const;

const dollars = (micros: number) => (micros / 1_000_000).toString();
const micros = (value: string) => Math.round(Number(value) * 1_000_000);
const local = (iso: string) => iso.slice(0, 16);

export function SpendPolicySettings() {
  const { project, locale } = useWorkspace();
  const t = text[locale === "de" ? "de" : "en"];
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const view = useResource<SpendPolicyView>(
    collectionPath(project.id, `ai-spend-policy?revision=${revision}`),
  );
  const data = view.data;
  const limits = data?.effective;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
        {data && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            {data.record ? t.change : t.set}
          </Button>
        )}
      </div>
      {view.loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          <div className="data-row">
            <div>
              <strong>{data.active ? t.active : t.inactive}</strong>
              <p>{t.sources[data.source]}</p>
            </div>
            <Status value={data.active ? "ready" : "not_configured"} />
          </div>
          {data.problem && <Alert kind="warning">{data.problem}</Alert>}
          {data.organization && <OrganizationRow org={data.organization} t={t} />}
          <div className="metrics-strip">
            <Metric
              icon={Coins}
              label={t.month}
              amount={usd(data.usage.monthMicros)}
              detail={
                limits ? `${t.limits}: ${usd(limits.monthlyBudgetMicros)}` : undefined
              }
            />
            <Metric
              icon={Wallet}
              label={t.today}
              amount={usd(data.usage.todayMicros)}
              detail={
                limits
                  ? `${t.limits}: ${usd(limits.dailyBudgetMicros)} · ${usd(limits.perRunBudgetMicros)}`
                  : undefined
              }
            />
            {limits && (
              <Metric
                icon={CalendarClock}
                label={t.window}
                amount={when(limits.endAt)}
              />
            )}
          </div>
        </>
      ) : null}
      {editing && data && (
        <SpendPolicyForm
          view={data}
          t={t}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

/** The organization's month: total and per provider, with its level. */
function OrganizationRow({
  org,
  t,
}: {
  org: NonNullable<SpendPolicyView["organization"]>;
  t: (typeof text)["en"] | (typeof text)["de"];
}) {
  const part = (spent: number, limit: number | null, level: OrgLevel) =>
    `${usd(spent)} / ${limit === null ? t.orgNone : usd(limit)}${level && t.orgLevels[level] ? ` (${t.orgLevels[level]})` : ""}`;
  const capped = (["anthropic", "openai"] as const).filter(
    (p) => org.providers[p].capMicros !== null,
  );
  const worst = [org.level, ...capped.map((p) => org.providers[p].level)];
  return (
    <div className="data-row">
      <div>
        <strong>{t.organization}</strong>
        <p>
          {part(org.spentMicros, org.monthlyMicros, org.level)}
          {capped
            .map(
              (p) =>
                ` · ${p === "anthropic" ? "Claude" : "OpenAI"} ${part(org.providers[p].spentMicros, org.providers[p].capMicros, org.providers[p].level)}`,
            )
            .join("")}
        </p>
      </div>
      {worst.includes("stopped") ? (
        <Badge tone="danger">{t.orgLevels.stopped}</Badge>
      ) : worst.includes("warn2") ? (
        <Badge tone="warning">{t.orgLevels.warn2}</Badge>
      ) : worst.includes("warn") ? (
        <Badge tone="warning">{t.orgLevels.warn}</Badge>
      ) : null}
    </div>
  );
}

/** The form's choice for a saved record. */
function choiceOf(view: SpendPolicyView): Choice {
  const record = view.record as
    | { profile?: Profile; monthlyBudgetMicros?: number }
    | null;
  const profile = record?.profile;
  if (!profile) return "monthly-10";
  if (profile === "normal") return "monthly-50";
  if (profile !== "monthly") return profile;
  if (record?.monthlyBudgetMicros === 10_000_000) return "monthly-10";
  if (record?.monthlyBudgetMicros === 50_000_000) return "monthly-50";
  return "monthly";
}

function SpendPolicyForm({
  view,
  t,
  onClose,
  onSaved,
}: {
  view: SpendPolicyView;
  t: (typeof text)["en"] | (typeof text)["de"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { project } = useWorkspace();
  const mutation = useMutation(onSaved);
  const current = view.effective;
  const now = new Date();
  const custom = { name: "profile", values: ["custom"] };
  const fields: FormField[] = [
    {
      name: "profile",
      label: t.profile,
      type: "select",
      value: choiceOf(view),
      options: (
        ["off", "monthly-10", "monthly-50", "monthly", "test", "custom"] as const
      ).map((p) => ({
        value: p,
        label: t.profiles[p],
      })),
      hint: t.profileHint,
    },
    {
      name: "amount",
      label: t.amount,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(current?.monthlyBudgetMicros ?? 20_000_000),
      showWhen: { name: "profile", values: ["monthly"] },
    },
    {
      name: "startAt",
      label: t.startAt,
      type: "datetime-local",
      value: local(current?.startAt ?? now.toISOString()),
      showWhen: custom,
    },
    {
      name: "endAt",
      label: t.endAt,
      type: "datetime-local",
      value: local(
        current?.endAt ??
          new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      ),
      showWhen: custom,
    },
    {
      name: "approvedPaidUse",
      label: t.approved,
      type: "checkbox",
      value: current?.approvedPaidTests ?? true,
      hint: t.approvedHint,
      showWhen: custom,
    },
    {
      name: "daily",
      label: t.daily,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(current?.dailyBudgetMicros ?? 1_000_000),
      showWhen: custom,
    },
    {
      name: "monthly",
      label: t.monthly,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(current?.monthlyBudgetMicros ?? 10_000_000),
      showWhen: custom,
    },
    {
      name: "perRun",
      label: t.perRun,
      type: "number",
      step: "0.01",
      min: 0,
      value: dollars(current?.perRunBudgetMicros ?? 500_000),
      showWhen: custom,
    },
  ];
  return (
    <Modal title={t.modal} onClose={onClose}>
      <Alert>{t.saved}</Alert>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel={t.save}
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() => {
            const choice = str(values, "profile") as Choice;
            const monthly = {
              "monthly-10": 10_000_000,
              "monthly-50": 50_000_000,
              monthly: micros(str(values, "amount")),
            } as Partial<Record<Choice, number>>;
            return action(
              project.id,
              "ai-spend-policy",
              monthly[choice] !== undefined
                ? { profile: "monthly", monthlyBudgetMicros: monthly[choice] }
                : choice === "custom"
                ? {
                    profile: choice,
                    startAt: new Date(str(values, "startAt")).toISOString(),
                    endAt: new Date(str(values, "endAt")).toISOString(),
                    approvedPaidUse: values.approvedPaidUse === true,
                    dailyBudgetMicros: micros(str(values, "daily")),
                    monthlyBudgetMicros: micros(str(values, "monthly")),
                    perRunBudgetMicros: micros(str(values, "perRun")),
                  }
                : { profile: choice },
            );
          })
        }
      />
    </Modal>
  );
}
