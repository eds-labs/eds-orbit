import type { NavGroup } from "./nav-groups";

// The collapsed sidebar groups (UI restructure, U3): all groups are open by
// default; the ids of the collapsed ones are kept in localStorage. Pure
// helpers, so the sidebar itself stays a controlled component.

const KEY = "orbit.nav.collapsed";

/** The collapsed group ids; empty without storage or with a broken value. */
export function readCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* The groups then open again on the next visit. */
  }
}

/** A copy of `collapsed` with `id` collapsed or opened. */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(collapsed);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Whether a group shows its entries: the group of the open page always does. */
export function isGroupOpen(
  groupId: string,
  collapsed: ReadonlySet<string>,
  activeGroupId: string | undefined,
): boolean {
  return groupId === activeGroupId || !collapsed.has(groupId);
}

/** The sum of the badges of a group's entries, keyed by route key. */
export function groupBadge(
  group: NavGroup,
  badges: Readonly<Record<string, number>>,
): number {
  return group.entries.reduce((sum, r) => sum + (badges[r.key] ?? 0), 0);
}
