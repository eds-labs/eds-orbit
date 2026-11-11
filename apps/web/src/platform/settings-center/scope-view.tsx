"use client";
import type { Identity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { visibleSections } from "./registry";
import { backLink, scopeTitle } from "./scope-links";
import { accountSections } from "./sections/account";
import { organizationSections } from "./sections/organization";
import { ProjectScopeView } from "./sections/project";
import { systemSections } from "./sections/system";
import { SettingsCenterView } from "./settings-center";
import type {
  Capability,
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
} from "./types";

export { backLink, scopeTitle } from "./scope-links";

export type ScopeViewProps = {
  scope: ManageScope;
  capabilities: readonly Capability[];
  name: string;
  target: ManageTarget;
  caps: ManagementCapabilities;
  identity: Identity;
  locale: Locale;
  navigate(href: string): void;
};

/**
 * The one place that picks the content of a scope, so the shell renders this
 * component for every scope and never needs to know the sections.
 */
export function ScopeView(props: ScopeViewProps) {
  // The project's sections include the modules', whose hooks need a
  // component of their own; this one calls no hook, so returning early is safe.
  if (props.scope.kind === "project") return <ProjectScopeView {...props} />;
  const { scope, capabilities, name, target, caps, identity, locale, navigate } =
    props;
  const back = backLink(scope, locale);
  const sections =
    scope.kind === "system"
      ? visibleSections(systemSections, "system", capabilities)
      : scope.kind === "organization"
        ? visibleSections(organizationSections, "organization", capabilities)
        : visibleSections(accountSections, "account", capabilities);
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
