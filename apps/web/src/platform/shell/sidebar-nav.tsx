"use client";
import { Fragment } from "react";
import Link from "next/link";
import { ChevronDown, Settings } from "lucide-react";
import { labels, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { groupBadge } from "./nav-collapse";
import type { NavGroup } from "./nav-groups";
import type { Route } from "./routes";

type Props = {
  groups: readonly NavGroup[];
  /** The navigation entry of the open page (activeNavKey). */
  activeKey: string | undefined;
  hrefOf: (route: Route) => string;
  /** Counts per route key, such as open approvals. */
  badges?: Readonly<Record<string, number>>;
  /** Route keys with a critical item: their badge shows the warning style. */
  urgent?: ReadonlySet<string>;
  locale: Locale;
  /** Ids of the collapsed groups; the shell keeps them (nav-collapse). */
  collapsed: ReadonlySet<string>;
  onToggle(id: string): void;
};

/**
 * The count of a nav entry, read as "3 to do" by screen readers; with a
 * critical item it shows the warning colour and adds "urgent". Nothing for 0.
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
 * shell opens the group of a page when the user navigates to it.
 */
export function SidebarNav({
  groups,
  activeKey,
  hrefOf,
  badges = {},
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
        {badge(badges[route.key] ?? 0, urgent.has(route.key))}
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
        const Icon =
          group.id === "project" ? Settings : group.entries[0]!.nav!.icon;
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
                <ChevronDown className="nav-group-chevron" aria-hidden="true" />
              </button>
              {/* Kept while collapsed, so aria-controls names an element. */}
              <ul id={listId} className="nav-group-list" hidden={!open}>
                {open &&
                  group.entries.map((r) => (
                    <li key={r.key}>{link(r, "nav-sub-link", false)}</li>
                  ))}
              </ul>
            </div>
          </Fragment>
        );
      })}
    </nav>
  );
}
