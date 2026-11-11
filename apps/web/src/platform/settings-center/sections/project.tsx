"use client";
import { Fragment, useContext } from "react";
import { collectionPath, useResource, type Dashboard } from "@/lib/api";
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
import {
  platformSettingsTabs,
  settingsSectionHref,
} from "@/platform/shell/settings-nav";
import { ResourceError } from "@/platform/ui/collection";
import { adaptModuleSections, visibleSections } from "../registry";
import { backLink, scopeTitle } from "../scope-links";
import type { ScopeViewProps } from "../scope-view";
import { SettingsCenterView } from "../settings-center";
import type { ManagementSection, SectionProps } from "../types";
import { AiLinkPanel } from "./ai-link";

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
  return <Connectors embedded />;
}

/** The AI section of the project's settings page, where the forms stay for now. */
export const projectAiSettingsHref = (settingsHref: string) =>
  settingsSectionHref(settingsHref, "ai");

function AiSection({ locale }: SectionProps) {
  const shell = useContext(ShellContext);
  const href = projectAiSettingsHref(shell?.hrefOf("settings") ?? "");
  return <AiLinkPanel href={href} locale={locale} />;
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
    label: { en: "AI settings", de: "KI-Einstellungen" },
    description: {
      en: "Spending policy, agent mandates, models and budget of the project's AI.",
      de: "Ausgabenrichtlinie, Agentenmandate, Modelle und Budget der KI des Projekts.",
    },
    component: AiSection,
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
