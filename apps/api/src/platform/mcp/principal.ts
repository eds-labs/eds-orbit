/**
 * Who an MCP call acts for (Track M, WP-M2, plans/orbit-modularization/09
 * §4.2): the verified access-token claims narrowed by the user's active grant
 * and current memberships. A grant only narrows what the user may do in the
 * UI; nothing here widens it. The token itself (signature, `iss`, `aud`,
 * `exp`) is verified before these functions run.
 */
import type { JWTPayload } from "better-auth";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { activeGrantForToken, grantableWorkspace } from "../mcp-auth/grants.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../mcp-auth/plugins.ts";
import { actorScope } from "../tenancy/member-scope.ts";

export type McpPrincipal = {
  userId: string;
  clientId: string;
  grantId: string;
  workspaceId: string;
  /** Token `scope` ∩ grant scopes. */
  scopes: ReadonlySet<string>;
  /** Granted projects the user is still a member of, at resolution time. */
  projectIds: readonly string[];
  /** The grant's module restriction; empty means no restriction. */
  modules: readonly string[];
};

/** Membership checks resolvePrincipal runs at once (one query each). */
export const MEMBERSHIP_CHECK_CONCURRENCY = 4;

/**
 * Maps the items with at most `limit` calls in flight, keeping input order:
 * a grant over many projects never fans out an unbounded number of queries.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}

/** Scopes that let a principal call anything at all. */
const ORBIT_SCOPES = ["orbit:read", "orbit:propose", "orbit:write"];

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The principal behind verified claims, resolved again for every request:
 * the active, unexpired grant for (sub, azp, workspace claim) whose user is
 * still a workspace member; token scopes intersected with the grant's; the
 * granted projects (or, for "all current projects", the user's current
 * projects in the workspace) kept only where the user is still a member.
 * Null when no grant matches or no Orbit scope or project remains.
 */
export async function resolvePrincipal(
  claims: JWTPayload,
): Promise<McpPrincipal | null> {
  const userId = text(claims.sub);
  const clientId = text(claims.azp);
  const grant = await activeGrantForToken({
    sub: userId,
    azp: clientId,
    [ORBIT_WORKSPACE_CLAIM]: text(claims[ORBIT_WORKSPACE_CLAIM]),
  });
  if (!grant) return null;
  if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) return null;

  const granted = new Set(grant.scopes);
  const scopes = new Set(
    text(claims.scope)
      .split(" ")
      .filter((scope) => scope && granted.has(scope)),
  );
  if (!ORBIT_SCOPES.some((scope) => scopes.has(scope))) return null;

  const candidates = grant.allCurrentProjects
    ? ((await grantableWorkspace(userId, grant.workspaceId))?.projects.map(
        (project) => project.id,
      ) ?? [])
    : [...new Set(grant.projectIds)];
  // Every project is checked against the user's membership in the grant's
  // workspace (actorScope via projectMembership, SECURITY_REVIEW O-6), a few
  // at a time.
  const kept = await mapBounded(
    candidates,
    MEMBERSHIP_CHECK_CONCURRENCY,
    async (projectId) =>
      (await actorScope(grant.workspaceId, projectId, userId))
        ? projectId
        : null,
  );
  const projectIds = kept.filter((id): id is string => id !== null);
  if (!projectIds.length) return null;

  return {
    userId,
    clientId,
    grantId: grant.id,
    workspaceId: grant.workspaceId,
    scopes,
    projectIds,
    modules: [...grant.modules],
  };
}

/**
 * The user's scope in one of the principal's projects, read again on every
 * call. 404 NOT_FOUND when the project is outside the principal or the
 * membership is gone; the answer never tells whether such a project exists.
 */
export async function projectScope(
  principal: McpPrincipal,
  projectId: string,
): Promise<Scope> {
  if (!principal.projectIds.includes(projectId))
    throw new DomainError("NOT_FOUND", 404);
  const scope = await actorScope(
    principal.workspaceId,
    projectId,
    principal.userId,
  );
  if (!scope) throw new DomainError("NOT_FOUND", 404);
  return scope;
}
