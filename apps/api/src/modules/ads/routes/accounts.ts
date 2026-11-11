import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { scopeFor } from "../../../platform/tenancy/auth.ts";
import { beginMetaConnect, finishMetaConnect } from "../accounts/connect.ts";
import { consumeAdsOAuthState, projectOfAdsState, type ConsumedAdsState } from "../accounts/oauth-state.ts";
import { requireAds } from "../gate.ts";
import { ADS_BASE, inAds } from "../http-scope.ts";
import { ADS_ACCOUNTS_MANAGE, ADS_READ } from "../permissions.ts";
import { adAccountSettingsPatchSchema } from "../accounts/account-settings.ts";
import {
  assignAdAccount,
  availableAccounts,
  listAdAccounts,
  listConnections,
  revokeAdsConnection,
  unlinkAdAccount,
  updateAdAccount,
} from "../accounts/accounts.ts";

// Account connection routes (ADR 0025, A3): the owner starts Meta's login
// and the provider sends the browser back to the callback.

const providerParam = z.object({ provider: z.enum(["meta"]) });
const callbackQuery = z
  .object({
    state: z.string().min(40).max(200),
    code: z.string().min(1).max(2000).optional(),
    error: z.string().max(200).optional(),
  })
  .passthrough();
/** Only a code of ours reaches the redirect; anything else is a generic failure. */
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^ADS_[A-Z0-9_]{1,60}$/.test(code) ? code : "ADS_CONNECT_FAILED";
};
const connectionParam = z.object({ connectionId: z.uuid() });
const accountParam = z.object({ accountId: z.uuid() });
const assignBody = z.object({ connectionId: z.uuid(), externalId: z.string().regex(/^act_\d{1,32}$/) }).strict();
const patchBody = z
  .object({ settings: adAccountSettingsPatchSchema.optional(), writesEnabled: z.boolean().optional(), version: z.int().min(1) })
  .strict()
  .refine((b) => b.settings !== undefined || b.writesEnabled !== undefined, { message: "Nothing to change" });
const unlinkBody = z.object({ version: z.int().min(1) }).strict();
const withParam = (path: string, param: string) => `${path}${path.includes("?") ? "&" : "?"}${param}`;

export const accountRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.post(`${ADS_BASE}/connections/meta/connect`, (req) =>
    inAds(auth, req, ADS_ACCOUNTS_MANAGE, (tx, scope) => beginMetaConnect(tx, scope)),
  );
  // Lists are wrapped: the platform's default response schema is an object.
  app.get(`${ADS_BASE}/accounts`, (req) =>
    inAds(auth, req, ADS_READ, async (tx, scope) => ({ accounts: await listAdAccounts(tx, scope) })),
  );
  app.get(`${ADS_BASE}/connections`, (req) =>
    inAds(auth, req, ADS_ACCOUNTS_MANAGE, (tx, scope) => listConnections(tx, scope)),
  );
  // Permission and module first; provider calls and claims run outside the
  // project transaction (Social's pattern), so only the scope leaves it.
  app.get(`${ADS_BASE}/connections/:connectionId/available-accounts`, async (req) => {
    const scope = await inAds(auth, req, ADS_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return availableAccounts(scope, connectionParam.parse(req.params).connectionId);
  });
  app.post(`${ADS_BASE}/connections/:connectionId/revoke`, async (req) => {
    const scope = await inAds(auth, req, ADS_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return revokeAdsConnection(scope, connectionParam.parse(req.params).connectionId);
  });
  app.post(`${ADS_BASE}/accounts`, async (req) => {
    const scope = await inAds(auth, req, ADS_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return assignAdAccount(scope, assignBody.parse(req.body));
  });
  app.patch(`${ADS_BASE}/accounts/:accountId`, (req) =>
    inAds(auth, req, ADS_ACCOUNTS_MANAGE, (tx, scope) => {
      const { accountId } = accountParam.parse(req.params);
      return updateAdAccount(tx, scope, accountId, patchBody.parse(req.body));
    }),
  );
  app.post(`${ADS_BASE}/accounts/:accountId/unlink`, async (req) => {
    const scope = await inAds(auth, req, ADS_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return unlinkAdAccount(scope, accountParam.parse(req.params).accountId, unlinkBody.parse(req.body));
  });
  // The provider sends the browser here (outside the project path, so the
  // project comes from the state). The member must be the signed-in owner who
  // started the flow; the state is used once, before any token exchange.
  app.get("/api/ads/oauth/callback/:provider", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const query = callbackQuery.parse(req.query);
    const projectId = projectOfAdsState(query.state);
    const scope = await scopeFor(auth, req, projectId, ADS_ACCOUNTS_MANAGE);
    let attempt: ConsumedAdsState;
    try {
      attempt = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        await requireAds(tx, scope);
        return consumeAdsOAuthState(tx, scope, { state: query.state, provider });
      });
    } catch (error) {
      if (errorCode(error) !== "ADS_OAUTH_STATE_INVALID") throw error;
      return reply.redirect(`/p/${projectId}/ads/accounts?error=ADS_OAUTH_STATE_INVALID`);
    }
    if (query.error || !query.code) return reply.redirect(withParam(attempt.redirectAfter, "error=ADS_OAUTH_CANCELLED"));
    try {
      const done = await finishMetaConnect(scope, { code: query.code, attempt });
      return reply.redirect(withParam(attempt.redirectAfter, `connection=${done.connectionId}`));
    } catch (error) {
      return reply.redirect(withParam(attempt.redirectAfter, `error=${errorCode(error)}`));
    }
  });
};
