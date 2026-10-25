import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups, mobileCurrentKey, mobileEntries } from "./nav-groups";
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
      "work",
      "support",
      "knowledge",
      "finance",
      "project",
    ]);
    expect(groups[0]!.label).toBeNull();
    expect(groups.at(-1)!.label).toEqual({ en: "Project", de: "Projekt" });
  });

  it("keeps the shared decisions inbox reachable when Marketing is disabled", () => {
    const groups = buildNavGroups(table.routes, modulesWith(["marketing"]));
    expect(
      groups.find((g) => g.id === "project")!.entries.map((r) => r.key),
    ).toContain("decisions");
    const route = table.routes.find((r) => r.key === "decisions")!;
    expect(routeEnabled(route, enabledIn(["marketing"]))).toBe(true);
    expect(route.segments).toEqual(["decisions"]);
  });

  it("drops a disabled module and its approvals entry", () => {
    const groups = buildNavGroups(table.routes, modulesWith(["marketing"]));
    expect(groups.map((g) => g.id)).not.toContain("marketing");
    expect(
      groups.flatMap((g) => g.entries).some((r) => r.key === "approvals"),
    ).toBe(false);
  });

  it("orders the support group Overview, Tickets, Contacts, Statistics", () => {
    const support = buildNavGroups(table.routes, modulesWith()).find(
      (g) => g.id === "support",
    )!;
    expect(support.entries.map((r) => r.key)).toEqual([
      "support",
      "support-tickets",
      "support-contacts",
      "support-stats",
    ]);
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
    ).toEqual(["home", "chat", "support-tickets", "approvals"]);
    expect(
      mobileEntries(table.routes, enabledIn(["support"])).map((r) => r.key),
    ).toEqual(["home", "chat", "approvals", "marketing-plans"]);
  });

  it("only offers routes the enabled check allows", () => {
    for (const r of mobileEntries(table.routes, enabledIn(["marketing"])))
      expect(routeEnabled(r, enabledIn(["marketing"]))).toBe(true);
  });
});

describe("mobileCurrentKey", () => {
  const route = (key: string) => table.routes.find((r) => r.key === key)!;
  const bar = mobileEntries(table.routes, enabledIn([]));
  const current = (key: string) => mobileCurrentKey(bar, route(key));

  it("marks the bar entry of the open page", () => {
    expect(current("home")).toBe("home");
    expect(current("approvals")).toBe("approvals");
    expect(current("chat")).toBe("chat");
  });

  it("marks the module's only bar entry on the module's other pages", () => {
    // Rulings R12/R12b: Support is on the bar through its inbox (Tickets), not
    // through its root (the overview), so Tickets stands for the module.
    expect(current("support-tickets")).toBe("support-tickets");
    expect(current("support")).toBe("support-tickets");
    expect(current("support-contacts")).toBe("support-tickets");
    expect(current("support-stats")).toBe("support-tickets");
    // Approvals sits in the Marketing group but is a platform page, not
    // Marketing's: it never stands for Missions, Content and the rest.
    for (const key of ["marketing-overview", "missions", "content", "calendar"])
      expect(current(key), key).toBeUndefined();
  });

  it("keeps a module root current on the pages of its group", () => {
    // Knowledge is not on this bar; with its root on the bar, a URL-only page
    // counts through its navKey and a tab through the group.
    const withKnowledge = [route("home"), route("knowledge")];
    expect(mobileCurrentKey(withKnowledge, route("knowledge-health"))).toBe(
      "knowledge",
    );
    expect(mobileCurrentKey(withKnowledge, route("knowledge-sources"))).toBe(
      "knowledge",
    );
  });

  it("marks nothing for a page that no bar entry stands for", () => {
    // Knowledge and the project group have no entry on this bar.
    expect(current("knowledge")).toBeUndefined();
    expect(current("knowledge-sources")).toBeUndefined();
    expect(current("settings")).toBeUndefined();
    expect(mobileCurrentKey(bar, null)).toBeUndefined();
  });

  it("lets Plans stand for Marketing when support is off (MA-08)", () => {
    // With support off the bar carries Approvals (a platform page) and
    // Plans is Marketing's first own bar entry while the agent feature is on.
    const noSupport = mobileEntries(table.routes, enabledIn(["support"]));
    expect(mobileCurrentKey(noSupport, route("missions"))).toBe(
      "marketing-plans",
    );
    expect(mobileCurrentKey(noSupport, route("approvals"))).toBe("approvals");
    expect(mobileCurrentKey(noSupport, route("settings"))).toBeUndefined();
  });
});
