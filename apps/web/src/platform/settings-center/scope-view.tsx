"use client";
import type { Identity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { visibleSections } from "./registry";
import { accountSections } from "./sections/account";
import { organizationSections } from "./sections/organization";
import { systemSections } from "./sections/system";
import { SettingsCenterView } from "./settings-center";
import { centerText } from "./texts";
import type {
  Capability,
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
  ResolvedSection,
} from "./types";

/** The heading of a scope; organizations and projects go by their name. */
export function scopeTitle(
  scope: ManageScope,
  name: string,
  locale: Locale,
): string {
  const text = centerText(locale);
  if (scope.kind === "system") return text("scopeSystem");
  if (scope.kind === "account") return text("scopeAccount");
  return name;
}

/** Where the back link of a scope leads: its organization, project or Orbit. */
export function backLink(
  scope: ManageScope,
  locale: Locale,
): { href: string; label: string } {
  const text = centerText(locale);
  if (scope.kind === "organization")
    return {
      href: `/o/${encodeURIComponent(scope.organizationId)}`,
      label: text("backToOrganization"),
    };
  if (scope.kind === "project")
    return {
      href: `/p/${encodeURIComponent(scope.projectId)}`,
      label: text("backToProject"),
    };
  return { href: "/", label: text("backToApp") };
}

// Project sections come with a later task; until then its overview says
// nothing is available.
const NO_SECTIONS: readonly ResolvedSection[] = [];

/**
 * The one place that picks the content of a scope, so the shell renders this
 * component for every scope and never needs to know the sections.
 */
export function ScopeView({
  scope,
  capabilities,
  name,
  target,
  caps,
  identity,
  locale,
  navigate,
}: {
  scope: ManageScope;
  capabilities: readonly Capability[];
  name: string;
  target: ManageTarget;
  caps: ManagementCapabilities;
  identity: Identity;
  locale: Locale;
  navigate(href: string): void;
}) {
  const back = backLink(scope, locale);
  const sections =
    scope.kind === "system"
      ? visibleSections(systemSections, "system", capabilities)
      : scope.kind === "organization"
        ? visibleSections(organizationSections, "organization", capabilities)
        : scope.kind === "account"
          ? visibleSections(accountSections, "account", capabilities)
          : NO_SECTIONS;
  return (
    <SettingsCenterView
      scope={scope}
      scopeName={scopeTitle(scope, name, locale)}
      sections={sections}
      target={target}
      caps={caps}
      identity={identity}
      locale={locale}
      moduleName={() => undefined}
      navigate={navigate}
      backHref={back.href}
      backLabel={back.label}
    />
  );
}
