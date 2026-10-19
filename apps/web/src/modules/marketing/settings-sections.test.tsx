import { describe, expect, it } from "vitest";
import { marketingWeb } from "./manifest";

// The settings sections and connectors marketing contributes (WP2.3b) keep
// the labels the pages had before the split.
describe("marketing settings and connector contributions", () => {
  // UI restructure §5.4: policy first (the sidebar's settings link), then
  // brand. The assignments are a Marketing page since 2026-10-19.
  it("contributes the policy and brand sections in spec order", () => {
    expect(
      marketingWeb.settings!.map((s) => [
        s.tab.key,
        s.tab.order,
        s.tab.label.en,
      ]),
    ).toEqual([
      ["policy", 20, "Policy & budget"],
      ["brand", 30, "Brand"],
    ]);
  });

  it("offers the assignments as a page after the missions", () => {
    const keys = marketingWeb.views
      .filter((v) => v.nav)
      .sort((a, b) => a.nav!.order - b.nav!.order)
      .map((v) => v.key);
    expect(keys.indexOf("assignments")).toBe(keys.indexOf("missions") + 1);
    const page = marketingWeb.views.find((v) => v.key === "assignments")!;
    expect([page.path, page.nav!.label.de]).toEqual([
      "assignments",
      "Aufträge",
    ]);
  });

  it("contributes Postiz, Matomo and Slack with their checks and forms", () => {
    expect(
      marketingWeb.connectors!.providers!.map((p) => [
        p.id,
        p.checkLabel,
        (p.fields ?? []).map((f) => f.name),
        Boolean(p.Configure),
      ]),
    ).toEqual([
      ["postiz", "Test connection / refresh channels", [], false],
      ["matomo", "Check capabilities", ["siteId"], false],
      ["slack", null, [], true],
    ]);
    expect(marketingWeb.connectors!.extras).toHaveLength(2);
    expect(marketingWeb.setupLinks).toHaveLength(1);
  });
});
