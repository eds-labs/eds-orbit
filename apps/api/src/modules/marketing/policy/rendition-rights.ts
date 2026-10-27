import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";
import { isApprovedAsset } from "../brand/asset-rules.ts";

/**
 * Whether a creative rendition (an asset bound to its creative) still rests
 * on approved components (R36): every component recorded in its
 * `rightsSource` (logo, art, product) is still approved in this project and
 * still has the SHA-256 it was composed from. A new version with the same
 * bytes, e.g. approved again, holds; a rendition without recorded components
 * or hashes cannot be shown to hold.
 */
export async function renditionComponentsHold(
  tx: DbTx,
  scope: Scope,
  rendition: Record<string, any>,
): Promise<boolean> {
  const recorded: unknown = rendition.rightsSource?.components;
  if (!Array.isArray(recorded) || recorded.length === 0) return false;
  const components = recorded.map((c) =>
    typeof c?.assetId === "string" &&
    typeof c.sha256 === "string" &&
    c.sha256 !== ""
      ? { assetId: c.assetId, sha256: c.sha256.toLowerCase() }
      : null,
  );
  if (components.some((c) => c === null)) return false;
  const rows = await tx.entity.findMany({
    where: {
      id: { in: [...new Set(components.map((c) => c!.assetId))] },
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  const current = new Map(rows.map((row) => [row.id, data(row)]));
  return components.every((c) => {
    const now = current.get(c!.assetId);
    return (
      !!now &&
      isApprovedAsset(now) &&
      String(now.sha256 ?? "").toLowerCase() === c!.sha256
    );
  });
}
