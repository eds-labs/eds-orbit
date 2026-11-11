"use client";
import Link from "next/link";
import {
  Audit,
  Integrations,
  Invitations,
  Organizations,
  Overview,
  Projects,
  UserDetail,
  UserList,
  adminHref,
} from "@/platform/administration/admin-area";
import { McpAdmin } from "@/platform/administration/admin-mcp";
import { OrganizationManager } from "@/platform/administration/organization-manager";
import { manageHref } from "../routes";
import { centerText } from "../texts";
import type { ManagementSection, SectionProps } from "../types";
import { AiLinkPanel } from "./ai-link";

// The system scope (system administrators) mounts the existing administration
// components; /admin keeps rendering the same components unchanged. Overview
// already shows the webmail status panel, so the status section needs no
// second copy of it.

const SYSTEM = { kind: "system" } as const;

/**
 * Where an administration component's link leads inside the center. Users
 * and organizations have sections here; any other admin page keeps its old
 * address so nothing links to a dead page.
 */
export function adminLinkInCenter(section: string, id?: string): string {
  const rest = id === undefined ? [] : [id];
  if (section === "users") return manageHref(SYSTEM, "users", ...rest);
  if (section === "organizations")
    return manageHref(SYSTEM, "organizations", ...rest);
  return adminHref(section, id);
}

function StatusSection({ locale }: SectionProps) {
  return <Overview locale={locale} />;
}

function UsersSection({ id, locale, identity }: SectionProps) {
  return id ? (
    <UserDetail
      id={id}
      locale={locale}
      currentUserId={identity.user.id}
      hrefOf={adminLinkInCenter}
    />
  ) : (
    <UserList locale={locale} hrefOf={adminLinkInCenter} />
  );
}

function InvitationsSection({ locale }: SectionProps) {
  return <Invitations locale={locale} />;
}

function OrganizationsSection({ id, locale }: SectionProps) {
  if (!id) return <Organizations locale={locale} hrefOf={adminLinkInCenter} />;
  return (
    <>
      <Link className="back-link" href={adminLinkInCenter("organizations")}>
        ← {centerText(locale)("backToList")}
      </Link>
      <OrganizationManager organizationId={id} locale={locale} asAdministrator />
    </>
  );
}

function ProjectsSection({ locale }: SectionProps) {
  return <Projects locale={locale} hrefOf={adminLinkInCenter} />;
}

function ConnectionsSection({ locale }: SectionProps) {
  return <Integrations locale={locale} />;
}

function AiSection({ locale }: SectionProps) {
  return <AiLinkPanel href={adminHref("ai")} locale={locale} />;
}

function McpSection({ locale }: SectionProps) {
  return <McpAdmin locale={locale} />;
}

function AuditSection({ locale }: SectionProps) {
  return <Audit locale={locale} />;
}

export const systemSections: readonly ManagementSection[] = [
  {
    id: "status",
    scope: "system",
    area: "overview",
    order: 0,
    capability: "system.overview",
    label: { en: "System status", de: "Systemstatus" },
    description: {
      en: "Users, organizations, projects and the state of this Orbit installation, without project content.",
      de: "Benutzer, Organisationen, Projekte und der Zustand dieser Orbit-Installation, ohne Projektinhalte.",
    },
    component: StatusSection,
  },
  {
    id: "users",
    scope: "system",
    area: "users",
    order: 0,
    capability: "system.users",
    label: { en: "Users", de: "Benutzer" },
    description: {
      en: "Every account of the installation with its memberships.",
      de: "Alle Konten der Installation mit ihren Mitgliedschaften.",
    },
    component: UsersSection,
  },
  {
    id: "invitations",
    scope: "system",
    area: "users",
    order: 10,
    capability: "system.users",
    label: { en: "Invitations", de: "Einladungen" },
    description: {
      en: "Open invitations of every organization; new ones are made in the organization.",
      de: "Offene Einladungen aller Organisationen; neue entstehen in der Organisation.",
    },
    component: InvitationsSection,
  },
  {
    id: "organizations",
    scope: "system",
    area: "organizations",
    order: 0,
    capability: "system.organizations",
    label: { en: "Organizations", de: "Organisationen" },
    description: {
      en: "Organizations group members and projects.",
      de: "Organisationen bündeln Mitglieder und Projekte.",
    },
    component: OrganizationsSection,
  },
  {
    id: "projects",
    scope: "system",
    area: "organizations",
    order: 10,
    capability: "system.organizations",
    label: { en: "Projects", de: "Projekte" },
    description: {
      en: "Every project of every organization, metadata only.",
      de: "Alle Projekte aller Organisationen, nur Metadaten.",
    },
    component: ProjectsSection,
  },
  {
    id: "connections",
    scope: "system",
    area: "integrations",
    order: 0,
    capability: "system.connections",
    label: { en: "Central connections", de: "Zentrale Verbindungen" },
    description: {
      en: "Central connections such as AI providers; infrastructure secrets stay in the environment.",
      de: "Zentrale Verbindungen wie KI-Anbieter; Infrastruktur-Geheimnisse bleiben in der Umgebung.",
    },
    component: ConnectionsSection,
  },
  {
    id: "overview",
    scope: "system",
    area: "ai",
    order: 0,
    capability: "system.ai",
    label: { en: "AI & knowledge", de: "KI & Wissen" },
    description: {
      en: "System-wide AI defaults, models and prices.",
      de: "Systemweite KI-Standards, Modelle und Preise.",
    },
    component: AiSection,
  },
  {
    id: "clients",
    scope: "system",
    area: "mcp",
    order: 0,
    capability: "system.mcp",
    label: { en: "MCP clients", de: "MCP-Clients" },
    description: {
      en: "Orbit as an MCP server for external clients such as ChatGPT, with every active grant.",
      de: "Orbit als MCP-Server für externe Clients wie ChatGPT, mit jeder aktiven Freigabe.",
    },
    component: McpSection,
  },
  {
    id: "audit",
    scope: "system",
    area: "security",
    order: 0,
    capability: "system.audit",
    label: { en: "Audit log", de: "Protokoll" },
    description: {
      en: "Administrative changes, without content, addresses or passwords.",
      de: "Administrative Änderungen, ohne Inhalte, Adressen oder Passwörter.",
    },
    component: AuditSection,
  },
];
