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
import { ApiError } from "@/lib/api";
import type { YearOverview } from "./api";
import { financeText } from "./labels";
import { errorText } from "./lists";
import {
  customValid,
  exportPeriod,
  FinanceReports,
  YearTables,
  yearOptions,
  yearOf,
} from "./reports";

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

function render(
  node: React.ReactNode,
  options: { canEdit?: boolean; access?: string } = {},
) {
  const canEdit = options.canEdit ?? true;
  const shell = {
    modules: options.access ? [{ id: "finance", access: options.access }] : [],
    hrefOf: (key: string) => `/p/p1/${key}`,
  } as unknown as ShellContextValue;
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
const MONTHS = Array.from(
  { length: 12 },
  (_, i) => `2026-${String(i + 1).padStart(2, "0")}`,
);
const overview = (extra: Partial<YearOverview> = {}): YearOverview => ({
  baseCurrency: "USD",
  year: 2026,
  months: MONTHS,
  categories: [
    {
      id: "c1",
      name: "Consulting",
      kind: "income",
      months: MONTHS.map((month, i) => ({
        month,
        amountMicros: i === 0 ? "1000000000" : "0",
      })),
      totalMicros: "1000000000",
    },
    {
      id: "c2",
      name: "Hosting",
      kind: "expense",
      months: MONTHS.map((month, i) => ({
        month,
        amountMicros: i < 2 ? "20000000" : "0",
      })),
      totalMicros: "40000000",
    },
    {
      id: null,
      name: null,
      kind: "expense",
      months: MONTHS.map((month) => ({ month, amountMicros: "0" })),
      totalMicros: "0",
    },
  ],
  costCenters: [
    { id: "k1", name: "uLiquid", expenseMicros: "30000000" },
    { id: null, name: null, expenseMicros: "10000000" },
  ],
  open: [
    {
      invoiceId: "i1",
      number: "INV-9",
      direction: "payable",
      counterpartyId: "cp1",
      currency: "EUR",
      issueDate: "2026-12-01",
      dueDate: "2027-01-15",
      openMicros: "50000000",
      openBaseMicros: "55000000",
    },
  ],
  creditsOpen: { count: 0, totalMicros: "0", items: [] },
  documents: [
    {
      id: "doc1",
      invoiceId: "i1",
      number: "INV-9",
      issueDate: "2026-12-01",
      counterparty: "Hosting GmbH",
      currency: "EUR",
      totalMicros: "50000000",
      totalBaseMicros: null,
      entryNumber: "2026-0042",
    },
  ],
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  search.value = "";
  answers["/counterparties"] = { items: [] };
  answers["/accounts"] = { items: [] };
  answers["/categories"] = { items: [] };
  answers["/cost-centers"] = { items: [] };
  answers["/settings"] = {
    settings: { baseCurrency: "USD", currencies: ["USD", "EUR"] },
    version: 1,
  };
  answers["/reports/year"] = overview();
  answers["/exports"] = {
    items: [
      {
        id: "x1",
        kind: "year_overview",
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-12-31T00:00:00.000Z",
        rowCount: 42,
        createdAt: "2026-01-02T08:00:00.000Z",
      },
    ],
  };
});
afterEach(() => vi.useRealTimers());

describe("export periods", () => {
  it("year overview export uses Jan 1 – Dec 31", () => {
    expect(exportPeriod("year_overview", 2025, null)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    // A custom period never changes the year overview: the server accepts
    // exactly one calendar year.
    expect(
      exportPeriod("year_overview", 2025, {
        from: "2025-03-01",
        to: "2025-04-30",
      }),
    ).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    // The journal and the documents default to the year, or use the custom period.
    expect(exportPeriod("journal_csv", 2025, null)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    expect(
      exportPeriod("documents_zip", 2025, {
        from: "2025-03-01",
        to: "2025-04-30",
      }),
    ).toEqual({ from: "2025-03-01", to: "2025-04-30" });
    expect(customValid({ from: "2025-03-01", to: "2025-02-01" })).toBe(false);
    expect(customValid({ from: "2025-02-30", to: "2025-03-01" })).toBe(false);
    expect(customValid({ from: "2025-03-01", to: "2025-03-01" })).toBe(true);
  });

  it("offers the current year and six before", () => {
    const now = new Date(NOW);
    expect(yearOptions(now, 2026)).toEqual([
      2026, 2025, 2024, 2023, 2022, 2021, 2020,
    ]);
    expect(yearOptions(now, 2010)[0]).toBe(2026);
    expect(yearOptions(now, 2010)).toContain(2010);
    expect(yearOf("2024", now)).toBe(2024);
    expect(yearOf("nonsense", now)).toBe(2026);
  });

  it("reads 413 and 422 as sentences", () => {
    expect(errorText(new ApiError("EXPORT_TOO_LARGE", 413), t)).toContain(
      "Export a shorter period",
    );
    expect(errorText(new ApiError("EXPORT_PERIOD_INVALID", 422), t)).toContain(
      "exactly one calendar year",
    );
    expect(errorText(new ApiError("SOMETHING_ELSE", 500), t)).toBe(
      "SOMETHING ELSE",
    );
  });
});

describe("FinanceReports", () => {
  it("reports offers the three exports", () => {
    search.value = "year=2025";
    const html = render(<FinanceReports />);
    for (const kind of ["year_overview", "journal_csv", "documents_zip"])
      expect(html).toContain(`data-export="${kind}"`);
    expect(html).toContain("Period: 2025-01-01 to 2025-12-31");
    expect(requested.some((p) => p.includes("/reports/year?year=2025"))).toBe(
      true,
    );
    // The history lists the stored export with a download link.
    expect(html).toContain("Export history");
    expect(html).toContain('href="/api/projects/p1/finance/exports/x1/file"');
    expect(html).toContain("2025-01-01 – 2025-12-31");
    // Print layout: actions are marked to be hidden on paper.
    expect(html).toContain("finance-noprint");
  });

  it("viewers see the report but no exports", () => {
    const html = render(<FinanceReports />, {
      canEdit: false,
      access: "viewer",
    });
    expect(html).not.toContain("data-export");
    expect(html).toContain("Exports need the editor or owner role.");
    expect(html).toContain("Hosting");
    expect(requested.some((p) => p.includes("/exports"))).toBe(false);
  });

  it("shows loading-free error and empty states", () => {
    answers["/reports/year"] = new Error("down");
    expect(render(<FinanceReports />)).toContain("failed");
    answers["/reports/year"] = overview({ categories: [] });
    expect(render(<FinanceReports />)).toContain(
      "Nothing was booked in this year.",
    );
  });
});

describe("YearTables", () => {
  const html = renderToStaticMarkup(
    <YearTables
      t={t}
      locale="en"
      overview={overview()}
      counterparties={new Map([["cp1", "Hosting GmbH"]])}
      fileUrl={(id) => `/files/${id}`}
      word={(key) => labels.en[key]}
    />,
  );

  it("is a categories by months table with real headers", () => {
    expect(html).toContain('<th scope="col">Category</th>');
    expect(html).toContain('<th scope="col" class="finance-num">Jan 26</th>');
    expect(html).toContain('<th scope="row">Consulting</th>');
    expect(html).toContain("$1,000.00");
    expect(html).toContain("Total income");
    expect(html).toContain("Total expenses");
    // Result = income − expenses.
    expect(html).toContain("Result: $960.00");
    expect(html).toContain("Uncategorized");
  });

  it("lists cost centers, open items and documents", () => {
    expect(html).toContain("Unassigned");
    expect(html).toContain("INV-9");
    expect(html).toContain("Hosting GmbH");
    expect(html).toContain("€50.00");
    expect(html).toContain("$55.00");
    // A document without a base total reads —, and links to its original.
    expect(html).toContain('href="/files/doc1"');
    expect(html).toContain("2026-0042");
    expect(html).toMatch(/<td class="finance-num">—<\/td>/);
    expect(html).not.toContain("(Credit)");
  });

  it("lists open credits apart from the invoices, as negative amounts", () => {
    const credit = {
      invoiceId: "cn1",
      number: "CN-3",
      direction: "payable" as const,
      counterpartyId: "cp1",
      currency: "USD",
      issueDate: "2026-11-01",
      dueDate: null,
      openMicros: "25000000",
      openBaseMicros: "25000000",
    };
    const withCredit = renderToStaticMarkup(
      <YearTables
        t={t}
        locale="en"
        overview={overview({
          creditsOpen: { count: 1, totalMicros: "25000000", items: [credit] },
        })}
        counterparties={new Map([["cp1", "Hosting GmbH"]])}
        fileUrl={(id) => `/files/${id}`}
        word={(key) => labels.en[key]}
      />,
    );
    expect(withCredit).toContain("CN-3 (Credit)");
    expect(withCredit).toContain("-$25.00");
    expect(withCredit).toContain("Credits are open credit notes");
  });
});
