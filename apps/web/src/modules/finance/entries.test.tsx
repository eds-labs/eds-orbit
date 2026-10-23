import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/p1/finance/bookings",
  useSearchParams: () => new URLSearchParams(search.value),
}));

// Every resource the page reads, by a part of its path; `requested` records
// every path asked for. The first matching key answers.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const requested = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      if (path) requested.push(path);
      const key = Object.keys(answers).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      const failed = found === undefined || found instanceof Error;
      return {
        data: failed ? null : found,
        error: failed
          ? Object.assign(new Error("failed"), {
              status: found instanceof Error ? 500 : 404,
            })
          : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import type { Account, JournalEntry, JournalLine } from "./api";
import {
  entriesQuery,
  entryFilters,
  FinanceEntries,
  paramsHref,
} from "./entries";
import { canReverse, EntryDetail, entryTotal } from "./entry-detail";
import { financeText } from "./labels";
import {
  adjustmentBalance,
  initialManual,
  ManualEntryForm,
  manualEntryOf,
} from "./manual-entry-form";
import { ReasonForm } from "./void-dialog";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [{ id: "w1", name: "Org one", role: "owner" }],
  projects: [project],
};
const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const shell = {
  modules: [],
  hrefOf: (key: string) =>
    key === "finance" ? "/p/p1/finance" : `/p/p1/${key}`,
} as unknown as ShellContextValue;

function render(
  node: React.ReactNode,
  options: { locale?: Locale; canEdit?: boolean } = {},
) {
  const locale = options.locale ?? "en";
  const canEdit = options.canEdit ?? true;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit,
          isOwner: canEdit,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const t = financeText("en");
const BANK = "11111111-1111-4111-8111-111111111111";
const HOSTING = "22222222-2222-4222-8222-222222222222";
const account = (id: string, code: string, name: string): Account => ({
  id,
  code,
  name,
  type: "asset",
  role: null,
  paymentAccount: true,
  currency: null,
  externalCode: null,
  version: 1,
  archivedAt: null,
});
const line = (extra: Partial<JournalLine>): JournalLine => ({
  id: "l1",
  entryId: "e1",
  accountId: BANK,
  side: "debit",
  currency: "EUR",
  amountMicros: "100000000",
  fxRate: "1.100000000000",
  rateDate: "2026-10-01",
  rateSource: "ecb",
  baseAmountMicros: "110000000",
  categoryId: null,
  costCenterId: null,
  ...extra,
});
const entry = (extra: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "e1",
  number: "2026-0001",
  entryDate: "2026-10-01T00:00:00.000Z",
  kind: "contribution",
  status: "posted",
  memo: "Seed money",
  documentId: null,
  sourceType: "manual",
  sourceId: null,
  reversalOfId: null,
  reversedById: null,
  lines: [
    line({}),
    line({
      id: "l2",
      accountId: HOSTING,
      side: "credit",
      amountMicros: "100000000",
    }),
  ],
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  search.value = "";
  answers["/accounts"] = {
    items: [account(BANK, "1200", "Bank"), account(HOSTING, "6300", "Hosting")],
  };
  answers["/categories"] = { items: [] };
  answers["/cost-centers"] = { items: [] };
  answers["/counterparties"] = { items: [] };
  answers["/settings"] = {
    settings: { baseCurrency: "USD", currencies: ["USD", "EUR", "USDC"] },
    version: 1,
  };
  answers["/entries"] = { items: [entry()] };
});
afterEach(() => vi.useRealTimers());

describe("entries filters", () => {
  it("entries filters are reflected in the url", () => {
    search.value =
      "period=lastYear&kind=adjustment&q=rent&account=a1&category=c1&costCenter=k1";
    const html = render(<FinanceEntries />);
    expect(
      requested.some((p) =>
        p.endsWith(
          "/entries?from=2025-01-01&to=2025-12-31&account=a1&category=c1&costCenter=k1&kind=adjustment&q=rent&limit=500",
        ),
      ),
    ).toBe(true);
    // The controls show what the URL says.
    expect(html).toMatch(/<option value="lastYear" selected/);
    expect(html).toMatch(/<option value="adjustment" selected/);
    expect(html).toContain('value="rent"');
    // A change writes back into the same URL, dropping an emptied filter.
    const params = new URLSearchParams("kind=adjustment&entry=e1");
    expect(
      paramsHref("/p/p1/finance/bookings", params, { kind: null, q: "rent" }),
    ).toBe("/p/p1/finance/bookings?entry=e1&q=rent");
    expect(
      paramsHref("/p/p1/finance/bookings", new URLSearchParams(), {
        kind: null,
      }),
    ).toBe("/p/p1/finance/bookings");
  });

  it("defaults to the last 12 months and ignores unknown periods", () => {
    expect(entryFilters(new URLSearchParams("period=bogus")).period).toBe(
      "12m",
    );
    expect(entryFilters(new URLSearchParams("period=all")).period).toBe("all");
    const now = new Date(NOW);
    expect(entriesQuery(entryFilters(new URLSearchParams("")), now)).toBe(
      "?from=2025-11-01&to=2026-10-31&limit=500",
    );
    expect(
      entriesQuery(entryFilters(new URLSearchParams("period=all")), now),
    ).toBe("?limit=500");
  });

  it("lists the bookings with their amount in the base currency", () => {
    const html = render(<FinanceEntries />);
    expect(html).toContain("2026-0001");
    expect(html).toContain("Seed money");
    expect(html).toContain("$110.00");
    expect(html).toContain('<th scope="col">Number</th>');
    // Writers get the manual entry button, viewers do not.
    expect(html).toContain("New entry");
    expect(render(<FinanceEntries />, { canEdit: false })).not.toContain(
      "New entry",
    );
  });

  it("shows loading-free empty and error states", () => {
    answers["/entries"] = { items: [] };
    expect(render(<FinanceEntries />)).toContain("No bookings yet");
    search.value = "kind=transfer";
    expect(render(<FinanceEntries />)).toContain(
      "No bookings match these filters.",
    );
    answers["/entries"] = new Error("down");
    expect(render(<FinanceEntries />)).toContain("failed");
  });
});

describe("entry detail", () => {
  const detail = (e: JournalEntry, canWrite = true) =>
    render(
      <EntryDetail
        t={t}
        locale="en"
        entry={e}
        accounts={[account(BANK, "1200", "Bank")]}
        baseCurrency="USD"
        numberOf={(id) => (id === "e0" ? "2026-0000" : null)}
        canWrite={canWrite}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );

  it("shows the lines with original amount, rate, rate date, source and base", () => {
    const html = detail(entry());
    expect(html).toContain("€100.00");
    expect(html).toContain("1.100000000000");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("ECB");
    expect(html).toContain("$110.00");
    expect(html).toContain('<th scope="col">In USD</th>');
    expect(html).toContain("finance-back");
    expect(html).toMatch(/<h2 tabindex="-1">/);
  });

  it("links the original document and shows the reversal relations", () => {
    const html = detail(
      entry({
        documentId: "doc-1",
        reversalOfId: "e0",
        reversedById: "e9",
      }),
    );
    expect(html).toContain('href="/p/p1/finance/review?document=doc-1"');
    expect(html).toContain("Reverses 2026-0000");
    expect(html).toContain("Reversed by —");
  });

  it("reverse is offered only for manual entries", () => {
    expect(canReverse(entry())).toBe(true);
    expect(canReverse(entry({ sourceType: "invoice", kind: "invoice" }))).toBe(
      false,
    );
    expect(canReverse(entry({ sourceType: "payment", kind: "payment" }))).toBe(
      false,
    );
    expect(canReverse(entry({ kind: "reversal" }))).toBe(false);
    expect(canReverse(entry({ reversedById: "e9" }))).toBe(false);

    expect(detail(entry())).toContain(">Reverse<");
    // Viewers see no action at all.
    expect(detail(entry(), false)).not.toContain(">Reverse<");
    // An invoice-sourced entry offers Void invoice instead, never Reverse.
    answers["/invoices/inv-1"] = {
      id: "inv-1",
      number: "INV-1",
      status: "open",
      version: 2,
      allocations: [],
    };
    const invoice = detail(
      entry({ sourceType: "invoice", sourceId: "inv-1", kind: "invoice" }),
    );
    expect(invoice).not.toContain(">Reverse<");
    expect(invoice).toContain("Void invoice");
    expect(invoice).toContain("Invoice INV-1");
    expect(invoice).toContain('href="/p/p1/finance/invoices?invoice=inv-1"');
    const payment = detail(
      entry({ sourceType: "payment", sourceId: "pay-1", kind: "payment" }),
    );
    expect(payment).not.toContain(">Reverse<");
    expect(payment).toContain("Void payment");
    // The payment's entry links to the invoices it settled.
    const linked = detail(
      entry({
        sourceType: "payment",
        sourceId: "pay-1",
        kind: "payment",
        paymentInvoices: [{ id: "inv-1", number: "INV-1" }],
      }),
    );
    expect(linked).toContain("Settles invoice INV-1");
    expect(linked).toContain('href="/p/p1/finance/invoices?invoice=inv-1"');
  });

  it("entryTotal sums the debit lines in base", () => {
    expect(entryTotal(entry())).toBe("110000000");
    expect(
      entryTotal({ lines: [line({ baseAmountMicros: "n/a" })] }),
    ).toBeNull();
  });
});

describe("reverse dialog", () => {
  const form = (reason: string) =>
    renderToStaticMarkup(
      <ReasonForm
        t={t}
        body="Posts an opposite booking."
        confirmLabel="Reverse"
        reason={reason}
        pending={false}
        error={null}
        onReason={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

  it("reverse asks for a reason", () => {
    const empty = form("");
    expect(empty).toContain("Reason");
    expect(empty).toMatch(/<textarea[^>]*required/);
    // The confirm button stays disabled until a reason is typed.
    expect(empty).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(form("   ")).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(form("Wrong account")).not.toMatch(
      /<button[^>]*type="submit"[^>]*disabled/,
    );
  });
});

describe("manual entries", () => {
  const adjustment = (lines: Array<[string, "debit" | "credit", string]>) => ({
    ...initialManual("USD", "2026-10-23"),
    kind: "adjustment" as const,
    lines: lines.map(([accountId, side, amount]) => ({
      accountId,
      side,
      amount,
    })),
  });

  it("adjustment blocks submit until balanced", () => {
    const unbalanced = adjustment([
      [BANK, "debit", "100"],
      [HOSTING, "credit", "90.50"],
    ]);
    expect(adjustmentBalance(unbalanced).difference).toBe(9_500_000n);
    const blocked = manualEntryOf(unbalanced, t, { fxMissing: false });
    expect(blocked.body).toBeNull();
    expect(blocked.problems.join(" ")).toContain("differ by $9.50");

    const html = render(
      <ManualEntryForm
        t={t}
        locale="en"
        accounts={[
          account(BANK, "1200", "Bank"),
          account(HOSTING, "6300", "Hosting"),
        ]}
        baseCurrency="USD"
        initial={unbalanced}
        onPosted={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("differ by $9.50");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);

    const balanced = adjustment([
      [BANK, "debit", "100"],
      [HOSTING, "credit", "100"],
    ]);
    const ok = manualEntryOf(balanced, t, { fxMissing: false });
    expect(ok.problems).toEqual([]);
    expect(ok.body).toEqual({
      kind: "adjustment",
      date: "2026-10-23",
      currency: "USD",
      lines: [
        { accountId: BANK, side: "debit", amount: "100.00" },
        { accountId: HOSTING, side: "credit", amount: "100.00" },
      ],
    });
    const open = render(
      <ManualEntryForm
        t={t}
        locale="en"
        accounts={[
          account(BANK, "1200", "Bank"),
          account(HOSTING, "6300", "Hosting"),
        ]}
        baseCurrency="USD"
        initial={balanced}
        onPosted={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(open).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("uses the booking form's decimal rules", () => {
    const base = { ...initialManual("USDC", "2026-10-23"), accountId: BANK };
    // 1,000 is ambiguous for USDC and refused, like in the booking form.
    expect(
      manualEntryOf({ ...base, amount: "1,000" }, t, { fxMissing: false }).body,
    ).toBeNull();
    const ok = manualEntryOf({ ...base, amount: "1.5" }, t, {
      fxMissing: false,
    });
    expect(ok.body).toEqual({
      kind: "contribution",
      accountId: BANK,
      amount: "1.500000",
      date: "2026-10-23",
      currency: "USDC",
    });
  });

  it("transfers need two different accounts and a rate once one is missing", () => {
    const base = {
      ...initialManual("EUR", "2026-10-23"),
      kind: "transfer" as const,
      amount: "10",
      fromAccountId: BANK,
      toAccountId: BANK,
    };
    expect(manualEntryOf(base, t, { fxMissing: false }).problems).toContain(
      "Choose two different accounts.",
    );
    const fixed = { ...base, toAccountId: HOSTING };
    expect(manualEntryOf(fixed, t, { fxMissing: false }).body).not.toBeNull();
    expect(manualEntryOf(fixed, t, { fxMissing: true }).body).toBeNull();
    expect(
      manualEntryOf({ ...fixed, rateOverride: "1.08" }, t, { fxMissing: true })
        .body,
    ).toMatchObject({ rateOverride: "1.08" });
  });
});
