import { z } from "zod";
import { authDb, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { connectionSecret, connectionsEnabled, resolveConnection } from "../../../platform/connections/central.ts";
import { DomainError } from "../../../shared.ts";

// Developer apps (ADR 0020): system connections in the administration whose
// secret is a JSON object, granted to an organization and then a project
// for the purpose "social_oauth" and the module "social".

export type SocialApp = "meta" | "x";

export const metaAppSecret = z
  .object({
    appId: z.string().regex(/^\d{5,20}$/),
    appSecret: z.string().min(16).max(200),
    configId: z.string().regex(/^\d{5,20}$/),
  })
  .strict();
export const xAppSecret = z
  .object({
    clientId: z.string().min(10).max(200),
    clientSecret: z.string().min(10).max(200),
  })
  .strict();
export type MetaAppSecret = z.infer<typeof metaAppSecret>;
export type XAppSecret = z.infer<typeof xAppSecret>;

/** Parses an app secret; the message never contains the secret. */
export function parseAppSecret<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: refused below.
  }
  throw new DomainError("SOCIAL_APP_INVALID", 500);
}

/** The project's granted developer app with its parsed secret. */
export async function appCredentials(
  tx: DbTx,
  scope: Scope,
  app: SocialApp,
): Promise<{ connectionId: string; meta?: MetaAppSecret; x?: XAppSecret }> {
  const granted = await resolveConnection(tx, scope, {
    provider: `social.app.${app}`,
    purpose: "social_oauth",
    module: "social",
  });
  if (!granted) throw new DomainError("SOCIAL_APP_NOT_GRANTED", 409);
  const raw = await connectionSecret(tx, granted.connection.id);
  if (raw === null) throw new DomainError("SOCIAL_APP_NOT_GRANTED", 409);
  const connectionId = granted.connection.id;
  return app === "meta"
    ? { connectionId, meta: parseAppSecret(metaAppSecret, raw) }
    : { connectionId, x: parseAppSecret(xAppSecret, raw) };
}

/**
 * "project_not_granted": the organization holds the app, only this
 * project's grant is missing (an organization owner adds it in the
 * organization settings); "not_granted": the administration still has to
 * add or grant the app.
 */
export type AppReadiness = "ready" | "project_not_granted" | "not_granted" | "invalid";

/**
 * Whether the organization holds an active grant of the app for social
 * sign-in. The business role sees a connection only through a project
 * grant, so this existence check reads as the auth role, limited to the
 * caller's organization; only a boolean leaves it.
 */
async function grantedToOrganization(scope: Scope, app: SocialApp): Promise<boolean> {
  if (!connectionsEnabled()) return false;
  const grant = await authDb.connectionGrant.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: null,
      userId: null,
      revokedAt: null,
      connection: { provider: `social.app.${app}`, disabledAt: null, revokedAt: null },
      AND: [
        { OR: [{ purposes: { isEmpty: true } }, { purposes: { has: "social_oauth" } }] },
        { OR: [{ modules: { isEmpty: true } }, { modules: { has: "social" } }] },
      ],
    },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Whether each developer app can start a connection for the project, so
 * the accounts page can say what is missing before the owner taps
 * "connect". Only the state leaves this function, never the secret.
 */
export async function appReadiness(tx: DbTx, scope: Scope): Promise<Record<SocialApp, AppReadiness>> {
  const state = async (app: SocialApp): Promise<AppReadiness> => {
    try {
      await appCredentials(tx, scope, app);
      return "ready";
    } catch (error) {
      if ((error as { code?: string }).code === "SOCIAL_APP_INVALID") return "invalid";
      return (await grantedToOrganization(scope, app)) ? "project_not_granted" : "not_granted";
    }
  };
  return { x: await state("x"), meta: await state("meta") };
}

/** The OAuth callback URL a developer app must list, on the web origin. */
export function redirectUri(config: { APP_ORIGIN: string }, app: SocialApp) {
  return `${new URL(config.APP_ORIGIN).origin}/api/social/oauth/callback/${app}`;
}
