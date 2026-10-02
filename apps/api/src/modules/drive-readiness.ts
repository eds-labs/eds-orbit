import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, list } from "../shared.ts";

/**
 * Drive readiness from recorded state only. A rejected OAuth refresh is
 * persisted on the connection by the Drive adapter, so dashboards report it
 * without calling Google on every load.
 */
export function driveReconnectRequired(
  connection: { data: unknown } | null | undefined,
) {
  const value = data(connection);
  return Boolean(value.encryptedRefreshToken && value.lastRefreshFailedAt);
}

/** Inline bytes are kept locally; only Drive-referenced assets need Drive. */
export function isDriveOnlyAsset(asset: Record<string, any>) {
  return Boolean(asset.driveFileId && !asset.base64);
}

// Mission states that can still produce or publish content (see lifecycle).
const runningMissionStates = ["ready", "awaiting_followup"];

/**
 * True when enabled autopilot settings or a running mission reference an
 * asset whose bytes exist only in Drive, so scheduled and live posts read
 * Drive at publish time.
 */
export async function publishingUsesDriveAssets(tx: DbTx, scope: Scope) {
  const ids = new Set<string>();
  const autopilot = data((await list(tx, scope, "autopilot_settings"))[0]);
  if (autopilot.enabled === true)
    for (const id of autopilot.assetIds ?? []) ids.add(id);
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
