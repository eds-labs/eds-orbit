import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AiCostDiagnosisView,
  diagnosisText,
  diagnosisRows,
  diagnosisVisible,
  settleBody,
  settleFields,
  settleReady,
  type ReservationItem,
  type ReservationPage,
} from "./ai-cost-diagnosis";
import { operationsBudget, operationsText } from "./operations-text";
import { DataForm } from "@/platform/ui/form";

const item = (over: Partial<ReservationItem>): ReservationItem => ({
  id: "r1",
  createdAt: "2026-11-09T18:30:00.000Z",
  module: "support",
  category: "support_text",
  taskClass: "support_triage",
  provider: "anthropic",
  model: "claude-haiku-5-5",
  run: { id: "run1", kind: "support", status: "failed", errorCode: "SUPPORT_CALL_UNKNOWN" },
  reservedMicros: "100000",
  settledMicros: null,
  status: "unknown",
  providerConfirmed: false,
  nextAction: "check_billing_then_settle",
  ...over,
});
const summary: ReservationPage["summary"] = {
  month: {
    periodStart: "2026-11-01T00:00:00.000Z",
    settledMicros: 1_000_000,
    inFlightMicros: 100_000,
    staleMicros: 200_000,
    unknownMicros: 100_000,
    reservedMicros: 400_000,
  },
  unknownAllMonths: { micros: 800_000, count: 3 },
};
const view = (isOwner: boolean, selected = new Set<string>()) =>
  renderToStaticMarkup(
    <AiCostDiagnosisView
      items={[
        item({}),
        item({
          id: "r2",
          status: "stale",
          nextAction: "check_run",
          run: null,
          module: "marketing",
          provider: "openai",
          model: "gpt-image-1",
        }),
        item({
          id: "r3",
          status: "in_flight",
          nextAction: "wait",
          run: { id: "run3", kind: "chat", status: "running", errorCode: null },
          module: "assistant",
        }),
      ]}
      summary={summary}
      locale="de"
      isOwner={isOwner}
      selected={selected}
      onToggle={() => {}}
      onSettle={() => {}}
      hasMore
      onLoadMore={() => {}}
    />,
  );

describe("AI cost diagnosis (WP2 C)", () => {
  it("explains each row: module, provider, run, status and next step", () => {
    const html = view(false);
    expect(html).toContain("KI-Kosten unklar: $0.10");
    expect(html).toContain("$0.20 veraltet diesen Monat");
    expect(html).toContain("Alle Monate: 3 unklare Reservierungen, $0.80.");
    expect(html).toContain("Support · $0.10");
    expect(html).toContain("Claude · claude-haiku-5-5 · support · failed · SUPPORT_CALL_UNKNOWN");
    expect(html).toContain("kein Lauf erfasst");
    expect(html).toContain("Abrechnung beim Anbieter prüfen");
    expect(html).toContain("Orbit räumt ihn nicht automatisch auf");
    expect(html).toContain("Läuft noch");
    expect(html).toContain(">unklar<");
    expect(html).toContain(">veraltet<");
    expect(html).toContain("Weitere laden");
    // Editors read it; they never get the selection.
    expect(html).not.toContain('type="checkbox"');
  });

  it("lets owners select only unclear rows and offers the settle step once selected", () => {
    const none = view(true);
    expect(none.match(/type="checkbox"/g)).toHaveLength(1);
    expect(none).not.toContain("als abgerechnet übernehmen…");
    const chosen = view(true, new Set(["r1"]));
    expect(chosen).toContain("1 als abgerechnet übernehmen…");
  });

  it("sends named ids, a reason and confirm:true, never an empty bulk body", () => {
    expect(settleBody(["r1", "r2"], "other", "  Checked by phone  ")).toEqual({
      reservationIds: ["r1", "r2"],
      reason: "other",
      note: "Checked by phone",
      confirm: true,
    });
    expect(settleBody(["r1"], "provider_invoice_checked", " ")).toEqual({
      reservationIds: ["r1"],
      reason: "provider_invoice_checked",
      confirm: true,
    });
    const fields = settleFields(diagnosisText("en"));
    // One note field, optional for a checked invoice or dashboard and
    // required for another reason.
    expect(fields.map((f) => [f.name, f.required ?? false, f.showWhen?.values ?? null])).toEqual([
      ["reason", true, null],
      ["note", false, ["provider_invoice_checked", "provider_dashboard_checked"]],
      ["note", true, ["other"]],
      ["confirm", true, null],
    ]);
    expect(fields[0]!.options!.map((o) => o.value)).toEqual([
      "provider_invoice_checked",
      "provider_dashboard_checked",
      "other",
    ]);
  });

  it("keeps the action disabled for another reason until a note is given", () => {
    expect(settleReady({ reason: "provider_invoice_checked", note: "", confirm: true })).toBe(true);
    expect(settleReady({ reason: "other", note: "", confirm: true })).toBe(false);
    expect(settleReady({ reason: "other", note: "   ", confirm: true })).toBe(false);
    expect(settleReady({ reason: "other", note: "Checked by phone", confirm: true })).toBe(true);
    const t = diagnosisText("de");
    const form = (reason: string) =>
      renderToStaticMarkup(
        <DataForm
          fields={settleFields(t).map((f) => (f.name === "reason" ? { ...f, value: reason } : f))}
          pending={false}
          submitLabel={t.submit}
          canSubmit={settleReady}
          onSubmit={() => {}}
        />,
      );
    const other = form("other");
    expect(other).toContain(t.noteRequired);
    expect(other).toContain(t.noteRequiredHint);
    expect(other).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    const invoice = form("provider_invoice_checked");
    expect(invoice).toContain(t.note);
    expect(invoice).not.toContain(t.noteRequiredHint);
    expect(invoice).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("cancels in the member's language; other forms keep their default", () => {
    const t = diagnosisText("de");
    const form = (cancelLabel?: string) =>
      renderToStaticMarkup(
        <DataForm
          fields={settleFields(t)}
          pending={false}
          submitLabel={t.submit}
          cancelLabel={cancelLabel}
          onCancel={() => {}}
          onSubmit={() => {}}
        />,
      );
    expect(form("Abbrechen")).toMatch(/<button[^>]*type="button"[^>]*>Abbrechen</);
    expect(form()).toMatch(/<button[^>]*type="button"[^>]*>Cancel</);
  });

  it("drops the loaded pages when the first page refreshes, so no row repeats", () => {
    const first: ReservationPage = { items: [item({ id: "a" }), item({ id: "b" })], nextCursor: "b", staleAfterMs: 900_000, summary };
    const more = { after: first, items: [item({ id: "c" })], cursor: "c" };
    expect(diagnosisRows(first, more)).toMatchObject({ cursor: "c" });
    expect(diagnosisRows(first, more).items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    // A refresh (a new first page that already holds c) starts over.
    const refreshed: ReservationPage = { ...first, items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })], nextCursor: "c" };
    const after = diagnosisRows(refreshed, more);
    expect(after.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(after).toMatchObject({ cursor: "c", extra: null });
    // A row in two pages shows once.
    expect(diagnosisRows(first, { ...more, items: [item({ id: "b" }), item({ id: "c" })] }).items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("shows nothing without open rows or unclear amounts", () => {
    expect(diagnosisVisible(null)).toBe(false);
    expect(
      diagnosisVisible({
        items: [],
        nextCursor: null,
        staleAfterMs: 900_000,
        summary: { ...summary!, unknownAllMonths: { micros: 0, count: 0 } },
      }),
    ).toBe(false);
    expect(
      diagnosisVisible({ items: [item({})], nextCursor: null, staleAfterMs: 900_000, summary }),
    ).toBe(true);
  });
});

describe("the operations band", () => {
  it("labels the month scope and splits what is open, in both languages", () => {
    const budget = {
      periodStart: "2026-11-01T00:00:00.000Z",
      spentMicros: 1_000_000,
      reservedMicros: 400_000,
      inFlightMicros: 100_000,
      staleMicros: 200_000,
      unknownMicros: 100_000,
    };
    expect(operationsBudget(budget, "de")).toEqual({
      spend: "$1.00",
      open: "$0.40",
      since: "seit 1. Nov. (UTC-Monat)",
      split: "läuft $0.10 · veraltet $0.20 · unklar $0.10",
    });
    expect(operationsBudget(budget, "en").split).toBe(
      "in flight $0.10 · stale $0.20 · unclear $0.10",
    );
    // A viewer (no split since R26) or an older API keeps the totals only.
    expect(
      operationsBudget({ reservedMicros: 5, spentMicros: 0 }, "en"),
    ).toMatchObject({ since: null, split: null });
    expect(operationsText("de").execution).toBe("Projektausführung");
    // The English headings the browser checks stay as they were.
    expect(operationsText("en").worker).toBe("Worker and dispatch");
    expect(operationsText("en").outbox).toBe("Pending outbox");
  });
});
