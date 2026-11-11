import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { aiDefaultsEnabled } from "../ai/catalog.ts";
import {
  projectAiExceptions,
  routingModeOf,
  type RoutingMode,
} from "../ai/effective-configuration.ts";
import { projectSpendAuthority } from "../ai/org-budget-levels.ts";
import { configurationRow, ownAiKeys, storedAiFields } from "../ai/openai-configuration.ts";

// Which projects of an organization follow its AI settings and which
// override them (ADR 0027, phase 4). For the organization's owners only; the
// caller checks ownership. Each project is read inside its own scoped
// transaction as the owner, so row-level security stays as it is, and the
// answer is built field by field: no key, no model list, no price, no profile.
// Personal spaces and other organizations never appear.

export type SpendingAuthorityState = "none" | "active" | "expired" | "off" | "invalid";

export type OrganizationAiProjects = {
  /** Whether the runtime applies a saved routing mode (ORBIT_AI_DEFAULTS). */
  routingApplied: boolean;
  projects: Array<{
    projectId: string;
    name: string;
    routingMode: RoutingMode;
    ownKeys: { openai: boolean; image: boolean; anthropic: boolean };
    overrides: { models: boolean; routes: boolean; prices: boolean; providerBudgets: boolean };
    spendingAuthority: SpendingAuthorityState;
  }>;
};

/** Called with the project id and the error when one project's read throws. */
export type AiProjectReadFailure = (projectId: string, error: unknown) => void;

export async function organizationAiProjects(
  workspaceId: string,
  actorId: string,
  now = new Date(),
  onFailure?: AiProjectReadFailure,
): Promise<OrganizationAiProjects> {
  const rows = await authDb.project.findMany({
    where: { workspaceId, kind: { not: "personal" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const projects: OrganizationAiProjects["projects"] = [];
  for (const project of rows) {
    const scope = { workspaceId, projectId: project.id, userId: actorId, role: "owner" } as Scope;
    try {
      const row = await scoped(workspaceId, project.id, (tx) => configurationRow(tx, scope));
      const stored = storedAiFields(row);
      const ownKeys = ownAiKeys(row);
      const { keys: _keys, ...overrides } = projectAiExceptions(stored, ownKeys);
      const authority = await projectSpendAuthority(workspaceId, project.id, actorId, now);
      projects.push({
        projectId: project.id,
        name: project.name,
        routingMode: routingModeOf(stored),
        ownKeys,
        overrides,
        spendingAuthority: authority.state === "not_set" ? "none" : authority.state,
      });
    } catch (error) {
      // One unreadable project must not hide the others; it is left out and
      // reported to the caller for logging (the error text never reaches the answer).
      onFailure?.(project.id, error);
    }
  }
  return { routingApplied: aiDefaultsEnabled(), projects };
}
