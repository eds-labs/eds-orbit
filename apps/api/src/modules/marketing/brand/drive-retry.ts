import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { connectionStatus } from "../../../platform/connections/google-drive.ts";
import { data } from "../../../shared.ts";
import { markSyncFailed, saveGeneratedAsset } from "./drive-assets.ts";

// One check per project at most this often; a project without Drive costs no transaction per tick.
const DRIVE_CHECK_MS = 30_000;
const checks = new Map<
  string,
  { at: number; enabled: boolean; nextRetryAt: number | null }
>();

/**
 * Retries saving generated images to Drive whose upload failed (WP2.5d):
 * up to three due assets per pass, five attempts each. Moved unchanged from
 * the worker's pass; the next retry time wakes the project again.
 */
export const driveAssetRetry: PeriodicTask = {
  name: "drive-asset-retry",
  async run(scope) {
    let drive = checks.get(scope.projectId);
    if (!drive || Date.now() - drive.at > DRIVE_CHECK_MS) {
      drive = {
        at: Date.now(),
        enabled: (await connectionStatus(scope)).enabled,
        nextRetryAt: null,
      };
      checks.set(scope.projectId, drive);
      if (drive.enabled) {
        const failed = await scoped(scope.workspaceId, scope.projectId, (tx) =>
          tx.entity.findMany({
            where: {
              projectId: scope.projectId,
              kind: "assets",
              data: { path: ["driveSyncStatus"], equals: "FAILED" },
            },
            take: 30,
            orderBy: { updatedAt: "asc" },
          }),
        );
        const pending = failed.filter(
          (row) =>
            data(row).driveSyncStatus === "FAILED" &&
            Number(data(row).driveRetryAttempts ?? 0) < 5,
        );
        const due = pending.filter(
          (row) => Date.parse(data(row).driveRetryAt ?? "") <= Date.now(),
        );
        for (const asset of due.slice(0, 3)) {
          try {
            await saveGeneratedAsset(scope, asset.id);
          } catch {
            await markSyncFailed(scope, asset.id);
          }
        }
        const retryTimes = pending
          .filter((row) => !due.slice(0, 3).includes(row))
          .map((row) => Date.parse(data(row).driveRetryAt ?? ""))
          .filter(Number.isFinite);
        if (retryTimes.length) drive.nextRetryAt = Math.min(...retryTimes);
      }
    }
    return drive.enabled && drive.nextRetryAt !== null
      ? {
          wakeAt: new Date(
            Math.max(drive.nextRetryAt, drive.at + DRIVE_CHECK_MS),
          ),
        }
      : undefined;
  },
};
