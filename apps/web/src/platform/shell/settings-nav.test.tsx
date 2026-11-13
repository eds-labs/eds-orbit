import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import { resolveSection } from "@/platform/settings-center/registry";
import {
  PLATFORM_TAB_KEYS,
  projectModuleSections,
} from "@/platform/settings-center/sections/project";
import { buildNavGroups, moduleSettingsHref, withSettingsLinks } from "./nav-groups";
import { locate, projectHref, routeTable, type Route } from "./routes";
import { SidebarNav } from "./sidebar-nav";
import type { SettingsSection } from "./types";
import {
  moduleSettingsSection,
  platformSettingsTabs,
  SettingsNav,
  settingsSectionHref,
  type SettingsGroup,
  type SettingsTab,
} from "./settings-nav";

// The project settings grouped by module (UI restructure §3.4, §5.4).

const owner = platformSettingsTabs({ isOwner: true, connectedApps: true });
// The module sections as the shell collects them: each in its module's group.
const contributed = webRegistry.modules.flatMap((m) =>
  (m.settings ?? []).map((section) => ({
    tab: { ...section.tab, group: section.tab.group ?? m.id },
    shown: {},
  })),
);
describe("platform sections", () => {
  it("retention is its own project section", () => {
    const retention = owner.find((t) => t.key === "retention");
    expect(retention).toMatchObject({
      group: "project",
      order: 45,
      label: { en: "Retention", de: "Aufbewahrung" },
    });
    // The platform has no policy section of its own any more: the policy
    // belongs to the Marketing group.
    expect(owner.map((t) => t.key)).not.toContain("policy");
    const policy = contributed.find((c) => c.tab.key === "policy")!.tab;
    expect(policy).toMatchObject({
      group: "marketing",
      label: { en: "Publishing rules", de: "Veröffentlichungsregeln" },
    });
  });

  it("members is its own project section", () => {
    expect(owner.find((t) => t.key === "members")).toMatchObject({
      group: "project",
      order: 10,
      label: { en: "Members & roles", de: "Mitglieder & Rollen" },
    });
  });

  it("members and retention are for owners; apps only when available", () => {
    expect(
      platformSettingsTabs({ isOwner: false, connectedApps: false }).map(
        (t) => t.key,
      ),
    ).toEqual(["project", "integrations", "modules"]);
  });
});

describe("the Google Drive callback", () => {
  it("the callback's address is the settings page of its project", () => {
    // The API sends the browser to /p/<project>/settings?googleDrive=...;
    // the path must resolve to that project's settings, not be rewritten.
    const place = locate("/p/p1/settings", routeTable(webRegistry));
    expect(place).toMatchObject({
      kind: "view",
      projectId: "p1",
      route: { key: "settings" },
    });
  });
});

describe("settingsSectionHref", () => {
  it("is the page for Project and ?section=<key>, encoded, otherwise", () => {
    expect(settingsSectionHref("/p/p1/settings", "project")).toBe(
      "/p/p1/settings",
    );
    expect(settingsSectionHref("/p/p1/settings", "policy")).toBe(
      "/p/p1/settings?section=policy",
    );
    expect(settingsSectionHref("/p/p1/settings", "a b&c")).toBe(
      "/p/p1/settings?section=a%20b%26c",
    );
  });
});

const tab = (key: string, en: string, de: string, group: string): SettingsTab => ({
  key,
  label: { en, de },
  order: 0,
  group,
});
const groups: SettingsGroup[] = [
  {
    id: "project",
    label: { en: "Project", de: "Projekt" },
    tabs: owner,
  },
  {
    id: "marketing",
    label: { en: "Marketing", de: "Marketing" },
    tabs: [
      tab("policy", "Publishing rules", "Veröffentlichungsregeln", "marketing"),
      tab("brand", "Brand", "Marke", "marketing"),
    ],
  },
  {
    id: "support",
    label: { en: "Support", de: "Support" },
    tabs: [tab("support", "Support", "Support", "support")],
  },
];

describe("SettingsNav", () => {
  const html = renderToStaticMarkup(
    <SettingsNav
      groups={groups}
      value="brand"
      hrefOf={(key) => `/p/p1/settings?section=${key}`}
      onSelect={() => {}}
      locale="de"
    />,
  );

  it("is a labelled nav with group headings and the open section current", () => {
    expect(html).toMatch(/<nav[^>]*aria-label="Einstellungsbereiche"/);
    for (const label of ["Projekt", "Marketing", "Support"])
      expect(html).toMatch(new RegExp(`<h2[^>]*>${label}</h2>`));
    const brand = /<a[^>]*section=brand"[^>]*>/.exec(html)?.[0];
    expect(brand).toContain('aria-current="page"');
    const policy = /<a[^>]*section=policy"[^>]*>/.exec(html)?.[0];
    expect(policy).not.toContain("aria-current");
  });

  it("offers the same sections as a labelled select for small screens", () => {
    expect(html).toMatch(/<label[^>]*for="settings-section"[^>]*>Bereich</);
    expect(html).toContain('<optgroup label="Marketing">');
    expect(html).toMatch(/<option value="brand" selected="">Marke<\/option>/);
  });
});

describe("SettingsNav placeholder", () => {
  const nav = (value: string, placeholder?: string) =>
    renderToStaticMarkup(
      <SettingsNav
        groups={groups}
        value={value}
        hrefOf={(key) => `/p/p1/settings?section=${key}`}
        onSelect={() => {}}
        locale="en"
        placeholder={placeholder}
      />,
    );

  it("leads the select with the placeholder when no section is open", () => {
    expect(nav("", "Choose a section")).toContain(
      '<option value="" disabled="" selected="">Choose a section</option>',
    );
    expect(nav("nope", "Choose a section")).toContain(
      '<option value="" disabled="" selected="">Choose a section</option>',
    );
  });

  it("leaves the placeholder out while a section is open", () => {
    const html = nav("brand", "Choose a section");
    expect(html).not.toContain("Choose a section");
    expect(html).toBe(nav("brand"));
  });

  it("renders no placeholder without the prop", () => {
    expect(nav("")).not.toContain('<option value=""');
  });
});

describe("module settings links in the sidebar", () => {
  const table = routeTable(webRegistry);
  const hrefOf = (r: Route) => projectHref("p1", r);
  const shellModules = webRegistry.modules.map((m) => ({
    ...m,
    enabled: true,
    settingsSection: moduleSettingsSection(m.id, m.settings ?? []),
  }));

  it("the first section by order is the module's settings section", () => {
    expect(shellModules.map((m) => [m.id, m.settingsSection])).toEqual([
      ["knowledge", undefined],
      ["marketing", "policy"],
      ["support", "support"],
      ["finance", "finance-mailboxes"],
      ["work", "work"],
      ["issues", "issues"],
      ["social", undefined],
      ["webmail", "integrations"],
      ["ads", undefined],
    ]);
  });

  it("the first section is never a conditional one", () => {
    // The sidebar link targets the lowest-order section, so it must be shown
    // whenever the module is. Sections whose hook can return null (hidden
    // until an API answers) must not come first; none is left since the
    // assignments became a page.
    const conditional = new Set<string>([]);
    for (const m of webRegistry.modules) {
      const key = moduleSettingsSection(m.id, m.settings ?? []);
      if (key === undefined) continue;
      expect(conditional.has(key), `${m.id}: ${key}`).toBe(false);
    }
    const marketing = webRegistry.modules.find((m) => m.id === "marketing")!;
    expect(moduleSettingsSection("marketing", marketing.settings!)).toBe(
      "policy",
    );
  });

  it("the sidebar group shows Einstellungen linking to ?section=policy for marketing", () => {
    const groups = withSettingsLinks(
      buildNavGroups(table.routes, shellModules),
      shellModules,
      (key) => settingsSectionHref("/p/p1/settings", key),
    );
    const html = renderToStaticMarkup(
      <SidebarNav
        groups={groups}
        activeKey={undefined}
        hrefOf={hrefOf}
        locale="de"
        collapsed={new Set()}
        onToggle={() => {}}
      />,
    );
    const list = (id: string) =>
      new RegExp(`<ul id="nav-group-${id}"[^>]*>.*?</ul>`).exec(html)?.[0] ??
      "";
    const marketing = list("marketing");
    // The last entry of the group, with the module in its accessible name.
    expect(marketing).toMatch(
      /<li><a[^>]*href="\/p\/p1\/settings\?section=policy"[^>]*>.*Einstellungen<\/a><\/li><\/ul>$/,
    );
    expect(marketing).toContain('<span class="sr-only">Marketing </span>');
    expect(list("support")).toContain('href="/p/p1/settings?section=support"');
    // Knowledge has no settings section, so no link.
    expect(list("knowledge")).not.toContain("settings?section");
    // Not a route: no badge and never the current page.
    expect(marketing).not.toMatch(/section=policy"[^>]*aria-current/);
  });
});

describe("module settings links into the settings center (P5-R6)", () => {
  const table = routeTable(webRegistry);
  const shellModules = webRegistry.modules.map((m) => ({
    ...m,
    enabled: true,
    settingsSection: moduleSettingsSection(m.id, m.settings ?? []),
  }));
  const links = () =>
    Object.fromEntries(
      withSettingsLinks(
        buildNavGroups(table.routes, shellModules),
        shellModules,
        moduleSettingsHref({ projectId: "p1", platformKeys: PLATFORM_TAB_KEYS }),
      ).flatMap((g) => (g.settingsHref ? [[g.id, g.settingsHref]] : [])),
    );

  it("opens each module's own section in the center", () => {
    expect(links()).toEqual({
      marketing: "/manage/p/p1/modules/marketing/policy",
      work: "/manage/p/p1/modules/work/settings",
      support: "/manage/p/p1/modules/support/settings",
      // On the platform key "integrations", yet its own section, not the catalog.
      webmail: "/manage/p/p1/modules/webmail/settings",
      issues: "/manage/p/p1/modules/issues/settings",
      finance: "/manage/p/p1/modules/finance/mailboxes",
    });
  });

  it("every link lands on a section the center has", () => {
    const sections = projectModuleSections(
      webRegistry.modules.flatMap((m) =>
        (m.settings ?? []).map((s) => ({
          section: { ...s, tab: { ...s.tab, group: s.tab.group ?? m.id } },
          shown: { content: null } as ReturnType<SettingsSection["useSection"]>,
        })),
      ),
      shellModules,
    ).sections;
    for (const [id, href] of Object.entries(links())) {
      const rest = href.replace("/manage/p/p1/modules/", "").split("/");
      expect(resolveSection(sections, "modules", rest)?.section.id, id).toBeDefined();
    }
  });
});
