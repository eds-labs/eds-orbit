"use client";
import type { MouseEvent } from "react";
import { labels, type Locale } from "@/lib/i18n";
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
    // AI spending authority, providers, models, budget and usage (owner
    // tools; ADR 0015).
    ...(options.isOwner ? [tab("ai", 42, "AI & budget", "KI & Budget")] : []),
    ...(options.isOwner
      ? [tab("retention", 45, "Retention", "Aufbewahrung")]
      : []),
    tab("modules", 50, "Modules", "Module"),
    ...(options.connectedApps
      ? [tab("apps", 60, labels.en.connectedApps, labels.de.connectedApps)]
      : []),
  ];
}

// Sections that moved: an old link opens the new place when the old one is
// not offered. The AI budget left the Marketing policy (ADR 0015).
export const MOVED: Readonly<Record<string, string>> = { policy: "ai" };

/**
 * The URL of a settings section below the page's URL: Project is the page
 * itself, any other section `?section=<key>` (encoded).
 */
export function settingsSectionHref(settingsHref: string, key: string) {
  return key === PROJECT
    ? settingsHref
    : `${settingsHref}?section=${encodeURIComponent(key)}`;
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
 * calls onSelect, which replaces the URL in place. With a `placeholder`, a
 * page that opens no section (value matching no tab) leads the select with it,
 * so the select names no section as open and every section can be chosen.
 */
export function SettingsNav({
  groups,
  value,
  hrefOf,
  onSelect,
  locale,
  placeholder,
}: {
  groups: readonly SettingsGroup[];
  value: string;
  hrefOf: (key: string) => string;
  onSelect(key: string): void;
  locale: Locale;
  placeholder?: string;
}) {
  const text = labels[locale];
  const showPlaceholder =
    placeholder !== undefined &&
    !groups.some((group) => group.tabs.some((tab) => tab.key === value));
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
          value={showPlaceholder ? "" : value}
          onChange={(e) => onSelect(e.target.value)}
        >
          {showPlaceholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
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
