import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { fromNodeHeaders, type Auth } from "../tenancy/auth.ts";
import { DomainError } from "../shared.ts";
import { systemMailConfigured } from "../email/system-mail.ts";
import {
  organizationManagerFor,
  projectManagerFor,
  systemAdminFor,
} from "./authz.ts";
import {
  listOrganizations,
  listProjects,
  listSystemAudit,
  listUsers,
  openInvitations,
  organizationDetail,
  overview,
  userDetail,
} from "./queries.ts";
import {
  removeProjectMember,
  removeWorkspaceMember,
  setProjectMember,
  setWorkspaceRole,
  type Actor,
} from "./memberships.ts";
import {
  deactivateUser,
  reactivateUser,
  revokeUserSessions,
  setSystemRole,
  systemRoleInput,
} from "./users.ts";
import {
  acceptInvitation,
  createInvitation,
  invitationEmail,
  resendInvitation,
  revokeInvitation,
  viewInvitation,
} from "./invitations.ts";
import { createOrganization, renameOrganization } from "./organizations.ts";
import { adminPasswordReset } from "../account/service.ts";

// System administration, organization settings, project member management
// and invitation acceptance (ADR 0012). Every handler authorizes from the
// session and current database state; nothing in the request grants
// access. 404 while ORBIT_ADMINISTRATION is off (server onRequest hook).

/** Route patterns that exist only while ORBIT_ADMINISTRATION is on. */
export function isAdministrationRoute(url: string) {
  return (
    url.startsWith("/api/admin/") ||
    url.startsWith("/api/organizations/") ||
    url.startsWith("/api/invitations/") ||
    url === "/api/projects/:projectId/members/:userId" ||
    url.startsWith("/api/projects/:projectId/invitations")
  );
}

type Deps = {
  /** Worker and queue state for the dashboard (modules/runtime.ts). */
  runtimeHealth: () => Promise<{ worker: string; lastHeartbeat: string | null }>;
};

const param = (req: FastifyRequest, name: string) =>
  z
    .string()
    .min(1)
    .max(100)
    .parse((req.params as Record<string, string>)[name]);
const uuidParam = (req: FastifyRequest, name: string) =>
  z.uuid().parse((req.params as Record<string, string>)[name]);

function setCookies(reply: FastifyReply, cookies: string[]) {
  if (cookies.length) reply.header("set-cookie", cookies);
}

/** The acting administrator's password for a sensitive change (step-up). */
async function confirmPassword(auth: Auth, req: FastifyRequest, password: string) {
  try {
    await auth.api.verifyPassword({
      body: { password },
      headers: fromNodeHeaders(req.headers),
    });
  } catch {
    throw new DomainError("INVALID_PASSWORD", 403);
  }
}

export function registerAdministrationRoutes(
  app: FastifyInstance,
  auth: Auth,
  deps: Deps,
) {
  const admin = (req: FastifyRequest) => systemAdminFor(auth, req);
  const adminActor = async (req: FastifyRequest): Promise<Actor> => ({
    userId: (await admin(req)).userId,
    kind: "admin",
  });

  // System administration: overview and metadata.
  app.get("/api/admin/overview", async (req) => {
    await admin(req);
    const [counts, runtime] = await Promise.all([
      overview(),
      deps.runtimeHealth(),
    ]);
    return {
      ...counts,
      system: {
        // This answer itself read the database.
        database: "ok",
        worker: runtime.worker,
        lastHeartbeat: runtime.lastHeartbeat,
        systemMail: systemMailConfigured() ? "configured" : "missing",
        version: process.env.ORBIT_VERSION ?? process.env.npm_package_version ?? null,
      },
    };
  });
  app.get("/api/admin/users", async (req) => {
    await admin(req);
    return listUsers(req.query);
  });
  app.get("/api/admin/users/:userId", async (req) => {
    await admin(req);
    return userDetail(param(req, "userId"));
  });
  app.post("/api/admin/users/:userId/deactivate", async (req) => {
    const { userId } = await admin(req);
    return deactivateUser(userId, param(req, "userId"), req.body);
  });
  app.post("/api/admin/users/:userId/reactivate", async (req) => {
    const { userId } = await admin(req);
    return reactivateUser(userId, param(req, "userId"));
  });
  app.post("/api/admin/users/:userId/sessions/revoke", async (req) => {
    const { userId } = await admin(req);
    return revokeUserSessions(userId, param(req, "userId"));
  });
  app.post("/api/admin/users/:userId/password-reset", async (req) => {
    const { userId } = await admin(req);
    return adminPasswordReset(auth, userId, param(req, "userId"));
  });
  app.put("/api/admin/users/:userId/system-role", async (req) => {
    const { userId } = await admin(req);
    const input = systemRoleInput.parse(req.body);
    await confirmPassword(auth, req, input.password);
    return setSystemRole(userId, param(req, "userId"), input.role);
  });
  app.get("/api/admin/organizations", async (req) => {
    await admin(req);
    return listOrganizations(req.query);
  });
  app.post("/api/admin/organizations", async (req, reply) => {
    const actor = await adminActor(req);
    return reply.code(201).send(await createOrganization(actor, req.body));
  });
  app.get("/api/admin/projects", async (req) => {
    await admin(req);
    return listProjects(req.query);
  });
  app.get("/api/admin/invitations", async (req) => {
    await admin(req);
    return { items: await openInvitations() };
  });
  app.get("/api/admin/audit", async (req) => {
    await admin(req);
    return listSystemAudit(req.query);
  });

  // Organization management: system administrators and the owners.
  const manager = (req: FastifyRequest) =>
    organizationManagerFor(auth, req, uuidParam(req, "workspaceId"));
  const org = "/api/organizations/:workspaceId";
  app.get(org, async (req) => {
    await manager(req);
    return organizationDetail(uuidParam(req, "workspaceId"));
  });
  app.patch(org, async (req) =>
    renameOrganization(
      await manager(req),
      uuidParam(req, "workspaceId"),
      req.body,
    ),
  );
  app.put(`${org}/members/:userId`, async (req) =>
    setWorkspaceRole(
      await manager(req),
      uuidParam(req, "workspaceId"),
      param(req, "userId"),
      req.body,
    ),
  );
  app.delete(`${org}/members/:userId`, async (req, reply) => {
    await removeWorkspaceMember(
      await manager(req),
      uuidParam(req, "workspaceId"),
      param(req, "userId"),
    );
    return reply.code(204).send();
  });
  app.put(`${org}/projects/:projectId/members/:userId`, async (req) =>
    setProjectMember(
      await manager(req),
      {
        workspaceId: uuidParam(req, "workspaceId"),
        projectId: uuidParam(req, "projectId"),
        userId: param(req, "userId"),
      },
      req.body,
    ),
  );
  app.delete(
    `${org}/projects/:projectId/members/:userId`,
    async (req, reply) => {
      await removeProjectMember(await manager(req), {
        workspaceId: uuidParam(req, "workspaceId"),
        projectId: uuidParam(req, "projectId"),
        userId: param(req, "userId"),
      });
      return reply.code(204).send();
    },
  );
  app.get(`${org}/invitations`, async (req) => {
    await manager(req);
    return { items: await openInvitations(uuidParam(req, "workspaceId")) };
  });
  app.post(`${org}/invitations`, async (req, reply) =>
    reply
      .code(201)
      .send(
        await createInvitation(
          await manager(req),
          uuidParam(req, "workspaceId"),
          req.body,
        ),
      ),
  );
  app.post(`${org}/invitations/:invitationId/resend`, async (req) =>
    resendInvitation(
      await manager(req),
      uuidParam(req, "workspaceId"),
      uuidParam(req, "invitationId"),
    ),
  );
  app.delete(`${org}/invitations/:invitationId`, async (req, reply) => {
    await revokeInvitation(
      await manager(req),
      uuidParam(req, "workspaceId"),
      uuidParam(req, "invitationId"),
    );
    return reply.code(204).send();
  });

  // Project owners: change and remove members, manage their invitations.
  const project = (req: FastifyRequest) =>
    projectManagerFor(auth, req, uuidParam(req, "projectId"));
  app.put("/api/projects/:projectId/members/:userId", async (req) => {
    const { scope, actor } = await project(req);
    return setProjectMember(
      actor,
      {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: param(req, "userId"),
      },
      req.body,
    );
  });
  app.delete(
    "/api/projects/:projectId/members/:userId",
    async (req, reply) => {
      const { scope, actor } = await project(req);
      await removeProjectMember(actor, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: param(req, "userId"),
      });
      return reply.code(204).send();
    },
  );
  app.get("/api/projects/:projectId/invitations", async (req) => {
    const { scope } = await project(req);
    const items = await openInvitations(scope.workspaceId);
    return {
      items: items.filter((i) =>
        i.projects.some((p) => p.id === scope.projectId),
      ),
    };
  });
  app.post(
    "/api/projects/:projectId/invitations/:invitationId/resend",
    async (req) => {
      const { scope, actor } = await project(req);
      return resendInvitation(
        actor,
        scope.workspaceId,
        uuidParam(req, "invitationId"),
        scope.projectId,
      );
    },
  );
  app.delete(
    "/api/projects/:projectId/invitations/:invitationId",
    async (req, reply) => {
      const { scope, actor } = await project(req);
      await revokeInvitation(
        actor,
        scope.workspaceId,
        uuidParam(req, "invitationId"),
        scope.projectId,
      );
      return reply.code(204).send();
    },
  );

  // Invitation links: the token travels in the body, never in a URL.
  const publicLimit = {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  };
  const tokenBody = z.object({ token: z.string().min(20).max(200) }).strict();
  app.post("/api/invitations/view", publicLimit, async (req) =>
    viewInvitation(tokenBody.parse(req.body).token),
  );
  const acceptBody = z
    .object({
      token: z.string().min(20).max(200),
      name: z.string().trim().min(1).max(100).optional(),
      password: z.string().min(12).max(128).optional(),
    })
    .strict();
  app.post("/api/invitations/accept", publicLimit, async (req, reply) => {
    const input = acceptBody.parse(req.body);
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers }).catch(() => null);
    // Signed in: the invitation must be for this account.
    if (session && !(session.user as { banned?: boolean }).banned) {
      const result = await acceptInvitation(input.token, session.user.id);
      return { ...result, signedIn: true };
    }
    if (!input.name || !input.password)
      throw new DomainError("ACCOUNT_DETAILS_REQUIRED", 400);
    const email = await invitationEmail(input.token);
    let userId: string;
    try {
      userId = (
        await auth.api.signUpEmail({
          body: { email, name: input.name, password: input.password },
        })
      ).user.id;
    } catch {
      // The address got an account meanwhile: sign in, then accept.
      throw new DomainError("ACCOUNT_EXISTS", 409);
    }
    let result;
    try {
      result = await acceptInvitation(input.token, userId);
    } catch (error) {
      // No account without the invitation it was created for.
      await authDb.user.delete({ where: { id: userId } }).catch(() => null);
      throw error;
    }
    const signIn = await auth.api.signInEmail({
      body: { email, password: input.password },
      headers,
      returnHeaders: true,
    });
    setCookies(reply, signIn.headers?.getSetCookie() ?? []);
    return { ...result, signedIn: true };
  });
}
