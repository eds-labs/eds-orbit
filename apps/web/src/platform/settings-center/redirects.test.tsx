import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import type { SettingsSection } from "@/platform/shell/types";
import { ADMIN_SECTIONS, routeTable } from "@/platform/shell/routes";
import {
  adaptIntegrationSections,
  resolveSection,
  visibleSections,
} from "./registry";
import {
  centerHref,
  mapOldAddress,
  moduleTabIndex,
  type CenterAddress,
  type MapContext,
  type OldAddress,
} from "./redirects";
import { accountSections } from "./sections/account";
import { organizationSections } from "./sections/organization";
import {
  PLATFORM_TAB_KEYS,
  projectModuleSections,
  projectSections,
} from "./sections/project";
import { systemSections } from "./sections/system";
import { CAPABILITIES, type ScopeKind } from "./types";

const table = routeTable(webRegistry);
const tabs = moduleTabIndex(webRegistry.modules);

const ctx = (over: Partial<MapContext> = {}): MapContext => ({
  table,
  tabs,
  platformKeys: PLATFORM_TAB_KEYS,
  moduleShown: () => true,
  ...over,
});

const parse = (href: string): OldAddress => {
  const url = new URL(href, "https://orbit.invalid");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};

const hrefOf = (target: CenterAddress | "wait" | null) =>
  target && target !== "wait" ? centerHref(target) : target;

const ROWS: ReadonlyArray<readonly [string, string]> = [
  ["/admin", "/manage/system/overview"],
  ["/admin?x=1#top", "/manage/system/overview?x=1#top"],
  ["/admin/integrations", "/manage/system/integrations"],
  ["/admin/ai", "/manage/system/ai"],
  ["/admin/mcp", "/manage/system/mcp"],
  ["/admin/audit", "/manage/system/security/audit"],
  ["/admin/users", "/manage/system/users"],
  ["/admin/users/u%201", "/manage/system/users/u%201"],
  ["/admin/invitations", "/manage/system/users/invitations"],
  ["/admin/organizations", "/manage/system/organizations"],
  ["/admin/organizations/w1", "/manage/system/organizations/w1"],
  ["/admin/projects", "/manage/system/organizations/projects"],
  ["/o/w1/settings", "/manage/o/w1/overview"],
  ["/o/w1/settings?x=1", "/manage/o/w1/overview?x=1"],
  ["/o/w1/settings#assistant-budget", "/manage/o/w1/ai/budget#assistant-budget"],
  ["/account", "/manage/me/profile"],
  ["/account/assistant", "/manage/me/assistant"],
  ["/p/p1/settings", "/manage/p/p1/overview"],
  ["/p/p1/settings?x=1#a", "/manage/p/p1/overview?x=1#a"],
  ["/p/p1/settings?googleDrive=choose-root", "/manage/p/p1/integrations/google-drive?googleDrive=choose-root"],
  [
    "/p/p1/settings?section=integrations&googleDrive=connected",
    "/manage/p/p1/integrations/google-drive?googleDrive=connected",
  ],
  ["/p/p1/settings?section=integrations", "/manage/p/p1/integrations"],
  ["/p/p1/settings?section=members", "/manage/p/p1/members"],
  ["/p/p1/settings?section=members&x=1", "/manage/p/p1/members?x=1"],
  ["/p/p1/settings?section=ai", "/manage/p/p1/ai"],
  ["/p/p1/settings?section=retention", "/manage/p/p1/data"],
  ["/p/p1/settings?section=modules", "/manage/p/p1/modules"],
  ["/p/p1/settings?section=apps", "/manage/me/connections"],
  ["/p/p1/settings?section=project", "/manage/p/p1/overview"],
  ["/p/p1/settings?section=nothing-here", "/manage/p/p1/overview"],
  ["/p/p1/settings?section=finance-mailboxes", "/manage/p/p1/modules/finance/mailboxes"],
  ["/p/p1/settings?section=work", "/manage/p/p1/modules/work/settings"],
  ["/p/p1/settings?section=brand", "/manage/p/p1/modules/marketing/brand"],
  ["/p/p1/settings?section=policy", "/manage/p/p1/modules/marketing/policy"],
  ["/p/p1/connectors", "/manage/p/p1/integrations"],
  ["/p/p1/connectors?x=1", "/manage/p/p1/integrations?x=1"],
  ["/p/p1/social/accounts?connected=2", "/manage/p/p1/integrations/social/accounts?connected=2"],
  ["/p/p1/social/accounts?error=denied", "/manage/p/p1/integrations/social/accounts?error=denied"],
];

/** Every section of a scope a member with every capability sees. */
function allSections(scope: ScopeKind) {
  const caps = [...CAPABILITIES];
  if (scope === "system") return visibleSections(systemSections, scope, caps);
  if (scope === "organization")
    return visibleSections(organizationSections, scope, caps);
  if (scope === "account") return visibleSections(accountSections, scope, caps);
  // The module hooks cannot run here: every section counts as shown, as in
  // sections/project.test.tsx.
  const contributed = webRegistry.modules.flatMap((m) =>
    (m.settings ?? []).map((s) => ({
      section: { ...s, tab: { ...s.tab, group: s.tab.group ?? m.id } },
      shown: { content: null } as ReturnType<SettingsSection["useSection"]>,
    })),
  );
  const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
  return [
    ...visibleSections(projectSections, scope, caps),
    ...projectModuleSections(contributed, modules).sections,
    ...adaptIntegrationSections(
      webRegistry.modules.flatMap((m) =>
        (m.integrations ?? []).map((c) => ({ ...c, moduleId: m.id })),
      ),
    ),
  ];
}

const EVERY_KEY: readonly string[] = [
  "/admin",
  ...[...ADMIN_SECTIONS].map((s) => `/admin/${s}`),
  ...PLATFORM_TAB_KEYS.map((k) => `/p/p1/settings?section=${k}`),
  ...[...tabs.keys()].map((k) => `/p/p1/settings?section=${k}`),
];

describe("old settings addresses", () => {
  it.each(ROWS)("maps %s", (from, to) => {
    expect(hrefOf(mapOldAddress(parse(from), ctx()))).toBe(to);
  });

  it("leaves every other address alone", () => {
    for (const a of [
      "/manage/system",
      "/manage/p/p1/overview",
      "/p/p1/social/accounts",
      "/p/p1/social/accounts?x=1",
      "/p/p1/knowledge",
      "/p/p1/settings/extra",
      "/connect",
      "/invite",
      "/reset-password",
      "/account/confirm-email",
      "/data-deletion",
      "/o/w1/agents",
      "/o/w1",
      "/o",
      "/admin/ai/extra",
      "/admin/unknown",
      "/settings",
      "/connectors",
      "/",
    ])
      expect(mapOldAddress(parse(a), ctx()), a).toBeNull();
  });

  it("sends a moved key to its new home while its module is off, and waits while that is unknown", () => {
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx({ moduleShown: () => false })))).toBe("/manage/p/p1/ai");
    expect(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx({ moduleShown: () => null }))).toBe("wait");
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx()))).toBe("/manage/p/p1/modules/marketing/policy");
  });

  it("asks whether a module is shown only for a moved key, with the project and the module", () => {
    const asked: string[] = [];
    const record = ctx({
      moduleShown: (projectId, moduleId) => {
        asked.push(`${projectId}:${moduleId}`);
        return false;
      },
    });
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=brand"), record))).toBe("/manage/p/p1/modules/marketing/brand");
    expect(asked).toEqual([]);
    mapOldAddress(parse("/p/p1/settings?section=policy"), record);
    expect(asked).toEqual([`p1:${tabs.get("policy")}`]);
  });

  it("lets a platform key win over a module tab with the same key", () => {
    // Webmail contributes to the platform tab "integrations".
    const webmail = webRegistry.modules.find((m) => m.id === "webmail")!;
    expect(webmail.settings?.some((s) => s.tab.key === "integrations")).toBe(true);
    for (const key of PLATFORM_TAB_KEYS) expect(tabs.has(key), key).toBe(false);
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=integrations"), ctx()))).toBe("/manage/p/p1/integrations");
  });

  it("indexes the first module of a shared key and skips modules without settings", () => {
    const index = moduleTabIndex([
      { id: "a" },
      { id: "b", settings: [{ tab: { key: "shared" } }, { tab: { key: "b-own" } }] },
      { id: "c", settings: [{ tab: { key: "shared" } }, { tab: { key: "members" } }] },
    ]);
    expect([...index]).toEqual([
      ["shared", "b"],
      ["b-own", "b"],
    ]);
  });

  it("keeps the search stable and drops an empty one", () => {
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?b=2&section=ai&a=x%20y"), ctx()))).toBe("/manage/p/p1/ai?b=2&a=x+y");
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=ai"), ctx()))).toBe("/manage/p/p1/ai");
    expect(hrefOf(mapOldAddress({ pathname: "/admin", search: "?", hash: "#" }, ctx()))).toBe("/manage/system/overview");
  });

  it("maps every admin section, every platform tab and every registered module tab", () => {
    expect(tabs.size).toBeGreaterThan(0);
    for (const a of EVERY_KEY) {
      const target = mapOldAddress(parse(a), ctx());
      expect(target, a).not.toBeNull();
      expect(target, a).not.toBe("wait");
    }
  });

  it("lands on a section the center has", () => {
    const addresses = [
      ...ROWS.map(([from]) => from),
      ...EVERY_KEY,
      "/p/p1/settings?section=policy",
    ];
    const contexts = [ctx(), ctx({ moduleShown: () => false })];
    for (const c of contexts) {
      for (const a of addresses) {
        const target = mapOldAddress(parse(a), c);
        if (!target || target === "wait") throw new Error(`no target for ${a}`);
        expect(
          resolveSection(allSections(target.scope.kind), target.area, target.rest),
          `${a} -> ${centerHref(target)}`,
        ).not.toBeNull();
      }
    }
  });
});
