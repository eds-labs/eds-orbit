"use client";
import { Fragment } from "react";
import Link from "next/link";
import { ChevronDown, Settings } from "lucide-react";
import { labels, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { groupBadge, isGroupOpen } from "./nav-collapse";
import type { NavGroup } from "./nav-groups";
import type { Route } from "./routes";

type Props = {
  groups: readonly NavGroup[];
  /** The navigation entry of the open page (activeNavKey). */
  activeKey: string | undefined;
  hrefOf: (route: Route) => string;
  /** Counts per route key, such as open approvals. */
  badges?: Readonly<Record<string, number>>;
  locale: Locale;
  /** Ids of the collapsed groups; the shell keeps them (nav-collapse). */
  collapsed: ReadonlySet<string>;
  onToggle(id: string): void;
};

/**
 * The sidebar navigation (UI restructure, spec §3.3): the "top" entries, then
 * one collapsible group per module under "Modules", then the project group.
 * A collapsed group renders no entries and shows the sum of their badges; the
 * group of the open page is always open.
 */
export function SidebarNav({
  groups,
  activeKey,
  hrefOf,
  badges = {},
  locale,
  collapsed,
  onToggle,
}: Props) {
  const text = labels[locale];
  const activeGroupId = groups.find((g) =>
    g.entries.some((r) => r.key === activeKey),
  )?.id;
  const firstModule = groups.find(
    (g) => g.id !== "top" && g.id !== "project",
  )?.id;
  const badge = (count: number) =>
    count > 0 ? (
      <span className="nav-badge">
        {count}
        <span className="sr-only">{` ${text.navOpen}`}</span>
      </span>
    ) : null;
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
        {badge(badges[route.key] ?? 0)}
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
        const open = isGroupOpen(group.id, collapsed, activeGroupId);
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
                {!open && badge(groupBadge(group, badges))}
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
