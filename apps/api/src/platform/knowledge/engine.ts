import type { DbTx } from "../../../../../packages/db/src/index.ts";
import * as engine from "../../../../../packages/knowledge/src/index.ts";
import type {
  FactData,
  FactInput,
  IngestInput,
  Scope,
  SourceData,
} from "../../../../../packages/knowledge/src/index.ts";
import { registeredImpactHandlers } from "../modules/contributions.ts";

/**
 * The knowledge engine's changing operations with every registered impact
 * handler bound (WP3.1). Callers use these, never the engine directly, so a
 * change always invalidates the records modules built on it; without
 * registered modules they fail closed (MODULE_CONTRIBUTIONS_NOT_REGISTERED).
 */
export const ingest = (tx: DbTx, s: Scope, input: IngestInput) =>
  engine.ingest(tx, s, registeredImpactHandlers(), input);
export const setFact = (tx: DbTx, s: Scope, input: FactInput) =>
  engine.setFact(tx, s, registeredImpactHandlers(), input);
export const withdrawFact = (
  tx: DbTx,
  s: Scope,
  id: string,
  expectedVersion: number,
) =>
  engine.withdrawFact(tx, s, registeredImpactHandlers(), id, expectedVersion);
export const revokeSource = (tx: DbTx, s: Scope, sourceId: string) =>
  engine.revokeSource(tx, s, registeredImpactHandlers(), sourceId);
/**
 * A source's rights or settings change (new generation, dependents
 * invalidated), then its stored documents move to that generation, so the
 * source stays searchable under its new rules without a new import
 * (plans/knowledge-indexing-repair.md).
 */
export const setSourceRights = async (
  tx: DbTx,
  s: Scope,
  id: string,
  changes: Parameters<typeof engine.setSourceRights>[4],
) => {
  const changed = await engine.setSourceRights(
    tx,
    s,
    registeredImpactHandlers(),
    id,
    changes,
  );
  const reindexed = await engine.restampSource(tx, s, id);
  return { ...changed, reindexRequired: false, reindexed };
};
/**
 * Confirms a stored fact again, under its source's current generation.
 * `value` replaces the text; everything else stays as recorded, and a former
 * withdrawal is cleared. The earlier state remains in the version history.
 */
export const reverifyFact = (
  tx: DbTx,
  s: Scope,
  id: string,
  d: FactData,
  value = d.value,
) =>
  setFact(tx, s, {
    id,
    key: d.key,
    value,
    valueType: d.valueType,
    ...(d.currency ? { currency: d.currency } : {}),
    ...(d.unit ? { unit: d.unit } : {}),
    language: d.language,
    ...(d.market ? { market: d.market } : {}),
    sourceId: d.sourceId,
    validFrom: d.validFrom,
    ...(d.validUntil ? { validUntil: d.validUntil } : {}),
    status: "verified",
    publicUse: d.publicUse,
    modelUse: d.modelUse,
  });
/**
 * Lifts a source's pause. `setSourceRights` moves the documents to the new
 * generation; retrieval also compares each fact's generation, so the source's
 * verified facts have to follow or they would stay hidden.
 */
export const resumeSource = async (tx: DbTx, s: Scope, id: string) => {
  const resumed = await setSourceRights(tx, s, id, { paused: false });
  const where = { workspaceId: s.workspaceId, projectId: s.projectId };
  const source = await tx.entity.findFirst({
    where: { ...where, id, kind: "sources" },
  });
  // Generated content is never evidence: its facts cannot be confirmed again.
  if ((source?.data as unknown as SourceData)?.authority === "generated")
    return resumed;
  const facts = await tx.entity.findMany({
    where: { ...where, kind: "facts" },
  });
  for (const fact of facts) {
    const d = fact.data as unknown as FactData;
    if (
      d.sourceId === id &&
      d.status === "verified" &&
      d.sourceGeneration !== resumed.generation
    )
      await reverifyFact(tx, s, fact.id, d);
  }
  return resumed;
};
/** Moves a source's stored documents to its current generation (idempotent). */
export const restampSource = (tx: DbTx, s: Scope, id: string) =>
  engine.restampSource(tx, s, id);
export const setSourceAudiences = (
  tx: DbTx,
  s: Scope,
  id: string,
  audiences: readonly string[],
) =>
  engine.setSourceAudiences(tx, s, registeredImpactHandlers(), id, audiences);
export const revokeDocument = (
  tx: DbTx,
  s: Scope,
  documentId: string,
  versionId?: string,
) =>
  engine.revokeDocument(
    tx,
    s,
    registeredImpactHandlers(),
    documentId,
    versionId,
  );
