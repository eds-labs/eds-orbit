import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { connectionSecret, resolveConnection } from "../../../platform/connections/central.ts";
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

/** The OAuth callback URL a developer app must list, on the web origin. */
export function redirectUri(config: { APP_ORIGIN: string }, app: SocialApp) {
  return `${new URL(config.APP_ORIGIN).origin}/api/social/oauth/callback/${app}`;
}
