import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";

const drive = vi.hoisted(() => ({
  enabled: false,
  saved: [] as string[],
  failed: [] as string[],
  failSave: new Set<string>(),
}));
vi.mock("../src/platform/connections/google-drive.ts", async (original) => ({
  ...(await original<
    typeof import("../src/platform/connections/google-drive.ts")
  >()),
  connectionStatus: vi.fn(async () => ({ enabled: drive.enabled })),
}));
vi.mock("../src/modules/marketing/brand/drive-assets.ts", async (original) => ({
  ...(await original<
    typeof import("../src/modules/marketing/brand/drive-assets.ts")
  >()),
  saveGeneratedAsset: vi.fn(async (_scope: Scope, id: string) => {
    drive.saved.push(id);
    if (drive.failSave.has(id)) throw new Error("DRIVE_UPLOAD_FAILED");
  }),
  markSyncFailed: vi.fn(async (_scope: Scope, id: string) => {
    drive.failed.push(id);
  }),
}));
import { driveAssetRetry } from "../src/modules/marketing/brand/drive-retry.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const MINUTE = 60000;

/**
 * The Drive retry of generated images (WP2.5d), a marketing periodic task
 * since it left the worker's pass: due assets only, at most three per pass
 * and five attempts each, one check per 30 seconds, and the next retry time
 * as the project's wake-up.
 */
describe.skipIf(!enabled)("Drive retry of generated images", () => {
  const users: string[] = [];
  let workspaceId = "";
  const project = async () => {
    const id = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic Drive retry" },
      })
    ).id;
    return {
      workspaceId,
      projectId: id,
      userId: "worker",
      role: "owner",
    } as Scope;
  };
  const asset = (scope: Scope, retryAt: number, attempts = 1) =>
    scoped(scope.workspaceId, scope.projectId, (tx) =>
      create(tx, scope, "assets", {
        name: "Synthetic generated image",
        driveSyncStatus: "FAILED",
        driveRetryAttempts: attempts,
        driveRetryAt: new Date(retryAt).toISOString(),
      }),
    );

  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic Drive owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(user.id);
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic Drive retry",
          members: { create: { userId: user.id, role: "owner" } },
        },
      })
    ).id;
  });
  afterAll(async () => {
    if (workspaceId)
      await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("does nothing without a Drive connection", async () => {
    const scope = await project();
    await asset(scope, Date.now() - MINUTE);
    drive.enabled = false;
    expect(await driveAssetRetry.run(scope)).toBeUndefined();
    expect(drive.saved).toEqual([]);
  });

  it("retries due assets once per check and wakes the project for the next", async () => {
    const scope = await project();
    drive.enabled = true;
    drive.saved.length = 0;
    drive.failed.length = 0;
    const due = await asset(scope, Date.now() - MINUTE);
    const broken = await asset(scope, Date.now() - 2 * MINUTE);
    drive.failSave.add(broken.id);
    const later = Date.now() + 10 * MINUTE;
    await asset(scope, later);
    // Five attempts are the limit.
    await asset(scope, Date.now() - MINUTE, 5);

    const first = await driveAssetRetry.run(scope);
    expect(drive.saved.sort()).toEqual([due.id, broken.id].sort());
    expect(drive.failed).toEqual([broken.id]);
    expect(first).toEqual({ wakeAt: new Date(later) });

    // Within 30 seconds nothing is checked again; the wake-up stays.
    expect(await driveAssetRetry.run(scope)).toEqual(first);
    expect(drive.saved).toHaveLength(2);
  });
});
