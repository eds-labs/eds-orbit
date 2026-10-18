import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups, mobileEntries } from "./nav-groups";
import { routeEnabled, routeTable } from "./routes";

const table = routeTable(webRegistry);
const modulesWith = (off: string[] = []) =>
  webRegistry.modules.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    enabled: !off.includes(m.id),
    groupOrder: m.groupOrder,
  }));
const enabledIn = (off: string[]) => (id: string) => !off.includes(id);

describe("buildNavGroups", () => {
  it("orders top, modules by groupOrder, project", () => {
    const groups = buildNavGroups(table.routes, modulesWith());
    expect(groups.map((g) => g.id)).toEqual([
      "top",
      "marketing",
      "support",
      "knowledge",
      "project",
    ]);
    expect(groups[0]!.label).toBeNull();
    expect(groups.at(-1)!.label).toEqual({ en: "Project", de: "Projekt" });
  });

  it("drops a disabled module and its approvals entry", () => {
    const groups = buildNavGroups(table.routes, modulesWith(["marketing"]));
    expect(groups.map((g) => g.id)).not.toContain("marketing");
    expect(
      groups.flatMap((g) => g.entries).some((r) => r.key === "approvals"),
    ).toBe(false);
  });

  it("puts approvals into marketing after calendar", () => {
    const marketing = buildNavGroups(table.routes, modulesWith()).find(
      (g) => g.id === "marketing",
    )!;
    const keys = marketing.entries.map((r) => r.key);
    expect(keys.indexOf("approvals")).toBe(keys.indexOf("calendar") + 1);
  });
});

describe("mobileEntries", () => {
  it("picks four by rank", () => {
    expect(
      mobileEntries(table.routes, enabledIn([])).map((r) => r.key),
    ).toEqual(["home", "chat", "support", "approvals"]);
    expect(
      mobileEntries(table.routes, enabledIn(["support"])).map((r) => r.key),
    ).toEqual(["home", "chat", "approvals", "content"]);
  });

  it("only offers routes the enabled check allows", () => {
    for (const r of mobileEntries(table.routes, enabledIn(["marketing"])))
      expect(routeEnabled(r, enabledIn(["marketing"]))).toBe(true);
  });
});
