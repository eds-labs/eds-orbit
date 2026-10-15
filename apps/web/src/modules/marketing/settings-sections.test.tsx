import { describe, expect, it } from "vitest";
import { marketingWeb } from "./manifest";

// The settings tabs and connectors marketing contributes (WP2.3b) keep the
// order and labels the pages had before the split.
describe("marketing settings and connector contributions", () => {
  it("contributes the agents, policy and brand tabs in their old order", () => {
    expect(
      marketingWeb.settings!.map((s) => [
        s.tab.key,
        s.tab.order,
        s.tab.label.en,
      ]),
    ).toEqual([
      ["agents", 10, "Assignments"],
      ["policy", 20, "Policy & budget"],
      ["brand", 30, "Brand"],
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
