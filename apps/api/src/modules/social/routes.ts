import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { disconnectAccount, listAccounts } from "./accounts/accounts.ts";
import { redirectUri } from "./accounts/apps.ts";
import { connectHandler, oauthPlatform } from "./accounts/connect.ts";
import { handleMetaDataDeletion } from "./accounts/data-deletion.ts";
import { checkAccount } from "./accounts/health.ts";
import { consumeOAuthState, projectOfState } from "./accounts/oauth-state.ts";
import { connectTelegramChannel } from "./accounts/telegram.ts";
import { requireSocial } from "./gate.ts";
import { socialModule } from "./manifest.ts";
import { SOCIAL_ACCOUNTS_MANAGE, SOCIAL_READ, SOCIAL_SETTINGS } from "./permissions.ts";
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
const appParam = z.object({ app: z.enum(["meta", "x"]) });
const accountParam = z.object({ accountId: z.uuid() }).passthrough();
const callbackQuery = z
  .object({
    state: z.string().min(40).max(200),
    code: z.string().min(1).max(2000).optional(),
    error: z.string().max(200).optional(),
  })
  .passthrough();
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^SOCIAL_[A-Z0-9_]{1,60}$/.test(code) ? code : "SOCIAL_CONNECT_FAILED";
};

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
  app.post(`${BASE}/accounts/connect/:app`, (req) =>
    inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, (tx, scope, params) =>
      connectHandler(appParam.parse(params).app).begin(tx, scope),
    ),
  );
  app.get(`${BASE}/accounts`, (req) => inSocial(auth, req, SOCIAL_READ, (tx, scope) => listAccounts(tx, scope)));
  app.post(`${BASE}/accounts/:accountId/check`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return checkAccount(scope, accountParam.parse(req.params).accountId, { manual: true });
  });
  app.post(`${BASE}/accounts/:accountId/disconnect`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return disconnectAccount(scope, accountParam.parse(req.params).accountId, req.body);
  });
  // Permission and module first; the provider calls run outside the project
  // transaction, which they would otherwise hold open.
  app.post(`${BASE}/accounts/telegram`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return connectTelegramChannel(scope, req.body);
  });
  // Meta's data-deletion request (public ingress only; signed by Meta).
  app.post(
    "/api/callbacks/social/meta-data-deletion",
    { bodyLimit: 16_384, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    (req) => handleMetaDataDeletion(req.body),
  );
  // The provider sends the browser here (outside the project path, so the
  // project comes from the state). The member must be the signed-in owner
  // who started the flow; the state is used once, before any token exchange.
  app.get("/api/social/oauth/callback/:app", async (req, reply) => {
    const { app: provider } = appParam.parse(req.params);
    const query = callbackQuery.parse(req.query);
    const projectId = projectOfState(query.state);
    const scope = await scopeFor(auth, req, projectId, SOCIAL_ACCOUNTS_MANAGE);
    const accounts = `/p/${projectId}/social/accounts`;
    let attempt;
    try {
      attempt = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        await requireSocial(tx, scope);
        return consumeOAuthState(tx, scope, { state: query.state, platform: oauthPlatform(provider) });
      });
    } catch (error) {
      if (errorCode(error) !== "SOCIAL_OAUTH_STATE_INVALID") throw error;
      return reply.redirect(`${accounts}?error=SOCIAL_OAUTH_STATE_INVALID`);
    }
    if (query.error || !query.code)
      return reply.redirect(`${attempt.redirectAfter}?error=SOCIAL_OAUTH_CANCELLED`);
    const raw = req.url.slice(req.url.indexOf("?") + 1);
    try {
      const done = await connectHandler(provider).finish(scope, {
        callbackUrl: `${redirectUri(loadConfig(), provider)}?${raw}`,
        state: query.state,
        attempt,
      });
      return reply.redirect(`${attempt.redirectAfter}?connected=${done.accounts}`);
    } catch (error) {
      return reply.redirect(`${attempt.redirectAfter}?error=${errorCode(error)}`);
    }
  });
  app.put(`${BASE}/settings`, (req) =>
    inSocial(auth, req, SOCIAL_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return saveSocialSettings(tx, scope, settings, version);
    }),
  );
};
