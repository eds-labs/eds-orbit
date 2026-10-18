import type { NavGroup } from "./nav-groups";

// The collapsed sidebar groups (UI restructure, U3): all groups are open by
// default; the ids of the collapsed ones are kept in localStorage, and the
// group of a page opens when the user navigates to it. Pure
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

/**
 * Opens the group of the page just navigated to: a copy without `groupId`,
 * or the same set when that group is not collapsed (nothing to store).
 */
export function revealGroup(
  collapsed: ReadonlySet<string>,
  groupId: string | undefined,
): ReadonlySet<string> {
  if (!groupId || !collapsed.has(groupId)) return collapsed;
  const next = new Set(collapsed);
  next.delete(groupId);
  return next;
}

/** The sum of the badges of a group's entries, keyed by route key. */
export function groupBadge(
  group: NavGroup,
  badges: Readonly<Record<string, number>>,
): number {
  return group.entries.reduce((sum, r) => sum + (badges[r.key] ?? 0), 0);
}
