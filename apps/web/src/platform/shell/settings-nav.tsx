"use client";
import type { MouseEvent } from "react";
import { labels, type Locale } from "@/lib/i18n";
import { groupedModules } from "./nav-groups";
import type { Label, SettingsSection } from "./types";

// The project settings grouped by module (UI restructure §5.4): the platform's
// sections under "Project", then one group per module with its sections. The
// open section lives in the URL (?section=); pure helpers, then the list.

export type SettingsTab = {
  key: string;
  label: Label;
  order: number;
  /** "project" or a module id. */
  group: string;
};
export type SettingsGroup = { id: string; label: Label; tabs: SettingsTab[] };

const PROJECT = "project";
const PROJECT_LABEL: Label = {
  en: labels.en.navProject,
  de: labels.de.navProject,
};

/**
 * The platform's own sections. Members and retention are owner tools (their
 * panels render nothing for others), so they are offered to owners only;
 * connected apps only while the MCP grants answer.
 */
export function platformSettingsTabs(options: {
  isOwner: boolean;
  connectedApps: boolean;
}): SettingsTab[] {
  const tab = (key: string, order: number, en: string, de: string) => ({
    key,
    label: { en, de },
    order,
    group: PROJECT,
  });
  return [
    tab("project", 0, "Project", "Projekt"),
    ...(options.isOwner
      ? [tab("members", 10, "Members & roles", "Mitglieder & Rollen")]
      : []),
    tab("integrations", 40, "Integrations", "Integrationen"),
    ...(options.isOwner
      ? [tab("retention", 45, "Retention", "Aufbewahrung")]
      : []),
    tab("modules", 50, "Modules", "Module"),
    ...(options.connectedApps
      ? [tab("apps", 60, labels.en.connectedApps, labels.de.connectedApps)]
      : []),
  ];
}

/**
 * The platform's sections plus every shown module section. A module section
 * that names a platform key joins it (and may relabel it); a hidden one
 * (its hook returned null) is left out.
 */
export function collectSettingsTabs(
  platform: readonly SettingsTab[],
  contributed: ReadonlyArray<{
    tab: SettingsSection["tab"];
    shown: { label?: Label } | null;
  }>,
): SettingsTab[] {
  const tabs = platform.map((t) => ({ ...t }));
  for (const { tab, shown } of contributed) {
    if (!shown) continue;
    const known = tabs.find((t) => t.key === tab.key);
    if (!known)
      tabs.push({
        key: tab.key,
        label: shown.label ?? tab.label,
        order: tab.order,
        group: tab.group ?? PROJECT,
      });
    else if (shown.label) known.label = shown.label;
  }
  return tabs;
}

/**
 * The settings list: "project" first, then the enabled modules by groupOrder
 * (like the sidebar), each with its sections by order. A section of a module
 * that is not enabled, or of an unknown group, is not offered; a group
 * without sections is left out.
 */
export function groupSettings(
  tabs: readonly SettingsTab[],
  modules: ReadonlyArray<{
    id: string;
    displayName: Label;
    enabled: boolean;
    groupOrder?: number;
  }>,
): SettingsGroup[] {
  return [
    { id: PROJECT, label: PROJECT_LABEL },
    ...groupedModules(modules).map((m) => ({ id: m.id, label: m.displayName })),
  ]
    .map((group) => ({
      ...group,
      tabs: tabs
        .filter((t) => t.group === group.id)
        .sort((a, b) => a.order - b.order),
    }))
    .filter((group) => group.tabs.length > 0);
}

/**
 * The open section: `?section=` when it is offered, else "project". The
 * Google Drive callback (`?googleDrive=`, sent by the API) opens the
 * integrations, where its card is.
 */
export function sectionFromSearch(
  search: string,
  available: readonly string[],
): string {
  const params = new URLSearchParams(search);
  const wanted =
    params.get("section") ??
    (params.has("googleDrive") ? "integrations" : null);
  return wanted && available.includes(wanted) ? wanted : PROJECT;
}

/** The key of a module's first own section by order (spec §3.4), if any. */
export function moduleSettingsSection(
  moduleId: string,
  sections: readonly SettingsSection[],
): string | undefined {
  return sections
    .filter((s) => (s.tab.group ?? moduleId) === moduleId)
    .reduce<SettingsSection["tab"] | undefined>(
      (first, s) => (!first || s.tab.order < first.order ? s.tab : first),
      undefined,
    )?.key;
}

/** A plain click; a modified one (new tab, window) keeps the link's default. */
const plainClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The section list: a labelled nav with one heading per group and the open
 * section marked current; below 760 px the same sections as a select (CSS
 * shows one of the two). Links keep their URL for a new tab; a plain click
 * calls onSelect, which replaces the URL in place.
 */
export function SettingsNav({
  groups,
  value,
  hrefOf,
  onSelect,
  locale,
}: {
  groups: readonly SettingsGroup[];
  value: string;
  hrefOf: (key: string) => string;
  onSelect(key: string): void;
  locale: Locale;
}) {
  const text = labels[locale];
  return (
    <>
      <nav className="settings-nav" aria-label={text.settingsSections}>
        {groups.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <h2
              className="settings-nav-heading"
              id={`settings-group-${group.id}`}
            >
              {group.label[locale]}
            </h2>
            <ul aria-labelledby={`settings-group-${group.id}`}>
              {group.tabs.map((tab) => (
                <li key={tab.key}>
                  <a
                    className="settings-nav-link"
                    href={hrefOf(tab.key)}
                    aria-current={tab.key === value ? "page" : undefined}
                    onClick={(e) => {
                      if (!plainClick(e)) return;
                      e.preventDefault();
                      onSelect(tab.key);
                    }}
                  >
                    {tab.label[locale]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="settings-select">
        <label htmlFor="settings-section">{text.settingsSection}</label>
        <select
          className="input"
          id="settings-section"
          value={value}
          onChange={(e) => onSelect(e.target.value)}
        >
          {groups.map((group) => (
            <optgroup key={group.id} label={group.label[locale]}>
              {group.tabs.map((tab) => (
                <option key={tab.key} value={tab.key}>
                  {tab.label[locale]}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </>
  );
}
