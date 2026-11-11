import { z } from "zod";
import { authDb, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { connectionSecret, connectionsEnabled, resolveConnection } from "../../../platform/connections/central.ts";
import { DomainError } from "../../../shared.ts";

// The ads module's Meta developer app (ADR 0025): a system connection in
// the administration whose secret is a JSON object, granted to an
// organization and then a project for the purpose "ads_oauth" and the
// module "ads". It is separate from Social's app: its own Facebook Login
// for Business configuration carries the ads permissions.

const PROVIDER = "ads.app.meta";
const PURPOSE = "ads_oauth";

export const metaAdsAppSecret = z
  .object({
    appId: z.string().regex(/^\d{5,20}$/),
    appSecret: z.string().min(16).max(200),
    configId: z.string().regex(/^\d{5,20}$/),
  })
  .strict();
export type MetaAdsAppSecret = z.infer<typeof metaAdsAppSecret>;

/** Parses the app secret; the error never contains the secret. */
export function parseMetaAdsAppSecret(raw: string): MetaAdsAppSecret {
  try {
    const parsed = metaAdsAppSecret.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: refused below.
  }
  throw new DomainError("ADS_META_APP_INVALID", 500);
}

/** The project's granted Meta app with its parsed secret. */
export async function adsAppCredentials(
  tx: DbTx,
  scope: Scope,
): Promise<{ connectionId: string; clientId: string; clientSecret: string; configId: string }> {
  const granted = await resolveConnection(tx, scope, { provider: PROVIDER, purpose: PURPOSE, module: "ads" });
  if (!granted) throw new DomainError("ADS_META_APP_NOT_GRANTED", 409);
  const raw = await connectionSecret(tx, granted.connection.id);
  if (raw === null) throw new DomainError("ADS_META_APP_NOT_GRANTED", 409);
  const secret = parseMetaAdsAppSecret(raw);
  return {
    connectionId: granted.connection.id,
    clientId: secret.appId,
    clientSecret: secret.appSecret,
    configId: secret.configId,
  };
}

/**
 * "project_not_granted": the organization holds the app, only this
 * project's grant is missing; "not_granted": the administration still has
 * to add or grant the app.
 */
export type AdsAppReadiness = "ready" | "project_not_granted" | "not_granted" | "invalid";

/**
 * Whether the organization holds an active grant of the app for ads
 * sign-in. The business role sees a connection only through a project
 * grant, so this existence check reads as the auth role, limited to the
 * caller's organization; only a boolean leaves it.
 */
async function grantedToOrganization(scope: Scope): Promise<boolean> {
  if (!connectionsEnabled()) return false;
  const grant = await authDb.connectionGrant.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: null,
      userId: null,
      revokedAt: null,
      connection: { provider: PROVIDER, disabledAt: null, revokedAt: null },
      AND: [
        { OR: [{ purposes: { isEmpty: true } }, { purposes: { has: PURPOSE } }] },
        { OR: [{ modules: { isEmpty: true } }, { modules: { has: "ads" } }] },
      ],
    },
    select: { id: true },
  });
  return grant !== null;
}

/** Whether the app can start a connection for the project; only the state leaves, never the secret. */
export async function adsAppReadiness(tx: DbTx, scope: Scope): Promise<AdsAppReadiness> {
  try {
    await adsAppCredentials(tx, scope);
    return "ready";
  } catch (error) {
    if ((error as { code?: string }).code === "ADS_META_APP_INVALID") return "invalid";
    return (await grantedToOrganization(scope)) ? "project_not_granted" : "not_granted";
  }
}

/** The OAuth callback URL the Meta app must list, on the web origin. */
export function adsRedirectUri(config: { APP_ORIGIN: string }): string {
  return `${new URL(config.APP_ORIGIN).origin}/api/ads/oauth/callback/meta`;
}
