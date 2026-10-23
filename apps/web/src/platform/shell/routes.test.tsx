import { describe, expect, it } from "vitest";
import { Home } from "lucide-react";
import { webRegistry } from "@/modules/registry";
import {
  activeNavKey,
  crumbs,
  defaultProject,
  keptSuffix,
  knownModuleStates,
  waitsForModuleStates,
  locate,
  moduleShown,
  moduleUsable,
  navGroupOf,
  navOrder,
  pageTitle,
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

  it("groups the navigation by module", () => {
    const route = (key: string) => table.routes.find((r) => r.key === key)!;
    expect(navGroupOf(route("home"))).toBe("top");
    expect(navGroupOf(route("chat"))).toBe("top");
    expect(navGroupOf(route("approvals"))).toBe("marketing");
    for (const key of ["connectors", "operations", "settings"])
      expect(navGroupOf(route(key)), key).toBe("project");
    expect(navGroupOf(route("missions"))).toBe("marketing");
    expect(navGroupOf(route("knowledge-sources"))).toBe("knowledge");
    for (const key of [
      "support",
      "support-tickets",
      "support-contacts",
      "support-stats",
    ])
      expect(route(key).nav, key).toBeTruthy();
    expect(route("support").nav!.mobile).toBeFalsy();
    const nav = navOrder(table.routes.filter((r) => r.nav));
    for (const r of nav) {
      expect(r.nav!.label.en, r.key).toBeTruthy();
      expect(r.nav!.label.de, r.key).toBeTruthy();
    }
    // The mobile bar is ranked explicitly, independent of the sidebar order.
    expect(
      nav
        .filter((r) => r.nav!.mobile)
        .sort((a, b) => a.nav!.mobileRank! - b.nav!.mobileRank!)
        .map((r) => r.key),
    ).toEqual([
      "home",
      "chat",
      "support-tickets",
      "approvals",
      "marketing-plans",
      "content",
      "knowledge",
    ]);
    expect(webRegistry.modules.map((m) => [m.id, m.groupOrder])).toEqual(
      expect.arrayContaining([
        ["marketing", 10],
        ["support", 20],
        ["knowledge", 30],
      ]),
    );
  });

  it("rejects an unknown navGroup", () => {
    const view = (key: string, path: string, navGroup?: string) => ({
      key,
      path,
      component: () => null,
      navGroup,
      nav: { label: { en: key, de: key }, icon: Home, order: 1 },
    });
    expect(() =>
      routeTable({
        platform: [view("home", ""), view("a", "a", "nope")],
        modules: [],
      }),
    ).toThrow(/navGroup/);
  });

  it("requires a platform page in a module's group to require that module", () => {
    const view = (key: string, path: string, extra = {}) => ({
      key,
      path,
      component: () => null,
      nav: { label: { en: key, de: key }, icon: Home, order: 1 },
      ...extra,
    });
    const modules = [
      {
        id: "a",
        displayName: { en: "a", de: "a" },
        description: { en: "a", de: "a" },
        views: [{ ...view("a-root", ""), navGroup: undefined }],
      },
    ];
    expect(() =>
      routeTable({
        platform: [view("home", ""), view("x", "x", { navGroup: "a" })],
        modules,
      }),
    ).toThrow(/navGroup/);
    expect(() =>
      routeTable({
        platform: [
          view("home", ""),
          view("x", "x", { navGroup: "a", requiresModule: "a" }),
        ],
        modules,
      }),
    ).not.toThrow();
  });

  it("rejects a module page in another module's group, and a mobileRank without mobile", () => {
    const view = (key: string, path: string) => ({
      key,
      path,
      component: () => null,
      nav: { label: { en: key, de: key }, icon: Home, order: 1 },
    });
    const mod = (id: string, navGroup?: string) => ({
      id,
      displayName: { en: id, de: id },
      description: { en: id, de: id },
      views: [{ ...view(`${id}-root`, ""), navGroup }],
    });
    expect(() =>
      routeTable({
        platform: [view("home", "")],
        modules: [mod("a", "b"), mod("b")],
      }),
    ).toThrow(/WEB_ROUTES_INVALID/);
    expect(() =>
      routeTable({
        platform: [view("home", "")],
        modules: [mod("a", "a"), mod("b")],
      }),
    ).not.toThrow();
    expect(() =>
      routeTable({
        platform: [
          {
            ...view("home", ""),
            nav: { ...view("home", "").nav, mobileRank: 1 },
          },
        ],
        modules: [],
      }),
    ).toThrow(/mobileRank/);
  });

  it("crumbs show the group", () => {
    const route = (key: string) => table.routes.find((r) => r.key === key)!;
    const group = (g: string) => (g === "knowledge" ? "Wissen" : undefined);
    expect(crumbs(route("knowledge-sources"), table, "de", group)).toEqual([
      "Wissen",
      "Quellen",
    ]);
    expect(crumbs(route("home"), table, "de", group)).toHaveLength(1);
  });

  it("titles a page with its group, as the breadcrumb does", () => {
    const route = (key: string) => table.routes.find((r) => r.key === key)!;
    const group = (g: string) => (g === "knowledge" ? "Knowledge" : undefined);
    expect(pageTitle(route("knowledge"), table, "en", group)).toBe(
      "Knowledge / Overview",
    );
    expect(pageTitle(route("home"), table, "en", group)).toBe("Home");
  });

  it("opens a module's root view at the module path", () => {
    expect(locate(`/p/${P}/marketing`, table)).toMatchObject({
      kind: "view",
      projectId: P,
      route: { key: "marketing-overview", moduleId: "marketing" },
    });
  });

  it("sends the root of a module without a root view to its first page", () => {
    const view = (key: string, path: string, order: number) => ({
      key,
      path,
      component: () => null,
      nav: { label: { en: key, de: key }, icon: Home, order },
    });
    const rootless = routeTable({
      platform: [view("home", "", 1)],
      modules: [
        {
          id: "m",
          displayName: { en: "m", de: "m" },
          description: { en: "m", de: "m" },
          views: [view("second", "second", 20), view("first", "first", 10)],
        },
      ],
    });
    expect(locate(`/p/${P}/m`, rootless)).toMatchObject({
      kind: "redirect",
      projectId: P,
      route: { key: "first" },
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

  it("knows the organization settings and the system administration (ADR 0013)", () => {
    expect(locate("/o/org%201/settings", table)).toEqual({
      kind: "organizationSettings",
      organizationId: "org 1",
    });
    expect(locate("/admin", table)).toEqual({ kind: "admin", section: "" });
    expect(locate("/admin/users", table)).toEqual({
      kind: "admin",
      section: "users",
    });
    expect(locate(`/admin/users/${P}`, table)).toEqual({
      kind: "admin",
      section: "users",
      id: P,
    });
    expect(locate("/admin/secrets", table)).toEqual({ kind: "notFound" });
    expect(locate(`/admin/users/${P}/x`, table)).toEqual({ kind: "notFound" });
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
      // Content tabs have their own sidebar entry (UI restructure); the
      // diagnostic ones highlight the overview.
      if (["health", "inspector", "impact"].includes(tab)) {
        expect(place.route.navKey).toBe("knowledge");
        expect(activeNavKey(place.route)).toBe("knowledge");
        expect(place.route.nav).toBeUndefined();
      } else {
        expect(place.route.nav, tab).toBeTruthy();
        expect(activeNavKey(place.route)).toBe(`knowledge-${tab}`);
      }
      expect(href(`knowledge-${tab}`)).toBe(`/p/${P}/knowledge/${tab}`);
    }
    // The overview stays the module root.
    expect(href("knowledge")).toBe(`/p/${P}/knowledge`);
    expect(
      navOrder(
        table.routes.filter((r) => r.moduleId === "knowledge" && r.nav),
      ).map((r) => r.key),
    ).toEqual([
      "knowledge",
      "knowledge-sources",
      "knowledge-facts",
      "knowledge-conflicts",
      "knowledge-import",
      "knowledge-library",
    ]);
  });

  it("knows the standalone pages of the OAuth authorization outside any project", () => {
    for (const [path, key, session] of [
      ["/connect", "connect", "required"],
      ["/connect/login", "connect-login", "required"],
      ["/connect/error", "connect-error", "none"],
    ] as const) {
      const place = locate(path, table);
      expect(place.kind, path).toBe("standalone");
      if (place.kind !== "standalone") continue;
      expect(place.view.key).toBe(key);
      expect(place.view.session).toBe(session);
      expect(place.view.title.en).toBeTruthy();
      expect(place.view.title.de).toBeTruthy();
    }
    // Only /connect/login continues an authorization when signing in.
    expect(
      table.standalone.filter((v) => v.oauthLogin).map((v) => v.key),
    ).toEqual(["connect-login"]);
    expect(locate("/connect/other", table)).toEqual({ kind: "notFound" });
    expect(locate("/connect/", table)).toMatchObject({ kind: "standalone" });
    // They never show up in a project's navigation.
    const standaloneKeys = table.standalone.map((v) => v.key);
    expect(table.routes.some((r) => standaloneKeys.includes(r.key))).toBe(
      false,
    );
  });

  it("names a diagnostic knowledge tab in the breadcrumb under its entry, never by its key", () => {
    const route = (key: string) => table.routes.find((r) => r.key === key)!;
    expect(crumbs(route("knowledge-health"), table, "de")).toEqual([
      "Übersicht",
      "Gesundheit",
    ]);
    expect(crumbs(route("knowledge-impact"), table, "en")).toEqual([
      "Overview",
      "Impact",
    ]);
    expect(crumbs(route("knowledge"), table, "de")).toEqual(["Übersicht"]);
    for (const r of table.routes)
      for (const part of crumbs(r, table, "en"))
        expect(part, r.key).not.toBe(r.key);
  });

  it("hides a module that is off or that the member has no access to (WP4.5)", () => {
    expect(moduleUsable(undefined)).toBe(true);
    expect(moduleUsable({ enabled: true })).toBe(true);
    expect(moduleUsable({ enabled: true, access: "viewer" })).toBe(true);
    expect(moduleUsable({ enabled: true, access: "none" })).toBe(false);
    expect(moduleUsable({ enabled: false, access: "editor" })).toBe(false);
  });

  it("hides a module the loaded states leave out, and opt-in modules until they load (WP5.1)", () => {
    const states = [{ id: "knowledge", enabled: true }];
    // States loaded: a module the server does not list (unavailable) is off.
    expect(moduleShown(states, "support")).toBe(false);
    expect(moduleShown(states, "knowledge")).toBe(true);
    // Not loaded yet or failed: modules count as on, opt-in modules as off.
    expect(moduleShown(undefined, "marketing")).toBe(true);
    expect(moduleShown(undefined, "support", true)).toBe(false);
    expect(
      moduleShown([{ id: "support", enabled: true }], "support", true),
    ).toBe(true);
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
    const page = (key: string, path: string) => ({
      key,
      path,
      title: { en: key, de: key },
      session: "none" as const,
      component: () => null,
    });
    broken.push(
      [
        'standalone page c claims "/o"',
        { ...base, standalone: [page("c", "o/x")] },
      ],
      [
        'standalone page c claims "/p"',
        { ...base, standalone: [page("c", "p")] },
      ],
      [
        "invalid standalone path",
        { ...base, standalone: [page("c", "Connect")] },
      ],
      ["key home used", { ...base, standalone: [page("home", "connect")] }],
      [
        "path /connect used by c1 and c2",
        {
          ...base,
          standalone: [page("c1", "connect"), page("c2", "connect")],
        },
      ],
      [
        "legacy path /x used by a and c",
        {
          ...base,
          platform: [
            view("home", ""),
            { ...view("a", "a"), legacyPaths: ["/x"] },
          ],
          standalone: [page("c", "x")],
        },
      ],
    );
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

describe("knownModuleStates", () => {
  const loaded = { modules: [{ id: "support", enabled: true }] };

  it("prefers the states just loaded", () => {
    expect(knownModuleStates(loaded, null, "p1")).toBe(loaded);
  });

  it("keeps the project's last states while they load again", () => {
    // A refresh refetches them; falling back to the defaults would hide the
    // opt-in support module for a moment and remount the page.
    expect(
      knownModuleStates(null, { projectId: "p1", states: loaded }, "p1"),
    ).toBe(loaded);
  });

  it("knows nothing after a failed load, for another project or before the first load", () => {
    expect(
      knownModuleStates(null, { projectId: "p1", states: null }, "p1"),
    ).toBeUndefined();
    expect(
      knownModuleStates(null, { projectId: "p2", states: loaded }, "p1"),
    ).toBeUndefined();
    expect(knownModuleStates(null, null, "p1")).toBeUndefined();
    expect(knownModuleStates(null, null, undefined)).toBeUndefined();
  });
});

describe("waitsForModuleStates", () => {
  const loaded = { modules: [{ id: "support", enabled: true }] };

  it("waits only for the project's first load", () => {
    expect(waitsForModuleStates(null, null, null, "p1")).toBe(true);
    expect(waitsForModuleStates(loaded, null, null, "p1")).toBe(false);
    // A failed load renders with the defaults.
    expect(waitsForModuleStates(null, new Error("x"), null, "p1")).toBe(false);
    // Another project's states say nothing about this one.
    expect(
      waitsForModuleStates(
        null,
        null,
        { projectId: "p2", states: loaded },
        "p1",
      ),
    ).toBe(true);
  });

  it("does not wait again while a refresh refetches", () => {
    // After a success the last states stand in.
    expect(
      waitsForModuleStates(
        null,
        null,
        { projectId: "p1", states: loaded },
        "p1",
      ),
    ).toBe(false);
    // After a failure the page keeps rendering with the defaults instead of
    // unmounting into a loading state (and losing its form state).
    expect(
      waitsForModuleStates(null, null, { projectId: "p1", states: null }, "p1"),
    ).toBe(false);
  });
});
