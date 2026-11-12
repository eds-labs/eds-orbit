import type { ComponentType, ReactNode } from "react";
import type { Identity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type { Label } from "@/platform/shell/types";

// Mirror of apps/api/src/platform/management/capabilities.ts. The web app
// never imports server code, so the vocabulary is copied by hand and must
// stay identical in names and shape.

export const CAPABILITIES = [
  "system.overview",
  "system.users",
  "system.organizations",
  "system.connections",
  "system.ai",
  "system.mcp",
  "system.audit",
  "organization.overview",
  "organization.members",
  "organization.connections",
  "organization.ai",
  "organization.knowledge",
  "organization.apps",
  "project.overview",
  "project.profile",
  "project.members",
  "project.modules",
  "project.integrations",
  "project.ai",
  "project.data",
  "account.profile",
  "account.apps",
  "account.assistant",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

type ProjectRole = "owner" | "editor" | "viewer";

export type ManagementCapabilities = {
  stage: "preview" | "on";
  system: Capability[];
  account: Capability[];
  organizations: Array<{
    id: string;
    name: string;
    capabilities: Capability[];
  }>;
  projects: Array<{
    id: string;
    name: string;
    workspaceId: string;
    role: ProjectRole;
    capabilities: Capability[];
  }>;
};

export type ManageScope =
  | { kind: "system" }
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; projectId: string }
  | { kind: "account" };
export type ScopeKind = ManageScope["kind"];
/** `scope` null is the bare /manage; `rest` is what follows the area. */
export type ManageTarget = {
  scope: ManageScope | null;
  area: string | null;
  rest: readonly string[];
};

export type SectionProps = {
  scope: ManageScope;
  /** The path part after the section, e.g. a user id. */
  id?: string;
  locale: Locale;
  identity: Identity;
  /**
   * The capabilities answer the frame already holds, for display hints only
   * (e.g. whose step a setup step is); every write keeps its server check.
   */
  caps?: ManagementCapabilities;
  /** Address of another section of the same scope. */
  hrefOf(area: string, ...rest: string[]): string;
};
/** What navigation and search need; `id` may hold a slash ("finance/accounts"). */
export type SectionMeta = {
  id: string;
  scope: ScopeKind;
  area: string;
  moduleId?: string;
  label: Label;
  description: Label;
  keywords?: Label;
  order: number;
  advanced?: true;
  /** The section's component renders its own page head; the frame omits its section head. */
  ownHead?: true;
  /** The section reads the path segment after it as an id, e.g. a user. */
  takesId?: true;
};
export type ManagementSection = SectionMeta & {
  capability: Capability;
  component: ComponentType<SectionProps>;
};
export type ResolvedSection = SectionMeta & {
  render(props: SectionProps): ReactNode;
};
export type Area = { id: string; label: Label; order: number };
