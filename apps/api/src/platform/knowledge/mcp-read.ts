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
 * `retrieve(forModel: true, purpose: "public")` without a consumer module
 * could return (D-M3-4): sources open to all modules only. A fetch of an
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

/** The most a fetched version text carries (D-M3-8; the gateway caps at 64 KB). */
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

const notFound = () => new DomainError("NOT_FOUND", 404);

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
  if (
    !(error instanceof DomainError || error instanceof KnowledgeError) ||
    !PRE_SPEND_FAILURES.has(error.code)
  )
    return false;
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
      );
    } catch (error) {
      if (!(await isPreSpendFailure(scope, error, options.budget))) throw error;
    }
  }
  outcome ??= await knowledgeSearch(scope, { query });
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
      if (!item || item.publicUse !== true || item.modelUse !== true) return [];
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

/** The longest prefix of `text` that fits `maxBytes` in UTF-8, ending on a character boundary. */
function clipUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // bytes[end] is the first byte left out; a continuation byte there means
  // the character started before the limit, so it is left out whole.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
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
async function modelFacts(tx: DbTx, scope: Scope, ids: readonly string[]) {
  const usable = await usableFactsByIds(tx, scope, ids, {
    at: new Date(),
    language: await projectLanguage(tx, scope),
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
 * A chunk's document version text (the active version, at most 48 KB),
 * only when the chunk passes every rule `retrieve(forModel: true, purpose:
 * "public")` applies, through the engine's own eligibility query.
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
        purpose: "public",
        forModel: true,
      },
      FETCH_TEXT_MAX_BYTES,
    );
    if (!passage) throw notFound();
    return {
      title: passage.title,
      text: clipUtf8(passage.text, FETCH_TEXT_MAX_BYTES),
      truncated: passage.textBytes > FETCH_TEXT_MAX_BYTES,
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
