import { APIError } from "better-auth/api";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import {
  authDb,
  Prisma,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { recordGrantEvent } from "./events.ts";
import type { McpAuthDeps, McpHookDeps } from "./plugins.ts";

// MCP grants (Track M, WP-M1): which workspace, projects and scopes a user
// gave an MCP client. A grant only narrows what the user may do in the UI; it
// holds no business logic.
//
// Lifecycle:
// - The selection on /connect is a grant row bound to the browser session
//   (`sessionId`). Without an active grant for (user, client, workspace) it is
//   `pending` for SELECTION_TTL_SECONDS and an accepted consent activates it.
//   With an active grant the selection replaces it at once (the stored consent
//   usually covers the request, so Better Auth skips the consent page).
// - Issuing the authorization code consumes the selection: `sessionId` is
//   cleared, so a later authorization in the same session selects again.
// - Revocation (Task 5) and denial set `revoked`; rows are never deleted here.

/** The signed OAuth query and the authorization code share this lifetime (codeExpiresIn). */
export const SELECTION_TTL_SECONDS = 600;

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
 * otherwise creates a pending grant and drops any stale stored consent for
 * that reference, so the consent step runs.
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
      // Without an active grant a stored consent for this reference is stale.
      await tx.oauthConsent.deleteMany({
        where: {
          clientId: input.clientId,
          userId: input.userId,
          referenceId: input.workspaceId,
        },
      });
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
 * The workspace of this session's current selection for the client; Better
 * Auth's consent reference. Idempotent: it is asked up to three times per
 * authorization.
 */
export async function pendingReference(sessionId: string, clientId: string) {
  return (await currentSelection(authDb, sessionId, clientId))?.workspaceId;
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
      if (own.status === "active") {
        const reference = {
          clientId: input.clientId,
          userId: input.userId,
          referenceId: own.workspaceId,
        };
        await tx.oauthConsent.deleteMany({ where: reference });
        await tx.oauthRefreshToken.deleteMany({ where: reference });
      }
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

/** The authorization code was issued: the session's selection for the client is used up. */
export async function consumeSelection(input: {
  sessionId: string;
  clientId: string;
}) {
  await authDb.mcpGrant.updateMany({
    where: { sessionId: input.sessionId, clientId: input.clientId },
    data: { sessionId: null },
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

/** Grant bookkeeping for the provider's consent, code and refresh events. */
export function grantHookDeps(): McpHookDeps {
  return {
    onConsent: async ({ userId, sessionId, accepted, scope }) => {
      const request = await providerRequest();
      if (!request) throw setWorkspace();
      const { clientId } = request;
      if (!accepted) return denyGrant({ userId, sessionId, clientId });
      const scopes = (scope ?? request.scope ?? "").split(" ").filter(Boolean);
      try {
        await activateGrant({ userId, sessionId, clientId, scopes });
      } catch (error) {
        // Inside a Better Auth hook only an APIError becomes an OAuth answer.
        if (error instanceof DomainError && error.code === "NO_SELECTION")
          throw setWorkspace();
        if (error instanceof DomainError && error.code === "GRANT_CONFLICT")
          throw new APIError("CONFLICT", {
            error: "grant_conflict",
            error_description: "another authorization changed this grant",
          });
        throw error;
      }
    },
    onCodeIssued: async ({ sessionId }) => {
      const request = await providerRequest();
      if (request)
        await consumeSelection({ sessionId, clientId: request.clientId });
    },
    onRefreshReplay: recordRefreshReplay,
  };
}
