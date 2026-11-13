import { locate, moduleShown, type RouteTable } from "@/platform/shell/routes";
import { MOVED, platformSettingsTabs } from "@/platform/shell/settings-nav";
import { moduleSectionId, visibleSections } from "./registry";
import { manageHref } from "./routes";
// The shell already loads these lists through the settings center's views,
// so deciding where a member may land adds nothing to its first render.
import { accountSections } from "./sections/account";
import { organizationSections } from "./sections/organization";
import { projectSections } from "./sections/project";
import { systemSections } from "./sections/system";
import type {
  Capability,
  ManageScope,
  ManagementCapabilities,
  ManagementSection,
  ScopeKind,
} from "./types";

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
      // The connections section mounts the panel the old page showed.
      if (route.key === "connectors")
        return done({
          scope: { kind: "project", projectId },
          area: "integrations",
          rest: ["connections"],
        });
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

/**
 * Whether `locate` could place a path where the table maps it: the
 * administration, the account, or a path ending in an organization's or a
 * project's settings, the connectors page or the Social accounts page.
 * Segments are read as `locate` reads them (empty ones dropped, decoded), so
 * this only skips paths the table would leave alone.
 */
export function mayBeOldAddress(pathname: string): boolean {
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
  const first = parts[0];
  const last = parts[parts.length - 1];
  return (
    first === "admin" ||
    first === "account" ||
    last === "settings" ||
    last === "connectors" ||
    (last === "accounts" && parts[parts.length - 2] === "social")
  );
}

/**
 * A link as the shell renders it: an old settings address
 * becomes its center address. Any other link stays as it is, and so does one
 * whose mapping waits for module states: the redirect then decides. A link
 * never asks for capabilities; at worst it leads through the redirect.
 */
export function centerLink(href: string, ctx: MapContext): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
  if (!match) return href;
  const [, pathname = "", search = "", hash = ""] = match;
  if (!mayBeOldAddress(pathname)) return href;
  const target = mapOldAddress({ pathname, search, hash }, ctx);
  return target && target !== "wait" ? centerHref(target) : href;
}

export type RedirectContext = MapContext & {
  /** The member's capabilities; null while loading; undefined when the request failed. */
  caps: ManagementCapabilities | null | undefined;
};
export type Redirect = { kind: "go"; href: string } | { kind: "wait" } | { kind: "stay" };

const STAY: Redirect = { kind: "stay" };
const WAIT: Redirect = { kind: "wait" };

// The platform's own sections per scope: an area a member can open is one
// where they see at least one of them. A module section of a project needs
// project.modules, the capability of the platform's Modules section.
const PLATFORM_SECTIONS: Readonly<Record<ScopeKind, readonly ManagementSection[]>> = {
  system: systemSections,
  organization: organizationSections,
  project: projectSections,
  account: accountSections,
};

function scopeCapabilities(
  caps: ManagementCapabilities,
  scope: ManageScope,
): readonly Capability[] {
  switch (scope.kind) {
    case "system":
      return caps.system;
    case "account":
      return caps.account;
    case "organization":
      return caps.organizations.find((o) => o.id === scope.organizationId)?.capabilities ?? [];
    case "project":
      return caps.projects.find((p) => p.id === scope.projectId)?.capabilities ?? [];
  }
}

/** What the shell does with an address. */
export function oldAddressTarget(address: OldAddress, ctx: RedirectContext): Redirect {
  return redirectFor(mapOldAddress(address, ctx), ctx);
}

/** The decision for an address `mapOldAddress` has already mapped. */
export function redirectFor(
  target: CenterAddress | "wait" | null,
  ctx: Pick<RedirectContext, "caps">,
): Redirect {
  if (target === null) return STAY;
  if (target === "wait" || ctx.caps === null) return WAIT;
  // Without capabilities the old page still works; better than no page.
  if (ctx.caps === undefined) return STAY;
  const kind = target.scope.kind;
  const open = visibleSections(
    PLATFORM_SECTIONS[kind],
    kind,
    scopeCapabilities(ctx.caps, target.scope),
  );
  // A scope the member cannot open keeps today's page (e.g. not found).
  if (open.length === 0) return STAY;
  // The target never equals the address: a mapped address is never below
  // /manage, and every target is. visibleSections sorts by area order, so
  // the first section's area is the scope's first area.
  return {
    kind: "go",
    href: open.some((s) => s.area === target.area)
      ? centerHref(target)
      : manageHref(target.scope, open[0].area),
  };
}

/**
 * `moduleShown` for the redirect, so a "wait" always ends and never decides
 * on another project's states. `projectId` is the project whose module states
 * the shell loads; `settled` its last settled load (states null: it failed),
 * tagged with the project it was loaded for. A project whose states the shell
 * does not load counts as not shown, and a moved key goes to its platform home.
 * A failed load is answered by `shown(null)`, so the caller can apply the
 * shell's own rule for a failed load.
 */
export function redirectModuleShown<T>(
  source: {
    projectId: string | undefined;
    settled: { projectId: string; states: T | null } | null;
  },
  projectId: string,
  shown: (states: T | null) => boolean,
): boolean | null {
  if (projectId !== source.projectId) return false;
  if (source.settled?.projectId !== projectId) return null;
  return shown(source.settled.states);
}

type ModuleStateList = ReadonlyArray<{ id: string; enabled: boolean; access?: string }>;

/**
 * `MapContext.moduleShown` from the settled module states of the project the
 * shell loads them for (redirectModuleShown). `otherProject` answers for any
 * other project: the redirect sends it home (false), a link keeps its old
 * address (null). A failed load answers as the shell shows modules then
 * (moduleShown without states: every module but an opt-in one), so a link
 * or a redirect never disagrees with the sidebar while the failure lasts.
 */
export function shownFromStates(
  modules: ReadonlyArray<{ id: string; optIn?: boolean; minAccess?: "editor" | "owner" }>,
  source: {
    projectId: string | undefined;
    settled: { projectId: string; states: { modules: ModuleStateList } | null } | null;
  },
  otherProject: false | null,
) {
  return (projectId: string, moduleId: string): boolean | null => {
    if (projectId !== source.projectId) return otherProject;
    const module = modules.find((m) => m.id === moduleId);
    return redirectModuleShown(source, projectId, (states) =>
      moduleShown(states?.modules, moduleId, module?.optIn === true, module?.minAccess),
    );
  };
}

/**
 * Whether the shell requests the member's capabilities. Never without a
 * session (a signed-out visitor would store a 401 that outlives the sign-in).
 * Once the address is known, when it is needed (a center page, or an address that maps). While
 * the location waits for its commit, only a request the previous address
 * already had stays on (coming from a center page, it is not dropped and
 * fetched again); none is started for a render whose address is not known.
 * The wait ends with the commit record, not with the capabilities.
 */
export function capabilitiesWanted(state: {
  signedIn: boolean;
  needed: boolean;
  locationWaits: boolean;
  before: boolean;
}): boolean {
  if (!state.signedIn) return false;
  return state.locationWaits ? state.before : state.needed;
}

/**
 * The search and hash the redirect may decide on. During the render that
 * first sees a client navigation's pathname, the browser still shows the
 * previous page: Next.js writes the new URL to the history only on commit.
 * So the browser's location counts only when its pathname is the router's;
 * otherwise the location the shell recorded after the commit of the router's
 * pathname, if any; else "wait". The record is keyed by the router's
 * pathname, so an encoding difference between the two cannot keep it waiting.
 */
export function locationToDecide(
  pathname: string,
  browser: OldAddress,
  committed: OldAddress | null,
): { search: string; hash: string } | "wait" {
  if (browser.pathname === pathname) return { search: browser.search, hash: browser.hash };
  if (committed?.pathname === pathname) return { search: committed.search, hash: committed.hash };
  return "wait";
}
