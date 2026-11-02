import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { requireSocial } from "./gate.ts";
import { socialModule } from "./manifest.ts";
import { SOCIAL_READ, SOCIAL_SETTINGS } from "./permissions.ts";
import { readSocialSettings, saveSocialSettings } from "./settings.ts";

// The social module's HTTP API (ADR 0020, plan §6.2). Every route checks
// the member's permission in the module, then that the module is on in the
// project (404 SOCIAL_DISABLED), then runs in one project transaction.

const BASE = "/api/projects/:projectId/social";

type Params = Record<string, string>;
type Req = Parameters<typeof scopeFor>[1];

export async function inSocial<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSocial(tx, scope);
    return work(tx, scope, params);
  });
}

const settingsInput = z.object({ settings: z.unknown(), version: z.int().min(1) }).strict();

/** Social module routes (plan §6.2); later phases add accounts, posts and media. */
export const socialRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.get(`${BASE}/status`, (req) =>
    inSocial(auth, req, SOCIAL_READ, async (tx, scope) => {
      const { settings, version } = await readSocialSettings(tx, scope);
      return {
        module: "social" as const,
        version: socialModule.version,
        settings,
        settingsVersion: version,
      };
    }),
  );
  app.put(`${BASE}/settings`, (req) =>
    inSocial(auth, req, SOCIAL_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return saveSocialSettings(tx, scope, settings, version);
    }),
  );
};
