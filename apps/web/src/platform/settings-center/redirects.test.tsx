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
  oldAddressTarget,
  redirectModuleShown,
  type CenterAddress,
  type MapContext,
  type OldAddress,
  type RedirectContext,
} from "./redirects";
import { accountSections } from "./sections/account";
import { organizationSections } from "./sections/organization";
import {
  PLATFORM_TAB_KEYS,
  projectModuleSections,
  projectSections,
} from "./sections/project";
import { systemSections } from "./sections/system";
import { CAPABILITIES, type ManagementCapabilities, type ScopeKind } from "./types";

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
  // The old shell shows the section and ignores an id it does not take.
  ["/admin/ai/x", "/manage/system/ai"],
  ["/admin/audit/x", "/manage/system/security/audit"],
  ["/admin/invitations/x", "/manage/system/users/invitations"],
  ["/admin/projects/x?y=1", "/manage/system/organizations/projects?y=1"],
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
      "/admin/ai/x/y",
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

  it("gives every platform tab but the project its own place", () => {
    const overview = hrefOf(mapOldAddress(parse("/p/p1/settings"), ctx()));
    for (const key of PLATFORM_TAB_KEYS.filter((k) => k !== "project"))
      expect(hrefOf(mapOldAddress(parse(`/p/p1/settings?section=${key}`), ctx())), key).not.toBe(overview);
  });

  it("keeps the meaning of encoded search values", () => {
    const target = mapOldAddress(
      parse("/p/p1/settings?section=ai&q=a%26b%3Dc&name=J%C3%BCrgen%20%E2%9C%93"),
      ctx(),
    );
    if (!target || target === "wait") throw new Error("no target");
    const kept = new URLSearchParams(target.search);
    expect([...kept]).toEqual([
      ["q", "a&b=c"],
      ["name", "Jürgen ✓"],
    ]);
  });

  it("sends an empty section to the overview and lets a section win over googleDrive", () => {
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section="), ctx()))).toBe("/manage/p/p1/overview");
    expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=members&googleDrive=ready"), ctx()))).toBe(
      "/manage/p/p1/members?googleDrive=ready",
    );
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

const PROJECT_CAPS = CAPABILITIES.filter((c) => c.startsWith("project."));

/** Capabilities of a member who owns project p1 and nothing else. */
const caps = (over: Partial<ManagementCapabilities> = {}): ManagementCapabilities => ({
  stage: "on",
  flags: { connections: false, aiCatalog: false, aiDefaults: false, aiOrgBudget: false },
  system: [],
  account: [],
  organizations: [],
  projects: [
    { id: "p1", name: "P1", workspaceId: "w1", role: "owner", capabilities: [...PROJECT_CAPS] },
  ],
  ...over,
});

const rctx = (over: Partial<RedirectContext> = {}): RedirectContext => ({
  ...ctx(),
  stage: "on",
  caps: caps(),
  ...over,
});

describe("the shell's redirect of an old settings address", () => {
  const members = parse("/p/p1/settings?section=members");

  it("does nothing unless the stage is on", () => {
    for (const stage of ["off", "preview", undefined] as const)
      expect(oldAddressTarget(members, rctx({ stage })), String(stage)).toEqual({ kind: "stay" });
  });

  it("waits for the capabilities and stays when they cannot be read", () => {
    expect(oldAddressTarget(members, rctx({ caps: null }))).toEqual({ kind: "wait" });
    expect(oldAddressTarget(members, rctx({ caps: undefined }))).toEqual({ kind: "stay" });
    // Unknown module states wait even with capabilities.
    expect(
      oldAddressTarget(parse("/p/p1/settings?section=policy"), rctx({ moduleShown: () => null })),
    ).toEqual({ kind: "wait" });
    // An address that is no old settings address never waits.
    expect(oldAddressTarget(parse("/p/p1/knowledge"), rctx({ caps: null }))).toEqual({ kind: "stay" });
  });

  it("goes to the target the member can open", () => {
    expect(oldAddressTarget(members, rctx())).toEqual({ kind: "go", href: "/manage/p/p1/members" });
    expect(oldAddressTarget(parse("/p/p1/settings?section=policy&x=1#a"), rctx())).toEqual({
      kind: "go",
      href: "/manage/p/p1/modules/marketing/policy?x=1#a",
    });
    const admin = caps({ system: CAPABILITIES.filter((c) => c.startsWith("system.")) });
    expect(oldAddressTarget(parse("/admin/users/u1"), rctx({ caps: admin }))).toEqual({
      kind: "go",
      href: "/manage/system/users/u1",
    });
  });

  it("falls back to the scope's first area the member can open", () => {
    const editor = caps({
      projects: [
        {
          id: "p1",
          name: "P1",
          workspaceId: "w1",
          role: "editor",
          capabilities: PROJECT_CAPS.filter((c) => c !== "project.members"),
        },
      ],
    });
    expect(oldAddressTarget(parse("/p/p1/settings?section=members&x=1#a"), rctx({ caps: editor }))).toEqual({
      kind: "go",
      href: "/manage/p/p1/overview",
    });
    // The first area in registry order the member holds, not always the overview.
    const narrow = caps({
      projects: [
        { id: "p1", name: "P1", workspaceId: "w1", role: "editor", capabilities: ["project.ai", "project.data"] },
      ],
    });
    expect(oldAddressTarget(members, rctx({ caps: narrow }))).toEqual({ kind: "go", href: "/manage/p/p1/ai" });
  });

  it("stays when the scope is not available to the member", () => {
    expect(oldAddressTarget(parse("/account"), rctx())).toEqual({ kind: "stay" });
    expect(oldAddressTarget(parse("/admin"), rctx())).toEqual({ kind: "stay" });
    expect(oldAddressTarget(parse("/o/w1/settings"), rctx())).toEqual({ kind: "stay" });
    expect(oldAddressTarget(parse("/p/p2/settings"), rctx())).toEqual({ kind: "stay" });
  });

  it("leaves a center address alone, even while the capabilities load", () => {
    expect(oldAddressTarget(parse("/manage/p/p1/members"), rctx())).toEqual({ kind: "stay" });
    expect(oldAddressTarget(parse("/manage/system"), rctx({ caps: null }))).toEqual({ kind: "stay" });
  });
});

describe("module states for the redirect", () => {
  const shown = (states: string[]) => states.includes("marketing");
  const of = (settled: { projectId: string; states: string[] | null } | null) => ({
    projectId: "p1",
    settled,
  });

  it("is unknown while the states of that project load, then their value", () => {
    expect(redirectModuleShown(of(null), "p1", shown)).toBeNull();
    expect(redirectModuleShown(of({ projectId: "p1", states: ["marketing"] }), "p1", shown)).toBe(true);
    expect(redirectModuleShown(of({ projectId: "p1", states: [] }), "p1", shown)).toBe(false);
  });

  it("counts a module as not shown once the states of that project failed", () => {
    expect(redirectModuleShown(of({ projectId: "p1", states: null }), "p1", shown)).toBe(false);
  });

  it("never decides on states or a failure recorded for another project", () => {
    expect(redirectModuleShown(of({ projectId: "p0", states: ["marketing"] }), "p1", shown)).toBeNull();
    expect(redirectModuleShown(of({ projectId: "p0", states: [] }), "p1", shown)).toBeNull();
    expect(redirectModuleShown(of({ projectId: "p0", states: null }), "p1", shown)).toBeNull();
  });

  it("counts a module as not shown in a project whose states the shell never loads", () => {
    expect(redirectModuleShown(of({ projectId: "p1", states: ["marketing"] }), "p2", shown)).toBe(false);
    expect(redirectModuleShown({ projectId: undefined, settled: null }, "p1", shown)).toBe(false);
  });
});

describe("what the shell may read from a first mapping without module states", () => {
  const addresses = [
    ...ROWS.map(([from]) => from),
    ...EVERY_KEY,
    "/p/p1/settings?section=policy",
    "/manage/system",
    "/manage/p/p1/overview",
    "/p/p1/social/accounts",
    "/p/p1/knowledge",
    "/admin/unknown",
    "/settings",
    "/connectors",
    "/",
  ];
  const answers = [() => null, () => true, () => false] as const;

  it("whether an address maps does not depend on the module states", () => {
    for (const a of addresses) {
      const nulls = answers.map((m) => mapOldAddress(parse(a), ctx({ moduleShown: m })) === null);
      expect(new Set(nulls).size, a).toBe(1);
    }
  });

  it("a mapping that does not wait is the same with any module states", () => {
    for (const a of addresses) {
      const first = mapOldAddress(parse(a), ctx({ moduleShown: () => null }));
      if (first === "wait") continue;
      for (const m of answers.slice(1))
        expect(mapOldAddress(parse(a), ctx({ moduleShown: m })), a).toEqual(first);
    }
  });
});
