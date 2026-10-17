import type { FastifyInstance } from "fastify";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import { data, list, publicEntity } from "../shared.ts";
import { connectionsOf } from "../connections/connections.ts";
import { EMAIL_PROVIDER, emailEnabled, liveSending } from "./connection.ts";
import { INBOUND_STATE_KIND } from "./inbound.ts";

// The owner's view of the project's mailbox (WP4.7): the connection
// without its password, the receiving state and whether sending is live.
// 404 while ORBIT_EMAIL is off (the server's onRequest hook).

export const EMAIL_ROUTE = "/api/projects/:projectId/email";

export function registerEmailRoutes(app: FastifyInstance, auth: Auth) {
  app.get(EMAIL_ROUTE, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const connection = (await connectionsOf(tx, scope, EMAIL_PROVIDER)).at(
        -1,
      );
      const state = connection
        ? (await list(tx, scope, INBOUND_STATE_KIND)).find(
            (row) => data(row).connectionId === connection.id,
          )
        : undefined;
      return {
        enabled: emailEnabled(),
        live: liveSending(),
        connection: connection ? publicEntity(connection) : null,
        inbound: state
          ? {
              checkedAt: data(state).checkedAt ?? null,
              lastError: data(state).lastError ?? null,
            }
          : null,
      };
    });
  });
}
