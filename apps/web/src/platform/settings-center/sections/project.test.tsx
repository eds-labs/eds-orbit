import { describe, expect, it } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import { moduleIntegrations, moduleSettings } from "@/platform/shell/routes";
import type { Identity, Project } from "@/lib/api";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { platformSettingsTabs } from "@/platform/shell/settings-nav";
import { groupedModules } from "@/platform/shell/nav-groups";
import { WorkspaceContext } from "@/components/workspace-context";
import type { AiConfigurationData } from "@/components/ai-settings";
import type { SettingsSection } from "@/platform/shell/types";
import {
  adaptIntegrationSections,
  adaptModuleSections,
  navGroups,
  resolveSection,
  sectionPath,
  validateModuleSections,
  validateSections,
  visibleSections,
} from "../registry";
import { ScopeView } from "../scope-view";
import type { ManagementCapabilities, ManageScope, ManageTarget } from "../types";
import {
  AiModelsSectionView,
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
      "integrations/integrations",
      "integrations/setup",
      "integrations/connections",
      "integrations/google-drive",
      "integrations/public-access",
    ]);
    expect(keys([...OWNER])).toEqual([
      "overview/summary",
      "profile/profile",
      "members/members",
      "modules/switches",
      "integrations/integrations",
      "integrations/setup",
      "integrations/connections",
      "integrations/google-drive",
      "integrations/public-access",
      "ai/overview",
      "ai/providers",
      "ai/models",
      "ai/budget",
      "ai/usage",
      "ai/agents",
      "data/retention",
    ]);
    expect(keys([])).toEqual([]);
  });

  it("opens the area on the catalog and keeps connections and google-drive reachable", () => {
    const list = visibleSections(projectSections, "project", [...VIEWER]);
    const lead = resolveSection(list, "integrations", []);
    expect(lead?.section.id).toBe("integrations");
    expect(sectionPath(lead!.section)).toEqual(["integrations"]);
    expect(resolveSection(list, "integrations", ["connections"])?.section.id).toBe("connections");
    expect(resolveSection(list, "integrations", ["google-drive"])?.section.id).toBe("google-drive");
  });

  it("opens a provider's setup by address and refuses an unknown one", () => {
    const list = visibleSections(projectSections, "project", [...VIEWER]);
    expect(resolveSection(list, "integrations", ["setup", "postiz"])).toMatchObject({ section: { id: "setup" }, id: "postiz" });
    expect(resolveSection(list, "integrations", ["setup"])).toMatchObject({ section: { id: "setup" }, id: undefined });
    expect(resolveSection(list, "integrations", ["setup", "postiz", "extra"])).toBeNull();
    expect(list.find((s) => s.id === "setup")?.label).toEqual({ en: "Set up an integration", de: "Integration einrichten" });
  });

  it("places the Social accounts section of the real registry under Integrations", () => {
    const social = webRegistry.modules.find((m) => m.id === "social")!;
    const contributed = (social.integrations ?? []).map((c) => ({ ...c, moduleId: social.id }));
    const all = [
      ...visibleSections(projectSections, "project", [...VIEWER]),
      ...adaptIntegrationSections(contributed),
    ];
    const accounts = resolveSection(all, "integrations", ["social", "accounts"]);
    expect(accounts?.section).toMatchObject({ id: "social/accounts", ownHead: true, order: 100 });
    expect(accounts?.section.label).toEqual({ en: "Social accounts", de: "Social-Media-Konten" });
    expect(resolveSection(all, "integrations", [])?.section.id).toBe("integrations");
    const group = navGroups(all, "project", () => undefined).find((g) => g.id === "integrations")!;
    expect(group.sections.map((s) => s.id)).toEqual([
      "integrations",
      "setup",
      "connections",
      "google-drive",
      "public-access",
      "social/accounts",
    ]);
  });

  it("names every tab the platform's settings page can offer", () => {
    const offered = platformSettingsTabs({ isOwner: true, connectedApps: true });
    for (const tab of offered) expect(PLATFORM_TAB_KEYS).toContain(tab.key);
    expect(PLATFORM_TAB_KEYS).toHaveLength(offered.length);
  });

  it("registers the six AI sections for owners only", () => {
    const ai = (caps: Parameters<typeof visibleSections>[2]) =>
      keys(caps).filter((key) => key.startsWith("ai/"));
    expect(ai([...OWNER])).toEqual([
      "ai/overview",
      "ai/providers",
      "ai/models",
      "ai/budget",
      "ai/usage",
      "ai/agents",
    ]);
    expect(ai([...VIEWER])).toEqual([]);
    const sections = projectSections.filter((s) => s.area === "ai");
    expect(sections.every((s) => s.capability === "project.ai")).toBe(true);
    expect(sections.map((s) => s.order)).toEqual([0, 10, 20, 30, 40, 50]);
    // The agent permissions panel keeps its own heading below the frame's.
    expect(sections.some((s) => s.ownHead || s.takesId || s.advanced)).toBe(false);
    expect(sections.find((s) => s.id === "overview")?.label).toEqual({
      en: "AI overview",
      de: "KI-Übersicht",
    });
  });

  it("resolves the short address to the overview and nothing else below it", () => {
    const list = visibleSections(projectSections, "project", [...OWNER]);
    expect(resolveSection(list, "ai", [])?.section.id).toBe("overview");
    expect(resolveSection(list, "ai", ["overview"])?.section.id).toBe("overview");
    expect(resolveSection(list, "ai", ["models"])?.section.id).toBe("models");
    expect(resolveSection(list, "ai", ["nope"])).toBeNull();
    expect(resolveSection(list, "ai", ["models", "extra"])).toBeNull();
  });

  it("offers model edits only while the project does not follow the standard", () => {
    const configuration = (routing: AiConfigurationData["routing"]) => ({
      data: {
        configured: true,
        source: "environment",
        textKeyConfigured: true,
        imageKeyConfigured: true,
        dedicatedImageKeyConfigured: false,
        verifiedModels: [],
        rateCard: {},
        modelRoutes: { fast: "m", standard: "m", quality: "m", escalation: "m" },
        imageGeneration: { model: "i", maxCostMicrosPerImage: 0 },
        taskRoutes: {},
        catalog: null,
        stored: null,
        defaultProvider: "openai",
        anthropicTierRoutes: null,
        models: {},
        providerBudgets: {},
        fallback: { onProviderBudgetStop: "none" },
        providers: {
          openai: { keyConfigured: true, source: "environment" },
          anthropic: { keyConfigured: false, source: "none" },
        },
        routing,
        defaults: { standard: null, presets: {} },
      } as unknown as AiConfigurationData,
      loading: false,
      error: null,
      refresh() {},
      path: null,
    });
    const render = (routing: AiConfigurationData["routing"], aiDefaults = true) =>
      renderToStaticMarkup(
        <WorkspaceContext.Provider
          value={{
            project: { id: "p1", name: "Alpha" } as unknown as Project,
            identity: props.identity,
            locale: "en",
            t: (key: string) => key,
            canEdit: true,
            isOwner: true,
            revision: 0,
            refresh: () => {},
            href: (path: string) => path,
          }}
        >
          <AiModelsSectionView
            configuration={configuration(routing) as never}
            refreshAll={() => {}}
            aiDefaults={aiDefaults}
            locale="en"
          />
        </WorkspaceContext.Provider>,
      );
    const following = render({ source: "organization", overrides: {} } as never);
    expect(following).not.toContain("Task routes");
    expect(following).toContain("<summary>Models, prices and task routes</summary>");
    expect(following).not.toContain("not switched on");
    expect(render(null)).toContain("Task routes");
    expect(render(null, false)).toContain(
      "Standard models and presets are not switched on for this installation; a project uses its own AI settings, or the profiles and the environment where it has none.",
    );
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
    expect(sections.find((s) => s.id === "webmail/settings")?.description).toEqual({
      en: "Which mailboxes open in Webmail.",
      de: "Welche Postfächer in Webmail geöffnet werden.",
    });
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

describe("the real registry's module sections", () => {
  // Every module shown, each hook replaced by a stub that returns content.
  const sections = () => {
    const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
    const contributed = moduleSettings(webRegistry.modules, () => true).map(
      ({ moduleId: _moduleId, ...section }) => ({
        section,
        shown: { content: <i>stub</i> } as Shown,
      }),
    );
    return [
      ...projectModuleSections(contributed, modules).sections,
      ...adaptIntegrationSections(moduleIntegrations(webRegistry.modules, () => true, { knowledgeWorkspace: true })),
    ];
  };

  it("are valid", () => {
    expect(sections().length).toBeGreaterThan(5);
    expect(() => validateModuleSections(sections())).not.toThrow();
  });

  it("each have their own description in both languages", () => {
    const modulesById = new Map(webRegistry.modules.map((m) => [m.id, m]));
    for (const s of sections().filter((x) => x.moduleId)) {
      expect(s.description.en.trim()).not.toBe("");
      expect(s.description.de.trim()).not.toBe("");
      expect(s.description).not.toEqual(modulesById.get(s.moduleId!)!.description);
    }
  });
});

describe("projectModuleSections", () => {
  it("orders the module groups like the sidebar", () => {
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
    const expected = groupedModules(modules)
      .map((m) => m.id)
      .filter((id) => center.includes(id));
    expect(center.length).toBeGreaterThan(1);
    expect(center).toEqual(expected);
  });
});

describe("ProjectScopeView", () => {
  const scope: ManageScope = { kind: "project", projectId: "p1" };
  const caps: ManagementCapabilities = {
    flags: { connections: false, aiCatalog: false, aiDefaults: false, aiOrgBudget: false },
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
    integrations: [
      {
        moduleId: "alpha",
        id: "accounts",
        label: { en: "Alpha accounts", de: "Alpha-Konten" },
        description: { en: "About alpha accounts", de: "Über Alpha-Konten" },
        order: 0,
        component: () => <i>alpha-accounts</i>,
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

  it("opens a module's integration section under Integrations", () => {
    const page = render({ area: "integrations", rest: ["alpha", "accounts"] });
    expect(page).toContain("<i>alpha-accounts</i>");
    expect(page).toContain("<h2>Alpha accounts</h2>");
    const overview = render({});
    expect(overview).toContain('href="/manage/p/p1/integrations/alpha/accounts"');
  });

  it("lets an unknown module address fall to not available", () => {
    const page = render({ area: "modules", rest: ["beta", "settings"] });
    expect(page).toContain("Not available");
    expect(page).not.toContain("alpha-content");
  });
});
