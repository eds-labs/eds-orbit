import { labels } from "@/lib/i18n";
import {
  activeNavKey,
  navGroupOf,
  navOrder,
  routeEnabled,
  type Route,
} from "./routes";
import type { Label } from "./types";

// The grouped navigation model of the sidebar and the mobile bar (UI
// restructure): pure, so the shell only renders what it returns.

export type NavGroup = {
  /** "top", a module id, or "project". */
  id: string;
  /** Null for "top"; a module's display name; "Project" for "project". */
  label: Label | null;
  /** Entries sorted by nav.order. */
  entries: Route[];
  /** Filled by the shell from the module's settings section. */
  settingsHref?: string;
};

type GroupModule = {
  id: string;
  displayName: Label;
  enabled: boolean;
  groupOrder?: number;
};

const PROJECT_LABEL: Label = {
  en: labels.en.navProject,
  de: labels.de.navProject,
};
const MOBILE_LIMIT = 4;

/**
 * Sidebar groups: "top", then the enabled modules by groupOrder (ties in
 * registry order), then "project". A group without entries is left out, and
 * so is a route its module does not allow (routeEnabled), such as approvals
 * while marketing is off. Modules missing from `modules` count as disabled.
 */
export function buildNavGroups(
  routes: readonly Route[],
  modules: readonly GroupModule[],
): NavGroup[] {
  const enabled = (id: string) => modules.some((m) => m.id === id && m.enabled);
  const visible = navOrder(
    routes.filter((r) => r.nav && routeEnabled(r, enabled)),
  );
  const ordered = modules
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.enabled)
    .sort(
      (a, b) =>
        (a.m.groupOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.m.groupOrder ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({ m }) => m);
  const candidates: Array<{ id: string; label: Label | null }> = [
    { id: "top", label: null },
    ...ordered.map((m) => ({ id: m.id, label: m.displayName })),
    { id: "project", label: PROJECT_LABEL },
  ];
  return candidates
    .map(({ id, label }) => ({
      id,
      label,
      entries: visible.filter((r) => navGroupOf(r) === id),
    }))
    .filter((g) => g.entries.length > 0);
}

/**
 * The mobile bottom bar: the first four enabled entries marked `mobile`, by
 * nav.mobileRank; an entry without a rank comes last.
 */
export function mobileEntries(
  routes: readonly Route[],
  enabled: (moduleId: string) => boolean,
): Route[] {
  return routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.nav?.mobile && routeEnabled(route, enabled))
    .sort(
      (a, b) =>
        (a.route.nav!.mobileRank ?? Number.MAX_SAFE_INTEGER) -
          (b.route.nav!.mobileRank ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .slice(0, MOBILE_LIMIT)
    .map(({ route }) => route);
}

/**
 * The bottom-bar entry that is current for the open page: the entry of the
 * page itself, else the bar entry that stands for the page's group (ruling
 * R12): the module's root (Knowledge on its Sources page), else the group's
 * only bar entry (Tickets on the support overview, contacts and statistics).
 */
export function mobileCurrentKey(
  bar: readonly Route[],
  active: Route | null | undefined,
): string | undefined {
  if (!active) return undefined;
  const key = activeNavKey(active);
  if (bar.some((n) => n.key === key)) return key;
  const group = bar.filter((n) => navGroupOf(n) === navGroupOf(active));
  const root = group.find((n) => n.moduleId && n.path === "");
  return (root ?? (group.length === 1 ? group[0] : undefined))?.key;
}
