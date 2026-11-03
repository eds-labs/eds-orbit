import { randomUUID } from "node:crypto";
import { authDb } from "../../../../packages/db/src/index.ts";
import { createConnection, grantConnection } from "../../src/platform/administration/connections.ts";
import type { createSocialProject } from "./social-project.ts";

type Project = Awaited<ReturnType<typeof createSocialProject>>;

export const X_APP_SECRET = { clientId: "client-1-abcdef", clientSecret: "x-client-secret-0123456789" };
export const META_APP_SECRET = { appId: "1234567890", appSecret: "meta-app-secret-0123456789", configId: "9876543210" };

/**
 * A developer app (ADR 0020) created by a synthetic administrator and
 * granted to the project's organization and the project, as the
 * administration does it. Returns the connection id and a cleanup.
 */
export async function grantSocialApp(project: Project, provider: "social.app.x" | "social.app.meta", secret: object) {
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const connection = await createConnection(admin, {
    provider,
    label: `Synthetic ${provider}`,
    config: {},
    secret: JSON.stringify(secret),
  });
  for (const projectId of [undefined, project.owner.projectId])
    await grantConnection(admin, connection.id, {
      workspaceId: project.owner.workspaceId,
      ...(projectId ? { projectId } : {}),
      purposes: ["social_oauth"],
      modules: ["social"],
    });
  return {
    connectionId: connection.id,
    cleanup: () => authDb.connection.deleteMany({ where: { id: connection.id } }),
  };
}

/** Removes the project's social account connections (module-managed). */
export function removeProjectConnections(project: Project) {
  return authDb.connection.deleteMany({ where: { projectId: project.owner.projectId } });
}
