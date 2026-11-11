import { z } from "zod";
import type { ConnectionProvider } from "../../../platform/connections/connections.ts";
import { DomainError } from "../../../shared.ts";
import { createMetaGraphClient } from "../providers/meta/graph.ts";
import { parseMetaAdsAppSecret } from "./app.ts";

// The ads module's connection providers (ADR 0025): the Meta developer app
// is a system connection in the administration; each project's Meta token
// is a project connection the module manages itself (project-secrets.ts).

const appProbe = z.object({ id: z.string(), name: z.string().optional() }).passthrough();

async function checkMetaApp(_connection: Record<string, unknown>, credential: string) {
  const app = parseMetaAdsAppSecret(credential);
  try {
    // App token in the Authorization header with appsecret_proof, so no
    // secret appears in a URL or log.
    const graph = createMetaGraphClient({ accessToken: `${app.appId}|${app.appSecret}`, appSecret: app.appSecret });
    await graph.get(`/${app.appId}`, { fields: "id,name" }, appProbe);
  } catch {
    throw new DomainError("ADS_META_APP_CHECK_FAILED", 409);
  }
  return { status: "read_verified", capabilities: ["ads_oauth"] };
}

/** Refuses a malformed app secret when it is entered (422, no echo). */
function validateMetaAppSecret(secret: string) {
  try {
    parseMetaAdsAppSecret(secret);
  } catch {
    throw new DomainError("ADS_META_APP_INVALID", 422);
  }
}

export const adsConnectionProviders: Record<string, ConnectionProvider> = {
  "ads.app.meta": {
    scopes: ["system"],
    purposes: ["ads_oauth"],
    label: { en: "Meta app for ads", de: "Meta-App für Werbung" },
    check: checkMetaApp,
    callbackPath: "/api/ads/oauth/callback/meta",
    secretFields: [
      {
        key: "appId",
        label: { en: "App ID", de: "App-ID" },
        pattern: "\\d{5,20}",
        hint: {
          en: "Meta for Developers → the ads app → App settings → Basic.",
          de: "Meta for Developers → die Werbe-App → App-Einstellungen → Allgemeines.",
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
          en: "Facebook Login for Business → Configurations: the ads configuration with the ads_management and ads_read permissions (not the social one).",
          de: "Facebook Login for Business → Konfigurationen: die Werbe-Konfiguration mit den Berechtigungen ads_management und ads_read (nicht die Social-Konfiguration).",
        },
      },
    ],
    validateSecret: validateMetaAppSecret,
  },
  "ads.account.meta": {
    scopes: ["project"],
    managedByModule: true,
    purposes: ["ads_manage"],
    label: { en: "Meta ad access", de: "Meta-Werbezugang" },
    checkUnsupported: "ADS_CONNECTION_CHECK_IN_MODULE",
  },
};
