import type { ConnectionProvider } from "../../../platform/connections/connections.ts";
import { DomainError } from "../../../shared.ts";
import { metaAppSecret, parseAppSecret } from "./apps.ts";
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

const account = (en: string, de: string): ConnectionProvider => ({
  scopes: ["project"],
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
    check: checkMetaApp,
  },
  "social.app.x": {
    scopes: ["system"],
    purposes: ["social_oauth"],
    label: { en: "X app", de: "X-App" },
    checkUnsupported: "SOCIAL_APP_NOT_CHECKABLE",
  },
  "social.account.x": account("X account", "X-Konto"),
  "social.account.facebook": account("Facebook Page", "Facebook-Seite"),
  "social.account.instagram": account("Instagram account", "Instagram-Konto"),
  "social.account.telegram": account("Telegram channel", "Telegram-Kanal"),
};
