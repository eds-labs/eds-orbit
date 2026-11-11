"use client";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert } from "@/components/ui/primitives";
import { affectedCounts, type OrganizationAiProjects } from "./organization-projects";
import { aiPaths } from "./paths";
import { affectedText, type AiTextKey } from "./texts";

export { affectedText } from "./texts";

// Who a central AI form changes, shown above it. A profile save changes the
// route version of every project below it (central-ai.ts), so running work
// stops before its next paid call; catalog prices take no part in the route
// version, so their notice does not claim it. While the counts load or fail
// the notice is left out: the form below works without it. While the
// standard does not apply (ORBIT_AI_DEFAULTS off) the runtime skips it, so a
// profile notice then says only what stays true: the route version change.

export type AffectedKind = "profile" | "catalog";

type Counts = ReturnType<typeof affectedCounts>;

export function AffectedProjectsNotice(
  props:
    | {
        scope: "organization";
        kind: AffectedKind;
        counts: Counts;
        /** Projects the list could not read; the counts miss them. */
        unreadable?: number;
        /** Whether the runtime applies the standard; default true. */
        standardApplies?: boolean;
        locale: Locale;
      }
    | {
        scope: "system";
        kind: AffectedKind;
        total: number;
        /** Whether the runtime applies the standard; default true. */
        standardApplies?: boolean;
        locale: Locale;
      },
) {
  const { kind, locale } = props;
  const key = (profile: AiTextKey, routeOnly: AiTextKey, catalog: AiTextKey) =>
    kind === "catalog"
      ? catalog
      : props.standardApplies === false
        ? routeOnly
        : profile;
  let text: string;
  if (props.scope === "organization") {
    text = affectedText(
      key("affectedOrgProfile", "affectedOrgRouteOnly", "affectedOrgCatalog"),
      props.counts,
      locale,
    );
    if (props.unreadable && props.unreadable > 0)
      text += ` ${affectedText("projectsUnreadable", { count: props.unreadable }, locale)}`;
  } else {
    text = affectedText(
      key("affectedSystemProfile", "affectedSystemRouteOnly", "affectedSystemCatalog"),
      { total: props.total },
      locale,
    );
  }
  return <Alert kind={kind === "profile" ? "warning" : "info"}>{text}</Alert>;
}

/** The organization's notice, counted from its AI projects list. */
export function OrganizationAffected({
  organizationId,
  kind,
  locale,
}: {
  organizationId: string;
  kind: AffectedKind;
  locale: Locale;
}) {
  const path = aiPaths({ kind: "organization", organizationId }).projects ?? null;
  const projects = useResource<OrganizationAiProjects>(path);
  if (!projects.data) return null;
  return (
    <AffectedProjectsNotice
      scope="organization"
      kind={kind}
      counts={affectedCounts(projects.data)}
      unreadable={projects.data.unreadable}
      standardApplies={projects.data.routingApplied}
      locale={locale}
    />
  );
}

/** The part of the system overview the notice reads. */
type OverviewCounts = { projects?: { total?: number } };

/** The system's notice; the overview counts every organization's business projects. */
export function SystemAffected({
  kind,
  standardApplies,
  locale,
}: {
  kind: AffectedKind;
  /** Whether the runtime applies the standard; default true. */
  standardApplies?: boolean;
  locale: Locale;
}) {
  const path = aiPaths({ kind: "system" }).overview ?? null;
  const overview = useResource<OverviewCounts>(path);
  const total = overview.data?.projects?.total;
  if (typeof total !== "number") return null;
  return (
    <AffectedProjectsNotice
      scope="system"
      kind={kind}
      total={total}
      standardApplies={standardApplies}
      locale={locale}
    />
  );
}
