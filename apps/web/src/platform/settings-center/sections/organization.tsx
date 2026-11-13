"use client";
import Link from "next/link";
import { useResource } from "@/lib/api";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { OrganizationManager } from "@/platform/administration/organization-manager";
import type { OrganizationDetail } from "@/platform/administration/organization-manager";
import { ConnectionsPanel } from "@/platform/administration/connections-ui";
import {
  AiProfileEditor,
  KnowledgeSharesPanel,
} from "@/platform/administration/ai-knowledge-ui";
import { AiBudgetPanel, AiUsagePanel } from "@/platform/administration/ai-budget-ui";
import { ModelPricesPanel } from "@/platform/administration/ai-catalog-ui";
import { AiDefaultsPanel } from "@/platform/administration/ai-defaults-ui";
import type { Locale } from "@/lib/i18n";
import {
  CATALOG_SECTION,
  OrganizationCatalog,
} from "../integrations/scopes";
import { SETUP_SECTION, OrganizationSetup } from "../integrations/setup";
import { OrganizationAffected } from "../ai/affected-projects";
import { OrganizationAiProjectsSection } from "../ai/organization-projects";
import { AI_SECTION_TEXT, aiText } from "../ai/texts";
import { centerText } from "../texts";
import {
  flagsOf,
  type ManageScope,
  type ManagementSection,
  type SectionProps,
} from "../types";
import { GrantsPanel, grantsPath } from "./grants-panel";

// The organization scope mounts the components the old /o/:id/settings page
// showed; that address redirects here.

/** The organization the scope belongs to; no other scope reaches these sections. */
export function organizationIdOf(scope: ManageScope): string {
  if (scope.kind !== "organization") {
    throw new Error("Organization scope required");
  }
  return scope.organizationId;
}

/** Every request path and link of the organization sections, with the id encoded. */
export function organizationPaths(organizationId: string) {
  const id = encodeURIComponent(organizationId);
  return {
    detail: `/organizations/${id}`,
    connections: `/organizations/${id}/connections`,
    aiBase: `/organizations/${id}`,
    grants: grantsPath({ kind: "organization", organizationId }),
    agents: `/o/${id}/agents`,
  };
}

const pathsOf = (scope: ManageScope) =>
  organizationPaths(organizationIdOf(scope));

/** The loaded summary; the container below fetches it. */
export function SummaryPanel({
  name,
  members,
  projects,
  membersHref,
  agentsHref,
  locale,
}: {
  name: string;
  members: number;
  projects: number;
  membersHref: string;
  agentsHref: string;
  locale: Locale;
}) {
  const text = centerText(locale);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <strong>{name}</strong>
          <p>
            {text("orgMembers")}: {members} · {text("orgProjects")}: {projects}
          </p>
        </div>
        <div className="form-actions">
          <Button asChild variant="outline">
            <Link href={membersHref}>{text("orgOpenMembers")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={agentsHref}>{text("orgOpenAgents")}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function SummarySection({ scope, locale, hrefOf }: SectionProps) {
  const paths = pathsOf(scope);
  const detail = useResource<OrganizationDetail>(paths.detail);
  if (detail.loading && !detail.data) return <Loading />;
  if (!detail.data)
    return <ResourceError error={detail.error} retry={detail.refresh} />;
  const d = detail.data;
  return (
    <SummaryPanel
      name={d.organization.name}
      members={d.members.length}
      projects={d.projects.length}
      membersHref={hrefOf("members")}
      agentsHref={paths.agents}
      locale={locale}
    />
  );
}

function MembersSection({ scope, locale }: SectionProps) {
  return (
    <OrganizationManager organizationId={organizationIdOf(scope)} locale={locale} />
  );
}

function ConnectionsSection({ scope, locale, identity }: SectionProps) {
  const id = organizationIdOf(scope);
  const projects = identity.projects
    .filter((p) => p.workspaceId === id)
    .map((p) => ({ id: p.id, name: p.name }));
  return (
    <ConnectionsPanel
      base={pathsOf(scope).connections}
      mode="owner"
      locale={locale}
      targets={projects}
    />
  );
}

// The AI area mounts the panels of /o/:id/settings one per section, with the
// same props as that page, so the forms behave the same in both places.

function AiStandardSection({ scope, locale }: SectionProps) {
  const base = pathsOf(scope).aiBase;
  return (
    <>
      <OrganizationAffected organizationId={organizationIdOf(scope)} kind="profile" locale={locale} />
      <AiDefaultsPanel
        path={`${base}/ai/defaults`}
        modelsPath={`${base}/ai/models`}
        locale={locale}
      />
    </>
  );
}

function AiModelsSection({ scope, locale, caps }: SectionProps) {
  // While the catalog is off its prices apply to no project yet, so the
  // affected notice would claim too much; catalogOff says when they will.
  return (
    <>
      {flagsOf(caps).aiCatalog ? (
        <OrganizationAffected organizationId={organizationIdOf(scope)} kind="catalog" locale={locale} />
      ) : (
        <Alert kind="info">{aiText(locale)("catalogOff")}</Alert>
      )}
      <ModelPricesPanel path={`${pathsOf(scope).aiBase}/ai/models`} locale={locale} />
    </>
  );
}

function AiBudgetSection({ scope, locale }: SectionProps) {
  // The panel renders #assistant-budget itself and scrolls to it on that hash.
  return <AiBudgetPanel base={pathsOf(scope).aiBase} locale={locale} />;
}

function UsageSection({ scope, locale }: SectionProps) {
  return (
    <AiUsagePanel base={pathsOf(scope).aiBase} locale={locale} />
  );
}

function AiAdvancedSection({ scope, locale }: SectionProps) {
  return (
    <>
      <OrganizationAffected organizationId={organizationIdOf(scope)} kind="profile" locale={locale} />
      <AiProfileEditor
        path={`${pathsOf(scope).aiBase}/ai/profile`}
        locale={locale}
        scopeLabel={locale === "de" ? "Organisation" : "Organization"}
      />
    </>
  );
}

function KnowledgeSection({ scope, locale, identity }: SectionProps) {
  const id = organizationIdOf(scope);
  return (
    <KnowledgeSharesPanel
      organizationId={id}
      projects={identity.projects
        .filter((p) => p.workspaceId === id)
        .map((p) => ({ id: p.id, name: p.name }))}
      locale={locale}
    />
  );
}

function AppsSection({ scope }: SectionProps) {
  return <GrantsPanel scope={scope} showUser />;
}

export const organizationSections: readonly ManagementSection[] = [
  {
    id: "summary",
    scope: "organization",
    area: "overview",
    order: 0,
    capability: "organization.overview",
    label: { en: "Organization", de: "Organisation" },
    description: {
      en: "Name, members and projects of this organization.",
      de: "Name, Mitglieder und Projekte dieser Organisation.",
    },
    component: SummarySection,
  },
  {
    id: "members",
    scope: "organization",
    area: "members",
    order: 0,
    capability: "organization.members",
    label: { en: "Members and invitations", de: "Mitglieder und Einladungen" },
    description: {
      en: "Who belongs to the organization, their project roles and open invitations.",
      de: "Wer zur Organisation gehört, ihre Projektrollen und offene Einladungen.",
    },
    component: MembersSection,
  },
  {
    id: "integrations",
    scope: "organization",
    area: "integrations",
    // First, so the area's address opens the catalog.
    order: -10,
    capability: "organization.connections",
    ...CATALOG_SECTION,
    component: OrganizationCatalog,
  },
  {
    id: "setup",
    scope: "organization",
    area: "integrations",
    // After the catalog, before the panels it guides through.
    order: -5,
    capability: "organization.connections",
    takesId: true,
    ...SETUP_SECTION,
    component: OrganizationSetup,
  },
  {
    id: "connections",
    scope: "organization",
    area: "integrations",
    order: 0,
    capability: "organization.connections",
    label: { en: "Connections", de: "Verbindungen" },
    description: {
      en: "Connections of the organization and the projects that may use them.",
      de: "Verbindungen der Organisation und die Projekte, die sie nutzen dürfen.",
    },
    component: ConnectionsSection,
  },
  {
    id: "standard",
    scope: "organization",
    area: "ai",
    order: 0,
    capability: "organization.ai",
    ...AI_SECTION_TEXT.standard,
    component: AiStandardSection,
  },
  {
    id: "models",
    scope: "organization",
    area: "ai",
    order: 10,
    capability: "organization.ai",
    ...AI_SECTION_TEXT.models,
    component: AiModelsSection,
  },
  {
    id: "budget",
    scope: "organization",
    area: "ai",
    order: 20,
    capability: "organization.ai",
    label: { en: "Budget", de: "Budget" },
    description: {
      en: "The organization's monthly AI budget, provider caps and the assistant's cap per member.",
      de: "Das monatliche KI-Budget der Organisation, Anbieter-Obergrenzen und die Grenze des Assistenten je Mitglied.",
    },
    component: AiBudgetSection,
  },
  {
    id: "usage",
    scope: "organization",
    area: "ai",
    order: 30,
    capability: "organization.ai",
    label: { en: "AI usage", de: "KI-Nutzung" },
    description: {
      en: "What AI used in this organization, read only.",
      de: "Was die KI in dieser Organisation verbraucht hat, nur lesend.",
    },
    component: UsageSection,
  },
  {
    id: "projects",
    scope: "organization",
    area: "ai",
    order: 40,
    capability: "organization.ai",
    label: { en: "Projects", de: "Projekte" },
    description: {
      en: "Which projects follow the standard and which set their own.",
      de: "Welche Projekte dem Standard folgen und welche eigene Einstellungen haben.",
    },
    component: OrganizationAiProjectsSection,
  },
  {
    id: "advanced",
    scope: "organization",
    area: "ai",
    order: 50,
    capability: "organization.ai",
    advanced: true,
    ...AI_SECTION_TEXT.advanced,
    component: AiAdvancedSection,
  },
  {
    id: "shares",
    scope: "organization",
    area: "knowledge",
    order: 0,
    capability: "organization.knowledge",
    label: { en: "Shared knowledge", de: "Geteiltes Wissen" },
    description: {
      en: "Knowledge the organization shares with its projects.",
      de: "Wissen, das die Organisation mit ihren Projekten teilt.",
    },
    component: KnowledgeSection,
  },
  {
    id: "apps",
    scope: "organization",
    area: "policies",
    order: 0,
    capability: "organization.apps",
    label: { en: "Connected apps", de: "Verbundene Apps" },
    description: {
      en: "Apps that members allowed to use Orbit in this organization; owners can revoke them.",
      de: "Apps, die Mitglieder für Orbit in dieser Organisation freigegeben haben; Eigentümer können sie widerrufen.",
    },
    component: AppsSection,
  },
];
