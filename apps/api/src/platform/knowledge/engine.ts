import type { DbTx } from "../../../../../packages/db/src/index.ts";
import * as engine from "../../../../../packages/knowledge/src/index.ts";
import type {
  FactInput,
  IngestInput,
  Scope,
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
