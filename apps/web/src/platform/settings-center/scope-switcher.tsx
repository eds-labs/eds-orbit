"use client";
import type { Locale } from "@/lib/i18n";
import { Field, FieldLabel } from "@/components/ui/primitives";
import { manageHref, scopeKey } from "./routes";
import { centerText } from "./texts";
import type { ManageScope, ManagementCapabilities } from "./types";

type ScopeOption = { key: string; label: string; href: string };
type ScopeGroup = { label: string | null; options: ScopeOption[] };

/**
 * Every scope the member may manage: system and account first (unlabelled),
 * then the organizations, then each organization's projects. Projects of an
 * organization the member does not manage are grouped under "Projects", so
 * the switcher never names an organization outside the capabilities.
 */
export function scopeOptions(
  caps: ManagementCapabilities,
  locale: Locale,
): ScopeGroup[] {
  const t = centerText(locale);
  const option = (scope: ManageScope, label: string): ScopeOption => ({
    key: scopeKey(scope),
    label,
    href: manageHref(scope),
  });
  const groups: ScopeGroup[] = [];
  const first = [
    ...(caps.system.length ? [option({ kind: "system" }, t("scopeSystem"))] : []),
    ...(caps.account.length ? [option({ kind: "account" }, t("scopeAccount"))] : []),
  ];
  if (first.length) groups.push({ label: null, options: first });
  if (caps.organizations.length) {
    groups.push({
      label: t("scopeOrganizations"),
      options: caps.organizations.map((o) =>
        option({ kind: "organization", organizationId: o.id }, o.name),
      ),
    });
  }
  const workspaceIds = [...new Set(caps.projects.map((p) => p.workspaceId))];
  for (const workspaceId of workspaceIds) {
    groups.push({
      label:
        caps.organizations.find((o) => o.id === workspaceId)?.name ??
        t("scopeProjects"),
      options: caps.projects
        .filter((p) => p.workspaceId === workspaceId)
        .map((p) => option({ kind: "project", projectId: p.id }, p.name)),
    });
  }
  return groups;
}

/** A labelled native select; choosing a scope opens its address. */
export function ScopeSwitcher({
  caps,
  current,
  locale,
  onSelect,
}: {
  caps: ManagementCapabilities;
  current: ManageScope;
  locale: Locale;
  onSelect(href: string): void;
}) {
  const groups = scopeOptions(caps, locale);
  const options = groups.flatMap((g) => g.options);
  const renderOption = (o: ScopeOption) => (
    <option key={o.key} value={o.key}>
      {o.label}
    </option>
  );
  return (
    <Field>
      <FieldLabel htmlFor="manage-scope">
        {centerText(locale)("scopeLabel")}
      </FieldLabel>
      <select
        className="input"
        id="manage-scope"
        value={scopeKey(current)}
        onChange={(e) => {
          const href = options.find((o) => o.key === e.target.value)?.href;
          if (href) onSelect(href);
        }}
      >
        {groups.map((group) =>
          group.label === null ? (
            group.options.map(renderOption)
          ) : (
            <optgroup key={`${group.label}-${group.options[0]?.key}`} label={group.label}>
              {group.options.map(renderOption)}
            </optgroup>
          ),
        )}
      </select>
    </Field>
  );
}
