"use client";
import { Fragment } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { workspaceGroupIcon } from "./navigation-icons";
import { labels, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { groupBadge } from "./nav-collapse";
import type { NavGroup } from "./nav-groups";
import type { NavigationCounts } from "./nav-counts";
import type { Route } from "./routes";

type Props = {
  groups: readonly NavGroup[];
  /** The navigation entry of the open page (activeNavKey). */
  activeKey: string | undefined;
  hrefOf: (route: Route) => string;
  /** Counts per route key, such as open approvals. */
  badges?: Readonly<Record<string, number>>;
  navCounts?: NavigationCounts;
  /** Route keys with a critical item: their badge shows the warning style. */
  urgent?: ReadonlySet<string>;
  locale: Locale;
  /** Ids of the collapsed groups; the shell keeps them (nav-collapse). */
  collapsed: ReadonlySet<string>;
  onToggle(id: string): void;
};

/**
 * The count of a nav entry, read as "3 to do" by screen readers; with a
 * critical item it shows the warning fill and a "!" mark (not colour alone)
 * and adds "urgent". Nothing for 0.
 */
export function NavBadge({
  count,
  urgent,
  locale,
}: {
  count: number;
  urgent: boolean;
  locale: Locale;
}) {
  if (count <= 0) return null;
  const text = labels[locale];
  return (
    <span className={cn("nav-badge", urgent && "nav-badge-warning")}>
      {urgent && (
        <span className="nav-badge-mark" aria-hidden="true">
          !
        </span>
      )}
      {count}
      <span className="sr-only">
        {` ${text.navToDo}${urgent ? `, ${text.navUrgent}` : ""}`}
      </span>
    </span>
  );
}

/**
 * The sidebar navigation (UI restructure, spec §3.3): the "top" entries, then
 * one collapsible group per module under "Modules", then the project group.
 * A collapsed group renders no entries and shows the sum of their badges; the
 * shell opens the group of a page when the user navigates to it. A module
 * group with a settings section ends with a subdued settings link.
 */
export function SidebarNav({
  groups,
  activeKey,
  hrefOf,
  badges = {},
  navCounts,
  urgent = new Set(),
  locale,
  collapsed,
  onToggle,
}: Props) {
  const text = labels[locale];
  const firstModule = groups.find(
    (g) => g.id !== "top" && g.id !== "project",
  )?.id;
  const badge = (count: number, critical: boolean) => (
    <NavBadge count={count} urgent={critical} locale={locale} />
  );
  const routeCount = (route: Route) => {
    const def = route.nav?.count;
    const value = navCounts?.[route.key];
    if (!def || !value || (value.complete && value.total === 0)) return null;
    return (
      <span key={route.key} className="nav-badge">
        <span aria-hidden="true">
          {value.complete ? value.total : value.total ? `${value.total}+` : "?"}
        </span>
        <span className="sr-only">
          {` ${def.label(value.total, value.complete, locale)}`}
        </span>
      </span>
    );
  };
  const link = (route: Route, className: string, withIcon: boolean) => {
    const Icon = route.nav!.icon;
    const active = route.key === activeKey;
    return (
      <Link
        key={route.key}
        href={hrefOf(route)}
        className={cn(className, active && "nav-active")}
        aria-current={active ? "page" : undefined}
      >
        {withIcon && <Icon aria-hidden="true" />}
        <span className="nav-entry-label">{route.nav!.label[locale]}</span>
        {route.nav!.planned && (
          <span className="nav-planned">{locale === "de" ? "Geplant" : "Planned"}</span>
        )}
        {badge(badges[route.key] ?? 0, urgent.has(route.key))}
        {withIcon && routeCount(route)}
      </Link>
    );
  };
  return (
    <nav aria-label="Workspace">
      {groups.map((group) => {
        if (group.id === "top")
          return (
            <Fragment key="top">
              {group.entries.map((r) => link(r, "nav-link", true))}
            </Fragment>
          );
        const open = !collapsed.has(group.id);
        const listId = `nav-group-${group.id}`;
        const Icon = workspaceGroupIcon(group.id, group.entries[0]!.nav!.icon);
        return (
          <Fragment key={group.id}>
            {group.id === firstModule && (
              <div className="nav-section-label">{text.navModules}</div>
            )}
            {group.id === "project" && (
              <div className="nav-section-label">{text.navProject}</div>
            )}
            <div className="nav-group">
              <button
                type="button"
                className="nav-group-head"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => onToggle(group.id)}
              >
                <Icon aria-hidden="true" />
                <span className="nav-group-label">
                  {group.label?.[locale] ?? group.id}
                </span>
                {!open &&
                  badge(
                    groupBadge(group, badges),
                    group.entries.some(
                      (r) => urgent.has(r.key) && (badges[r.key] ?? 0) > 0,
                    ),
                  )}
                {group.entries.map(routeCount)}
                <ChevronDown className="nav-group-chevron" aria-hidden="true" />
              </button>
              {/* Kept while collapsed, so aria-controls names an element. */}
              <ul id={listId} className="nav-group-list" hidden={!open}>
                {open &&
                  group.entries.map((r) => (
                    <li key={r.key}>{link(r, "nav-sub-link", false)}</li>
                  ))}
                {/* The module's settings (spec §3.4): not a route, no badge. */}
                {open && group.settingsHref && (
                  <li>
                    <Link
                      href={group.settingsHref}
                      className="nav-sub-link nav-settings-link"
                    >
                      <span className="sr-only">{`${group.label?.[locale] ?? group.id} `}</span>
                      {text.settings}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </Fragment>
        );
      })}
    </nav>
  );
}
