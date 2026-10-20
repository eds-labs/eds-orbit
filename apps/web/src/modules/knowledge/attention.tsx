import type { AttentionRenderer, Label } from "@/platform/shell/types";

// The knowledge module's attention texts (UI restructure §4.3). A source item
// names its source; beyond the first few, one aggregated item per kind counts
// the rest without names (ruling R18). The home page shows the time.

const CHECK: Label = { en: "Check", de: "Prüfen" };

/**
 * A stale or expiring source: "<one> · <name>" for a single source, or the
 * count of the further ones for the aggregated item (no name).
 */
const source =
  (one: Label, more: (n: number) => Label): AttentionRenderer =>
  (item, locale) => {
    const name = String(item.params.name ?? "").trim();
    return {
      title: name
        ? `${one[locale]} · ${name}`
        : item.count !== undefined
          ? more(item.count)[locale]
          : one[locale],
      action: CHECK,
    };
  };

export const knowledgeAttention: Readonly<Record<string, AttentionRenderer>> = {
  knowledge_source_stale: source(
    { en: "Source out of date", de: "Quelle veraltet" },
    (n) => ({
      en: `${n} more source${n === 1 ? "" : "s"} out of date`,
      de: `${n} ${n === 1 ? "weitere Quelle" : "weitere Quellen"} veraltet`,
    }),
  ),
  knowledge_source_expiring: source(
    { en: "Source expires soon", de: "Quelle läuft bald ab" },
    (n) => ({
      en: `${n} more source${n === 1 ? " expires" : "s expire"} soon`,
      de: `${n} ${n === 1 ? "weitere Quelle läuft" : "weitere Quellen laufen"} bald ab`,
    }),
  ),
  knowledge_review_pending: (item, locale) => ({
    title:
      locale === "de"
        ? `${item.count ?? 1} Erkenntnisse zu prüfen`
        : `${item.count ?? 1} findings to review`,
    action: { en: "Review", de: "Prüfen" },
  }),
  knowledge_conflicts: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${n === 1 ? "widersprüchlicher Fakt" : "widersprüchliche Fakten"}`
          : `${n} conflicting fact${n === 1 ? "" : "s"}`,
      action: { en: "Resolve", de: "Klären" },
    };
  },
  knowledge_import_failed: (item, locale) => {
    const n = item.count ?? 1;
    return {
      title:
        locale === "de"
          ? `${n} ${n === 1 ? "Import" : "Importe"} fehlgeschlagen`
          : `${n} import${n === 1 ? "" : "s"} failed`,
      action: { en: "Show", de: "Anzeigen" },
    };
  },
};
