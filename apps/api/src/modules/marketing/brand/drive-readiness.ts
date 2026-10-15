import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, list } from "../../../shared.ts";

// Connection state belongs to the platform's Drive connection (WP2.1f).
export { driveReconnectRequired } from "../../../platform/connections/google-drive.ts";

/** Inline bytes are kept locally; only Drive-referenced assets need Drive. */
export function isDriveOnlyAsset(asset: Record<string, any>) {
  return Boolean(asset.driveFileId && !asset.base64);
}

// Mission states that can still produce or publish content (see lifecycle).
const runningMissionStates = ["ready", "awaiting_followup"];

/**
 * True when a running mission references an asset whose bytes exist only in
 * Drive, so scheduled and live posts read Drive at publish time.
 */
export async function publishingUsesDriveAssets(tx: DbTx, scope: Scope) {
  const ids = new Set<string>();
  for (const mission of await list(tx, scope, "missions"))
    if (runningMissionStates.includes(data(mission).status))
      for (const id of data(mission).assetIds ?? []) ids.add(id);
  if (!ids.size) return false;
  const assets = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      id: { in: [...ids] },
    },
  });
  return assets.some((asset) => isDriveOnlyAsset(data(asset)));
}
