import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { appCredentials, redirectUri, type MetaAppSecret } from "./apps.ts";
import type { ConnectHandler } from "./connect.ts";
import { providerFailure } from "./errors.ts";
import { socialFetch } from "./http.ts";
import { beginOAuthState } from "./oauth-state.ts";
import { saveConnectedAccount } from "./store.ts";
import { markReconnectRequired } from "./vault.ts";

// Meta (Facebook Pages and linked Instagram accounts) through Facebook Login
// for Business (ADR 0020, S-D4). The person picks Pages and Instagram
// accounts in Meta's dialog; every granted Page with a posting task becomes
// an account, and so does its linked Instagram professional account. Page
// tokens obtained with a long-lived user token do not expire. The SDK has
// no Facebook provider, so this is Orbit code. The Graph API version is
// pinned here only.

export const META_GRAPH_VERSION = "v26.0";
export const META_GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const META_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const MAX_PAGES = 5;
const POSTING_TASKS = new Set(["CREATE_CONTENT", "MANAGE"]);
// Graph error codes of a throttle (app, user, Page, custom, business use case).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);

const tokenResponse = z.object({ access_token: z.string().min(1) });
const meResponse = z.object({ id: z.string().min(1), name: z.string().optional() });
const pagesResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      access_token: z.string().min(1).optional(),
      tasks: z.array(z.string()).optional(),
      instagram_business_account: z
        .object({ id: z.string().min(1), username: z.string().optional(), name: z.string().optional() })
        .optional(),
    }),
  ),
  paging: z.object({ next: z.string().optional() }).optional(),
});
const debugResponse = z.object({
  data: z.object({
    is_valid: z.boolean(),
    data_access_expires_at: z.number().optional(),
    error: z.object({ code: z.number().optional() }).optional(),
    granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() })).optional(),
  }),
});

type GraphError = { code?: number };
const graphError = (body: unknown): GraphError =>
  (body as { error?: GraphError } | null)?.error ?? {};

function metaFailure(status: number, error: GraphError): DomainError {
  if (error.code !== undefined && RATE_LIMIT_CODES.has(error.code))
    return new DomainError("SOCIAL_RATE_LIMITED", 429);
  if (status >= 500 || error.code === 1 || error.code === 2)
    return new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  return new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
}

/** One Graph request; never puts a provider message into the error. */
async function graph(
  url: string,
  options: { bearer?: string } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = await socialFetch(url, {
      headers: { Accept: "application/json", ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}) },
    });
  } catch (error) {
    throw providerFailure(error);
  }
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function graphOk<T>(schema: z.ZodType<T>, url: string, options: { bearer?: string } = {}): Promise<T> {
  const result = await graph(url, options);
  if (!result.ok) throw metaFailure(result.status, graphError(result.body));
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  return parsed.data;
}

const withQuery = (path: string, query: Record<string, string>) =>
  `${META_GRAPH}${path}?${new URLSearchParams(query).toString()}`;

/** Exchanges the code and then for a long-lived user token (Meta puts the app secret in the query). */
async function userToken(app: MetaAppSecret, callback: string, code: string) {
  const short = await graphOk(
    tokenResponse,
    withQuery("/oauth/access_token", {
      client_id: app.appId,
      redirect_uri: callback,
      client_secret: app.appSecret,
      code,
    }),
  );
  const long = await graphOk(
    tokenResponse,
    withQuery("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: short.access_token,
    }),
  );
  return long.access_token;
}

async function grantedPages(token: string) {
  const pages: z.infer<typeof pagesResponse>["data"] = [];
  let url: string | undefined = withQuery("/me/accounts", {
    fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}",
    limit: "100",
  });
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const result: z.infer<typeof pagesResponse> = await graphOk(pagesResponse, url, { bearer: token });
    pages.push(...result.data);
    const next = result.paging?.next;
    url = next && new URL(next).origin === "https://graph.facebook.com" ? next : undefined;
  }
  return pages;
}

export const metaConnect: ConnectHandler = {
  async begin(tx, scope) {
    const app = await appCredentials(tx, scope, "meta");
    const callback = redirectUri(loadConfig(), "meta");
    const started = await beginOAuthState(tx, scope, {
      platform: "facebook",
      appConnectionId: app.connectionId,
      redirectAfter: `/p/${scope.projectId}/social/accounts`,
    });
    const url = new URL(META_DIALOG);
    url.search = new URLSearchParams({
      client_id: app.meta!.appId,
      redirect_uri: callback,
      state: started.state,
      config_id: app.meta!.configId,
      response_type: "code",
    }).toString();
    return { authorizeUrl: url.toString() };
  },

  async finish(scope, { callbackUrl, attempt }) {
    const app = await scoped(scope.workspaceId, scope.projectId, (tx) => appCredentials(tx, scope, "meta"));
    if (app.connectionId !== attempt.appConnectionId) throw new DomainError("SOCIAL_APP_CHANGED", 409);
    const callback = redirectUri(loadConfig(), "meta");
    const returned = new URL(callbackUrl);
    const expected = new URL(callback);
    const code = returned.searchParams.get("code");
    if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || !code)
      throw new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
    const token = await userToken(app.meta!, callback, code);
    const me = await graphOk(meResponse, withQuery("/me", { fields: "id,name" }), { bearer: token });
    const pages = (await grantedPages(token)).filter(
      (page) => page.access_token && page.tasks?.some((task) => POSTING_TASKS.has(task)),
    );
    if (!pages.length) throw new DomainError("SOCIAL_META_NO_PAGES", 409);
    const granted = new Set<string>();
    for (const page of pages) {
      const secret = JSON.stringify({ pageToken: page.access_token });
      const base = { metaUserId: me.id, pageId: page.id, appConnectionId: app.connectionId };
      await saveConnectedAccount(scope, {
        platform: "facebook",
        externalId: page.id,
        handle: page.name,
        displayName: page.name,
        secret,
        config: base,
      });
      granted.add(`facebook:${page.id}`);
      const ig = page.instagram_business_account;
      if (ig) {
        await saveConnectedAccount(scope, {
          platform: "instagram",
          externalId: ig.id,
          handle: ig.username ? `@${ig.username}` : (ig.name ?? ig.id),
          displayName: ig.name ?? ig.username ?? ig.id,
          secret,
          config: { ...base, igUserId: ig.id },
        });
        granted.add(`instagram:${ig.id}`);
      }
    }
    // Pages this Meta user connected before but no longer granted.
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const known = await tx.socialAccount.findMany({
        where: { projectId: scope.projectId, platform: { in: ["facebook", "instagram"] }, status: "active" },
      });
      const stale = known.filter((a) => !granted.has(`${a.platform}:${a.externalId}`));
      if (!stale.length) return;
      const connections = await tx.connection.findMany({
        where: { id: { in: stale.map((a) => a.connectionId) } },
        select: { id: true, config: true },
      });
      const owner = new Map(connections.map((c) => [c.id, (c.config as { metaUserId?: string }).metaUserId]));
      for (const account of stale)
        if (owner.get(account.connectionId) === me.id)
          await markReconnectRequired(tx, scope, account.id, "SOCIAL_META_ASSET_NOT_GRANTED");
    });
    return { accounts: granted.size };
  },
};

/**
 * Checks a Page token with the app token (debug_token): valid, and holding
 * the publishing permission for this Page or Instagram account.
 */
export async function metaHealth(
  app: MetaAppSecret,
  pageToken: string,
  kind: "facebook" | "instagram",
  assetId: string,
): Promise<{ ok: true; dataAccessExpiresAt?: string } | { ok: false; code: string }> {
  const result = await graph(withQuery("/debug_token", { input_token: pageToken }), {
    bearer: `${app.appId}|${app.appSecret}`,
  });
  if (!result.ok) {
    const error = graphError(result.body);
    if (error.code === 190) return { ok: false, code: "SOCIAL_META_TOKEN_INVALID" };
    throw metaFailure(result.status, error);
  }
  const parsed = debugResponse.safeParse(result.body);
  if (!parsed.success) throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  const data = parsed.data.data;
  if (!data.is_valid || data.error?.code === 190) return { ok: false, code: "SOCIAL_META_TOKEN_INVALID" };
  const needed = kind === "facebook" ? "pages_manage_posts" : "instagram_content_publish";
  const permitted = (data.granular_scopes ?? []).some(
    (s) => s.scope === needed && (!s.target_ids || s.target_ids.includes(assetId)),
  );
  if (!permitted) return { ok: false, code: "SOCIAL_META_PERMISSION_MISSING" };
  return {
    ok: true,
    ...(data.data_access_expires_at
      ? { dataAccessExpiresAt: new Date(data.data_access_expires_at * 1000).toISOString() }
      : {}),
  };
}
