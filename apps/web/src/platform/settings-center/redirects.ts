import { locate, type RouteTable } from "@/platform/shell/routes";
import { MOVED, platformSettingsTabs } from "@/platform/shell/settings-nav";
import { moduleSectionId } from "./registry";
import { manageHref } from "./routes";
import type { ManageScope } from "./types";

// Phase 5 (ORBIT_SETTINGS_CENTER=on): every old settings address leads to its
// section of the settings center. This file is the pure table from an old
// address to a center address; the shell decides when to apply it.

export type OldAddress = { pathname: string; search: string; hash: string };
export type CenterAddress = {
  scope: ManageScope;
  area: string;
  rest: string[];
  /** "" or "?…". */
  search: string;
  /** "" or "#…". */
  hash: string;
};

// The platform's tab keys of the old project settings page. A module tab on
// one of them (webmail on "integrations") joins the platform tab there, so
// the key keeps leading to the platform's place.
const PLATFORM_KEYS = new Set(
  platformSettingsTabs({ isOwner: true, connectedApps: true }).map((t) => t.key),
);

/** Module settings tab key → module id, over every registered module (shown or not). */
export function moduleTabIndex(
  modules: ReadonlyArray<{
    id: string;
    settings?: ReadonlyArray<{ tab: { key: string } }>;
  }>,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const m of modules) {
    for (const s of m.settings ?? []) {
      const key = s.tab.key;
      if (!PLATFORM_KEYS.has(key) && !index.has(key)) index.set(key, m.id);
    }
  }
  return index;
}

export type MapContext = {
  table: RouteTable;
  tabs: ReadonlyMap<string, string>;
  platformKeys: readonly string[];
  /** Whether the module is shown in that project; null while unknown. Asked only for a key that has a MOVED entry. */
  moduleShown(projectId: string, moduleId: string): boolean | null;
};

type Place = { scope: ManageScope; area: string; rest?: string[] };

const SYSTEM: ManageScope = { kind: "system" };
const ACCOUNT: ManageScope = { kind: "account" };

// /admin/<section> → system area and rest. Only users and organizations
// take an id, as their center sections do; the old shell shows any other
// section and ignores an id below it, so that id is dropped.
const ADMIN: ReadonlyMap<string, { area: string; rest: string[]; takesId?: true }> =
  new Map([
    ["", { area: "overview", rest: [] }],
    ["integrations", { area: "integrations", rest: [] }],
    ["ai", { area: "ai", rest: [] }],
    ["mcp", { area: "mcp", rest: [] }],
    ["audit", { area: "security", rest: ["audit"] }],
    ["users", { area: "users", rest: [], takesId: true }],
    ["invitations", { area: "users", rest: ["invitations"] }],
    ["organizations", { area: "organizations", rest: [], takesId: true }],
    ["projects", { area: "organizations", rest: ["projects"] }],
  ]);

// ?section=<platform key> of the project settings page.
function platformPlace(key: string, projectId: string): Place | null {
  const project: ManageScope = { kind: "project", projectId };
  switch (key) {
    case "project":
      return { scope: project, area: "overview" };
    case "members":
      return { scope: project, area: "members" };
    case "integrations":
      return { scope: project, area: "integrations" };
    case "ai":
      return { scope: project, area: "ai" };
    case "retention":
      return { scope: project, area: "data" };
    case "modules":
      return { scope: project, area: "modules" };
    case "apps":
      return { scope: ACCOUNT, area: "connections" };
    default:
      return null;
  }
}

/** The search without the given parameters, in a stable form; "" when empty. */
function keptSearch(params: URLSearchParams, drop: readonly string[] = []) {
  const kept = new URLSearchParams();
  for (const [name, value] of params) if (!drop.includes(name)) kept.append(name, value);
  const text = kept.toString();
  return text ? `?${text}` : "";
}

function projectSettingsPlace(
  projectId: string,
  params: URLSearchParams,
  ctx: MapContext,
): Place | "wait" {
  const project: ManageScope = { kind: "project", projectId };
  const key = params.get("section");
  if (params.has("googleDrive") && (key === null || key === "integrations"))
    return { scope: project, area: "integrations", rest: ["google-drive"] };
  if (key === null) return { scope: project, area: "overview" };
  // Platform keys first: a module may contribute to a platform tab.
  const platform = platformPlace(key, projectId);
  if (platform) return platform;
  const moduleId = ctx.tabs.get(key);
  if (moduleId) {
    const moved = Object.hasOwn(MOVED, key) ? MOVED[key] : undefined;
    const shown = moved === undefined ? true : ctx.moduleShown(projectId, moduleId);
    if (shown === null) return "wait";
    if (shown)
      return {
        scope: project,
        area: "modules",
        rest: moduleSectionId(moduleId, key, ctx.platformKeys).split("/"),
      };
    const home = platformPlace(moved!, projectId);
    if (home) return home;
  }
  return { scope: project, area: "overview" };
}

/** The center address of an old settings address; null when the address is not an old settings address; "wait" while moduleShown is unknown. */
export function mapOldAddress(
  address: OldAddress,
  ctx: MapContext,
): CenterAddress | "wait" | null {
  const params = new URLSearchParams(address.search);
  const hash = address.hash.startsWith("#") && address.hash.length > 1 ? address.hash : "";
  const place = locate(address.pathname, ctx.table);
  const done = (to: Place, search = keptSearch(params)): CenterAddress => ({
    scope: to.scope,
    area: to.area,
    rest: to.rest ?? [],
    search,
    hash,
  });
  switch (place.kind) {
    case "admin": {
      const row = ADMIN.get(place.section);
      if (!row) return null;
      return done({
        scope: SYSTEM,
        area: row.area,
        rest: place.id !== undefined && row.takesId ? [...row.rest, place.id] : row.rest,
      });
    }
    case "organizationSettings": {
      const scope: ManageScope = {
        kind: "organization",
        organizationId: place.organizationId,
      };
      return hash === "#assistant-budget"
        ? done({ scope, area: "ai", rest: ["budget"] })
        : done({ scope, area: "overview" });
    }
    case "standalone":
      if (place.view.key === "account") return done({ scope: ACCOUNT, area: "profile" });
      if (place.view.key === "account-assistant")
        return done({ scope: ACCOUNT, area: "assistant" });
      return null;
    case "view": {
      const { projectId, route } = place;
      if (route.key === "settings") {
        const to = projectSettingsPlace(projectId, params, ctx);
        return to === "wait" ? to : done(to, keptSearch(params, ["section"]));
      }
      if (route.key === "connectors")
        return done({ scope: { kind: "project", projectId }, area: "integrations" });
      // The OAuth return of a Social account connection; the accounts page
      // itself stays.
      if (
        route.key === "social.accounts" &&
        (params.has("connected") || params.has("error"))
      )
        return done({
          scope: { kind: "project", projectId },
          area: "integrations",
          rest: ["social", "accounts"],
        });
      return null;
    }
    default:
      return null;
  }
}

export function centerHref(target: CenterAddress): string {
  return manageHref(target.scope, target.area, ...target.rest) + target.search + target.hash;
}
