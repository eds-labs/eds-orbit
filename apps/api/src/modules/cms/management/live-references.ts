import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { refused, UUID_RE } from "../entries/common.ts";
import { assetIsLive } from "../media/public-media.ts";

// Authors, terms and asset texts are read live by the delivery API: a change
// reaches every website showing them without a revision or an approval. A
// member may make that change in Orbit (like other shared settings); an API
// key, which may only ever propose publications (ADR 0029 §4.6), may not
// change what live content shows. It may still change unused ones.

async function revisionUses(tx: DbTx, scope: Pick<Scope, "projectId">, column: "authorIds" | "termIds", id: string) {
  const rows =
    column === "authorIds"
      ? await tx.$queryRaw<Array<{ live: number }>>`
          SELECT 1 AS live FROM "CmsEntry" e JOIN "CmsRevision" r ON r.id = e."publishedRevisionId"
          WHERE e."projectId" = ${scope.projectId}::uuid AND ${id}::uuid = ANY (r."authorIds") LIMIT 1`
      : await tx.$queryRaw<Array<{ live: number }>>`
          SELECT 1 AS live FROM "CmsEntry" e JOIN "CmsRevision" r ON r.id = e."publishedRevisionId"
          WHERE e."projectId" = ${scope.projectId}::uuid AND ${id}::uuid = ANY (r."termIds") LIMIT 1`;
  return rows.length > 0;
}

/** 409 CMS_LIVE_REFERENCE when live content shows the author, term or asset. */
export async function refuseLiveReference(tx: DbTx, scope: Pick<Scope, "projectId">, kind: "author" | "term" | "asset", id: string) {
  if (!UUID_RE.test(id)) return;
  const live =
    kind === "asset"
      ? await assetIsLive(tx, scope, id)
      : await revisionUses(tx, scope, kind === "author" ? "authorIds" : "termIds", id);
  if (live) throw refused("CMS_LIVE_REFERENCE", 409, { kind });
}
