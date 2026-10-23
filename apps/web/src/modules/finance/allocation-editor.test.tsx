import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CostCenter } from "./api";
import {
  AllocationEditor,
  allocationOf,
  bpToPercent,
  evenRows,
  evenSplit,
  percentToBp,
} from "./allocation-editor";
import { financeText } from "./labels";

const center = (id: string, archived = false): CostCenter => ({
  id,
  code: id.toUpperCase(),
  name: `Center ${id}`,
  orbitProjectId: null,
  version: 1,
  archivedAt: archived ? "2026-10-01T00:00:00.000Z" : null,
});

const render = (rows: { costCenterId: string; percent: string }[]) =>
  renderToStaticMarkup(
    <AllocationEditor
      t={financeText("en")}
      id="line-0"
      rows={rows}
      costCenters={[center("a"), center("b"), center("c", true)]}
      onChange={() => {}}
    />,
  );

describe("finance allocation editor", () => {
  it("allocation editor blocks submit until 100 %", () => {
    const short = [
      { costCenterId: "a", percent: "60" },
      { costCenterId: "b", percent: "30" },
    ];
    expect(allocationOf(short)).toMatchObject({
      allocation: null,
      sumBp: 9000,
      problem: "sum",
    });
    const html = render(short);
    expect(html).toContain('data-problem="sum"');
    expect(html).toContain("must add up to 100.00 %");
    expect(html).toContain("Total 90.00 %");

    const full = [
      { costCenterId: "a", percent: "60" },
      { costCenterId: "b", percent: "40.00" },
    ];
    expect(allocationOf(full)).toEqual({
      allocation: [
        { costCenterId: "a", bp: 6000 },
        { costCenterId: "b", bp: 4000 },
      ],
      sumBp: 10000,
      problem: null,
    });
    expect(render(full)).not.toContain("data-problem");
  });

  it("even split of three gives 33.33/33.33/33.34", () => {
    expect(evenSplit(3)).toEqual([3333, 3333, 3334]);
    const rows = evenRows([
      { costCenterId: "a", percent: "" },
      { costCenterId: "b", percent: "" },
      { costCenterId: "c", percent: "" },
    ]);
    expect(rows.map((r) => r.percent)).toEqual(["33.33", "33.33", "33.34"]);
    expect(allocationOf(rows).sumBp).toBe(10000);
  });

  it("even split of two gives 50/50", () => {
    expect(evenSplit(2)).toEqual([5000, 5000]);
    expect(
      evenRows([
        { costCenterId: "a", percent: "10" },
        { costCenterId: "b", percent: "" },
      ]).map((r) => r.percent),
    ).toEqual(["50.00", "50.00"]);
  });

  it("converts percent text to basis points with string math", () => {
    expect(percentToBp("33.33")).toBe(3333);
    expect(percentToBp("33,3")).toBe(3330);
    expect(percentToBp("0.01")).toBe(1);
    expect(percentToBp("100")).toBe(10000);
    expect(percentToBp("100.01")).toBeNull();
    expect(percentToBp("33.333")).toBeNull();
    expect(percentToBp("-5")).toBeNull();
    expect(bpToPercent(3334)).toBe("33.34");
    expect(bpToPercent(5)).toBe("0.05");
  });

  it("allows an empty allocation and refuses a missing or repeated center", () => {
    expect(allocationOf([])).toEqual({
      allocation: [],
      sumBp: 0,
      problem: null,
    });
    expect(allocationOf([{ costCenterId: "", percent: "100" }]).problem).toBe(
      "center",
    );
    expect(
      allocationOf([
        { costCenterId: "a", percent: "50" },
        { costCenterId: "a", percent: "50" },
      ]).problem,
    ).toBe("duplicate");
  });

  it("does not offer archived cost centers", () => {
    const html = render([{ costCenterId: "", percent: "" }]);
    expect(html).toContain("Center a");
    expect(html).not.toContain("Center c");
  });
});
