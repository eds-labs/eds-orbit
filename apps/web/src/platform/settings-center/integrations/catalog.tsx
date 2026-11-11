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

/** Whether the scope lists the entry at all, available or not. */
export const inScope = (entry: CatalogEntry, scope: ScopeKind): boolean => {
  const environment = entry.storage.includes("environment");
  switch (scope) {
    // Installation items belong to the system only; organizations and
    // projects never list them.
    case "system":
      return entry.scopes.includes("system") || environment;
    case "organization":
      return !environment && entry.scopes.includes("workspace");
    // A granted AI key or GitHub App shows its state in the project too.
    case "project":
      return (
        !environment &&
        (entry.scopes.includes("project") || entry.scopes.includes("workspace"))
      );
    default:
      return false;
  }
};

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
  setupHrefOf,
  extra,
  locale,
}: {
  groups: ReturnType<typeof catalogGroups>;
  /** available === false, shown in the "not available yet" group. */
  unavailable: readonly CatalogEntry[];
  recordsOf(entryId: string): readonly CardRecord[];
  manageHrefOf(entry: CatalogEntry): string | null;
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
          <h2>{categoryLabel(group.category, locale)}</h2>
          <div className="integration-grid">
            {group.entries.map((entry) => (
              <ProviderCard
                key={entry.id}
                entry={entry}
                records={recordsOf(entry.id)}
                manageHref={manageHrefOf(entry)}
                setupHref={setupHrefOf(entry)}
                locale={locale}
              />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h2>{text("notAvailableYet")}</h2>
        <div className="integration-grid">
          {unavailable.map((entry) => (
            // An unavailable entry's card says it is switched off and offers nothing.
            <ProviderCard
              key={entry.id}
              entry={entry}
              records={[]}
              manageHref={null}
              setupHref={null}
              locale={locale}
            />
          ))}
          {NOT_AVAILABLE_YET.map((item) => (
            <article className="integration-card" key={item.id} data-provider={item.id}>
              <h3>{item.label[locale] || item.label.en}</h3>
              <p>{text("notAvailableBody")}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
