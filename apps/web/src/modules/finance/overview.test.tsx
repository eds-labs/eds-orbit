import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

// Every resource the page reads, by a part of its path. A path without an
// entry answers 404. `requested` records every path asked for.
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
import { FinanceHome } from "./home";
import { FinanceOverview, periodOf, periodRange } from "./overview";

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

const zeroBucket = {
  count: 0,
  totalMicros: "0",
  payableMicros: "0",
  receivableMicros: "0",
};
const summary = (extra: Record<string, unknown> = {}) => ({
  baseCurrency: "USD",
  from: "2025-11-01",
  to: "2026-10-31",
  months: [
    {
      month: "2026-09",
      incomeMicros: "10000000",
      expenseMicros: "4000000",
      resultMicros: "6000000",
    },
    {
      month: "2026-10",
      incomeMicros: "250000000",
      expenseMicros: "40000000",
      resultMicros: "210000000",
    },
  ],
  open: { ...zeroBucket, count: 2, payableMicros: "3000000" },
  overdue: { ...zeroBucket, count: 1, totalMicros: "7000000" },
  recurringMonthlyMicros: "9000000",
  recurringMissingRate: 0,
  byCostCenter: [{ id: null, name: null, expenseMicros: "40000000" }],
  byCategory: [
    {
      id: "c1",
      name: "Hosting",
      months: [
        { month: "2026-09", expenseMicros: "1000000" },
        { month: "2026-10", expenseMicros: "2000000" },
      ],
    },
    {
      id: null,
      name: null,
      other: true,
      months: [{ month: "2026-10", expenseMicros: "5000000" }],
    },
  ],
  reviewCount: 3,
  ...extra,
});

function render(node: React.ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: true,
          isOwner: true,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  search.value = "";
  answers["/setup"] = { ready: true, missingRoles: [] };
  answers["/documents"] = { items: [] };
});
afterEach(() => vi.useRealTimers());

describe("periods", () => {
  it("defaults to the last 12 months including the current one", () => {
    expect(periodOf(null)).toBe("12m");
    expect(periodOf("bogus")).toBe("12m");
    const now = new Date(NOW);
    expect(periodRange("12m", now)).toEqual({
      from: "2025-11-01",
      to: "2026-10-31",
    });
    expect(periodRange("year", now)).toEqual({
      from: "2026-01-01",
      to: "2026-10-31",
    });
    expect(periodRange("lastYear", now)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });
});

describe("FinanceOverview", () => {
  it("shows the metrics, the charts and the review link", () => {
    answers["/summary"] = summary();
    const html = render(<FinanceOverview />);
    expect(html).toContain("Income this month");
    expect(html).toContain("$250.00");
    expect(html).toContain("1 overdue");
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('href="/p/p1/finance/review"');
    expect(html).toContain("Unassigned");
    expect(html).toContain("Hosting");
    expect(html).toContain("Other");
    expect(
      requested.some((p) => p.includes("from=2025-11-01&to=2026-10-31")),
    ).toBe(true);
    expect(
      requested.some((p) => p.includes("status=needs_review&limit=10")),
    ).toBe(true);
  });

  it("overview shows — for unknown values", () => {
    // The period does not contain the current month: its figures are unknown.
    answers["/summary"] = summary({
      months: [
        {
          month: "2025-12",
          incomeMicros: "1000000",
          expenseMicros: "0",
          resultMicros: "1000000",
        },
      ],
    });
    const html = render(<FinanceOverview />);
    expect(html).toMatch(/Income this month<\/span><strong>—<\/strong>/);
    expect(html).toMatch(/Result this month<\/span><strong>—<\/strong>/);
  });

  it("overview empty state when no bookings", () => {
    answers["/summary"] = summary({
      months: [
        {
          month: "2026-10",
          incomeMicros: "0",
          expenseMicros: "0",
          resultMicros: "0",
        },
      ],
      open: zeroBucket,
      overdue: zeroBucket,
      byCostCenter: [],
      byCategory: [],
      reviewCount: 0,
    });
    const html = render(<FinanceOverview />);
    expect(html).toContain("No bookings yet");
    expect(html).not.toContain("finance-chart");
  });

  it("hints at recurring items without a rate", () => {
    answers["/summary"] = summary({ recurringMissingRate: 2 });
    expect(render(<FinanceOverview />)).toContain("no rate yet");
  });

  it("renders German texts", () => {
    answers["/summary"] = summary();
    const html = render(<FinanceOverview />, "de");
    expect(html).toContain("Einnahmen diesen Monat");
    expect(html).toContain("Nicht zugeordnet");
  });
});

describe("FinanceHome", () => {
  it("shows the review and overdue counts", () => {
    answers["/summary"] = summary();
    const html = render(<FinanceHome />);
    expect(html).toContain("To review");
    expect(html).toContain("<dd>3</dd>");
    expect(html).toContain("<dd>1</dd>");
  });

  it("renders nothing while the module answers 404", () => {
    expect(render(<FinanceHome />)).toBe("");
  });
});
