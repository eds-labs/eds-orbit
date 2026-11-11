import { authDb } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  accountEnabled,
  administrationEnabled,
  isSystemAdmin,
} from "../administration/authz.ts";
import { connectionsEnabled } from "../connections/central.ts";
import { aiCatalogEnabled, aiDefaultsEnabled } from "../ai/catalog.ts";
import { aiOrgBudgetEnabled } from "../ai/org-budget.ts";
import { sharesEnabled } from "../knowledge/shares.ts";
import { personalAssistantEnabled } from "../assistant/personal-space.ts";
import { mcpConnectEnabled } from "../mcp-auth/routes.ts";
import { businessProjectsWhere } from "../tenancy/member-scope.ts";
import { settingsCenterStage } from "./flag.ts";

// What a member may open in the settings center (ADR 0027). A hint for
// navigation only: every route keeps its own server-side check. Control-plane
// tables only (authDb); nothing here reads module or project data.

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

/** Installation switches the sections word their notices by; display hints only. */
export type ManagementFlags = {
  connections: boolean;
  aiCatalog: boolean;
  aiDefaults: boolean;
  aiOrgBudget: boolean;
};

export type ManagementCapabilities = {
  stage: "preview" | "on";
  flags: ManagementFlags;
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

const PROJECT_ANY: Capability[] = [
  "project.overview",
  "project.profile",
  "project.modules",
  "project.integrations",
];
const PROJECT_OWNER: Capability[] = [
  "project.members",
  "project.ai",
  "project.data",
];

export async function managementCapabilities(
  userId: string,
): Promise<ManagementCapabilities> {
  const administration = administrationEnabled();
  const connections = connectionsEnabled();
  const apps = mcpConnectEnabled(loadConfig());

  const system: Capability[] =
    administration && (await isSystemAdmin(userId))
      ? [
          "system.overview",
          "system.users",
          "system.organizations",
          ...(connections
            ? (["system.connections", "system.ai"] as const)
            : []),
          "system.mcp",
          "system.audit",
        ]
      : [];

  const account: Capability[] = [
    ...(accountEnabled() ? (["account.profile"] as const) : []),
    ...(apps ? (["account.apps"] as const) : []),
    ...(personalAssistantEnabled() ? (["account.assistant"] as const) : []),
  ];

  const memberships = await authDb.workspaceMember.findMany({
    where: { userId },
    select: {
      workspaceId: true,
      role: true,
      workspace: { select: { name: true } },
    },
  });
  const owned = new Set(
    memberships.filter((m) => m.role === "owner").map((m) => m.workspaceId),
  );

  // Only organizations the caller owns: a system administrator's foreign
  // organizations are not listed (D-9), and a plain member manages nothing.
  const organizations = administration
    ? memberships
        .filter((m) => m.role === "owner")
        .map((m) => ({
          id: m.workspaceId,
          name: m.workspace.name,
          capabilities: [
            "organization.overview",
            "organization.members",
            ...(connections
              ? (["organization.connections", "organization.ai"] as const)
              : []),
            ...(sharesEnabled() ? (["organization.knowledge"] as const) : []),
            ...(apps ? (["organization.apps"] as const) : []),
          ] satisfies Capability[],
        }))
    : [];

  // The project role is computed as /api/me does: an organization owner is
  // owner of every business project of it.
  const projects = (
    await authDb.project.findMany({
      where: businessProjectsWhere(userId),
      select: {
        id: true,
        name: true,
        workspaceId: true,
        members: { where: { userId }, select: { role: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  ).flatMap((p) => {
    const stored = owned.has(p.workspaceId) ? "owner" : p.members[0]?.role;
    if (stored !== "owner" && stored !== "editor" && stored !== "viewer")
      return [];
    const role: ProjectRole = stored;
    return [
      {
        id: p.id,
        name: p.name,
        workspaceId: p.workspaceId,
        role,
        capabilities: [
          ...PROJECT_ANY,
          ...(role === "owner" ? PROJECT_OWNER : []),
        ],
      },
    ];
  });

  return {
    // The route answers 404 while the stage is "off" (server hook).
    stage: settingsCenterStage() === "on" ? "on" : "preview",
    flags: {
      connections,
      aiCatalog: aiCatalogEnabled(),
      aiDefaults: aiDefaultsEnabled(),
      aiOrgBudget: aiOrgBudgetEnabled(),
    },
    system,
    account,
    organizations,
    projects,
  };
}
