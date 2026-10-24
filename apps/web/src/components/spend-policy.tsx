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
import { Alert, Button, Loading, Modal, Status } from "./ui/primitives";
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
type Profile = "off" | "test" | "normal" | "custom";
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
      test: "Test: USD 1 per day, 10 per month, 0.50 per run, 14 days",
      normal: "Normal: USD 5 per day, 50 per month, 2 per run, one year",
      custom: "Custom values",
    },
    profileHint:
      "A profile sets every limit and the validity from now on. Module limits (Support, Finance) and provider budgets still apply on top.",
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
      test: "Test: 1 USD pro Tag, 10 pro Monat, 0,50 pro Lauf, 14 Tage",
      normal: "Normal: 5 USD pro Tag, 50 pro Monat, 2 pro Lauf, ein Jahr",
      custom: "Eigene Werte",
    },
    profileHint:
      "Ein Profil setzt alle Limits und die Gültigkeit ab jetzt. Modul-Limits (Support, Finanzen) und Anbieter-Budgets gelten zusätzlich.",
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
      value: (view.record?.profile as Profile | undefined) ?? "test",
      options: (["off", "test", "normal", "custom"] as const).map((p) => ({
        value: p,
        label: t.profiles[p],
      })),
      hint: t.profileHint,
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
            const profile = str(values, "profile") as Profile;
            return action(
              project.id,
              "ai-spend-policy",
              profile === "custom"
                ? {
                    profile,
                    startAt: new Date(str(values, "startAt")).toISOString(),
                    endAt: new Date(str(values, "endAt")).toISOString(),
                    approvedPaidUse: values.approvedPaidUse === true,
                    dailyBudgetMicros: micros(str(values, "daily")),
                    monthlyBudgetMicros: micros(str(values, "monthly")),
                    perRunBudgetMicros: micros(str(values, "perRun")),
                  }
                : { profile },
            );
          })
        }
      />
    </Modal>
  );
}
