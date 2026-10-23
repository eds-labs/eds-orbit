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
import type { Account, Invoice, Recurring } from "./api";
import { FinanceInvoices, invoiceFilters } from "./invoices";
import { financeText } from "./labels";
import {
  initialPayment,
  payable,
  PaymentFormView,
  paymentOf,
  sameSettlement,
  settlingDirection,
} from "./payment-form";
import {
  blankRecurring,
  FinanceRecurring,
  monthlyEquivalent,
  recurringBodyOf,
} from "./recurring";

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
  hrefOf: (key: string) => `/p/p1/${key}`,
} as unknown as ShellContextValue;

function render(node: React.ReactNode, canEdit = true) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale: "en" as Locale,
          t: (k) => labels.en[k],
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
const bank: Account = {
  id: BANK,
  code: "1200",
  name: "Bank",
  type: "asset",
  role: null,
  paymentAccount: true,
  currency: null,
  externalCode: null,
  version: 1,
  archivedAt: null,
};
const invoice = (extra: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1",
  kind: "invoice",
  direction: "payable",
  counterpartyId: "cp1",
  creditsInvoiceId: null,
  number: "INV-1",
  issueDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "EUR",
  netMicros: "100000000",
  taxMicros: "19000000",
  totalMicros: "119000000",
  status: "open",
  displayStatus: "overdue",
  openAmountMicros: "119000000",
  documentId: null,
  version: 1,
  ...extra,
});
const recurring = (extra: Partial<Recurring> = {}): Recurring => ({
  id: "r1",
  name: "Hosting",
  counterpartyId: "cp1",
  categoryId: null,
  allocation: null,
  interval: "quarterly",
  expectedAmountMicros: "100000000",
  currency: "USD",
  nextDueDate: "2026-11-01T00:00:00.000Z",
  active: true,
  match: null,
  version: 1,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  search.value = "";
  answers["/accounts"] = { items: [bank] };
  answers["/categories"] = { items: [] };
  answers["/cost-centers"] = { items: [] };
  answers["/counterparties"] = {
    items: [{ id: "cp1", name: "Hosting GmbH" }],
  };
  answers["/settings"] = {
    settings: { baseCurrency: "USD", currencies: ["USD", "EUR"] },
    version: 1,
  };
});
afterEach(() => vi.useRealTimers());

describe("record payment", () => {
  const two = [
    invoice(),
    invoice({
      id: "inv-2",
      number: "INV-2",
      openAmountMicros: "50000000",
      totalMicros: "50000000",
    }),
  ];
  const form = (change: Record<string, unknown> = {}) => ({
    ...initialPayment(two, "2026-10-23"),
    accountId: BANK,
    ...change,
  });

  it("defaults the allocations to the open amounts", () => {
    const initial = initialPayment(two, "2026-10-23");
    expect(initial.amount).toBe("169.00");
    expect(initial.rows.map((r) => r.allocation)).toEqual(["119.00", "50.00"]);
  });

  it("payment allocation must sum to the payment amount", () => {
    const ok = paymentOf(form(), two, t, { fxMissing: false });
    expect(ok.problems).toEqual([]);
    expect(ok.body).toEqual({
      direction: "outgoing",
      accountId: BANK,
      date: "2026-10-23",
      currency: "EUR",
      amountMicros: "169000000",
      allocations: [
        { invoiceId: "inv-1", amountMicros: "119000000" },
        { invoiceId: "inv-2", amountMicros: "50000000" },
      ],
    });

    // A payment larger than the allocations is blocked, with the sums named.
    const more = paymentOf(form({ amount: "170" }), two, t, {
      fxMissing: false,
    });
    expect(more.body).toBeNull();
    expect(more.problems.join(" ")).toContain(
      "The allocations add up to €169.00, the payment is €170.00",
    );
    // So is one smaller.
    expect(
      paymentOf(form({ amount: "100" }), two, t, { fxMissing: false }).body,
    ).toBeNull();
    // An allocation over what is open is blocked.
    const over = paymentOf(
      form({
        amount: "170",
        rows: [
          { invoiceId: "inv-1", allocation: "120" },
          { invoiceId: "inv-2", allocation: "50" },
        ],
      }),
      two,
      t,
      { fxMissing: false },
    );
    expect(over.body).toBeNull();
    expect(over.problems.join(" ")).toContain("more than the €119.00");
    // A part payment of an invoice sums too.
    const part = paymentOf(
      form({
        amount: "60",
        rows: [
          { invoiceId: "inv-1", allocation: "10" },
          { invoiceId: "inv-2", allocation: "50" },
        ],
      }),
      two,
      t,
      { fxMissing: false },
    );
    expect(part.problems).toEqual([]);
    expect(part.body).toMatchObject({ amountMicros: "60000000" });
  });

  it("blocks the submit button while the sums differ", () => {
    const html = (amount: string) =>
      render(
        <PaymentFormView
          t={t}
          locale="en"
          invoices={two}
          accounts={[bank]}
          baseCurrency="USD"
          onDone={() => {}}
          onCancel={() => {}}
        />,
      ).replace("169.00", amount);
    // No account chosen yet: the button is disabled and says why.
    expect(html("169.00")).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html("169.00")).toContain("Choose a payment account.");
  });

  it("settles invoices of one counterparty, direction and currency only", () => {
    const other = invoice({ id: "inv-3", counterpartyId: "cp2" });
    expect(sameSettlement([invoice(), other])).toBe(false);
    const mixed = paymentOf(
      { ...initialPayment([invoice(), other], "2026-10-23"), accountId: BANK },
      [invoice(), other],
      t,
      { fxMissing: false },
    );
    expect(mixed.body).toBeNull();
    expect(mixed.problems).toContain(t.payment.mixed);
    expect(
      sameSettlement([invoice(), invoice({ id: "x", currency: "USD" })]),
    ).toBe(false);
    // A credit note inverts the direction: only a refund settles it.
    const credit = invoice({ kind: "credit_note" });
    expect(settlingDirection(credit)).toBe("incoming");
    expect(settlingDirection(invoice({ direction: "receivable" }))).toBe(
      "incoming",
    );
    expect(sameSettlement([invoice(), credit])).toBe(false);
    expect(payable(invoice({ status: "paid" }))).toBe(false);
    expect(payable(invoice({ openAmountMicros: null }))).toBe(false);
  });

  it("asks for a rate after FX_RATE_MISSING", () => {
    const plain = paymentOf(form(), two, t, { fxMissing: true });
    expect(plain.body).toBeNull();
    expect(plain.problems).toContain(t.manage.rateInvalid);
    const rated = paymentOf(form({ rateOverride: "1.0850" }), two, t, {
      fxMissing: true,
    });
    expect(rated.body).toMatchObject({ rateOverride: "1.0850" });
  });
});

describe("FinanceInvoices", () => {
  it("filters by the url and shows open amount, due date and credits", () => {
    search.value = "direction=payable&status=overdue&invoice=inv-1";
    answers["/invoices/inv-1"] = {
      ...invoice(),
      lines: [],
      allocations: [
        {
          id: "a1",
          paymentId: "pay-1",
          amountMicros: "10000000",
          baseMicros: "11000000",
        },
      ],
    };
    answers["/invoices"] = {
      items: [
        invoice(),
        invoice({
          id: "cn-1",
          kind: "credit_note",
          number: "CN-1",
          creditsInvoiceId: "inv-1",
          displayStatus: "open",
        }),
      ],
    };
    const html = render(<FinanceInvoices />);
    expect(
      requested.some((p) =>
        p.endsWith("/invoices?direction=payable&status=overdue&limit=500"),
      ),
    ).toBe(true);
    expect(html).toMatch(/<option value="overdue" selected/);
    expect(html).toContain("2026-09-30");
    expect(html).toContain("€119.00");
    expect(html).toContain("Overdue");
    expect(html).toContain("Credits invoice INV-1");
    expect(html).toContain("Hosting GmbH");
    // Detail: the payment with its Void action and the invoice Void.
    expect(html).toContain("Void payment");
    expect(html).toContain("Void invoice");
    expect(html).toContain("Record payment");
    expect(invoiceFilters(new URLSearchParams("status=bogus")).status).toBe("");
  });

  it("viewers get a read-only list", () => {
    answers["/invoices"] = { items: [invoice()] };
    const html = render(<FinanceInvoices />, false);
    expect(html).not.toMatch(/<button[^>]*>Record payment/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("INV-1");
  });

  it("has empty and error states", () => {
    answers["/invoices"] = { items: [] };
    expect(render(<FinanceInvoices />)).toContain("No invoices yet");
    answers["/invoices"] = new Error("down");
    expect(render(<FinanceInvoices />)).toContain("failed");
  });
});

describe("recurring costs", () => {
  it("shows the monthly equivalent", () => {
    // Rounded half to even to the currency's decimals, like the server.
    expect(monthlyEquivalent("100000000", "quarterly", "USD")).toBe(
      33_330_000n,
    );
    expect(monthlyEquivalent("100000000", "yearly", "EUR")).toBe(8_330_000n);
    expect(monthlyEquivalent("100000000", "monthly", "EUR")).toBe(100_000_000n);
    expect(monthlyEquivalent("100000000", "weekly", "EUR")).toBeNull();
    answers["/recurring"] = { items: [recurring()] };
    const html = render(<FinanceRecurring />);
    expect(html).toContain("$100.00");
    expect(html).toContain("$33.33");
    expect(html).toContain("Quarterly");
    expect(html).toContain("2026-11-01");
    expect(html).toContain("Hosting GmbH");
    expect(html).toContain("Monthly total of active items: $33.33");
  });

  it("builds the body, with the allocation and the version on edit", () => {
    const form = {
      ...blankRecurring("USD", "2026-10-23"),
      name: " Hosting ",
      amount: "12,5",
    };
    const created = recurringBodyOf(form, t);
    expect(created.body).toEqual({
      name: "Hosting",
      counterpartyId: null,
      categoryId: null,
      allocation: null,
      interval: "monthly",
      expectedAmountMicros: "12500000",
      currency: "USD",
      nextDueDate: "2026-10-23",
    });
    const edited = recurringBodyOf({ ...form, id: "r1", version: 4 }, t);
    expect(edited.body).toMatchObject({ version: 4, active: true });
    expect(
      recurringBodyOf({ ...form, name: "", amount: "x" }, t).body,
    ).toBeNull();
  });

  it("is read-only for viewers and has empty and error states", () => {
    answers["/recurring"] = { items: [recurring({ active: false })] };
    const html = render(<FinanceRecurring />, false);
    expect(html).not.toContain("Add recurring cost");
    expect(html).toContain("Archived");
    answers["/recurring"] = { items: [] };
    expect(render(<FinanceRecurring />)).toContain("No recurring costs yet");
    answers["/recurring"] = new Error("down");
    expect(render(<FinanceRecurring />)).toContain("failed");
  });
});
