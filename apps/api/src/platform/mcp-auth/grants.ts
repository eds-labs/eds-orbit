import { APIError } from "better-auth/api";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import {
  authDb,
  Prisma,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { recordGrantEvent } from "./events.ts";
import {
  ORBIT_WORKSPACE_CLAIM,
  PENDING_REFERENCE_PREFIX,
  type McpAuthDeps,
  type McpHookDeps,
} from "./plugins.ts";

// MCP grants (Track M, WP-M1): which workspace, projects and scopes a user
// gave an MCP client. A grant only narrows what the user may do in the UI; it
// holds no business logic.
//
// Lifecycle:
// - The selection on /connect is a grant row bound to the browser session
//   (`sessionId`). Without an active grant for (user, client, workspace) it is
//   `pending` for SELECTION_TTL_SECONDS and an accepted consent activates it
//   (before the provider stores the consent and issues the code). With an
//   active grant the selection replaces it at once (the stored consent usually
//   covers the request, so Better Auth skips the consent page).
// - A code is only issued for an active selection: a pending one answers the
//   consent reference with a placeholder no consent is stored under, so the
//   consent page always runs, and a code seen for anything but an active
//   selection is withheld.
// - Issuing the authorization code consumes the selection: `sessionId` is
//   cleared, so a later authorization in the same session selects again.
// - Revocation and denial set `revoked`; grant rows are never deleted here.
//   Invariant: stored consent and refresh tokens for (user, client, workspace)
//   exist only while an active grant does, so every path that ends an active
//   grant also deletes them (`dropStoredAuthorization`).

/** The signed OAuth query and the authorization code share this lifetime (codeExpiresIn). */
export const SELECTION_TTL_SECONDS = 600;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

type Db = DbTx | typeof authDb;
export type ProjectSelection = string[] | "all_current";

const ttlStart = (now: Date) =>
  new Date(now.getTime() - SELECTION_TTL_SECONDS * 1000);

/** Projects of a workspace the user may grant: all for owners, memberships otherwise. */
async function grantableWorkspace(userId: string, workspaceId: string) {
  const membership = await authDb.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership) return null;
  const projects = await authDb.project.findMany({
    where: {
      workspaceId,
      ...(membership.role === "owner" ? {} : { members: { some: { userId } } }),
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return { role: membership.role, projects };
}

/** The workspaces offered on /connect, each with the projects the user may grant. */
export async function connectWorkspaces(userId: string) {
  const memberships = await authDb.workspaceMember.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: [{ workspace: { name: "asc" } }, { workspaceId: "asc" }],
  });
  return Promise.all(
    memberships.map(async (m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      projects: (await grantableWorkspace(userId, m.workspaceId))!.projects,
    })),
  );
}

/** The newest unconsumed selection of this session for this client, if still within the TTL. */
async function currentSelection(
  db: Db,
  sessionId: string,
  clientId: string,
  now = new Date(),
) {
  return db.mcpGrant.findFirst({
    where: {
      sessionId,
      clientId,
      status: { in: ["pending", "active"] },
      createdAt: { gt: ttlStart(now) },
    },
    orderBy: { createdAt: "desc" },
  });
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

/**
 * Records the workspace/project selection for the client named by the signed
 * OAuth query. Replaces an active grant for (user, client, workspace) at once;
 * otherwise creates a pending grant, which the consent step must activate.
 */
export async function recordSelection(input: {
  userId: string;
  sessionId: string;
  clientId: string;
  workspaceId: string;
  projectIds: ProjectSelection;
  modules?: string[];
}) {
  const access = await grantableWorkspace(input.userId, input.workspaceId);
  if (!access) throw new DomainError("NOT_FOUND", 404);
  if (!access.projects.length) throw new DomainError("NO_PROJECTS", 409);
  const allCurrentProjects = input.projectIds === "all_current";
  const projectIds = allCurrentProjects ? [] : [...new Set(input.projectIds)];
  if (!allCurrentProjects && !projectIds.length)
    throw new DomainError("VALIDATION_FAILED", 400);
  const allowed = new Set(access.projects.map((p) => p.id));
  if (projectIds.some((id) => !allowed.has(id)))
    throw new DomainError("NOT_FOUND", 404);

  const now = new Date();
  const base = {
    userId: input.userId,
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    projectIds,
    allCurrentProjects,
    modules: input.modules ?? [],
    sessionId: input.sessionId,
    createdAt: now,
  };
  const selectedDetail = {
    allCurrentProjects,
    projectIds,
  };
  try {
    return await authDb.$transaction(async (tx) => {
      const active = await tx.mcpGrant.findFirst({
        where: {
          userId: input.userId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          status: "active",
        },
      });
      if (active) {
        await tx.mcpGrant.update({
          where: { id: active.id },
          data: { status: "revoked", revokedAt: now, revokedBy: "replaced" },
        });
        const grant = await tx.mcpGrant.create({
          data: {
            ...base,
            status: "active",
            scopes: active.scopes,
            activatedAt: now,
          },
        });
        const event = {
          userId: input.userId,
          clientId: input.clientId,
          grantId: grant.id,
          workspaceId: input.workspaceId,
        };
        await recordGrantEvent(
          { ...event, action: "grant.selected", detail: selectedDetail },
          tx,
        );
        await recordGrantEvent(
          {
            ...event,
            action: "grant.activated",
            detail: { replaced: active.id },
          },
          tx,
        );
        return grant;
      }
      const grant = await tx.mcpGrant.create({
        data: {
          ...base,
          status: "pending",
          scopes: [],
          expiresAt: new Date(now.getTime() + SELECTION_TTL_SECONDS * 1000),
        },
      });
      await recordGrantEvent(
        {
          action: "grant.selected",
          userId: input.userId,
          clientId: input.clientId,
          grantId: grant.id,
          workspaceId: input.workspaceId,
          detail: selectedDetail,
        },
        tx,
      );
      return grant;
    });
  } catch (error) {
    // A concurrent selection activated a grant for the same reference first.
    if (isUniqueViolation(error)) throw new DomainError("GRANT_CONFLICT", 409);
    throw error;
  }
}

/**
 * Better Auth's consent reference for this session's current selection: the
 * workspace when the selection is an active grant, otherwise a placeholder
 * under which no consent is ever stored, so the consent page runs instead of
 * a code being issued. Undefined without a selection. Idempotent: it is asked
 * up to three times per authorization.
 */
export async function pendingReference(sessionId: string, clientId: string) {
  const selection = await currentSelection(authDb, sessionId, clientId);
  if (!selection) return undefined;
  return selection.status === "active"
    ? selection.workspaceId
    : `${PENDING_REFERENCE_PREFIX}${selection.id}`;
}

/** Whether this session holds an unconsumed selection for the client. */
export async function hasCurrentSelection(sessionId: string, clientId: string) {
  return Boolean(await currentSelection(authDb, sessionId, clientId));
}

/**
 * Applies an accepted consent: a pending selection becomes the one active
 * grant for (user, client, workspace) with the accepted scopes; an active one
 * (the selection replaced a grant) takes the accepted scopes.
 */
export async function activateGrant(input: {
  userId: string;
  sessionId: string;
  clientId: string;
  scopes: string[];
}) {
  const now = new Date();
  try {
    return await authDb.$transaction(async (tx) => {
      const selection = await currentSelection(
        tx,
        input.sessionId,
        input.clientId,
        now,
      );
      if (!selection || selection.userId !== input.userId)
        throw new DomainError("NO_SELECTION", 409);
      const event = {
        userId: input.userId,
        clientId: input.clientId,
        grantId: selection.id,
        workspaceId: selection.workspaceId,
      };
      if (selection.status === "active") {
        const grant = await tx.mcpGrant.update({
          where: { id: selection.id },
          data: { scopes: input.scopes },
        });
        await recordGrantEvent(
          { ...event, action: "grant.activated", detail: { updated: true } },
          tx,
        );
        return grant;
      }
      const previous = await tx.mcpGrant.findFirst({
        where: {
          userId: input.userId,
          clientId: input.clientId,
          workspaceId: selection.workspaceId,
          status: "active",
        },
      });
      if (previous)
        await tx.mcpGrant.update({
          where: { id: previous.id },
          data: { status: "revoked", revokedAt: now, revokedBy: "replaced" },
        });
      const grant = await tx.mcpGrant.update({
        where: { id: selection.id },
        data: {
          status: "active",
          scopes: input.scopes,
          activatedAt: now,
          expiresAt: null,
        },
      });
      await recordGrantEvent(
        {
          ...event,
          action: "grant.activated",
          detail: previous ? { replaced: previous.id } : {},
        },
        tx,
      );
      return grant;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("GRANT_CONFLICT", 409);
    throw error;
  }
}

/**
 * Deletes what lets a client act for (user, workspace): the stored consent,
 * the refresh tokens and any stored access tokens. Deleting the refresh rows
 * also drops the cached reuse-window replay response, so a token rotated a
 * moment ago cannot be replayed after this.
 */
async function dropStoredAuthorization(
  tx: DbTx,
  input: { userId: string; clientId: string; workspaceId: string },
) {
  const reference = {
    clientId: input.clientId,
    userId: input.userId,
    referenceId: input.workspaceId,
  };
  await tx.oauthConsent.deleteMany({ where: reference });
  await tx.oauthRefreshToken.deleteMany({ where: reference });
  await tx.oauthAccessToken.deleteMany({ where: reference });
}

/**
 * Applies a denied consent: the current selection is revoked as `denied`
 * (also when it had replaced an active grant, together with that reference's
 * stored consent and refresh tokens), so it can never become active.
 */
export async function denyGrant(input: {
  userId: string;
  sessionId: string;
  clientId: string;
}) {
  const now = new Date();
  await authDb.$transaction(async (tx) => {
    const selection = await currentSelection(
      tx,
      input.sessionId,
      input.clientId,
      now,
    );
    const own = selection?.userId === input.userId ? selection : null;
    if (own) {
      await tx.mcpGrant.update({
        where: { id: own.id },
        data: {
          status: "revoked",
          revokedAt: now,
          revokedBy: "denied",
          sessionId: null,
        },
      });
      if (own.status === "active")
        await dropStoredAuthorization(tx, {
          userId: input.userId,
          clientId: input.clientId,
          workspaceId: own.workspaceId,
        });
    }
    await recordGrantEvent(
      {
        action: "grant.denied",
        userId: input.userId,
        clientId: input.clientId,
        ...(own ? { grantId: own.id, workspaceId: own.workspaceId } : {}),
      },
      tx,
    );
  });
}

/**
 * The authorization code was issued: the session's selection for the client
 * is used up. Only an active selection may end in a code; anything else is
 * refused (the caller withholds the code). Older pending selections of the
 * same session and client are closed as `superseded`.
 */
export async function consumeSelection(input: {
  sessionId: string;
  clientId: string;
}) {
  const now = new Date();
  return authDb.$transaction(async (tx) => {
    const selection = await currentSelection(
      tx,
      input.sessionId,
      input.clientId,
      now,
    );
    if (selection?.status !== "active") return false;
    await tx.mcpGrant.update({
      where: { id: selection.id },
      data: { sessionId: null },
    });
    await tx.mcpGrant.updateMany({
      where: {
        sessionId: input.sessionId,
        clientId: input.clientId,
        status: "pending",
      },
      data: {
        status: "revoked",
        revokedAt: now,
        revokedBy: "superseded",
        sessionId: null,
      },
    });
    return true;
  });
}

/** A rotated refresh token was presented after the reuse window (the library revoked the family). */
export async function recordRefreshReplay(input: {
  userId: string;
  clientId: string;
  referenceId?: string;
  error: string;
}) {
  const workspaceId =
    input.referenceId && /^[\da-f-]{36}$/i.test(input.referenceId)
      ? input.referenceId
      : undefined;
  await recordGrantEvent({
    action: "token.refresh_replay",
    userId: input.userId,
    clientId: input.clientId,
    ...(workspaceId ? { workspaceId } : {}),
    detail: { error: input.error },
  });
}

/**
 * The client and requested scope of the authorization Better Auth is handling, from
 * its request state (the verified signed query, or the authorize parameters).
 * Null outside an OAuth request.
 */
async function providerRequest() {
  let state: Awaited<ReturnType<typeof getOAuthProviderState>>;
  try {
    state = await getOAuthProviderState();
  } catch {
    return null;
  }
  const query = new URLSearchParams(state?.query ?? "");
  const clientId = query.get("client_id");
  if (!clientId) return null;
  return {
    clientId,
    scope: query.get("scope") ?? undefined,
  };
}

const setWorkspace = () =>
  new APIError("BAD_REQUEST", {
    error: "set_workspace",
    error_description: "select a workspace first",
  });

/**
 * Better Auth's post-login callbacks backed by Orbit's grants. Both decide
 * from Orbit's own selection state (never from `isContinuation`, which the
 * client controls) and fail closed outside an OAuth request.
 */
export function grantPostLogin(): Pick<
  McpAuthDeps,
  "shouldRedirect" | "consentReference"
> {
  return {
    // The selection page is shown until this session has an unconsumed
    // selection for this client; issuing the code consumes it, so the next
    // authorization selects again and a selection never carries over to
    // another client. The provider's request state names the client.
    shouldRedirect: async ({ session }) => {
      const request = await providerRequest();
      if (!request) return true;
      return !(await hasCurrentSelection(session.id, request.clientId));
    },
    consentReference: async ({ session }) => {
      const request = await providerRequest();
      const reference = request
        ? await pendingReference(session.id, request.clientId)
        : undefined;
      if (!reference) throw setWorkspace();
      return reference;
    },
  };
}

const grantConflict = () =>
  new APIError("CONFLICT", {
    error: "grant_conflict",
    error_description: "another authorization changed this grant",
  });

/** Grant bookkeeping for the provider's consent, code and refresh events. */
export function grantHookDeps(): McpHookDeps {
  return {
    onConsentAccepted: async (input) => {
      try {
        await activateGrant(input);
      } catch (error) {
        // Inside a Better Auth hook only an APIError becomes an OAuth answer.
        if (error instanceof DomainError && error.code === "NO_SELECTION")
          throw setWorkspace();
        if (error instanceof DomainError && error.code === "GRANT_CONFLICT")
          throw grantConflict();
        throw error;
      }
    },
    onConsentDenied: async ({ userId, sessionId }) => {
      const request = await providerRequest();
      if (!request) throw setWorkspace();
      await denyGrant({ userId, sessionId, clientId: request.clientId });
    },
    // False (the hook withholds the code) unless the selection is active.
    onCodeIssued: async ({ sessionId }) => {
      const request = await providerRequest();
      return request
        ? consumeSelection({ sessionId, clientId: request.clientId })
        : false;
    },
    onRefreshReplay: recordRefreshReplay,
  };
}

/**
 * Revokes an active grant. Allowed for the grant's own user and for an owner
 * of its workspace. A grant that does not exist, is not active (already
 * revoked, denied or pending) or whose workspace the actor does not belong to
 * answers NOT_FOUND (404; revoking twice is not idempotent on purpose, so the
 * answer never tells outsiders which ids exist); a member who is neither the
 * grant's user nor an owner gets FORBIDDEN (403). The status change, the
 * stored authorization and the audit event share one transaction, so the
 * client fails on its very next call, also inside the refresh reuse window.
 */
export async function revokeGrant(
  actor: { userId: string },
  grantId: string,
): Promise<void> {
  if (!UUID.test(grantId)) throw new DomainError("NOT_FOUND", 404);
  const now = new Date();
  await authDb.$transaction(async (tx) => {
    const grant = await tx.mcpGrant.findFirst({
      where: { id: grantId, status: "active" },
    });
    if (!grant) throw new DomainError("NOT_FOUND", 404);
    const own = grant.userId === actor.userId;
    if (!own) {
      const membership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: grant.workspaceId,
            userId: actor.userId,
          },
        },
      });
      if (!membership) throw new DomainError("NOT_FOUND", 404);
      if (membership.role !== "owner") throw new DomainError("FORBIDDEN", 403);
    }
    // The guard on status keeps a concurrent revocation from writing twice.
    const changed = await tx.mcpGrant.updateMany({
      where: { id: grant.id, status: "active" },
      data: {
        status: "revoked",
        revokedAt: now,
        revokedBy: actor.userId,
        sessionId: null,
      },
    });
    if (!changed.count) throw new DomainError("NOT_FOUND", 404);
    await dropStoredAuthorization(tx, grant);
    await recordGrantEvent(
      {
        action: "grant.revoked",
        userId: grant.userId,
        clientId: grant.clientId,
        grantId: grant.id,
        workspaceId: grant.workspaceId,
        detail: { by: own ? "user" : "owner" },
      },
      tx,
    );
  });
}

export type GrantRow = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  userEmail: string;
  workspaceId: string;
  projectIds: string[];
  allCurrentProjects: boolean;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
};

/**
 * Active grants as listed on the settings page: `mine` is the viewer's own;
 * `workspaceId` is every user's grants in that workspace, for its owners only
 * (FORBIDDEN for other members, NOT_FOUND for non-members). Rows carry
 * identifiers and display names only, never token or code values.
 */
export async function listGrants(
  viewer: { userId: string },
  filter: { mine: true } | { workspaceId: string },
): Promise<GrantRow[]> {
  if ("workspaceId" in filter) {
    const membership = UUID.test(filter.workspaceId)
      ? await authDb.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: filter.workspaceId,
              userId: viewer.userId,
            },
          },
        })
      : null;
    if (!membership) throw new DomainError("NOT_FOUND", 404);
    if (membership.role !== "owner") throw new DomainError("FORBIDDEN", 403);
  }
  const grants = await authDb.mcpGrant.findMany({
    where: {
      status: "active",
      ...("workspaceId" in filter
        ? { workspaceId: filter.workspaceId }
        : { userId: viewer.userId }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  if (!grants.length) return [];
  const [clients, users] = await Promise.all([
    authDb.oauthClient.findMany({
      where: { clientId: { in: [...new Set(grants.map((g) => g.clientId))] } },
      select: { clientId: true, name: true },
    }),
    authDb.user.findMany({
      where: { id: { in: [...new Set(grants.map((g) => g.userId))] } },
      select: { id: true, email: true },
    }),
  ]);
  const clientNames = new Map(clients.map((c) => [c.clientId, c.name]));
  const emails = new Map(users.map((u) => [u.id, u.email]));
  return grants.map((g) => ({
    id: g.id,
    clientId: g.clientId,
    clientName: clientNames.get(g.clientId) || g.clientId,
    userId: g.userId,
    userEmail: emails.get(g.userId) ?? "",
    workspaceId: g.workspaceId,
    projectIds: g.projectIds,
    allCurrentProjects: g.allCurrentProjects,
    scopes: g.scopes,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
  }));
}

/**
 * The grant behind a verified access token, for the gateway to call on every
 * request: the active grant for (sub, azp, workspace claim) whose user still
 * belongs to that workspace, else null. Claims are taken as the verified JWT
 * gives them; a missing or empty workspace claim never matches. It does not
 * touch `lastUsedAt`: a write per request is the gateway's call (WP-M2).
 */
export async function activeGrantForToken(claims: {
  sub: string;
  azp: string;
  [ORBIT_WORKSPACE_CLAIM]?: string | null;
}) {
  const workspaceId = claims[ORBIT_WORKSPACE_CLAIM];
  if (
    !claims.sub ||
    !claims.azp ||
    typeof workspaceId !== "string" ||
    !UUID.test(workspaceId)
  )
    return null;
  const grant = await authDb.mcpGrant.findFirst({
    where: {
      userId: claims.sub,
      clientId: claims.azp,
      workspaceId,
      status: "active",
    },
  });
  if (!grant) return null;
  const membership = await authDb.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: claims.sub } },
  });
  return membership ? grant : null;
}
