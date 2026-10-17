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
  SUPPORT_SETTINGS_MANAGE,
  SUPPORT_TICKETS_READ,
} from "./permissions.ts";
import { supportSettingsDefaults, supportSettingsSchema } from "./settings.ts";

const BASE = "/api/projects/:projectId/support";
const inboxId = z.uuid();
const settingsInput = z
  .object({ settings: z.unknown(), version: z.number().int().min(1) })
  .strict();

type Params = { projectId: string; inboxId?: string };

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

/** Support settings and inbox management (WP5.1). */
export const supportRoutes: RoutesContribution = ({ app, auth }) => {
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
  app.post(`${BASE}/inboxes/:inboxId/archive`, (req) =>
    inSupport(auth, req, SUPPORT_SETTINGS_MANAGE, (tx, scope, params) =>
      archiveInbox(tx, scope, inboxId.parse(params.inboxId)),
    ),
  );
};
