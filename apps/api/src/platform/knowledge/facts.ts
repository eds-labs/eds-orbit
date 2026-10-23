import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { sourceData } from "../../../../../packages/knowledge/src/index.ts";
import { data, DomainError, hash, list } from "../shared.ts";

type FactRow = Awaited<ReturnType<typeof list>>[number];

/** Where usable facts are wanted: the moment, the content language, the market. */
export type FactQuery = {
  at: Date;
  language: string;
  market?: string;
  /**
   * "public" (K-1, the default): facts that may reach a public text.
   * "internal": facts a model may read without publishing them (the MCP
   * read surface); the public right is then not required.
   */
  purpose?: "public" | "internal";
};

/**
 * Whether a fact's source lets it reach a public, model-written text: the
 * engine's retrieval rules (active source with a valid policy, not
 * generated, public, not embargoed, model use allowed) and the fact from the
 * source's current generation. K-1 (plans/orbit-modularization/05 §5).
 */
function sourceAllows(
  fact: Record<string, any>,
  sources: ReadonlyMap<string, unknown>,
  at: Date,
  internal = false,
) {
  if (!sources.has(String(fact.sourceId))) return false;
  try {
    const source = sourceData(sources.get(String(fact.sourceId)));
    return (
      source.authority !== "generated" &&
      (internal ||
        (source.publicUse === true &&
          !(
            source.embargoUntil &&
            Date.parse(source.embargoUntil) > at.valueOf()
          ))) &&
      source.modelUse === true &&
      fact.sourceGeneration === source.generation
    );
  } catch {
    return false;
  }
}

function usableCopies(
  facts: FactRow[],
  sources: ReadonlyMap<string, unknown>,
  key: string,
  { at, language, market = "global", purpose = "public" }: FactQuery,
) {
  const internal = purpose === "internal";
  return facts.filter((row) => {
    const f = data(row);
    return (
      f.key === key &&
      f.status === "verified" &&
      (internal || f.publicUse === true) &&
      f.modelUse === true &&
      Date.parse(f.validFrom) <= at.valueOf() &&
      (!f.validUntil || Date.parse(f.validUntil) > at.valueOf()) &&
      f.language === language &&
      (f.market ?? "global") === market &&
      sourceAllows(f, sources, at, internal)
    );
  });
}

/** The one usable Verified Fact of a key; throws when there is none or the copies disagree. */
function usableFact(
  facts: FactRow[],
  sources: ReadonlyMap<string, unknown>,
  key: string,
  query: FactQuery,
) {
  const usable = usableCopies(facts, sources, key, query);
  if (!usable.length) throw new DomainError("FACT_NOT_USABLE", 409);
  // Copies with the same statement (for example from an import that ran
  // twice) are no contradiction: the newest copy is used. Differing values block.
  const statement = (row: (typeof usable)[number]) => {
    const f = data(row);
    return hash([f.value, f.valueType, f.unit, f.currency, f.language]);
  };
  if (new Set(usable.map(statement)).size > 1)
    throw new DomainError("FACT_CONFLICT", 409);
  // Deterministic, so a rebuilt plan picks the same copy.
  return [...usable].sort(
    (a, b) =>
      b.createdAt.valueOf() - a.createdAt.valueOf() || b.id.localeCompare(a.id),
  )[0]!;
}

async function factsAndSources(tx: DbTx, scope: Scope) {
  const [facts, sources] = await Promise.all([
    list(tx, scope, "facts"),
    list(tx, scope, "sources"),
  ]);
  return {
    facts,
    sources: new Map(sources.map((row) => [row.id, row.data as unknown])),
  };
}

/** Each key needs exactly one usable Verified Fact (FACTS_REQUIRED, FACT_NOT_USABLE, FACT_CONFLICT). */
export async function usableFacts(
  tx: DbTx,
  scope: Scope,
  keys: readonly string[],
  query: FactQuery,
) {
  if (!keys.length) throw new DomainError("FACTS_REQUIRED", 409);
  const { facts, sources } = await factsAndSources(tx, scope);
  return [...new Set(keys)].map((key) =>
    usableFact(facts, sources, key, query),
  );
}

/** Every key with a usable Verified Fact, sorted by key; a key whose copies disagree is left out. */
export async function listUsableFacts(
  tx: DbTx,
  scope: Scope,
  query: FactQuery,
) {
  const { facts, sources } = await factsAndSources(tx, scope);
  const keys = [...new Set(facts.map((row) => String(data(row).key)))].sort();
  return keys.flatMap((key) => {
    try {
      return [usableFact(facts, sources, key, query)];
    } catch (error) {
      if (error instanceof DomainError) return [];
      throw error;
    }
  });
}

/**
 * The facts among `ids` that are usable under K-1: each a usable copy of a
 * key whose usable copies agree. Unknown ids and facts that are not usable
 * for any reason are left out alike.
 */
export async function usableFactsByIds(
  tx: DbTx,
  scope: Scope,
  ids: readonly string[],
  query: FactQuery,
) {
  const usable = new Map<string, FactRow>();
  if (!ids.length) return usable;
  const { facts, sources } = await factsAndSources(tx, scope);
  for (const id of new Set(ids)) {
    const row = facts.find((candidate) => candidate.id === id);
    if (!row) continue;
    const key = String(data(row).key);
    if (
      !usableCopies(facts, sources, key, query).some((copy) => copy.id === id)
    )
      continue;
    try {
      usableFact(facts, sources, key, query);
    } catch (error) {
      if (error instanceof DomainError) continue;
      throw error;
    }
    usable.set(id, row);
  }
  return usable;
}
