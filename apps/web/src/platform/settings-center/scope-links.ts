import type { Locale } from "@/lib/i18n";
import { centerText } from "./texts";
import type { ManageScope } from "./types";

// Apart from scope-view.tsx so the project scope, which scope-view renders,
// can use them without an import cycle.

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
