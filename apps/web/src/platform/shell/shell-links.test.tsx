import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { centerLink, moduleTabIndex, type MapContext } from "@/platform/settings-center/redirects";
import { PLATFORM_TAB_KEYS } from "@/platform/settings-center/sections/project";
import { projectAwareHref, projectHref, routeTable } from "./routes";
import { shellLinks } from "./shell-links";

const table = routeTable(webRegistry);
const ctx = (moduleShown: MapContext["moduleShown"] = () => true): MapContext => ({
  table,
  tabs: moduleTabIndex(webRegistry.modules),
  platformKeys: PLATFORM_TAB_KEYS,
  moduleShown,
});
const hrefOf = (key: string) => {
  const route = table.routes.find((r) => r.key === key);
  return route ? projectHref("p1", route) : "/";
};
const links = (
  stage: "off" | "preview" | "on" | undefined,
  map: (href: string) => string = (href) => centerLink(href, ctx()),
) => shellLinks({ stage, projectId: "p1", hrefOf, map });

describe("shell links (settings center phase 5)", () => {
  it("links to the old addresses unless the flag is on", () => {
    for (const stage of [undefined, "off", "preview"] as const) {
      const l = links(stage);
      expect(l.settingsHref("ai")).toBe("/p/p1/settings?section=ai");
      expect(l.settingsHref("project")).toBe("/p/p1/settings");
      expect(l.settingsHref("finance-mailboxes")).toBe(
        "/p/p1/settings?section=finance-mailboxes",
      );
      expect(l.connectionsHref()).toBe("/p/p1/connectors");
      expect(l.organizationSettingsHref("w 1")).toBe("/o/w%201/settings");
      expect(l.centerLink("/p/p1/settings?section=ai")).toBe(
        "/p/p1/settings?section=ai",
      );
    }
  });

  it("links into the center when the flag is on", () => {
    const l = links("on");
    expect(l.settingsHref("ai")).toBe("/manage/p/p1/ai");
    expect(l.settingsHref("project")).toBe("/manage/p/p1/overview");
    expect(l.connectionsHref()).toBe("/manage/p/p1/integrations/connections");
    expect(l.settingsHref("finance-mailboxes")).toBe(
      "/manage/p/p1/modules/finance/mailboxes",
    );
    expect(l.organizationSettingsHref("w 1")).toBe("/manage/o/w%201/overview");
    expect(l.centerLink("/p/p1/settings?section=ai")).toBe("/manage/p/p1/ai");
  });

  it("keeps the old address while the mapping waits, and never asks for capabilities", () => {
    // "policy" moved: while the module states are unknown the mapping waits,
    // so the link keeps the old address and the redirect decides.
    const waiting = links("on", (href) => centerLink(href, ctx(() => null)));
    expect(waiting.settingsHref("policy")).toBe("/p/p1/settings?section=policy");
    expect(waiting.settingsHref("ai")).toBe("/manage/p/p1/ai");
  });
});

describe("centerLink", () => {
  it("maps old settings addresses and leaves every other link as it is", () => {
    const map = (href: string) => centerLink(href, ctx());
    expect(map("/p/p1/settings?section=policy#social-autopilot")).toBe(
      "/manage/p/p1/modules/marketing/policy#social-autopilot",
    );
    expect(map("/o/w1/settings")).toBe("/manage/o/w1/overview");
    expect(map("/p/p1/support/tickets?ticket=t1")).toBe(
      "/p/p1/support/tickets?ticket=t1",
    );
    expect(map("https://example.invalid/settings")).toBe(
      "https://example.invalid/settings",
    );
    expect(map("//example.invalid/p/p1/settings")).toBe(
      "//example.invalid/p/p1/settings",
    );
    expect(map("")).toBe("");
  });

  it("maps a card link of the assistant when the shell supplies the mapping", () => {
    const map = (href: string) => centerLink(href, ctx());
    expect(projectAwareHref(table, "p2", "/settings?section=ai", map)).toBe(
      "/manage/p/p2/ai",
    );
    expect(projectAwareHref(table, "p2", "/p/p1/connectors", map)).toBe(
      "/manage/p/p1/integrations",
    );
    expect(projectAwareHref(table, "p2", "/approvals", map)).toBe(
      "/p/p2/approvals",
    );
    // Identity by default: today's address.
    expect(projectAwareHref(table, "p2", "/settings?section=ai")).toBe(
      "/p/p2/settings?section=ai",
    );
  });
});
