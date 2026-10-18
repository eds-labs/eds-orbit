import type { Label, StandaloneView, ViewDef, WebRegistry } from "./types";

// URL scheme of the web shell (ADR 0009 AD-12, plans/orbit-modularization/02):
//   /                                  start: last project, else the pickers
//   /o                                 organization picker
//   /o/:orgId                          project picker of one organization
//   /p/:projectId                      project home
//   /p/:projectId/<view>               platform page
//   /p/:projectId/<moduleId>[/<view>]  module page
// The paths from before WP1.7 ("/missions", "/settings", …) redirect into the
// last used project, so bookmarks and Telegram or Slack links keep working.

export type Route = ViewDef & {
  /** The owning module, or null for a platform page. */
  moduleId: string | null;
  /** Path segments below /p/:projectId. */
  segments: readonly string[];
};

export type RouteTable = {
  routes: readonly Route[];
  /** Pages outside any project. */
  standalone: readonly StandaloneView[];
  /** Legacy path -> route. */
  legacy: ReadonlyMap<string, Route>;
  moduleIds: readonly string[];
};

const SEGMENT = /^[a-z][a-z0-9-]*$/;
// First segments the shell itself uses; no page may claim them.
const RESERVED = new Set(["o", "p", "api", "admin"]);
const STANDALONE_PATH = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

/** Builds and checks the route table once; throws on any conflict. */
export function routeTable(registry: WebRegistry): RouteTable {
  const problems: string[] = [];
  const routes: Route[] = [];
  const moduleIds = registry.modules.map((m) => m.id);
  const add = (view: ViewDef, moduleId: string | null) => {
    if (view.path && !SEGMENT.test(view.path))
      problems.push(`${view.key}: invalid path "${view.path}"`);
    if (view.requiresModule && !moduleIds.includes(view.requiresModule))
      problems.push(`${view.key}: unknown module "${view.requiresModule}"`);
    routes.push({
      ...view,
      moduleId,
      segments: [moduleId, view.path].filter((s): s is string => Boolean(s)),
    });
  };
  for (const view of registry.platform) {
    if (moduleIds.includes(view.path) || RESERVED.has(view.path))
      problems.push(`platform view ${view.key} claims "/${view.path}"`);
    add(view, null);
  }
  for (const m of registry.modules) {
    if (!SEGMENT.test(m.id) || RESERVED.has(m.id))
      problems.push(`invalid module id ${m.id}`);
    for (const view of m.views) add(view, m.id);
  }
  const seen = new Map<string, string>();
  const legacy = new Map<string, Route>();
  for (const route of routes) {
    const path = route.segments.join("/");
    for (const [what, name] of [
      ["key", route.key],
      ["path", `/${path}`],
    ] as const) {
      const prior = seen.get(`${what}:${name}`);
      if (prior)
        problems.push(`${what} ${name} used by ${prior} and ${route.key}`);
      seen.set(`${what}:${name}`, route.key);
    }
    for (const old of route.legacyPaths ?? []) {
      if (legacy.has(old))
        problems.push(
          `legacy path ${old} used by ${legacy.get(old)!.key} and ${route.key}`,
        );
      legacy.set(old, route);
    }
  }
  for (const route of routes) {
    if (!route.navKey) continue;
    const entry = routes.find((r) => r.key === route.navKey && r.nav);
    if (!entry)
      problems.push(
        `${route.key}: navKey "${route.navKey}" names no navigation entry`,
      );
    else if (entry.moduleId !== route.moduleId)
      problems.push(
        `${route.key}: navKey "${route.navKey}" belongs to another owner`,
      );
  }
  const standalone = registry.standalone ?? [];
  const standaloneKeys = new Set<string>();
  const standalonePaths = new Map<string, string>();
  for (const view of standalone) {
    const first = view.path.split("/")[0]!;
    if (!STANDALONE_PATH.test(view.path))
      problems.push(`${view.key}: invalid standalone path "${view.path}"`);
    else if (RESERVED.has(first) || moduleIds.includes(first))
      problems.push(`standalone page ${view.key} claims "/${first}"`);
    else if (legacy.has(`/${view.path}`))
      problems.push(
        `legacy path /${view.path} used by ${legacy.get(`/${view.path}`)!.key} and ${view.key}`,
      );
    if (standaloneKeys.has(view.key) || seen.has(`key:${view.key}`))
      problems.push(`key ${view.key} used twice`);
    standaloneKeys.add(view.key);
    const prior = standalonePaths.get(view.path);
    if (prior)
      problems.push(`path /${view.path} used by ${prior} and ${view.key}`);
    standalonePaths.set(view.path, view.key);
  }
  if (!routes.some((r) => r.segments.length === 0))
    problems.push('no project home (a platform view with path "")');
  if (problems.length)
    throw new Error(`WEB_ROUTES_INVALID: ${problems.join("; ")}`);
  return { routes, standalone, legacy, moduleIds };
}

/**
 * Whether a route is shown (WP2.4): a module page needs its module, a
 * platform page its requiresModule, if any.
 */
export function routeEnabled(
  route: Route,
  enabled: (moduleId: string) => boolean,
): boolean {
  const gate = route.moduleId ?? route.requiresModule;
  return !gate || enabled(gate);
}

/** Where a route lives in a project. */
export function projectHref(projectId: string, route: Route): string {
  return ["", "p", encodeURIComponent(projectId), ...route.segments].join("/");
}

export type Place =
  | { kind: "start" }
  | { kind: "organizations" }
  | { kind: "organization"; organizationId: string }
  | { kind: "view"; projectId: string; route: Route }
  /** A page outside any project, such as /connect. */
  | { kind: "standalone"; view: StandaloneView }
  /** A module root without a root view: go to its first page. */
  | { kind: "redirect"; projectId: string; route: Route }
  | { kind: "legacy"; route: Route }
  | { kind: "notFound"; projectId?: string };

/** Resolves a pathname to a place in the shell; never throws. */
export function locate(pathname: string, table: RouteTable): Place {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (!parts.length) return { kind: "start" };
  const [first, second, ...rest] = parts;
  if (first === "o") {
    if (!second) return { kind: "organizations" };
    return rest.length
      ? { kind: "notFound" }
      : { kind: "organization", organizationId: second };
  }
  if (first === "p" && second) {
    const path = rest.join("/");
    const route = table.routes.find((r) => r.segments.join("/") === path);
    if (route) return { kind: "view", projectId: second, route };
    if (rest.length === 1 && table.moduleIds.includes(rest[0]!)) {
      const entry = navOrder(
        table.routes.filter((r) => r.moduleId === rest[0]),
      )[0];
      if (entry) return { kind: "redirect", projectId: second, route: entry };
    }
    return { kind: "notFound", projectId: second };
  }
  const page = table.standalone.find((v) => v.path === parts.join("/"));
  if (page) return { kind: "standalone", view: page };
  const legacy = parts.length === 1 && table.legacy.get(`/${first}`);
  return legacy ? { kind: "legacy", route: legacy } : { kind: "notFound" };
}

/**
 * Whether the shell shows a module (WP2.4, WP4.5): enabled for the project
 * and the member's access is not "none". Unknown states count as usable, so
 * a failed load never hides a module.
 */
export function moduleUsable(state?: { enabled: boolean; access?: string }) {
  return state ? state.enabled && state.access !== "none" : true;
}

/**
 * Whether the shell shows a module given the loaded module states (WP5.1).
 * Once loaded, a module the server does not list (unavailable for the
 * installation, like support without ORBIT_SUPPORT) is hidden. Until they
 * load, or if they fail, modules show, except opt-in modules.
 */
export function moduleShown(
  states:
    | ReadonlyArray<{ id: string; enabled: boolean; access?: string }>
    | undefined,
  id: string,
  optIn = false,
) {
  if (!states) return !optIn;
  const state = states.find((m) => m.id === id);
  return state ? moduleUsable(state) : false;
}

/** The navigation entry a page highlights: its own, else its navKey. */
export function activeNavKey(
  route: Route | null | undefined,
): string | undefined {
  return route?.navKey ?? route?.key;
}

/**
 * The breadcrumb of a page: its navigation label, or for a page under
 * another entry (navKey) that entry's label and the page's title.
 */
export function crumbs(
  route: Route,
  table: RouteTable,
  locale: keyof Label,
): string[] {
  const own = route.nav?.label[locale] ?? route.title?.[locale];
  const parent = route.navKey
    ? table.routes.find((r) => r.key === route.navKey)?.nav?.label[locale]
    : undefined;
  return parent ? [parent, own ?? route.key] : [own ?? route.key];
}

/** Routes in sidebar order; routes without a nav entry come last. */
export function navOrder(routes: readonly Route[]): Route[] {
  return [...routes].sort(
    (a, b) =>
      (a.nav?.order ?? Number.MAX_SAFE_INTEGER) -
      (b.nav?.order ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Rewrites an in-app link from before WP1.7 ("/content", "/approvals", also
 * sent by the API in chat cards) to the page in the given project. Other
 * links are returned unchanged.
 */
export function rewriteLegacyHref(
  table: RouteTable,
  projectId: string,
  href: string,
): string {
  const match = /^(\/[^?#]*)([?#].*)?$/.exec(href);
  if (!match) return href;
  const [, path, suffix = ""] = match;
  if (path === "/") {
    const home = table.routes.find((r) => r.segments.length === 0)!;
    return projectHref(projectId, home) + suffix;
  }
  const route = table.legacy.get(path!);
  return route ? projectHref(projectId, route) + suffix : href;
}

/** Same-origin search and hash of a legacy URL, kept across the redirect. */
export function keptSuffix(search: string, hash: string): string {
  return `${search.startsWith("?") ? search : ""}${hash.startsWith("#") ? hash : ""}`;
}

type Membership = {
  projects: ReadonlyArray<{ id: string; workspaceId: string }>;
  workspaces: ReadonlyArray<{ id: string }>;
};

/** The project a start or legacy URL opens: the last used one, else the only one. */
export function defaultProject(
  identity: Membership,
  lastProjectId: string | null,
): string | null {
  if (lastProjectId && identity.projects.some((p) => p.id === lastProjectId))
    return lastProjectId;
  return identity.projects.length === 1 ? identity.projects[0]!.id : null;
}

/** Where the start page leads when no project can be chosen automatically. */
export function pickerHref(identity: Membership): string {
  return identity.workspaces.length === 1
    ? `/o/${encodeURIComponent(identity.workspaces[0]!.id)}`
    : "/o";
}
