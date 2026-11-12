import {
  INTEGRATION_CATEGORIES,
  type IntegrationAuthType,
  type IntegrationCategory,
  type IntegrationStorage,
} from "../connections/integrations.ts";
import { centralPathEnabled, providerScopes } from "../connections/connections.ts";
import {
  moduleAvailable,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredIntegrationDescriptors,
} from "../modules/contributions.ts";

// The Integrations Center catalog (ADR 0027): every integration that has code,
// whether or not anything is set up. Facts about the code and this
// installation (its switches), the same for every signed-in member; no
// secrets, no state of any record.

export type CatalogEntry = {
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  scopes: Array<"system" | "workspace" | "project">;
  checkable: boolean;
  storage: IntegrationStorage[];
  available: boolean;
  /**
   * Whether its central connections work in this installation: central
   * storage, ORBIT_CONNECTIONS on and, for a provider that also keeps project
   * connections, the provider in ORBIT_CONNECTIONS_CUTOVER. An entry stored
   * centrally only is unavailable without it.
   */
  centralUsable: boolean;
  /** "platform" or the module id. */
  owner: string;
};

/** Available unless it is stored centrally only and the central path is off. */
const reachable = (storage: readonly IntegrationStorage[], centralUsable: boolean) =>
  centralUsable || !(storage.length === 1 && storage[0] === "central");

const centralUsableOf = (id: string, storage: readonly IntegrationStorage[]) =>
  storage.includes("central") && centralPathEnabled(id, storage.includes("project"));

export function integrationCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const id of registeredConnectionProviderIds()) {
    const def = registeredConnectionProvider(id)!;
    const scopes = [...providerScopes(def)];
    const storage: IntegrationStorage[] = [];
    if (scopes.includes("system") || scopes.includes("workspace")) storage.push("central");
    if (scopes.includes("project")) storage.push("project");
    const centralUsable = centralUsableOf(id, storage);
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
      available: moduleAvailable(def.owner) && reachable(storage, centralUsable),
      centralUsable,
      owner: def.owner,
    });
  }
  for (const d of registeredIntegrationDescriptors()) {
    const centralUsable = centralUsableOf(d.id, d.storage);
    entries.push({
      id: d.id,
      label: d.label,
      category: d.category,
      authType: d.authType,
      scopes: [...d.scopes],
      checkable: d.checkable,
      storage: [...d.storage],
      available:
        moduleAvailable(d.owner) && (d.available?.() ?? true) && reachable(d.storage, centralUsable),
      centralUsable,
      owner: d.owner,
    });
  }
  return entries.sort(
    (a, b) =>
      INTEGRATION_CATEGORIES.indexOf(a.category) - INTEGRATION_CATEGORIES.indexOf(b.category) ||
      a.label.en.localeCompare(b.label.en),
  );
}

/**
 * The catalog ids whose project records only project owners may read
 * (descriptors with `visibleTo: "owner"`); providers are readable by every
 * member. Internal: the public catalog does not carry it.
 */
export function ownerOnlyIntegrationIds(): Set<string> {
  return new Set(
    registeredIntegrationDescriptors()
      .filter((d) => d.visibleTo === "owner")
      .map((d) => d.id),
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
