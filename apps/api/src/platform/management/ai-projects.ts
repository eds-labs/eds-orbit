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

type AiProjectEntry = {
  projectId: string;
  name: string;
  routingMode: RoutingMode;
  ownKeys: { openai: boolean; image: boolean; anthropic: boolean };
  overrides: { models: boolean; routes: boolean; prices: boolean; providerBudgets: boolean };
  spendingAuthority: SpendingAuthorityState;
};

export type OrganizationAiProjects = {
  /** Whether the runtime applies a saved routing mode (ORBIT_AI_DEFAULTS). */
  routingApplied: boolean;
  projects: AiProjectEntry[];
  /** Projects whose read failed and that are missing from `projects` (0 normally). */
  unreadable: number;
};

/** Called with the project id and the error when one project's read throws. */
export type AiProjectReadFailure = (projectId: string, error: unknown) => void;

/** Reads one project's entry as the owner; injectable so tests can fail one read. */
export type AiProjectReader = (
  workspaceId: string,
  projectId: string,
  actorId: string,
  now: Date,
) => Promise<Omit<AiProjectEntry, "projectId" | "name">>;

export const readAiProject: AiProjectReader = async (workspaceId, projectId, actorId, now) => {
  const scope = { workspaceId, projectId, userId: actorId, role: "owner" } as Scope;
  const row = await scoped(workspaceId, projectId, (tx) => configurationRow(tx, scope));
  const stored = storedAiFields(row);
  const keys = ownAiKeys(row);
  const exceptions = projectAiExceptions(stored, keys);
  const authority = await projectSpendAuthority(workspaceId, projectId, actorId, now);
  // Listed field by field: a field added to the helpers later must not appear here by itself.
  return {
    routingMode: routingModeOf(stored),
    ownKeys: { openai: keys.openai, image: keys.image, anthropic: keys.anthropic },
    overrides: {
      models: exceptions.models,
      routes: exceptions.routes,
      prices: exceptions.prices,
      providerBudgets: exceptions.providerBudgets,
    },
    spendingAuthority: authority.state === "not_set" ? "none" : authority.state,
  };
};

export async function organizationAiProjects(
  workspaceId: string,
  actorId: string,
  now = new Date(),
  onFailure?: AiProjectReadFailure,
  read: AiProjectReader = readAiProject,
): Promise<OrganizationAiProjects> {
  const rows = await authDb.project.findMany({
    where: { workspaceId, kind: { not: "personal" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const projects: AiProjectEntry[] = [];
  let unreadable = 0;
  for (const project of rows) {
    try {
      projects.push({
        projectId: project.id,
        name: project.name,
        ...(await read(workspaceId, project.id, actorId, now)),
      });
    } catch (error) {
      // One unreadable project must not hide the others: it is left out,
      // counted, and reported for logging (its error text never reaches the answer).
      unreadable += 1;
      onFailure?.(project.id, error);
    }
  }
  return { routingApplied: aiDefaultsEnabled(), projects, unreadable };
}
