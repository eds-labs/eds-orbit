import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { MonthlyBars, RankedBars, Sparkline, permille } from "./charts";

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

function render(node: React.ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
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
    </WorkspaceContext.Provider>,
  );
}

const month = (m: string, income: string, expense: string, result: string) => ({
  month: m,
  incomeMicros: income,
  expenseMicros: expense,
  resultMicros: result,
});
/** The `height` of every `data-bar` rect of the markup. */
const heights = (html: string) =>
  [...html.matchAll(/<rect data-bar[^>]*?height="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
const widths = (html: string) =>
  [...html.matchAll(/<rect data-bar[^>]*?width="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );

describe("charts", () => {
  it("bars scale to the largest value and render zero months", () => {
    const html = render(
      <MonthlyBars
        currency="USD"
        months={[
          month("2026-08", "100000000", "50000000", "50000000"),
          month("2026-09", "0", "0", "0"),
          month("2026-10", "200000000", "0", "200000000"),
        ]}
      />,
    );
    const h = heights(html);
    // 3 months x (income, expense) bars; the zero month is an empty bar.
    expect(h).toHaveLength(6);
    expect(h[2]).toBe(0);
    expect(h[3]).toBe(0);
    // The largest value fills the plot; half of it gets half the height.
    expect(h[4]).toBeCloseTo(160, 5);
    expect(h[0]).toBeCloseTo(80, 5);
    expect(h[1]).toBeCloseTo(40, 5);
    // Every month keeps its label.
    expect(html).toContain("Sep 26");
  });

  it("puts a negative result below the baseline", () => {
    const html = render(
      <MonthlyBars
        currency="USD"
        months={[month("2026-10", "0", "100000000", "-100000000")]}
      />,
    );
    const circle = /<circle[^>]*cy="([\d.]+)"/.exec(html);
    const baseline = /<line[^>]*y1="([\d.]+)"/.exec(html);
    expect(Number(circle![1])).toBeGreaterThan(Number(baseline![1]));
  });

  it("bar heights stay proportional for values up to 1e15", () => {
    expect(permille(1_000_000_000n, 1_000_000_000_000_000n)).toBe(0);
    expect(permille(500_000_000_000_000n, 1_000_000_000_000_000n)).toBe(500);
    const html = render(
      <RankedBars
        caption="Cost centers"
        fallback="Unassigned"
        currency="USD"
        rows={[
          { id: "a", name: "Big", valueMicros: "1000000000000000" },
          { id: "b", name: "Half", valueMicros: "500000000000000" },
          { id: "c", name: "Tiny", valueMicros: "1000000000" },
        ]}
      />,
    );
    // Widths of the three bar rects on the 0..1000 scale.
    expect(widths(html)).toEqual([1000, 500, 0]);
  });

  it("chart exposes a data table", () => {
    const html = render(
      <MonthlyBars
        currency="USD"
        months={[month("2026-10", "100000000", "40000000", "60000000")]}
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="1 months?, income \$100\.00/);
    expect(html).toContain('<table class="sr-only">');
    expect(html).toContain("$40.00");
    expect(html).toContain("$60.00");
    const spark = render(
      <Sparkline
        label="Rent: total $3.00"
        currency="USD"
        points={[
          { month: "2026-09", valueMicros: "1000000" },
          { month: "2026-10", valueMicros: "2000000" },
        ]}
      />,
    );
    expect(spark).toContain('role="img"');
    expect(spark).toContain('aria-label="Rent: total $3.00"');
    expect(spark).toContain("sr-only");
  });

  it("name null renders Other and Unassigned", () => {
    const rows = [
      { id: null, name: null, valueMicros: "5000000" },
      { id: "a", name: "Ops", valueMicros: "1000000" },
    ];
    const en = render(
      <RankedBars
        caption="Cost centers"
        fallback={labels.en.financeReportUnassigned}
        currency="USD"
        rows={rows}
      />,
    );
    expect(en).toContain("Unassigned");
    const de = render(
      <RankedBars
        caption="Kostenstellen"
        fallback={labels.de.financeReportUnassigned}
        currency="USD"
        rows={rows}
      />,
      "de",
    );
    expect(de).toContain("Nicht zugeordnet");
  });

  it("folds rows beyond eight into Other", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `c${i}`,
      name: `Center ${i}`,
      valueMicros: String((11 - i) * 1_000_000),
    }));
    const html = render(
      <RankedBars
        caption="Cost centers"
        fallback="Unassigned"
        currency="USD"
        rows={rows}
      />,
    );
    expect(widths(html)).toHaveLength(9);
    expect(html).toContain("Other");
    expect(html).not.toContain("Center 9");
  });

  it("renders all-zero data without NaN", () => {
    const monthly = render(
      <MonthlyBars
        currency="USD"
        months={[
          month("2026-09", "0", "0", "0"),
          month("2026-10", "0", "0", "0"),
        ]}
      />,
    );
    expect(monthly).not.toContain("NaN");
    expect(heights(monthly)).toEqual([0, 0, 0, 0]);
    const ranked = render(
      <RankedBars
        caption="Cost centers"
        fallback="Unassigned"
        currency="USD"
        rows={[{ id: "a", name: "Ops", valueMicros: "0" }]}
      />,
    );
    expect(ranked).not.toContain("NaN");
    expect(widths(ranked)).toEqual([0]);
  });

  it("renders a negative ranked value with its magnitude", () => {
    const html = render(
      <RankedBars
        caption="Cost centers"
        fallback="Unassigned"
        currency="USD"
        rows={[
          { id: "a", name: "Refund", valueMicros: "-4000000" },
          { id: "b", name: "Ops", valueMicros: "2000000" },
        ]}
      />,
    );
    expect(widths(html).sort((a, b) => b - a)).toEqual([1000, 500]);
  });

  it("draws a dot for a single-point sparkline", () => {
    const html = render(
      <Sparkline
        label="Rent"
        currency="USD"
        points={[{ month: "2026-10", valueMicros: "1000000" }]}
      />,
    );
    expect(html).toContain("<circle");
  });
});
