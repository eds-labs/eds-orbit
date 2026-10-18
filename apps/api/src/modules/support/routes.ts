import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { requireSupport } from "./gate.ts";
import {
  archiveInbox,
  createInbox,
  listInboxes,
  rotateWidgetSecret,
  updateInbox,
} from "./inboxes.ts";
import {
  SUPPORT_CONTACTS_MANAGE,
  SUPPORT_NOTES_WRITE,
  SUPPORT_SETTINGS_MANAGE,
  SUPPORT_STATS_READ,
  SUPPORT_TICKETS_ASSIGN,
  SUPPORT_TICKETS_READ,
  SUPPORT_TICKETS_REPLY,
} from "./permissions.ts";
import { supportAgents } from "./agents.ts";
import { statsCsv, supportStats } from "./stats.ts";
import { eraseContact, exportContact } from "./privacy.ts";
import { enableWidgetKey } from "./widget.ts";
import {
  contactDetail,
  listContacts,
  listTickets,
  mergeContact,
  mergeTicket,
  noteOnTicket,
  replyToTicket,
  ticketDetail,
  ticketSummary,
  requestDraft,
  updateContact,
  updateTicket,
} from "./workspace.ts";
import { supportSettingsDefaults, supportSettingsSchema } from "./settings.ts";

const BASE = "/api/projects/:projectId/support";
const inboxId = z.uuid();
const recordId = z.uuid();
const settingsInput = z
  .object({ settings: z.unknown(), version: z.number().int().min(1) })
  .strict();

type Params = {
  projectId: string;
  inboxId?: string;
  ticketId?: string;
  contactId?: string;
};

/**
 * Runs a support handler: the member's permission in the module first, then
 * the support gate and the work in one project transaction.
 */
async function inSupport<T>(
  auth: Auth,
  req: Parameters<typeof scopeFor>[1],
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSupport(tx, scope);
    return work(tx, scope, params);
  });
}

/** Support settings, inboxes (WP5.1) and the agent workspace (WP5.2). */
export const supportRoutes: RoutesContribution = ({ app, auth }) => {
  const ticket = (p: Params) => recordId.parse(p.ticketId);
  const contact = (p: Params) => recordId.parse(p.contactId);
  app.get(`${BASE}/tickets`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope) =>
      listTickets(tx, scope, req.query ?? {}),
    ),
  );
  app.get(`${BASE}/tickets/:ticketId`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope, p) =>
      ticketDetail(tx, scope, ticket(p)),
    ),
  );
  app.post(`${BASE}/tickets/:ticketId/replies`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_REPLY, (tx, scope, p) =>
      replyToTicket(tx, scope, ticket(p), req.body),
    ),
  );
  app.post(`${BASE}/tickets/:ticketId/notes`, (req) =>
    inSupport(auth, req, SUPPORT_NOTES_WRITE, (tx, scope, p) =>
      noteOnTicket(tx, scope, ticket(p), req.body),
    ),
  );
  app.patch(`${BASE}/tickets/:ticketId`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_ASSIGN, (tx, scope, p) =>
      updateTicket(tx, scope, ticket(p), req.body),
    ),
  );
  app.post(`${BASE}/tickets/:ticketId/ai-draft`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_REPLY, (tx, scope, p) =>
      requestDraft(tx, scope, ticket(p)),
    ),
  );
  app.post(`${BASE}/tickets/:ticketId/merge`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_ASSIGN, (tx, scope, p) =>
      mergeTicket(tx, scope, ticket(p), req.body),
    ),
  );
  app.get(`${BASE}/contacts`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope) =>
      listContacts(tx, scope, req.query ?? {}),
    ),
  );
  app.get(`${BASE}/contacts/:contactId`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope, p) =>
      contactDetail(tx, scope, contact(p)),
    ),
  );
  app.patch(`${BASE}/contacts/:contactId`, (req) =>
    inSupport(auth, req, SUPPORT_CONTACTS_MANAGE, (tx, scope, p) =>
      updateContact(tx, scope, contact(p), req.body),
    ),
  );
  app.post(`${BASE}/contacts/:contactId/merge`, (req) =>
    inSupport(auth, req, SUPPORT_CONTACTS_MANAGE, (tx, scope, p) =>
      mergeContact(tx, scope, contact(p), req.body),
    ),
  );
  app.get(`${BASE}/stats`, (req) =>
    inSupport(auth, req, SUPPORT_STATS_READ, (tx, scope) =>
      supportStats(tx, scope, req.query ?? {}),
    ),
  );
  app.get(`${BASE}/stats/export`, async (req, reply) => {
    const stats = await inSupport(auth, req, SUPPORT_STATS_READ, (tx, scope) =>
      supportStats(tx, scope, req.query ?? {}),
    );
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="support-stats.csv"')
      .send(statsCsv(stats));
  });
  app.get(`${BASE}/summary`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope) =>
      ticketSummary(tx, scope),
    ),
  );
  // Data-subject requests (WP5.8): owners only.
  app.get(`${BASE}/contacts/:contactId/export`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope, p) =>
      exportContact(tx, scope, contact(p)),
    ),
  );
  app.post(`${BASE}/contacts/:contactId/erase`, async (req) => {
    const params = req.params as Params;
    const scope = await scopeFor(
      auth,
      req,
      params.projectId,
      SUPPORT_SETTINGS_MANAGE,
    );
    return eraseContact(scope, contact(params));
  });
  app.get(`${BASE}/agents`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, async (_tx, scope) => ({
      items: await supportAgents(scope),
    })),
  );
  app.get(`${BASE}/settings`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, (tx, scope) =>
      readModuleSettings(
        tx,
        scope,
        "support",
        supportSettingsSchema,
        supportSettingsDefaults,
      ),
    ),
  );
  app.put(`${BASE}/settings`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return writeModuleSettings(
        tx,
        scope,
        "support",
        supportSettingsSchema,
        settings,
        version,
      );
    }),
  );
  app.get(`${BASE}/inboxes`, (req) =>
    inSupport(auth, req, SUPPORT_TICKETS_READ, async (tx, scope) => ({
      items: await listInboxes(tx, scope),
    })),
  );
  app.post(`${BASE}/inboxes`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope) =>
      createInbox(tx, scope, req.body),
    ),
  );
  app.patch(`${BASE}/inboxes/:inboxId`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope, params) =>
      updateInbox(tx, scope, inboxId.parse(params.inboxId), req.body),
    ),
  );
  app.post(`${BASE}/inboxes/:inboxId/rotate-widget-secret`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope, params) =>
      rotateWidgetSecret(tx, scope, inboxId.parse(params.inboxId)),
    ),
  );
  app.post(`${BASE}/inboxes/:inboxId/widget-key`, async (req) => {
    const params = req.params as Params;
    const scope = await scopeFor(
      auth,
      req,
      params.projectId,
      SUPPORT_SETTINGS_MANAGE,
    );
    return enableWidgetKey(scope, inboxId.parse(params.inboxId));
  });
  app.post(`${BASE}/inboxes/:inboxId/archive`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope, params) =>
      archiveInbox(tx, scope, inboxId.parse(params.inboxId)),
    ),
  );
};
