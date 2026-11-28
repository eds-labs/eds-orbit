import { z } from "zod";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  connectionSecret,
  grantedConnections,
} from "../../../platform/connections/central.ts";
import type { ConnectionProvider } from "../../../platform/connections/connections.ts";
import { DomainError } from "../../../platform/shared.ts";
import { SEO_MODULE_ID } from "../manifest.ts";

export const GOOGLE_SEARCH_CONSOLE = "google-search-console";
export const GOOGLE_SEARCH_CONSOLE_CALLBACK =
  "/api/seo/oauth/callback/google-search-console";

const appProvider = "seo.app.google-search-console";
const appPurpose = "seo_oauth";
export const googleAccountProvider = "seo.account.google-search-console";
export const googleAccountPurpose = "seo_read";

const googleAppSecret = z
  .object({
    clientId: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/),
    clientSecret: z.string().regex(/^[a-zA-Z0-9_-]{8,256}$/),
  })
  .strict();

function parseGoogleAppSecret(raw: string) {
  try {
    const parsed = googleAppSecret.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Reject malformed credentials without including their contents.
  }
  throw new DomainError("SEO_GOOGLE_APP_INVALID", 422);
}

export const seoConnectionProviders: Record<string, ConnectionProvider> = {
  [appProvider]: {
    scopes: ["system"],
    purposes: [appPurpose],
    category: "analytics",
    label: {
      en: "Google Search Console OAuth app",
      de: "Google Search Console OAuth-App",
    },
    callbackPath: GOOGLE_SEARCH_CONSOLE_CALLBACK,
    checkUnsupported: "SEO_GOOGLE_APP_CHECK_IN_MODULE",
    secretFields: [
      {
        key: "clientId",
        label: { en: "Client ID", de: "Client-ID" },
        pattern: "[a-zA-Z0-9_\\-]+\\.apps\\.googleusercontent\\.com",
      },
      {
        key: "clientSecret",
        label: { en: "Client secret", de: "Client-Secret" },
        secret: true,
      },
    ],
    validateSecret: parseGoogleAppSecret,
  },
  [googleAccountProvider]: {
    scopes: ["project"],
    managedByModule: true,
    purposes: [googleAccountPurpose],
    category: "analytics",
    authType: "oauth_account",
    label: {
      en: "Google Search Console access",
      de: "Google Search Console-Zugang",
    },
    checkUnsupported: "SEO_GOOGLE_ACCOUNT_CHECK_IN_MODULE",
  },
};

async function googleAppGrants(tx: DbTx, scope: Scope) {
  const grants = await grantedConnections(tx, scope, {
    provider: appProvider,
    purpose: appPurpose,
    module: SEO_MODULE_ID,
  });
  return grants.filter((item) => item.connection.scope === "system");
}

async function readGoogleApp(tx: DbTx, connectionId: string) {
  const raw = await connectionSecret(tx, connectionId).catch(() => {
    throw new DomainError("SEO_GOOGLE_APP_INVALID", 422);
  });
  if (raw === null) return null;
  return { connectionId, ...parseGoogleAppSecret(raw) };
}

export async function googleReadyAppIds(tx: DbTx, scope: Scope) {
  const candidates = await googleAppGrants(tx, scope);
  const ready = await Promise.all(
    candidates.map(({ connection }) =>
      readGoogleApp(tx, connection.id).catch(() => null),
    ),
  );
  return new Set(ready.flatMap((app) => (app ? [app.connectionId] : [])));
}

export async function googleAppCredentials(
  tx: DbTx,
  scope: Scope,
  connectionId?: string,
) {
  const candidates = (await googleAppGrants(tx, scope))
    .map(({ connection }) => connection.id)
    .filter((id) => !connectionId || id === connectionId)
    .sort();
  let invalid = false;
  for (const id of candidates) {
    const app = await readGoogleApp(tx, id).catch((error) => {
      if (
        !(error instanceof DomainError) ||
        error.code !== "SEO_GOOGLE_APP_INVALID"
      )
        throw error;
      invalid = true;
      return null;
    });
    if (app) return app;
  }
  if (invalid) throw new DomainError("SEO_GOOGLE_APP_INVALID", 422);
  throw new DomainError("SEO_GOOGLE_APP_NOT_GRANTED", 409);
}

export function googleRedirectUri() {
  return new URL(GOOGLE_SEARCH_CONSOLE_CALLBACK, loadConfig().APP_ORIGIN).href;
}
