import { describe, expect, it } from "vitest";
import { Home } from "lucide-react";
import { webRegistry } from "@/modules/registry";
import {
  activeNavKey,
  defaultProject,
  keptSuffix,
  locate,
  navOrder,
  pickerHref,
  projectHref,
  rewriteLegacyHref,
  routeEnabled,
  routeTable,
} from "./routes";
import type { WebRegistry } from "./types";

const table = routeTable(webRegistry);
const P = "11111111-2222-4333-8444-555555555555";
const href = (key: string) =>
  projectHref(
    P,
    table.routes.find((r) => r.key === key)!,
  );

// The 13 paths of the shell before WP1.7 and where they lead now.
const LEGACY: Record<string, string> = {
  "/": `/p/${P}`,
  "/missions": `/p/${P}/marketing/missions`,
  "/chat": `/p/${P}/assistant`,
  "/content": `/p/${P}/marketing/content`,
  "/calendar": `/p/${P}/marketing/calendar`,
  "/knowledge": `/p/${P}/knowledge`,
  "/assets": `/p/${P}/marketing/assets`,
  "/approvals": `/p/${P}/approvals`,
  "/analytics": `/p/${P}/marketing/analytics`,
  "/memory": `/p/${P}/marketing/memory`,
  "/connectors": `/p/${P}/connectors`,
  "/operations": `/p/${P}/operations`,
  "/settings": `/p/${P}/settings`,
};

describe("Web route registry", () => {
  it("keeps every page from before WP1.7 reachable under its project", () => {
    for (const [old, now] of Object.entries(LEGACY))
      expect(rewriteLegacyHref(table, P, old), old).toBe(now);
    for (const [old, now] of Object.entries(LEGACY)) {
      if (old === "/") continue;
      const place = locate(old, table);
      expect(place.kind, old).toBe("legacy");
      if (place.kind === "legacy")
        expect(projectHref(P, place.route), old).toBe(now);
    }
  });

  it("resolves every project page from its own URL", () => {
    for (const route of table.routes) {
      const place = locate(projectHref(P, route), table);
      expect(place).toEqual({ kind: "view", projectId: P, route });
    }
    expect(locate(`/p/${P}/`, table)).toMatchObject({
      kind: "view",
      route: { key: "home" },
    });
  });

  it("keeps the sidebar and mobile order of the old navigation", () => {
    const nav = navOrder(table.routes.filter((r) => r.nav));
    expect(nav.map((r) => r.key)).toEqual([
      "home",
      "missions",
      "chat",
      "content",
      "calendar",
      "knowledge",
      "assets",
      "approvals",
      "analytics",
      "memory",
      "connectors",
      "operations",
      "settings",
    ]);
    expect(nav.filter((r) => r.nav!.mobile).map((r) => r.key)).toEqual([
      "home",
      "chat",
      "content",
      "knowledge",
    ]);
    for (const r of nav) {
      expect(r.nav!.label.en, r.key).toBeTruthy();
      expect(r.nav!.label.de, r.key).toBeTruthy();
    }
  });

  it("sends a module root to the module's first page", () => {
    expect(locate(`/p/${P}/marketing`, table)).toMatchObject({
      kind: "redirect",
      projectId: P,
      route: { key: "missions" },
    });
  });

  it("reports unknown addresses instead of showing another page", () => {
    expect(locate("/nope", table)).toEqual({ kind: "notFound" });
    expect(locate("/missions/extra", table)).toEqual({ kind: "notFound" });
    expect(locate(`/p/${P}/nope`, table)).toEqual({
      kind: "notFound",
      projectId: P,
    });
    expect(locate(`/p/${P}/marketing/missions/x`, table)).toEqual({
      kind: "notFound",
      projectId: P,
    });
    expect(locate("/o/a/b", table)).toEqual({ kind: "notFound" });
  });

  it("knows the start page and the pickers", () => {
    expect(locate("/", table)).toEqual({ kind: "start" });
    expect(locate("/o", table)).toEqual({ kind: "organizations" });
    expect(locate("/o/org%201", table)).toEqual({
      kind: "organization",
      organizationId: "org 1",
    });
  });

  it("rewrites only in-app legacy links and keeps query and hash", () => {
    expect(rewriteLegacyHref(table, P, "/settings?googleDrive=ready")).toBe(
      `${href("settings")}?googleDrive=ready`,
    );
    expect(rewriteLegacyHref(table, P, "/approvals#open")).toBe(
      `${href("approvals")}#open`,
    );
    for (const other of [
      "https://example.invalid/content",
      "/api/projects/x/export",
      `/p/${P}/knowledge`,
      "mailto:a@example.invalid",
    ])
      expect(rewriteLegacyHref(table, P, other)).toBe(other);
    expect(keptSuffix("?a=1", "#b")).toBe("?a=1#b");
    expect(keptSuffix("", "")).toBe("");
  });

  it("opens the last project, else the only one, else a picker", () => {
    const me = {
      workspaces: [{ id: "w1" }, { id: "w2" }],
      projects: [
        { id: "a", workspaceId: "w1" },
        { id: "b", workspaceId: "w2" },
      ],
    };
    expect(defaultProject(me, "b")).toBe("b");
    expect(defaultProject(me, "gone")).toBeNull();
    expect(defaultProject({ ...me, projects: [me.projects[0]!] }, null)).toBe(
      "a",
    );
    expect(pickerHref(me)).toBe("/o");
    expect(pickerHref({ ...me, workspaces: [{ id: "w 1" }] })).toBe("/o/w%201");
  });

  it("gives every knowledge tab its own URL under the knowledge entry (WP3.3)", () => {
    const tabs = [
      "sources",
      "facts",
      "import",
      "conflicts",
      "library",
      "health",
      "inspector",
      "impact",
    ];
    for (const tab of tabs) {
      const place = locate(`/p/${P}/knowledge/${tab}`, table);
      expect(place.kind, tab).toBe("view");
      if (place.kind !== "view") continue;
      expect(place.route.key).toBe(`knowledge-${tab}`);
      expect(place.route.navKey).toBe("knowledge");
      expect(activeNavKey(place.route)).toBe("knowledge");
      expect(place.route.nav).toBeUndefined();
      expect(href(`knowledge-${tab}`)).toBe(`/p/${P}/knowledge/${tab}`);
    }
    // The overview stays the module root and its only sidebar entry.
    expect(href("knowledge")).toBe(`/p/${P}/knowledge`);
    expect(
      table.routes.filter((r) => r.moduleId === "knowledge" && r.nav),
    ).toHaveLength(1);
  });

  it("rejects conflicting registries", () => {
    const view = (key: string, path: string) => ({
      key,
      path,
      component: () => null,
      nav: { label: { en: key, de: key }, icon: Home, order: 1 },
    });
    const base: WebRegistry = { platform: [view("home", "")], modules: [] };
    expect(() => routeTable(base)).not.toThrow();
    const broken: Array<[string, WebRegistry]> = [
      ["no project home", { platform: [view("a", "a")], modules: [] }],
      [
        "key home used",
        { ...base, platform: [view("home", ""), view("home", "x")] },
      ],
      [
        'claims "/knowledge"',
        {
          platform: [view("home", ""), view("k", "knowledge")],
          modules: [
            {
              id: "knowledge",
              displayName: { en: "K", de: "K" },
              description: { en: "K", de: "K" },
              views: [],
            },
          ],
        },
      ],
      [
        'claims "/o"',
        { ...base, platform: [view("home", ""), view("x", "o")] },
      ],
      [
        "invalid path",
        { ...base, platform: [view("home", ""), view("x", "a/b")] },
      ],
      [
        'unknown module "marketing"',
        {
          ...base,
          platform: [
            view("home", ""),
            { ...view("a", "a"), requiresModule: "marketing" },
          ],
        },
      ],
      [
        'navKey "nope" names no navigation entry',
        {
          ...base,
          platform: [
            view("home", ""),
            { key: "a", path: "a", component: () => null, navKey: "nope" },
          ],
        },
      ],
      [
        'navKey "home" belongs to another owner',
        {
          ...base,
          modules: [
            {
              id: "knowledge",
              displayName: { en: "K", de: "K" },
              description: { en: "K", de: "K" },
              views: [
                view("k", ""),
                {
                  key: "k-a",
                  path: "a",
                  component: () => null,
                  navKey: "home",
                },
              ],
            },
          ],
        },
      ],
      [
        "legacy path /x used",
        {
          ...base,
          platform: [
            view("home", ""),
            { ...view("a", "a"), legacyPaths: ["/x"] },
            { ...view("b", "b"), legacyPaths: ["/x"] },
          ],
        },
      ],
    ];
    for (const [message, registry] of broken)
      expect(() => routeTable(registry), message).toThrow(message);
  });

  it("hides the pages of a disabled module and the pages that need it", () => {
    const shown = (off: string[]) =>
      table.routes
        .filter((r) => routeEnabled(r, (id) => !off.includes(id)))
        .map((r) => r.key);
    const all = shown([]);
    expect(all).toHaveLength(table.routes.length);
    const withoutMarketing = shown(["marketing"]);
    expect(withoutMarketing).not.toContain("approvals");
    expect(withoutMarketing).toContain("home");
    expect(withoutMarketing).toContain("knowledge");
    expect(
      withoutMarketing.some(
        (key) =>
          table.routes.find((r) => r.key === key)!.moduleId === "marketing",
      ),
    ).toBe(false);
  });
});
