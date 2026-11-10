"use client";
import { useState } from "react";
import {
  action,
  api,
  collectionPath,
  useMutation,
  useResource,
  usd,
  when,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  DataForm,
  str,
  type FormField,
  type FormValues,
} from "@/platform/ui/form";
import { Alert, Badge, Button, Modal } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

// The cost diagnosis on Operations (plan 2026-11-10, WP2 C), replacing the
// one-click "take over as settled": every open reservation of every month
// with what it was for, its run, a derived status (live, stale, unclear)
// and the next step. Owners and editors read it (the level of /ai-cost);
// only owners settle unclear rows, one by one, with a reason and an
// explicit confirmation, at the reserved amount. Nothing settles
// automatically.

export type ReservationStatus =
  | "reserved"
  | "in_flight"
  | "stale"
  | "settled"
  | "unknown"
  | "released";
export type ReservationItem = {
  id: string;
  createdAt: string;
  module: string;
  category: string;
  taskClass: string | null;
  provider: "openai" | "anthropic" | null;
  model: string | null;
  run: { id: string; kind: string; status: string; errorCode: string | null } | null;
  reservedMicros: string;
  settledMicros: string | null;
  status: ReservationStatus;
  providerConfirmed: boolean;
  nextAction: "wait" | "check_run" | "check_billing_then_settle" | "none";
};
export type ReservationPage = {
  items: ReservationItem[];
  nextCursor: string | null;
  staleAfterMs: number;
  summary: {
    month: {
      periodStart: string;
      settledMicros: number;
      inFlightMicros: number;
      staleMicros: number;
      unknownMicros: number;
      reservedMicros: number;
    };
    unknownAllMonths: { micros: number; count: number };
  } | null;
};

export const SETTLE_REASONS = [
  "provider_invoice_checked",
  "provider_dashboard_checked",
  "other",
] as const;

const texts = {
  en: {
    title: "AI cost diagnosis",
    intro:
      "Reservations still open, from every month. Each counts at its reserved amount until its run settles it or you take it over.",
    unclear: (amount: string) => `AI cost unclear: ${amount}`,
    unclearWhy:
      "The provider never confirmed these outcomes (for example interrupted calls or older image generations). Check the provider's billing, then take the rows you checked over as settled, each with a reason. Their months' totals do not change.",
    stale: (amount: string) => `${amount} stale this month`,
    staleWhy:
      "Stale rows are no longer a live call (their run ended or they are older than the longest job lease plus recovery). Orbit does not clear them automatically; check the run.",
    olderUnclear: (count: number, amount: string) =>
      `All months: ${count} unclear ${count === 1 ? "reservation" : "reservations"}, ${amount}.`,
    status: {
      reserved: "reserved",
      in_flight: "in flight",
      stale: "stale",
      unknown: "unclear",
      settled: "settled",
      released: "released",
    },
    next: {
      wait: "Still running; its run settles or releases it.",
      check_run:
        "No live call any more. Still counts at the reserved amount; check the run. Orbit does not clear it automatically.",
      check_billing_then_settle:
        "The provider did not confirm the outcome. Check the provider's billing, then take it over as settled with a reason (owners).",
      none: "Nothing to do.",
    },
    confirmed: "provider answered",
    notConfirmed: "no provider answer recorded",
    noRun: "no run recorded",
    select: (date: string) => `Select the reservation of ${date}`,
    settle: (n: number) => `Take over ${n} as settled…`,
    loadMore: "Load more",
    dialogTitle: "Take over unclear reservations as settled",
    dialogIntro: (n: number, amount: string) =>
      `${n} ${n === 1 ? "reservation" : "reservations"}, ${amount} in total, will be booked at the reserved amount. This cannot be undone.`,
    reason: "Reason",
    reasons: {
      provider_invoice_checked: "Checked the provider's invoice",
      provider_dashboard_checked: "Checked usage in the provider's dashboard",
      other: "Other reason (add a note)",
    },
    note: "Note (optional, up to 300 characters)",
    noteHint: "Orbit records only that a note was given (its length), not its text.",
    noteRequired: "Note (required for another reason, up to 300 characters)",
    noteRequiredHint:
      "Say what you checked: the action stays disabled until a note is given. Orbit records only its length, not its text.",
    confirm: "I checked the provider's billing for these reservations.",
    submit: "Take over as settled",
    settledNotice: (n: number) => `${n} ${n === 1 ? "reservation" : "reservations"} taken over as settled.`,
    modules: {
      marketing: "Marketing",
      support: "Support",
      knowledge: "Knowledge",
      finance: "Finance",
      work: "Projects",
      issues: "Issues",
      assistant: "Assistant",
      agents: "Agents",
      platform: "Platform",
    } as Record<string, string>,
  },
  de: {
    title: "KI-Kostendiagnose",
    intro:
      "Noch offene Reservierungen aus allen Monaten. Jede zählt mit ihrem reservierten Betrag, bis ihr Lauf sie abrechnet oder du sie übernimmst.",
    unclear: (amount: string) => `KI-Kosten unklar: ${amount}`,
    unclearWhy:
      "Der Anbieter hat diese Ergebnisse nie bestätigt (etwa abgebrochene Aufrufe oder ältere Bildgenerierungen). Prüfe die Abrechnung beim Anbieter und übernimm dann die geprüften Zeilen einzeln mit Begründung als abgerechnet. Die Monatsbeträge ändern sich dadurch nicht.",
    stale: (amount: string) => `${amount} veraltet diesen Monat`,
    staleWhy:
      "Veraltete Zeilen sind kein laufender Aufruf mehr (ihr Lauf ist beendet oder sie sind älter als die längste Job-Laufzeit plus Wiederanlauf). Orbit räumt sie nicht automatisch auf; prüfe den Lauf.",
    olderUnclear: (count: number, amount: string) =>
      `Alle Monate: ${count} ${count === 1 ? "unklare Reservierung" : "unklare Reservierungen"}, ${amount}.`,
    status: {
      reserved: "reserviert",
      in_flight: "läuft",
      stale: "veraltet",
      unknown: "unklar",
      settled: "abgerechnet",
      released: "freigegeben",
    },
    next: {
      wait: "Läuft noch; der Lauf rechnet ihn ab oder gibt ihn frei.",
      check_run:
        "Kein laufender Aufruf mehr. Zählt weiter mit dem reservierten Betrag; Lauf prüfen. Orbit räumt ihn nicht automatisch auf.",
      check_billing_then_settle:
        "Der Anbieter hat das Ergebnis nicht bestätigt. Abrechnung beim Anbieter prüfen, dann mit Begründung als abgerechnet übernehmen (Owner).",
      none: "Nichts zu tun.",
    },
    confirmed: "Anbieter hat geantwortet",
    notConfirmed: "keine Antwort des Anbieters erfasst",
    noRun: "kein Lauf erfasst",
    select: (date: string) => `Reservierung vom ${date} auswählen`,
    settle: (n: number) => `${n} als abgerechnet übernehmen…`,
    loadMore: "Weitere laden",
    dialogTitle: "Unklare Reservierungen als abgerechnet übernehmen",
    dialogIntro: (n: number, amount: string) =>
      `${n} ${n === 1 ? "Reservierung" : "Reservierungen"} mit zusammen ${amount} werden zum reservierten Betrag gebucht. Das lässt sich nicht rückgängig machen.`,
    reason: "Begründung",
    reasons: {
      provider_invoice_checked: "Rechnung des Anbieters geprüft",
      provider_dashboard_checked: "Nutzung im Anbieter-Dashboard geprüft",
      other: "Anderer Grund (Notiz ergänzen)",
    },
    note: "Notiz (optional, bis 300 Zeichen)",
    noteHint: "Orbit speichert nur, dass eine Notiz gegeben wurde (ihre Länge), nicht ihren Text.",
    noteRequired: "Notiz (bei anderem Grund nötig, bis 300 Zeichen)",
    noteRequiredHint:
      "Beschreibe, was du geprüft hast: ohne Notiz bleibt die Übernahme gesperrt. Orbit speichert nur ihre Länge, nicht ihren Text.",
    confirm: "Ich habe die Abrechnung des Anbieters für diese Reservierungen geprüft.",
    submit: "Als abgerechnet übernehmen",
    settledNotice: (n: number) =>
      `${n} ${n === 1 ? "Reservierung" : "Reservierungen"} als abgerechnet übernommen.`,
    modules: {
      marketing: "Marketing",
      support: "Support",
      knowledge: "Wissen",
      finance: "Finanzen",
      work: "Projekte",
      issues: "Issues",
      assistant: "Assistent",
      agents: "Agenten",
      platform: "Plattform",
    } as Record<string, string>,
  },
};
export type DiagnosisText = (typeof texts)["en"];
export const diagnosisText = (locale: Locale): DiagnosisText =>
  locale === "de" ? texts.de : texts.en;

const providerName = (id: string | null) =>
  id === "anthropic" ? "Claude" : id === "openai" ? "OpenAI" : "—";

/** The body of the owner's settle action: named rows, a reason, confirmed. */
export function settleBody(
  reservationIds: readonly string[],
  reason: (typeof SETTLE_REASONS)[number],
  note: string,
) {
  const trimmed = note.trim();
  return {
    reservationIds: [...reservationIds],
    reason,
    ...(trimmed ? { note: trimmed.slice(0, 300) } : {}),
    confirm: true as const,
  };
}

/** Pages loaded with "Load more", and the first page they continue. */
export type MorePages = {
  after: ReservationPage;
  items: ReservationItem[];
  cursor: string | null;
};

/**
 * The rows shown and the next cursor. Pages loaded after an earlier first
 * page are dropped once the first page is refreshed, so a refresh never
 * repeats rows; a row appears once.
 */
export function diagnosisRows(first: ReservationPage, more: MorePages | null) {
  const extra = more?.after === first ? more : null;
  const seen = new Set<string>();
  const items = [...first.items, ...(extra?.items ?? [])].filter((item) =>
    seen.has(item.id) ? false : (seen.add(item.id), true),
  );
  return { items, cursor: extra ? extra.cursor : first.nextCursor, extra };
}

/** Whether the diagnosis has anything to show: open rows or unclear amounts. */
export function diagnosisVisible(page: ReservationPage | null | undefined) {
  if (!page) return false;
  return (
    page.items.length > 0 || (page.summary?.unknownAllMonths.count ?? 0) > 0
  );
}

const statusTone = (status: ReservationStatus) =>
  status === "unknown" || status === "stale"
    ? ("warning" as const)
    : status === "settled"
      ? ("success" as const)
      : ("blue" as const);

/** The diagnosis as rendered, without data loading (tests render it). */
export function AiCostDiagnosisView({
  items,
  summary,
  locale,
  timezone,
  isOwner,
  selected,
  onToggle,
  onSettle,
  hasMore,
  onLoadMore,
}: {
  items: ReservationItem[];
  summary: ReservationPage["summary"];
  locale: Locale;
  timezone?: string;
  isOwner: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSettle: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const t = diagnosisText(locale);
  const month = summary?.month;
  return (
    <section className="panel" aria-labelledby="ai-cost-diagnosis-title">
      <div className="panel-head">
        <div>
          <h2 id="ai-cost-diagnosis-title">{t.title}</h2>
          <p>{t.intro}</p>
        </div>
        {isOwner && selected.size > 0 && (
          <Button variant="outline" onClick={onSettle}>
            {t.settle(selected.size)}
          </Button>
        )}
      </div>
      {month && month.unknownMicros > 0 && (
        <Alert kind="warning">
          <strong>{t.unclear(usd(month.unknownMicros))}</strong>
          <p>{t.unclearWhy}</p>
        </Alert>
      )}
      {month && month.staleMicros > 0 && (
        <Alert kind="warning">
          <strong>{t.stale(usd(month.staleMicros))}</strong>
          <p>{t.staleWhy}</p>
        </Alert>
      )}
      {summary && summary.unknownAllMonths.count > 0 && (
        <p className="panel-note">
          {t.olderUnclear(summary.unknownAllMonths.count, usd(summary.unknownAllMonths.micros))}
        </p>
      )}
      <div className="capability-readiness">
        {items.map((item) => {
          const date = when(item.createdAt, locale, timezone);
          const run = item.run
            ? [item.run.kind, item.run.status, item.run.errorCode].filter(Boolean).join(" · ")
            : t.noRun;
          const selectable = isOwner && item.status === "unknown";
          return (
            <div className="data-row" key={item.id} data-status={item.status}>
              {selectable && (
                <input
                  type="checkbox"
                  aria-label={t.select(date)}
                  checked={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                />
              )}
              <div>
                <strong>
                  {date} · {t.modules[item.module] ?? item.module} · {usd(Number(item.reservedMicros))}
                </strong>
                <p>
                  {providerName(item.provider)}
                  {item.model ? ` · ${item.model}` : ""} · {run} ·{" "}
                  {item.providerConfirmed ? t.confirmed : t.notConfirmed}
                </p>
                <p>{t.next[item.nextAction]}</p>
              </div>
              <Badge tone={statusTone(item.status)}>{t.status[item.status]}</Badge>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div className="form-actions">
          <Button size="sm" variant="outline" onClick={onLoadMore}>
            {t.loadMore}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The fields of the settle confirmation: reason, note, explicit
 * confirmation. The note is optional for a checked invoice or dashboard
 * and required for another reason (one field, its label and hint follow
 * the reason).
 */
export function settleFields(t: DiagnosisText): FormField[] {
  const checked = SETTLE_REASONS.filter((reason) => reason !== "other");
  return [
    {
      name: "reason",
      label: t.reason,
      type: "select",
      required: true,
      value: "provider_invoice_checked",
      options: SETTLE_REASONS.map((value) => ({ value, label: t.reasons[value] })),
    },
    {
      name: "note",
      label: t.note,
      type: "textarea",
      hint: t.noteHint,
      max: 300,
      showWhen: { name: "reason", values: [...checked] },
    },
    {
      name: "note",
      label: t.noteRequired,
      type: "textarea",
      hint: t.noteRequiredHint,
      max: 300,
      required: true,
      showWhen: { name: "reason", values: ["other"] },
    },
    { name: "confirm", label: t.confirm, type: "checkbox", required: true, value: false },
  ];
}

/** Whether the form may be sent: another reason needs a note that is not blank. */
export function settleReady(values: FormValues) {
  return str(values, "reason") !== "other" || str(values, "note") !== "";
}

export function AiCostDiagnosis() {
  const { locale, project, isOwner, canEdit, revision, refresh } = useWorkspace();
  const t = diagnosisText(locale);
  const first = useResource<ReservationPage>(
    canEdit
      ? collectionPath(project.id, `ai-reservations?state=open&revision=${revision}`)
      : null,
  );
  const [more, setMore] = useState<MorePages | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const loader = useMutation();
  const mutation = useMutation(() => {
    setConfirming(false);
    setSelected(new Set());
    setMore(null);
    first.refresh();
    refresh();
  });
  if (!canEdit || !diagnosisVisible(first.data)) return null;
  const page = first.data!;
  const { items, cursor, extra } = diagnosisRows(page, more);
  const chosen = items.filter((i) => selected.has(i.id) && i.status === "unknown");
  const total = chosen.reduce((n, i) => n + Number(i.reservedMicros), 0);
  return (
    <>
      {done !== null && <Alert kind="success">{t.settledNotice(done)}</Alert>}
      {loader.error && <Alert kind="error">{loader.error}</Alert>}
      <AiCostDiagnosisView
        items={items}
        summary={page.summary}
        locale={locale}
        timezone={project.timezone}
        isOwner={isOwner}
        selected={selected}
        onToggle={(id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onSettle={() => {
          setDone(null);
          mutation.clear();
          setConfirming(true);
        }}
        hasMore={Boolean(cursor)}
        onLoadMore={() =>
          void loader.run(async () => {
            const next = await api<ReservationPage>(
              collectionPath(
                project.id,
                `ai-reservations?state=open&cursor=${encodeURIComponent(cursor!)}`,
              ),
            );
            setMore({
              after: page,
              items: [...(extra?.items ?? []), ...next.items],
              cursor: next.nextCursor,
            });
          })
        }
      />
      {confirming && chosen.length > 0 && (
        <Modal
          title={t.dialogTitle}
          description={t.dialogIntro(chosen.length, usd(total))}
          onClose={() => setConfirming(false)}
        >
          <DataForm
            fields={settleFields(t)}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={t.submit}
            canSubmit={settleReady}
            onCancel={() => setConfirming(false)}
            onSubmit={(values) =>
              // The server needs confirm:true; it is sent only once checked,
              // and another reason only with a note.
              values.confirm !== true || !settleReady(values)
                ? undefined
                : mutation
                .run(() =>
                  action<{ settled: number }>(
                    project.id,
                    "settle-unknown-reservations",
                    settleBody(
                      chosen.map((i) => i.id),
                      str(values, "reason") as (typeof SETTLE_REASONS)[number],
                      str(values, "note"),
                    ),
                  ),
                )
                .then((result) => {
                  if (result) setDone(result.settled);
                })
            }
          />
        </Modal>
      )}
    </>
  );
}
