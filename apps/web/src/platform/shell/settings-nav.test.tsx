import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups, withSettingsLinks } from "./nav-groups";
import { projectHref, routeTable, type Route } from "./routes";
import { SidebarNav } from "./sidebar-nav";
import {
  collectSettingsTabs,
  groupSettings,
  moduleSettingsSection,
  platformSettingsTabs,
  SettingsNav,
  sectionFromSearch,
  type SettingsTab,
} from "./settings-nav";

// The project settings grouped by module (UI restructure §3.4, §5.4).

const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
const owner = platformSettingsTabs({ isOwner: true, connectedApps: true });
// The module sections as the shell collects them: each in its module's group.
const contributed = webRegistry.modules.flatMap((m) =>
  (m.settings ?? []).map((section) => ({
    tab: { ...section.tab, group: section.tab.group ?? m.id },
    shown: {},
  })),
);
const shape = (groups: ReturnType<typeof groupSettings>) =>
  groups.map((g) => [g.id, g.tabs.map((t) => t.key)]);

describe("groupSettings", () => {
  it("groups project first, then modules", () => {
    const groups = groupSettings(
      collectSettingsTabs(owner, contributed),
      modules,
    );
    expect(shape(groups)).toEqual([
      [
        "project",
        ["project", "members", "integrations", "retention", "modules", "apps"],
      ],
      // Spec §5.4: policy & budget, brand, then assignments.
      ["marketing", ["policy", "brand", "agents"]],
      ["support", ["support"]],
    ]);
    expect(groups.map((g) => g.label.de)).toEqual([
      "Projekt",
      "Marketing",
      "Support",
    ]);
  });

  it("orders module groups by groupOrder, not by tab order", () => {
    const tabs: SettingsTab[] = [
      {
        key: "support",
        label: { en: "S", de: "S" },
        order: 1,
        group: "support",
      },
      {
        key: "brand",
        label: { en: "B", de: "B" },
        order: 99,
        group: "marketing",
      },
      {
        key: "project",
        label: { en: "P", de: "P" },
        order: 50,
        group: "project",
      },
    ];
    expect(shape(groupSettings(tabs, modules))).toEqual([
      ["project", ["project"]],
      ["marketing", ["brand"]],
      ["support", ["support"]],
    ]);
  });

  it("a hidden module's section is not offered", () => {
    // The shell collects sections of shown modules only; a section of a
    // module that is off (or access "none") still never gets a group.
    const hidden = modules.map((m) =>
      m.id === "support" ? { ...m, enabled: false } : m,
    );
    const groups = groupSettings(
      collectSettingsTabs(owner, contributed),
      hidden,
    );
    expect(groups.map((g) => g.id)).toEqual(["project", "marketing"]);
    expect(groups.flatMap((g) => g.tabs.map((t) => t.key))).not.toContain(
      "support",
    );
  });

  it("a section whose hook returns null is left out; a label override wins", () => {
    const tabs = collectSettingsTabs(owner, [
      { tab: contributed[0]!.tab, shown: null },
      {
        tab: contributed[1]!.tab,
        shown: { label: { en: "Rules", de: "Regeln" } },
      },
    ]);
    expect(tabs.map((t) => t.key)).not.toContain(contributed[0]!.tab.key);
    expect(tabs.find((t) => t.key === contributed[1]!.tab.key)?.label.de).toBe(
      "Regeln",
    );
  });
});

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
    const groups = groupSettings(
      collectSettingsTabs(owner, contributed),
      modules,
    );
    expect(groups.find((g) => g.id === "marketing")!.tabs[0]).toMatchObject({
      key: "policy",
      label: { en: "Policy & budget", de: "Richtlinie & Budget" },
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

describe("sectionFromSearch", () => {
  const available = ["project", "members", "integrations", "policy"];
  it("opens the section named in the URL", () => {
    expect(sectionFromSearch("?section=policy", available)).toBe("policy");
    expect(sectionFromSearch("section=members&x=1", available)).toBe("members");
  });

  it("an unknown section falls back to project", () => {
    expect(sectionFromSearch("?section=nope", available)).toBe("project");
    expect(sectionFromSearch("", available)).toBe("project");
    // Hidden (e.g. assignments without Orbit Agents) counts as unknown.
    expect(sectionFromSearch("?section=agents", available)).toBe("project");
  });

  it("the Google Drive callback opens the integrations", () => {
    expect(sectionFromSearch("?googleDrive=ready", available)).toBe(
      "integrations",
    );
  });
});

describe("SettingsNav", () => {
  const groups = groupSettings(
    collectSettingsTabs(owner, contributed),
    modules,
  );
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
    ]);
  });

  it("the sidebar group shows Einstellungen linking to ?section=policy for marketing", () => {
    const groups = withSettingsLinks(
      buildNavGroups(table.routes, shellModules),
      shellModules,
      "/p/p1/settings",
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
