"use client";
import { Fragment, useContext } from "react";
import { collectionPath, useResource, type Dashboard } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { AgentMandateSettings } from "@/components/agent-mandates";
import {
  AiModelsPanel,
  AiProjectUsagePanel,
  AiProviderBudgetPanels,
  AiProvidersPanel,
  setupKeyProps,
  useAiSettingsResources,
  type AiConfigurationData,
} from "@/components/ai-settings";
import { AiSetupPanel, ModelChoicePanel } from "@/components/ai-model-choice";
import { SpendPolicySettings } from "@/components/spend-policy";
import { Alert } from "@/components/ui/primitives";
import {
  Connectors,
  ProjectReadinessPanel,
  ProjectSummaryPanel,
} from "@/components/management";
import { GoogleDriveSettings } from "@/components/google-drive";
import { ModuleSettings } from "@/components/module-settings";
import {
  ProjectAdministration,
  ProjectMembers,
} from "@/components/project-administration";
import { RetentionControl } from "@/components/retention-control";
import { SignalSettingsSection } from "@/components/signal-settings";
import { useWorkspace } from "@/components/workspace-context";
import {
  ContentLanguagesPanel,
  ProfileLinksPanel,
} from "@/platform/project-settings/project-configuration";
import { groupedModules } from "@/platform/shell/nav-groups";
import { ShellContext } from "@/platform/shell/shell-context";
import { platformSettingsTabs } from "@/platform/shell/settings-nav";
import { ResourceError } from "@/platform/ui/collection";
import {
  CATALOG_SECTION,
  ProjectCatalog,
} from "../integrations/scopes";
import { SETUP_SECTION, ProjectSetup } from "../integrations/setup";
import {
  adaptIntegrationSections,
  adaptModuleSections,
  visibleSections,
} from "../registry";
import { backLink, scopeTitle } from "../scope-links";
import type { ScopeViewProps } from "../scope-view";
import { SettingsCenterView } from "../settings-center";
import { EffectiveAiSection } from "../ai/effective-view";
import { ModuleCeilings } from "../ai/module-ceilings";
import { aiText } from "../ai/texts";
import { flagsOf, type ManagementSection, type SectionProps } from "../types";

// The project scope mounts the panels of /p/:id/settings and /p/:id/connectors;
// those pages keep rendering them unchanged. The shell wraps this scope in
// the project's ShellContext and WorkspaceContext, so the panels read the
// project from there exactly as on their own pages.

/**
 * The tab keys of the old settings page that belong to the platform. A module
 * section on one of them (webmail on "integrations") becomes the module's
 * own "settings" section.
 */
export const PLATFORM_TAB_KEYS: readonly string[] = platformSettingsTabs({
  isOwner: true,
  connectedApps: true,
}).map((tab) => tab.key);

function SummarySection() {
  const { project, revision } = useWorkspace();
  // The settings page's own dashboard request.
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  return (
    <>
      <ResourceError error={dashboard.error} retry={dashboard.refresh} />
      <div className="settings-grid">
        <ProjectSummaryPanel dashboard={dashboard.data} />
        <ProjectReadinessPanel
          dashboard={dashboard.data}
          loading={dashboard.loading}
        />
      </div>
    </>
  );
}

function ProfileSection() {
  const { project, isOwner, locale } = useWorkspace();
  return (
    <>
      <ContentLanguagesPanel project={project} isOwner={isOwner} locale={locale} />
      <ProfileLinksPanel project={project} isOwner={isOwner} locale={locale} />
      <ProjectAdministration />
    </>
  );
}

function SwitchesSection() {
  return (
    <>
      <ModuleSettings />
      {/* Proactive signal switches (ADR 0023); hidden while off. */}
      <SignalSettingsSection />
    </>
  );
}

function ConnectionsSection() {
  return <Connectors embedded groupMailboxes />;
}

// The AI area mounts the panels of the old AI tab (/p/:id/settings?section=ai)
// one per section, with the same props and conditions as AiSettingsView.
// Each section loads the configuration it needs itself.

/**
 * Whether the project follows the organization's standard models: only while
 * the standard applies (`defaults` is sent while ORBIT_AI_DEFAULTS is on).
 */
const followsStandard = (view: AiConfigurationData | null | undefined) =>
  view?.routing?.source === "organization" && Boolean(view.defaults);

function AiProvidersSection() {
  const { project, locale } = useWorkspace();
  const { configuration, refreshAll } = useAiSettingsResources();
  const view = configuration.data;
  return (
    <>
      {view && (
        <AiSetupPanel
          view={view}
          {...setupKeyProps(project.id, view, locale)}
          onChanged={refreshAll}
        />
      )}
      <AiProvidersPanel
        configuration={configuration}
        refreshAll={refreshAll}
        followsStandard={followsStandard(view)}
      />
    </>
  );
}

type AiResources = ReturnType<typeof useAiSettingsResources>;

/** The models section from a loaded configuration; the models stay read-only while the project follows the standard. */
export function AiModelsSectionView({
  configuration,
  refreshAll,
  aiDefaults,
  locale,
}: {
  configuration: AiResources["configuration"];
  refreshAll(): void;
  aiDefaults: boolean;
  locale: Locale;
}) {
  const t = aiText(locale);
  const view = configuration.data;
  return (
    <>
      {view && <ModelChoicePanel view={view} onChanged={refreshAll} />}
      {aiDefaults ? null : <Alert kind="info">{t("defaultsOff")}</Alert>}
      <details>
        <summary>{t("modelsAdvanced")}</summary>
        <AiModelsPanel
          configuration={configuration}
          editable={!followsStandard(view)}
        />
      </details>
    </>
  );
}

function AiModelsSection({ caps, locale }: SectionProps) {
  const { configuration, refreshAll } = useAiSettingsResources();
  return (
    <AiModelsSectionView
      configuration={configuration}
      refreshAll={refreshAll}
      aiDefaults={flagsOf(caps).aiDefaults}
      locale={locale}
    />
  );
}

function AiBudgetSection({ locale, hrefOf }: SectionProps) {
  const { configuration, budget } = useAiSettingsResources();
  return (
    <>
      <SpendPolicySettings />
      <AiProviderBudgetPanels configuration={configuration} budget={budget} />
      <ModuleCeilings locale={locale} hrefOf={hrefOf} />
    </>
  );
}

function AiUsageSection() {
  const { budget } = useAiSettingsResources();
  return <AiProjectUsagePanel budget={budget} />;
}

export const projectSections: readonly ManagementSection[] = [
  {
    id: "summary",
    scope: "project",
    area: "overview",
    order: 0,
    capability: "project.overview",
    label: { en: "Project", de: "Projekt" },
    description: {
      en: "Name, your role, the export and the autopilot readiness.",
      de: "Name, deine Rolle, der Export und die Autopilot-Bereitschaft.",
    },
    component: SummarySection,
  },
  {
    id: "profile",
    scope: "project",
    area: "profile",
    order: 0,
    capability: "project.profile",
    label: { en: "Project profile", de: "Projektprofil" },
    description: {
      en: "Content languages, profile links, name, timezone and public client keys.",
      de: "Inhaltssprachen, Profillinks, Name, Zeitzone und öffentliche Client-Schlüssel.",
    },
    component: ProfileSection,
  },
  {
    id: "members",
    scope: "project",
    area: "members",
    order: 0,
    capability: "project.members",
    label: { en: "Members", de: "Mitglieder" },
    description: {
      en: "Who works in this project and with which role.",
      de: "Wer in diesem Projekt arbeitet und mit welcher Rolle.",
    },
    component: ProjectMembers,
  },
  {
    id: "switches",
    scope: "project",
    area: "modules",
    order: 0,
    capability: "project.modules",
    label: { en: "Modules and signals", de: "Module und Signale" },
    description: {
      en: "Which modules are on in this project and which signals they may send.",
      de: "Welche Module in diesem Projekt an sind und welche Signale sie senden dürfen.",
    },
    component: SwitchesSection,
  },
  {
    id: "integrations",
    scope: "project",
    area: "integrations",
    // First, so the area's address opens the catalog.
    order: -10,
    capability: "project.integrations",
    ...CATALOG_SECTION,
    component: ProjectCatalog,
  },
  {
    id: "setup",
    scope: "project",
    area: "integrations",
    // After the catalog, before the panels it guides through.
    order: -5,
    capability: "project.integrations",
    takesId: true,
    ...SETUP_SECTION,
    component: ProjectSetup,
  },
  {
    id: "connections",
    scope: "project",
    area: "integrations",
    order: 0,
    capability: "project.integrations",
    label: { en: "Connections", de: "Verbindungen" },
    description: {
      en: "Connections with capabilities you can verify.",
      de: "Verbindungen mit überprüfbaren Fähigkeiten.",
    },
    component: ConnectionsSection,
  },
  {
    id: "google-drive",
    scope: "project",
    area: "integrations",
    order: 10,
    capability: "project.integrations",
    label: { en: "Google Drive", de: "Google Drive" },
    description: {
      en: "Google Drive for private project assets and generated media.",
      de: "Google Drive für private Projektdateien und erzeugte Medien.",
    },
    component: GoogleDriveSettings,
  },
  {
    id: "overview",
    scope: "project",
    area: "ai",
    order: 0,
    capability: "project.ai",
    label: { en: "AI overview", de: "KI-Übersicht" },
    description: {
      en: "Which models, keys and budgets apply and where each comes from.",
      de: "Welche Modelle, Schlüssel und Budgets gelten und woher sie kommen.",
    },
    component: EffectiveAiSection,
  },
  {
    id: "providers",
    scope: "project",
    area: "ai",
    order: 10,
    capability: "project.ai",
    label: { en: "Providers and keys", de: "Anbieter und Schlüssel" },
    description: {
      en: "Keys of OpenAI and Claude, where they come from, and what the project can do with them.",
      de: "Schlüssel für OpenAI und Claude, woher sie kommen und was das Projekt damit kann.",
    },
    component: AiProvidersSection,
  },
  {
    id: "models",
    scope: "project",
    area: "ai",
    order: 20,
    capability: "project.ai",
    label: { en: "Models", de: "Modelle" },
    description: {
      en: "Follow the standard, choose a level or set own models and task routes.",
      de: "Dem Standard folgen, eine Stufe wählen oder eigene Modelle und Aufgaben-Routen festlegen.",
    },
    component: AiModelsSection,
  },
  {
    id: "budget",
    scope: "project",
    area: "ai",
    order: 30,
    capability: "project.ai",
    label: { en: "Budget", de: "Budget" },
    description: {
      en: "Spending authority, provider budgets and the modules' AI ceilings.",
      de: "Ausgabenfreigabe, Anbieter-Budgets und die KI-Obergrenzen der Module.",
    },
    component: AiBudgetSection,
  },
  {
    id: "usage",
    scope: "project",
    area: "ai",
    order: 40,
    capability: "project.ai",
    label: { en: "Usage and costs", de: "Nutzung und Kosten" },
    description: {
      en: "What the project's AI used, calculated by Orbit.",
      de: "Was die KI des Projekts verbraucht hat, von Orbit berechnet.",
    },
    component: AiUsageSection,
  },
  {
    id: "agents",
    scope: "project",
    area: "ai",
    order: 50,
    capability: "project.ai",
    label: { en: "Agent permissions", de: "Agentenrechte" },
    description: {
      en: "What configured agents may do and spend.",
      de: "Was eingerichtete Agenten tun und ausgeben dürfen.",
    },
    component: AgentMandateSettings,
  },
  {
    id: "retention",
    scope: "project",
    area: "data",
    order: 0,
    capability: "project.data",
    label: { en: "Memory retention", de: "Aufbewahrung" },
    description: {
      en: "Delete old insights and expired editorial preferences of this project.",
      de: "Alte Erkenntnisse und abgelaufene redaktionelle Vorgaben dieses Projekts löschen.",
    },
    component: RetentionControl,
  },
];

type ShellModuleLike = Parameters<typeof adaptModuleSections>[1][number] & {
  enabled: boolean;
  groupOrder?: number;
};

/**
 * The module sections of the project scope and their notices, the module
 * groups in the sidebar's order (groupedModules: by groupOrder, ties in
 * registry order), as the old settings page lists them.
 */
export function projectModuleSections(
  contributed: Parameters<typeof adaptModuleSections>[0],
  modules: readonly ShellModuleLike[],
) {
  return adaptModuleSections(
    contributed,
    groupedModules(modules),
    PLATFORM_TAB_KEYS,
  );
}

/**
 * The project scope: the platform's sections the member's capabilities allow,
 * then the sections of the modules shown for the project. The module hooks
 * run on every render in the shell's order, which only changes when the
 * enabled modules change, and then the shell remounts this view.
 */
export function ProjectScopeView({
  scope,
  capabilities,
  name,
  target,
  caps,
  identity,
  locale,
  navigate,
}: ScopeViewProps) {
  const shell = useContext(ShellContext);
  const contributed = (shell?.settings ?? []).map((section) => ({
    section,
    shown: section.useSection(),
  }));
  const modules = shell?.modules ?? [];
  const adapted = projectModuleSections(contributed, modules);
  const sections = [
    ...visibleSections(projectSections, "project", capabilities),
    ...adapted.sections,
    // Integration sections of the modules shown for the project (ADR 0027).
    ...adaptIntegrationSections(shell?.integrations ?? []),
  ];
  const back = backLink(scope, locale);
  return (
    <SettingsCenterView
      scope={scope}
      scopeName={scopeTitle(scope, name, locale)}
      sections={sections}
      target={target}
      caps={caps}
      identity={identity}
      locale={locale}
      moduleName={(id) => modules.find((m) => m.id === id)?.displayName}
      navigate={navigate}
      backHref={back.href}
      backLabel={back.label}
      notices={adapted.notices.map((notice, index) => (
        <Fragment key={index}>{notice}</Fragment>
      ))}
    />
  );
}
