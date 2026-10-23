import type { FastifyInstance } from "fastify";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import { data, list, publicEntity } from "../shared.ts";
import { registeredEmailInbound } from "../modules/contributions.ts";
import {
  defaultEmailConnection,
  emailEnabled,
  emailMailboxes,
  liveSending,
} from "./connection.ts";
import { INBOUND_STATE_KIND } from "./inbound.ts";
import { lastArchiveError } from "./archive.ts";

// The owner's view of the project's mailboxes (WP4.7): each connection
// without its password, its receiving state, whether it is the default
// mailbox and how many module uses (live support inboxes) keep it from
// being removed; and whether sending is live. `connection` and `inbound`
// repeat the default mailbox for older clients. 404 while ORBIT_EMAIL is
// off (the server's onRequest hook).

export const EMAIL_ROUTE = "/api/projects/:projectId/email";

export function registerEmailRoutes(app: FastifyInstance, auth: Auth) {
  app.get(EMAIL_ROUTE, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const states = await list(tx, scope, INBOUND_STATE_KIND);
      const inboundOf = (id: string) => {
        const state = states.find((row) => data(row).connectionId === id);
        return state
          ? {
              checkedAt: data(state).checkedAt ?? null,
              lastError: data(state).lastError ?? null,
            }
          : null;
      };
      const fallback = await defaultEmailConnection(tx, scope);
      const mailboxes = [];
      for (const row of await emailMailboxes(tx, scope)) {
        let inUse = 0;
        for (const { mailboxUse } of registeredEmailInbound())
          inUse += mailboxUse ? await mailboxUse.inUse(tx, scope, row.id) : 0;
        mailboxes.push({
          connection: publicEntity(row),
          default: row.id === fallback?.id,
          inUse,
          inbound: inboundOf(row.id),
          lastArchiveError: await lastArchiveError(tx, scope, row.id),
        });
      }
      const shown = fallback ?? mailboxes[0]?.connection ?? null;
      return {
        enabled: emailEnabled(),
        live: liveSending(),
        connection: shown ? publicEntity(shown) : null,
        inbound: shown ? inboundOf(shown.id) : null,
        mailboxes,
      };
    });
  });
}
