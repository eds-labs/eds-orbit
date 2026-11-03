"use client";
import type { SocialAccount } from "../api";
import { socialText } from "../labels";
import type { CalendarState } from "./query";

// The calendar's filters (S6): labelled checkbox groups in a disclosure.

type ListKey =
  "accountIds" | "platforms" | "statuses" | "origins" | "projectIds";

const PLATFORMS = ["x", "facebook", "instagram", "telegram"] as const;
const STATUSES = [
  "draft",
  "needs_approval",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
  "canceled",
] as const;
const ORIGINS = [
  "manual",
  "marketing",
  "mcp",
  "assistant",
  "legacy_postiz",
] as const;

export function CalendarFilters({
  state,
  accounts,
  projects,
  locale,
  onChange,
}: {
  state: CalendarState;
  accounts: SocialAccount[];
  /** The organization scope's projects; none in the project scope. */
  projects: Array<{ id: string; name: string }>;
  locale: "en" | "de";
  onChange: (next: CalendarState) => void;
}) {
  const all = socialText(locale);
  const t = all.calendar;
  const toggle = (key: ListKey, value: string) => {
    const has = state[key].includes(value);
    onChange({
      ...state,
      [key]: has
        ? state[key].filter((v) => v !== value)
        : [...state[key], value],
    });
  };
  const group = (
    key: ListKey,
    legend: string,
    idPart: string,
    options: Array<{ value: string; label: string }>,
  ) =>
    options.length > 0 && (
      <fieldset className="cal-filter-group">
        <legend>{legend}</legend>
        {options.map((o) => {
          const id = `social-calendar-${idPart}-${o.value}`;
          return (
            <div key={o.value} className="checkbox-row">
              <input
                type="checkbox"
                id={id}
                checked={state[key].includes(o.value)}
                onChange={() => toggle(key, o.value)}
              />
              <label htmlFor={id}>{o.label}</label>
            </div>
          );
        })}
      </fieldset>
    );
  const active =
    state.accountIds.length +
    state.platforms.length +
    state.statuses.length +
    state.origins.length +
    state.projectIds.length;
  return (
    <details className="cal-filters" open={active > 0 || undefined}>
      <summary>
        {t.filters}
        {active > 0 && ` (${active})`}
      </summary>
      <div className="cal-filter-groups">
        {state.scope === "organization"
          ? group(
              "projectIds",
              t.filterProjects,
              "project",
              projects.map((p) => ({ value: p.id, label: p.name })),
            )
          : group(
              "accountIds",
              t.filterAccounts,
              "account",
              accounts.map((a) => ({
                value: a.id,
                label: `${a.handle} (${all.platform[a.platform]})`,
              })),
            )}
        {group(
          "platforms",
          t.filterPlatforms,
          "platform",
          PLATFORMS.map((p) => ({ value: p, label: all.platform[p] })),
        )}
        {group(
          "statuses",
          t.filterStatuses,
          "status",
          STATUSES.map((s) => ({ value: s, label: all.posts.status[s] })),
        )}
        {group(
          "origins",
          t.filterOrigins,
          "origin",
          ORIGINS.map((o) => ({ value: o, label: t.origins[o] ?? o })),
        )}
      </div>
    </details>
  );
}
