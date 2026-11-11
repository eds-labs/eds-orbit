import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import type { Label } from "@/platform/shell/types";
import type { ScopeKind } from "../types";
import { ProviderCard } from "./provider-card";
import { categoryLabel, integrationText } from "./texts";
import {
  INTEGRATION_CATEGORIES,
  type CardRecord,
  type CatalogEntry,
  type IntegrationCategory,
  type ManageNote,
} from "./types";

/** Planned integrations that have no provider yet; never shown as usable. */
export const NOT_AVAILABLE_YET: ReadonlyArray<{ id: string; label: Label }> = [
  { id: "tiktok", label: { en: "TikTok", de: "TikTok" } },
  {
    id: "external_mcp",
    label: {
      en: "MCP servers of other providers",
      de: "MCP-Server anderer Anbieter",
    },
  },
];

// A value of a newer API must not break the page: a non-array counts as empty.
export const storageOf = (entry: CatalogEntry): readonly string[] =>
  Array.isArray(entry.storage) ? entry.storage : [];
export const scopesOf = (entry: CatalogEntry): readonly string[] =>
  Array.isArray(entry.scopes) ? entry.scopes : [];

/**
 * Whether a member can act on the entry's central connections here: central
 * storage that this installation can use (`centralUsable`; absent in an older
 * answer counts as usable). An entry with central and project storage whose
 * central path is off behaves exactly like a project-only entry.
 */
export const centralPath = (entry: CatalogEntry): boolean =>
  storageOf(entry).includes("central") && entry.centralUsable !== false;

/** Whether the scope lists the entry at all, available or not. */
export const inScope = (entry: CatalogEntry, scope: ScopeKind): boolean => {
  const scopes = scopesOf(entry);
  const environment = storageOf(entry).includes("environment");
  switch (scope) {
    // Installation items belong to the system only; organizations and
    // projects never list them.
    case "system":
      return scopes.includes("system") || environment;
    case "organization":
      return !environment && scopes.includes("workspace");
    // A granted AI key or GitHub App shows its state in the project too.
    case "project":
      return (
        !environment &&
        (scopes.includes("project") || scopes.includes("workspace"))
      );
    default:
      return false;
  }
};

/**
 * What the guided setup offers in a scope: available entries the scope can
 * configure itself. The system and an organization configure central
 * connections, so only where the installation can use them; a project never
 * gets an entry the member cannot use there (`unavailable` of the project
 * answer). A planned provider without code is never in the catalog, so it
 * never gets a setup.
 */
export function setupOffers(
  entries: readonly CatalogEntry[],
  scope: ScopeKind,
  unavailable: readonly string[] = [],
): CatalogEntry[] {
  return entries.filter((e) => {
    // A value of a newer API must not break the page; it just offers nothing.
    const scopes = scopesOf(e);
    const storage = storageOf(e);
    if (!e.available || unavailable.includes(e.id)) return false;
    switch (scope) {
      case "system":
        return scopes.includes("system") && centralPath(e);
      case "organization":
        return scopes.includes("workspace") && centralPath(e);
      case "project":
        return scopes.includes("project") && !storage.includes("environment");
      default:
        return false;
    }
  });
}

/** Available entries of the scope grouped by category, in vocabulary order. */
export function catalogGroups(
  entries: readonly CatalogEntry[],
  scope: ScopeKind,
): Array<{ category: IntegrationCategory; entries: CatalogEntry[] }> {
  const visible = entries.filter((e) => e.available && inScope(e, scope));
  const known = (e: CatalogEntry) =>
    (INTEGRATION_CATEGORIES as readonly string[]).includes(e.category);
  return INTEGRATION_CATEGORIES.map((category) => ({
    category,
    entries: [
      ...visible.filter((e) => e.category === category),
      // A category newer than this build must not hide the entry; it joins
      // "other" after the known ones.
      ...(category === "other" ? visible.filter((e) => !known(e)) : []),
    ],
  })).filter((group) => group.entries.length > 0);
}

export function CatalogView({
  groups,
  unavailable,
  recordsOf,
  manageHrefOf,
  manageNoteOf,
  setupHrefOf,
  extra,
  locale,
}: {
  groups: ReturnType<typeof catalogGroups>;
  /** available === false, shown in the "not available yet" group. */
  unavailable: readonly CatalogEntry[];
  recordsOf(entryId: string): readonly CardRecord[];
  manageHrefOf(entry: CatalogEntry): string | null;
  /** Why a card has no Manage link (scopes.tsx `manageNote`). */
  manageNoteOf(entry: CatalogEntry): ManageNote | null;
  setupHrefOf(entry: CatalogEntry): string | null;
  /** Environment panel (system scope). */
  extra?: ReactNode;
  locale: Locale;
}) {
  const text = integrationText(locale);
  return (
    <div className="integration-catalog">
      {extra}
      {groups.map((group) => (
        <section key={group.category}>
          <h3>{categoryLabel(group.category, locale)}</h3>
          <div className="integration-grid">
            {group.entries.map((entry) => (
              <ProviderCard
                key={entry.id}
                entry={entry}
                records={recordsOf(entry.id)}
                manageHref={manageHrefOf(entry)}
                manageNote={manageNoteOf(entry)}
                setupHref={setupHrefOf(entry)}
                locale={locale}
              />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3>{text("notAvailableYet")}</h3>
        <div className="integration-grid">
          {unavailable.map((entry) => (
            // An unavailable entry's card says it is switched off and offers nothing.
            <ProviderCard
              key={entry.id}
              entry={entry}
              records={[]}
              manageHref={null}
              manageNote={null}
              setupHref={null}
              locale={locale}
            />
          ))}
          {NOT_AVAILABLE_YET.map((item) => (
            <article className="integration-card" key={item.id} data-provider={item.id}>
              <h4>{item.label[locale] || item.label.en}</h4>
              <p>{text("notAvailableBody")}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
