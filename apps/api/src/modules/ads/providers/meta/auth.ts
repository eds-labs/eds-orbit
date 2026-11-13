import { z } from "zod";
import { ConnectorError } from "../../../../../../../packages/connectors/src/index.ts";
import { AdsProviderError, type AdsConnect, type ProviderApp, type ProviderGrant } from "../types.ts";
import { classifyMetaFailure } from "./errors.ts";
import { createMetaGraphClient } from "./graph.ts";
import { metaAdsFetch } from "./transport.ts";
import { META_ADS_API_VERSION, META_ADS_GRAPH } from "./version.ts";

const DIALOG = `https://www.facebook.com/${META_ADS_API_VERSION}/dialog/oauth`;
/** Tokens that live shorter than seven days are swapped for a long-lived one. */
const LONG_LIVED_SECONDS = 604_800;

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().min(0).optional(),
});
type TokenAnswer = z.infer<typeof tokenAnswer>;

/** No expiry means a system user token; everything else is a user token. */
export function tokenTypeOf(expiresIn?: number): "user" | "system_user" {
  return expiresIn === undefined ? "system_user" : "user";
}

export function authorizeUrl(input: { app: ProviderApp; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.app.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    override_default_response_type: "true",
  });
  if (input.app.configId) params.set("config_id", input.app.configId);
  return `${DIALOG}?${params}`;
}

/** No bearer token exists yet, so the form (with the code or secret) goes in the body and never in the URL. */
async function tokenRequest(form: Record<string, string>): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await metaAdsFetch(`${META_ADS_GRAPH}/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    const transport = error instanceof ConnectorError ? error : new ConnectorError("NETWORK_ERROR", "not_sent");
    throw new AdsProviderError(classifyMetaFailure({ write: false, transport }));
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const parsed = response.ok ? tokenAnswer.safeParse(body) : undefined;
  if (parsed?.success) return parsed.data;
  throw new AdsProviderError(classifyMetaFailure({ write: false, httpStatus: response.status, body, headers: response.headers }));
}

const meAnswer = z.object({ id: z.string().min(1), name: z.string().optional() });
const permissionsAnswer = z.object({ data: z.array(z.object({ permission: z.string(), status: z.string() })) });

export async function scopes(input: { app: ProviderApp; accessToken: string }): Promise<string[]> {
  const client = createMetaGraphClient({ accessToken: input.accessToken, appSecret: input.app.clientSecret });
  const { data } = await client.get("/me/permissions", {}, permissionsAnswer);
  return data.data.filter(entry => entry.status === "granted").map(entry => entry.permission).sort();
}

export async function finish(input: { app: ProviderApp; redirectUri: string; code: string }): Promise<ProviderGrant> {
  const { app } = input;
  let token = await tokenRequest({ client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: input.redirectUri, code: input.code });
  if (token.expires_in !== undefined && token.expires_in < LONG_LIVED_SECONDS) {
    token = await tokenRequest({ grant_type: "fb_exchange_token", client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: token.access_token });
  }
  const client = createMetaGraphClient({ accessToken: token.access_token, appSecret: app.clientSecret });
  const { data: me } = await client.get("/me", { fields: "id,name" }, meAnswer);
  const grantedScopes = await scopes({ app, accessToken: token.access_token });
  if (!grantedScopes.includes("ads_read") && !grantedScopes.includes("ads_management")) {
    throw new AdsProviderError({ kind: "permission", code: "ADS_META_PERMISSION_MISSING", outcome: "rejected", retryable: false, fieldPaths: [] });
  }
  return {
    accessToken: token.access_token,
    tokenType: tokenTypeOf(token.expires_in),
    expiresAt: token.expires_in === undefined ? null : new Date(Date.now() + token.expires_in * 1000),
    userId: me.id,
    userName: me.name ?? null,
    grantedScopes,
  };
}

export const metaAuth: Pick<AdsConnect, "authorizeUrl" | "finish" | "scopes"> = { authorizeUrl, finish, scopes };
