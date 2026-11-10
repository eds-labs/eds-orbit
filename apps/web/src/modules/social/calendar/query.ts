// The calendar's state in the URL (S6): shareable, and back/forward work.

export type CalendarState = {
  view: "month" | "week" | "list";
  anchor: string;
  scope: "project" | "organization";
  accountIds: string[];
  platforms: string[];
  statuses: string[];
  origins: string[];
  projectIds: string[];
};

const VIEWS = ["month", "week", "list"] as const;
const PLATFORMS = ["x", "facebook", "instagram", "telegram"];
const STATUSES = ["draft", "needs_approval", "approved", "scheduled", "publishing", "published", "partially_published", "failed", "canceled", "archived"];
const ORIGINS = ["manual", "marketing", "mcp", "assistant", "legacy_postiz"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isDate = (v: string | null): v is string => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const at = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(v);
};
const list = (search: URLSearchParams, key: string, ok: (v: string) => boolean) => [
  ...new Set((search.get(key) ?? "").split(",").filter((v) => v && ok(v))),
];

export function stateFromSearch(search: URLSearchParams, today: string): CalendarState {
  const view = search.get("view");
  const anchor = search.get("anchor");
  return {
    view: VIEWS.find((v) => v === view) ?? "month",
    anchor: isDate(anchor) ? anchor : today,
    scope: search.get("scope") === "organization" ? "organization" : "project",
    accountIds: list(search, "accounts", (v) => UUID.test(v)),
    platforms: list(search, "platforms", (v) => PLATFORMS.includes(v)),
    statuses: list(search, "statuses", (v) => STATUSES.includes(v)),
    origins: list(search, "origins", (v) => ORIGINS.includes(v)),
    projectIds: list(search, "projects", (v) => UUID.test(v)),
  };
}

/** A stable search string; defaults are left out except the anchor. */
export function searchFromState(state: CalendarState): string {
  const out = new URLSearchParams();
  if (state.view !== "month") out.set("view", state.view);
  out.set("anchor", state.anchor);
  if (state.scope !== "project") out.set("scope", state.scope);
  const lists: Array<[string, string[]]> = [
    ["accounts", state.accountIds],
    ["platforms", state.platforms],
    ["statuses", state.statuses],
    ["origins", state.origins],
    ["projects", state.projectIds],
  ];
  for (const [key, values] of lists) if (values.length) out.set(key, values.join(","));
  return out.toString();
}

/** The API query for a range; projects only in the organization scope. */
export function apiQuery(state: CalendarState, range: { from: string; to: string }): string {
  const out = new URLSearchParams({ from: range.from, to: range.to });
  if (state.accountIds.length) out.set("accountIds", state.accountIds.join(","));
  if (state.platforms.length) out.set("platforms", state.platforms.join(","));
  if (state.statuses.length) out.set("statuses", state.statuses.join(","));
  if (state.origins.length) out.set("origins", state.origins.join(","));
  if (state.scope === "organization" && state.projectIds.length) out.set("projectIds", state.projectIds.join(","));
  return out.toString();
}
