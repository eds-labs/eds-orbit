import type { ConnectionProvider } from "../../../platform/connections/connections.ts";
import type { IntegrationAuthType } from "../../../platform/connections/integrations.ts";
import { DomainError } from "../../../shared.ts";
import { metaAppSecret, parseAppSecret, xAppSecret } from "./apps.ts";
import { socialFetch } from "./http.ts";
import { META_GRAPH } from "./meta.ts";

// The social module's connection providers (ADR 0020): developer apps are
// system connections in the administration; each connected account is a
// project connection the module manages itself (project-secrets.ts).

async function checkMetaApp(_connection: Record<string, unknown>, credential: string) {
  const app = parseAppSecret(metaAppSecret, credential);
  let response: Response;
  try {
    // The app token goes in a header, so it never appears in a URL or log.
    response = await socialFetch(`${META_GRAPH}/${app.appId}?fields=id,name`, {
      headers: { Authorization: `Bearer ${app.appId}|${app.appSecret}`, Accept: "application/json" },
    });
  } catch {
    throw new DomainError("SOCIAL_APP_CHECK_FAILED", 409);
  }
  if (!response.ok) throw new DomainError("SOCIAL_APP_CHECK_FAILED", 409);
  return { status: "read_verified", capabilities: ["social_oauth"] };
}

/** Refuses a malformed app secret when it is entered (422, no echo). */
const validator = (schema: Parameters<typeof parseAppSecret>[0]) => (secret: string) => {
  try {
    parseAppSecret(schema, secret);
  } catch {
    throw new DomainError("SOCIAL_APP_INVALID", 422);
  }
};

const account = (en: string, de: string, authType: IntegrationAuthType = "oauth_account"): ConnectionProvider => ({
  scopes: ["project"],
  category: "social",
  authType,
  managedByModule: true,
  purposes: ["social_publish"],
  label: { en, de },
  checkUnsupported: "SOCIAL_ACCOUNT_CHECK_IN_MODULE",
});

export const socialConnectionProviders: Record<string, ConnectionProvider> = {
  "social.app.meta": {
    scopes: ["system"],
    purposes: ["social_oauth"],
    label: { en: "Meta app (Facebook and Instagram)", de: "Meta-App (Facebook und Instagram)" },
    category: "social",
    check: checkMetaApp,
    callbackPath: "/api/social/oauth/callback/meta",
    secretFields: [
      {
        key: "appId",
        label: { en: "App ID", de: "App-ID" },
        pattern: "\\d{5,20}",
        hint: {
          en: "Meta for Developers → your app → App settings → Basic.",
          de: "Meta for Developers → deine App → App-Einstellungen → Allgemeines.",
        },
      },
      {
        key: "appSecret",
        label: { en: "App secret", de: "App-Secret" },
        secret: true,
        pattern: ".{16,200}",
        hint: { en: "On the same page, behind “Show”.", de: "Auf derselben Seite hinter „Anzeigen“." },
      },
      {
        key: "configId",
        label: { en: "Configuration ID", de: "Konfigurations-ID" },
        pattern: "\\d{5,20}",
        hint: {
          en: "Facebook Login for Business → Configurations: the configuration with the page and Instagram permissions.",
          de: "Facebook Login for Business → Konfigurationen: die Konfiguration mit den Seiten- und Instagram-Berechtigungen.",
        },
      },
    ],
    validateSecret: validator(metaAppSecret),
  },
  "social.app.x": {
    scopes: ["system"],
    purposes: ["social_oauth"],
    label: { en: "X app", de: "X-App" },
    category: "social",
    checkUnsupported: "SOCIAL_APP_NOT_CHECKABLE",
    callbackPath: "/api/social/oauth/callback/x",
    secretFields: [
      {
        key: "clientId",
        label: { en: "Client ID", de: "Client-ID" },
        pattern: ".{10,200}",
        hint: {
          en: "X developer portal → your app → Keys and tokens → OAuth 2.0 Client ID and Client Secret (not the API key).",
          de: "X Developer Portal → deine App → Keys and tokens → OAuth 2.0 Client ID and Client Secret (nicht der API Key).",
        },
      },
      {
        key: "clientSecret",
        label: { en: "Client secret", de: "Client-Secret" },
        secret: true,
        pattern: ".{10,200}",
      },
    ],
    validateSecret: validator(xAppSecret),
  },
  "social.account.x": account("X account", "X-Konto"),
  "social.account.facebook": account("Facebook Page", "Facebook-Seite"),
  "social.account.instagram": account("Instagram account", "Instagram-Konto"),
  "social.account.telegram": account("Telegram channel", "Telegram-Kanal", "bot_token"),
};
