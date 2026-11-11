import { describe, expect, it } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import type { Identity } from "@/lib/api";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import {
  collectSettingsTabs,
  groupSettings,
  platformSettingsTabs,
} from "@/platform/shell/settings-nav";
import type { SettingsSection } from "@/platform/shell/types";
import {
  adaptModuleSections,
  navGroups,
  resolveSection,
  validateSections,
  visibleSections,
} from "../registry";
import { ScopeView } from "../scope-view";
import type { ManagementCapabilities, ManageScope, ManageTarget } from "../types";
import {
  PLATFORM_TAB_KEYS,
  projectModuleSections,
  projectSections,
  ProjectScopeView,
} from "./project";

const keys = (caps: Parameters<typeof visibleSections>[2]) =>
  visibleSections(projectSections, "project", caps).map(
    (s) => `${s.area}/${s.id}`,
  );

// The capabilities of the two project roles, as apps/api grants them.
const VIEWER = [
  "project.overview",
  "project.profile",
  "project.modules",
  "project.integrations",
] as const;
const OWNER = [...VIEWER, "project.members", "project.ai", "project.data"] as const;

type Shown = ReturnType<SettingsSection["useSection"]>;

const modules = [
  {
    id: "alpha",
    displayName: { en: "Alpha module", de: "Alpha-Modul" },
    description: { en: "About alpha", de: "Über Alpha" },
  },
  {
    id: "beta",
    displayName: { en: "Beta module", de: "Beta-Modul" },
    description: { en: "About beta", de: "Über Beta" },
  },
];

const section = (
  group: string,
  key: string,
  extra: { tabOrder?: number; order?: number; label?: string } = {},
): SettingsSection => ({
  tab: {
    key,
    label: { en: extra.label ?? `Tab ${key}`, de: extra.label ?? `Reiter ${key}` },
    order: extra.tabOrder ?? 0,
    group,
  },
  order: extra.order ?? 0,
  useSection: () => null,
});

const props = {
  scope: { kind: "project", projectId: "p1" } as ManageScope,
  locale: "en" as const,
  identity: {
    user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
    projects: [],
    workspaces: [],
  } as Identity,
  hrefOf: () => "",
};
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("project scope", () => {
  it("registers valid sections", () => {
    expect(() => validateSections(projectSections)).not.toThrow();
    expect(projectSections.every((s) => s.scope === "project")).toBe(true);
  });

  it("gives viewers overview, profile, modules and integrations, and owners members, AI and data too", () => {
    expect(keys([...VIEWER])).toEqual([
      "overview/summary",
      "profile/profile",
      "modules/switches",
      "integrations/connections",
      "integrations/google-drive",
    ]);
    expect(keys([...OWNER])).toEqual([
      "overview/summary",
      "profile/profile",
      "members/members",
      "modules/switches",
      "integrations/connections",
      "integrations/google-drive",
      "ai/overview",
      "data/retention",
    ]);
    expect(keys([])).toEqual([]);
  });

  it("names the platform's own setting tabs", () => {
    expect(PLATFORM_TAB_KEYS).toEqual([
      "project",
      "members",
      "integrations",
      "ai",
      "retention",
      "modules",
      "apps",
    ]);
  });
});

describe("adaptModuleSections", () => {
  // Every module section as the shell collects it: each in its module's group.
  const real = webRegistry.modules.flatMap((m) =>
    (m.settings ?? []).map((s) => ({
      section: { ...s, tab: { ...s.tab, group: s.tab.group ?? m.id } },
      shown: { content: <i>marker</i> } as Shown,
    })),
  );

  it("adapts module sections under their module", () => {
    const { sections } = adaptModuleSections(
      real,
      webRegistry.modules,
      PLATFORM_TAB_KEYS,
    );
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [
        "marketing/policy",
        "marketing/brand",
        "work/settings",
        "issues/settings",
        "support/settings",
        "finance/mailboxes",
        "finance/accounts",
        "finance/cost-centers",
        "finance/currencies",
        "finance/ai",
        "webmail/settings",
      ].sort(),
    );
    for (const s of sections) {
      expect(s.scope).toBe("project");
      expect(s.area).toBe("modules");
      expect(s.moduleId).toBe(s.id.split("/")[0]);
    }
    // Webmail's section sits on the platform's integrations tab, so it goes by
    // the module's name rather than the tab's.
    const webmail = webRegistry.modules.find((m) => m.id === "webmail")!;
    expect(sections.find((s) => s.id === "webmail/settings")?.label).toEqual(
      webmail.displayName,
    );
    expect(sections.find((s) => s.id === "webmail/settings")?.description).toEqual(
      webmail.description,
    );
  });

  it("groups by module in the modules' order, each by tab order", () => {
    const { sections } = adaptModuleSections(
      [
        { section: section("beta", "beta-two", { tabOrder: 20 }), shown: { content: null } },
        { section: section("alpha", "alpha-x", { tabOrder: 50 }), shown: { content: null } },
        { section: section("beta", "beta-one", { tabOrder: 10 }), shown: { content: null } },
        { section: section("alpha", "alpha-y", { tabOrder: 5 }), shown: { content: null } },
      ],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(sections.map((s) => s.id)).toEqual([
      "alpha/y",
      "alpha/x",
      "beta/one",
      "beta/two",
    ]);
    expect(sections.map((s) => s.order)).toEqual([5, 50, 10, 20]);
    // One navigation group per module after the platform's modules area.
    expect(navGroups(sections, "project", () => undefined).map((g) => g.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("leaves out a section whose hook returned null and keeps its notice out", () => {
    const { sections, notices } = adaptModuleSections(
      [
        { section: section("alpha", "alpha-hidden"), shown: null },
        {
          section: section("beta", "beta"),
          shown: { content: <i>beta-content</i>, notice: <b>beta-notice</b> },
        },
      ],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(sections.map((s) => s.id)).toEqual(["beta/settings"]);
    expect(notices).toHaveLength(1);
    expect(html(notices)).toBe("<b>beta-notice</b>");
  });

  it("returns notices of shown sections, also when their module has no content to add", () => {
    const { notices } = adaptModuleSections(
      [
        { section: section("alpha", "alpha"), shown: { content: null, notice: "first" } },
        { section: section("alpha", "alpha-more"), shown: { content: null } },
        { section: section("beta", "beta"), shown: { content: null, notice: "second" } },
      ],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(notices).toEqual(["first", "second"]);
  });

  it("joins contributions with the same id in their order", () => {
    const { sections } = adaptModuleSections(
      [
        {
          section: section("alpha", "alpha", { order: 20, label: "Alpha tab" }),
          shown: { content: <i>second</i> },
        },
        {
          section: section("alpha", "alpha", { order: 10, label: "Alpha tab" }),
          shown: { content: <i>first</i>, label: { en: "Renamed", de: "Umbenannt" } },
        },
      ],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("alpha/settings");
    expect(html(sections[0].render(props))).toBe("<i>first</i><i>second</i>");
    // The module's own tab keeps its label; the hook's label overrides it.
    expect(sections[0].label).toEqual({ en: "Renamed", de: "Umbenannt" });
    expect(sections[0].description).toEqual(modules[0].description);
  });

  it("names a section on a platform tab after its module", () => {
    const { sections } = adaptModuleSections(
      [
        {
          section: section("beta", "integrations", { label: "Integrations" }),
          shown: { content: null, label: { en: "Ignored", de: "Ignoriert" } },
        },
        { section: section("beta", "beta-mail", { label: "Mail" }), shown: { content: null } },
      ],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(sections.map((s) => [s.id, s.label.en])).toEqual([
      ["beta/settings", "Beta module"],
      ["beta/mail", "Mail"],
    ]);
  });

  it("gives a module without contributions no section, no group and no address", () => {
    // Beta is disabled or its access is none: the shell leaves its sections out.
    const { sections } = adaptModuleSections(
      [{ section: section("alpha", "alpha-x"), shown: { content: null } }],
      modules,
      PLATFORM_TAB_KEYS,
    );
    expect(sections.some((s) => s.moduleId === "beta")).toBe(false);
    expect(navGroups(sections, "project", () => undefined).map((g) => g.id)).toEqual([
      "alpha",
    ]);
    expect(resolveSection(sections, "modules", ["beta"])).toBeNull();
    // Inside the real list too: the switches do not take a module's address.
    const all = [
      ...visibleSections(projectSections, "project", [...OWNER]),
      ...sections,
    ];
    expect(resolveSection(all, "modules", ["beta"])).toBeNull();
    expect(resolveSection(all, "modules", [])?.section.id).toBe("switches");
    expect(resolveSection(all, "modules", ["alpha"])?.section.id).toBe("alpha/x");
    // Module sections never read an id.
    expect(sections.every((s) => s.takesId === undefined)).toBe(true);
    expect(resolveSection(all, "modules", ["alpha", "x", "y"])).toBeNull();
    expect(resolveSection(sections, "modules", ["beta", "settings"])).toBeNull();
  });

  it("resolves a module section by its address", () => {
    const { sections } = adaptModuleSections(
      real,
      webRegistry.modules,
      PLATFORM_TAB_KEYS,
    );
    const all = [
      ...visibleSections(projectSections, "project", [...OWNER]),
      ...sections,
    ];
    const accounts = resolveSection(all, "modules", ["finance", "accounts"]);
    expect(accounts?.section.id).toBe("finance/accounts");
    expect(accounts?.id).toBeUndefined();
    const finance = sections
      .filter((s) => s.moduleId === "finance")
      .sort((a, b) => a.order - b.order)[0];
    expect(resolveSection(all, "modules", ["finance"])?.section).toBe(finance);
    // The platform's switches stay the area's first section.
    expect(resolveSection(all, "modules", [])?.section.id).toBe("switches");
  });
});

describe("projectModuleSections", () => {
  it("orders the module groups like the sidebar and the old settings page", () => {
    // The real modules, all enabled, with their real groupOrder values.
    const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
    const contributed = webRegistry.modules.flatMap((m) =>
      (m.settings ?? []).map((section) => ({
        section: {
          ...section,
          tab: { ...section.tab, group: section.tab.group ?? m.id },
        },
        shown: { content: null } as Shown,
      })),
    );
    const center = navGroups(
      projectModuleSections(contributed, modules).sections,
      "project",
      () => undefined,
    )
      .map((g) => g.id)
      .filter((id) => modules.some((m) => m.id === id));
    const old = groupSettings(
      collectSettingsTabs(
        platformSettingsTabs({ isOwner: true, connectedApps: true }),
        contributed.map(({ section, shown }) => ({ tab: section.tab, shown })),
      ),
      modules,
    )
      .map((g) => g.id)
      .filter((id) => modules.some((m) => m.id === id));
    expect(center.length).toBeGreaterThan(1);
    // A module whose only section joins a platform tab on the old page (webmail
    // on "integrations") has no group there; every other one is in the same
    // order.
    expect(center.filter((id) => old.includes(id))).toEqual(old);
  });
});

describe("ProjectScopeView", () => {
  const scope: ManageScope = { kind: "project", projectId: "p1" };
  const caps: ManagementCapabilities = {
    stage: "on",
    system: [],
    account: [],
    organizations: [],
    projects: [
      { id: "p1", name: "Alpha", workspaceId: "w1", role: "viewer", capabilities: [...VIEWER] },
    ],
  };
  const calls: string[] = [];
  const shell = {
    modules: modules.map((m) => ({ ...m, enabled: true, nav: [] })),
    hrefOf: (key: string) => `/p/p1/${key}`,
    settings: [
      {
        ...section("alpha", "alpha", { label: "Alpha tab" }),
        useSection() {
          // A real hook, as module sections use them.
          const [text] = useState("alpha-content");
          calls.push("alpha");
          return { content: <i>{text}</i>, notice: <b>alpha-notice</b> };
        },
      },
      {
        ...section("beta", "beta"),
        useSection() {
          calls.push("beta");
          return null;
        },
      },
    ],
  } as unknown as ShellContextValue;

  const render = (target: Partial<ManageTarget>) =>
    renderToStaticMarkup(
      <ShellContext.Provider value={shell}>
        <ScopeView
          scope={scope}
          capabilities={caps.projects[0].capabilities}
          name="Alpha"
          target={{ scope, area: null, rest: [], ...target }}
          caps={caps}
          identity={props.identity}
          locale="en"
          navigate={() => {}}
        />
      </ShellContext.Provider>,
    );

  it("lists the platform sections and the shown module sections in the overview", () => {
    calls.length = 0;
    const page = render({});
    expect(calls).toEqual(["alpha", "beta"]);
    expect(page).toContain("<h1>Alpha</h1>");
    expect(page).toContain('href="/p/p1"');
    expect(page).toContain('href="/manage/p/p1/modules/alpha/settings"');
    expect(page).toContain("Alpha module");
    expect(page).not.toContain("Beta module");
    expect(page).toContain("<b>alpha-notice</b>");
  });

  it("opens a module section by its address with the notice above it", () => {
    const page = render({ area: "modules", rest: ["alpha", "settings"] });
    expect(page).toContain("<i>alpha-content</i>");
    expect(page.indexOf("alpha-notice")).toBeLessThan(page.indexOf("alpha-content"));
    expect(page).toContain("<h2>Alpha tab</h2>");
    expect(page).toContain("<p>About alpha</p>");
  });

  it("lets an unknown module address fall to not available", () => {
    const page = render({ area: "modules", rest: ["beta", "settings"] });
    expect(page).toContain("Not available");
    expect(page).not.toContain("alpha-content");
  });
});
