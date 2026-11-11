import {
  INTEGRATION_CATEGORIES,
  type IntegrationAuthType,
  type IntegrationCategory,
  type IntegrationStorage,
} from "../connections/integrations.ts";
import { providerScopes } from "../connections/connections.ts";
import {
  moduleAvailable,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredIntegrationDescriptors,
} from "../modules/contributions.ts";

// The Integrations Center catalog (ADR 0027): every integration that has code,
// whether or not anything is set up. Static facts only; no secrets, no state.

export type CatalogEntry = {
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  scopes: Array<"system" | "workspace" | "project">;
  checkable: boolean;
  storage: IntegrationStorage[];
  available: boolean;
  /** "platform" or the module id. */
  owner: string;
};

export function integrationCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const id of registeredConnectionProviderIds()) {
    const def = registeredConnectionProvider(id)!;
    const scopes = [...providerScopes(def)];
    const storage: IntegrationStorage[] = [];
    if (scopes.includes("system") || scopes.includes("workspace")) storage.push("central");
    if (scopes.includes("project")) storage.push("project");
    entries.push({
      id,
      label: def.label ?? { en: id, de: id },
      // Defaults are applied here, not at registration (see ConnectionProvider).
      category: def.category ?? "other",
      authType:
        def.authType ??
        (def.callbackPath ? "oauth_app" : def.secretFields?.length ? "json_secret" : "api_key"),
      scopes,
      checkable: Boolean(def.check),
      storage,
      available: moduleAvailable(def.owner),
      owner: def.owner,
    });
  }
  for (const d of registeredIntegrationDescriptors())
    entries.push({
      id: d.id,
      label: d.label,
      category: d.category,
      authType: d.authType,
      scopes: [...d.scopes],
      checkable: d.checkable,
      storage: [...d.storage],
      available: moduleAvailable(d.owner) && (d.available?.() ?? true),
      owner: d.owner,
    });
  return entries.sort(
    (a, b) =>
      INTEGRATION_CATEGORIES.indexOf(a.category) - INTEGRATION_CATEGORIES.indexOf(b.category) ||
      a.label.en.localeCompare(b.label.en),
  );
}

/** Every catalog id with its category; build it once per request, not per item. */
export function catalogCategories(): Map<string, IntegrationCategory> {
  return new Map(integrationCatalog().map((e) => [e.id, e.category]));
}

/** The category of a provider or descriptor id; "other" when unknown. */
export function catalogCategory(id: string): IntegrationCategory {
  return catalogCategories().get(id) ?? "other";
}
