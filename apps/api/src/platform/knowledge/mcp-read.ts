import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  eligiblePassage,
  KnowledgeError,
  servesConsumer,
  type EvidenceData,
  type SourceData,
} from "../../../../../packages/knowledge/src/index.ts";
import { data, DomainError, entity } from "../shared.ts";
import { usableFactsByIds } from "./facts.ts";
import { queryReservationKey } from "./retrieval.ts";
import {
  knowledgeSearch,
  type SearchBudget,
  type SearchTrace,
} from "./search.ts";

/**
 * The knowledge reads behind the MCP `search` and `fetch` tools (Track M
 * WP-M3, plans/orbit-modularization/09 §5.2). Everything they return is what
 * `retrieve(forModel: true, purpose: "internal")` without a consumer module
 * could return (D-M3-4): sources open to all modules only. Since 2026-10-23
 * (Mario) the MCP read surface needs the model right only, not the public
 * one: an internal, model-approved source is readable by the member's own
 * model client but never becomes public evidence (its evidence is internal,
 * so validateEvidence never reports it public-ready). A fetch of an
 * unknown or ineligible id answers the same NOT_FOUND, never the reason.
 */

/** A search hit that `fetchChunkForModel` or `fetchFactForModel` resolves. */
export type KnowledgeHit =
  | {
      kind: "chunk";
      chunkId: string;
      documentVersionId: string;
      sourceId: string;
      title: string;
      canonicalUrl: string | null;
    }
  | {
      kind: "fact";
      factId: string;
      sourceId: string;
      key: string;
      canonicalUrl: string | null;
    };

/**
 * The most a fetched version text carries (D-M3-8), measured as it is sent:
 * the UTF-8 bytes of its JSON-escaped form (D-M5-6). With the title, URL
 * and ids a fetch result then stays below the gateway's 64 KB cap however
 * many characters need escaping.
 */
export const FETCH_TEXT_MAX_BYTES = 48 * 1024;

/**
 * Failures of the paid path that happen before anything is reserved
 * (D-M3-3): the search then runs lexically instead.
 */
const PRE_SPEND_FAILURES = new Set([
  "POLICY_REQUIRED",
  "PAID_MANDATE_EXPIRED",
  "BUDGET_NOT_APPROVED",
  "BUDGET_EXCEEDED",
  "RUN_BUDGET_EXCEEDED",
  "PROJECT_PAUSED",
  "NO_ACTIVE_EMBEDDING_INDEX",
  "OPENAI_API_KEY_REQUIRED",
]);

/**
 * Price-configuration failures of the cost estimate (plain errors that carry
 * the code as their message): the paid path stops at them before it reserves
 * anything, so they fall back to lexical as well.
 */
const PRE_SPEND_PRICE_FAILURES = new Set([
  "VERIFIED_PRICE_CONFIGURATION_REQUIRED",
  "CURRENT_PRICE_REQUIRED",
]);

const notFound = () => new DomainError("NOT_FOUND", 404);

/** Whether `error` is one of the failures the paid path raises before any spend. */
function isPreSpendCode(error: unknown) {
  if (error instanceof DomainError || error instanceof KnowledgeError)
    return PRE_SPEND_FAILURES.has(error.code);
  return error instanceof Error && PRE_SPEND_PRICE_FAILURES.has(error.message);
}

const searchResult = z.object({
  retrieval: z.object({
    mode: z.enum(["hybrid", "lexical_degraded"]),
    evidenceId: z.uuid(),
  }),
  facts: z.array(
    z.object({ id: z.uuid(), sourceId: z.uuid(), key: z.string() }),
  ),
  passages: z.array(
    z.object({ chunkId: z.uuid(), sourceId: z.uuid(), title: z.string() }),
  ),
});

async function isPreSpendFailure(
  scope: Scope,
  error: unknown,
  budget: SearchBudget,
) {
  if (!isPreSpendCode(error)) return false;
  // Never after a reservation exists, whatever the code says.
  const reserved = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.budgetReservation.count({
      where: {
        projectId: scope.projectId,
        key: `${scope.projectId}:${queryReservationKey(budget.retrievalJobKey)}`,
      },
    }),
  );
  return reserved === 0;
}

/**
 * Searches the project's model-eligible knowledge. With `budget` it tries
 * the paid hybrid retrieval, attributed to `trace`'s run, and falls back to
 * the lexical retrieval when that fails before any spend; without, it runs
 * lexically. `mode` says which retrieval answered.
 */
export async function searchForModel(
  scope: Scope,
  query: string,
  options: { budget: SearchBudget | null; trace?: SearchTrace },
): Promise<{ mode: "hybrid" | "lexical_degraded"; hits: KnowledgeHit[] }> {
  let outcome: Awaited<ReturnType<typeof knowledgeSearch>> | undefined;
  if (options.budget) {
    try {
      outcome = await knowledgeSearch(
        scope,
        { query },
        options.budget,
        undefined,
        options.trace,
        { shared: false, purpose: "internal" },
      );
    } catch (error) {
      if (!(await isPreSpendFailure(scope, error, options.budget))) throw error;
    }
  }
  outcome ??= await knowledgeSearch(
    scope,
    { query },
    undefined,
    undefined,
    undefined,
    { shared: false, purpose: "internal" },
  );
  const result = searchResult.parse(outcome.result);
  const { items, usable } = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const evidence = data(
        await entity(tx, scope, "evidence", result.retrieval.evidenceId),
      ) as EvidenceData;
      return {
        items: new Map(evidence.items.map((item) => [item.chunkId, item])),
        usable: await modelFacts(
          tx,
          scope,
          result.facts.map((fact) => fact.id),
        ),
      };
    },
  );
  const hits: KnowledgeHit[] = [
    // Retrieval returns every verified copy; only facts a fetch resolves
    // (K-1: copies of a key must agree) become hits.
    ...result.facts.flatMap((fact): KnowledgeHit[] =>
      usable.has(fact.id)
        ? [
            {
              kind: "fact",
              factId: fact.id,
              sourceId: fact.sourceId,
              key: fact.key,
              // Sources carry no canonical URL of their own.
              canonicalUrl: null,
            },
          ]
        : [],
    ),
    ...result.passages.flatMap((passage): KnowledgeHit[] => {
      const item = items.get(passage.chunkId);
      // Fail closed: a passage the evidence does not vouch for is dropped.
      if (!item || item.modelUse !== true) return [];
      return [
        {
          kind: "chunk",
          chunkId: passage.chunkId,
          documentVersionId: item.documentVersionId,
          sourceId: passage.sourceId,
          title: passage.title,
          canonicalUrl: item.canonicalUrl,
        },
      ];
    }),
  ];
  return { mode: result.retrieval.mode, hits };
}

/**
 * The UTF-8 bytes the code unit(s) at `index` take inside a JSON string, as
 * JSON.stringify writes them, and how many code units they are.
 */
function jsonUnit(text: string, index: number): [bytes: number, units: number] {
  const code = text.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return [2, 1];
  if (code < 0x20)
    // \b \t \n \f \r have short escapes; other controls are \u00XX.
    return [[8, 9, 10, 12, 13].includes(code) ? 2 : 6, 1];
  if (code < 0x80) return [1, 1];
  if (code < 0x800) return [2, 1];
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [4, 2];
  }
  // A lone surrogate is escaped as \uXXXX (well-formed JSON.stringify).
  if (code >= 0xd800 && code <= 0xdfff) return [6, 1];
  return [3, 1];
}

/** The UTF-8 length of `text` JSON-escaped, without the surrounding quotes. */
export function jsonTextBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const [size, units] = jsonUnit(text, index);
    bytes += size;
    index += units;
  }
  return bytes;
}

/**
 * The longest prefix of `text` whose JSON-escaped UTF-8 form fits
 * `maxBytes`, ending on a character boundary (never inside a surrogate pair).
 */
export function clipJsonText(text: string, maxBytes: number): string {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const [size, units] = jsonUnit(text, index);
    if (bytes + size > maxBytes) return text.slice(0, index);
    bytes += size;
    index += units;
  }
  return text;
}

async function projectLanguage(tx: DbTx, scope: Scope) {
  const project = await tx.project.findFirstOrThrow({
    where: { workspaceId: scope.workspaceId, id: scope.projectId },
    select: { language: true },
  });
  return project.language;
}

/**
 * The facts among `ids` a model may see: usable under K-1 now, in the
 * project's language and the global market (projects have no market of
 * their own), from a source open to all modules, as `retrieve` without a
 * consumer requires (K-1 itself does not look at audiences).
 */
export async function modelFacts(
  tx: DbTx,
  scope: Scope,
  ids: readonly string[],
) {
  const usable = await usableFactsByIds(tx, scope, ids, {
    at: new Date(),
    language: await projectLanguage(tx, scope),
    purpose: "internal",
  });
  const sourceIds = [
    ...new Set([...usable.values()].map((row) => String(data(row).sourceId))),
  ];
  const open = new Set(
    (
      await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "sources",
          id: { in: sourceIds },
        },
      })
    )
      .filter((source) =>
        servesConsumer((source.data as unknown as SourceData).audiences),
      )
      .map((source) => source.id),
  );
  for (const [id, row] of usable)
    if (!open.has(String(data(row).sourceId))) usable.delete(id);
  return usable;
}

/**
 * A chunk's document version text (the active version, at most
 * FETCH_TEXT_MAX_BYTES of JSON text), only when the chunk passes every rule
 * `retrieve(forModel: true, purpose: "internal")` applies, through the
 * engine's own eligibility query. `truncated` says whether text was left out.
 */
export async function fetchChunkForModel(
  scope: Scope,
  chunkId: string,
): Promise<{
  title: string;
  text: string;
  truncated: boolean;
  documentVersionId: string;
  sourceId: string;
  canonicalUrl: string | null;
  fetchedAt: string;
}> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const passage = await eligiblePassage(
      tx,
      scope,
      chunkId,
      {
        at: new Date(),
        language: await projectLanguage(tx, scope),
        purpose: "internal",
        forModel: true,
      },
      FETCH_TEXT_MAX_BYTES,
    );
    if (!passage) throw notFound();
    // The query returns at most FETCH_TEXT_MAX_BYTES characters, and every
    // character takes at least one byte, so the clip below is the only cut
    // unless the version is longer than that.
    const text = clipJsonText(passage.text, FETCH_TEXT_MAX_BYTES);
    return {
      title: passage.title,
      text,
      truncated:
        text.length < passage.text.length ||
        passage.textBytes > Buffer.byteLength(passage.text, "utf8"),
      documentVersionId: passage.documentVersionId,
      sourceId: passage.sourceId,
      canonicalUrl: passage.canonicalUrl,
      fetchedAt: passage.fetchedAt.toISOString(),
    };
  });
}

/** A Verified Fact a model may see (`modelFacts`), as `key: value` with its unit and currency. */
export async function fetchFactForModel(
  scope: Scope,
  factId: string,
): Promise<{
  key: string;
  value: string;
  unit?: string;
  currency?: string;
  sourceId: string;
  canonicalUrl: string | null;
}> {
  if (!z.uuid().safeParse(factId).success) throw notFound();
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = (await modelFacts(tx, scope, [factId])).get(factId);
    if (!row) throw notFound();
    const fact = data(row);
    return {
      key: String(fact.key),
      value: String(fact.value),
      ...(fact.unit ? { unit: String(fact.unit) } : {}),
      ...(fact.currency ? { currency: String(fact.currency) } : {}),
      sourceId: String(fact.sourceId),
      canonicalUrl: null,
    };
  });
}
