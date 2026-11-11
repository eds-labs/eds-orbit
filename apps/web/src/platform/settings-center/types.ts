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
