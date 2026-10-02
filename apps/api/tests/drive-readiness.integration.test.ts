import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, update } from "../src/shared.ts";
import { readiness } from "../src/modules/readiness.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// Regression for 2026-10-01: a revoked Drive refresh token left drive_save
// "ready" while autopilot posts depended on Drive-only assets.
describe.skipIf(!enabled)("Drive reconnect readiness on PostgreSQL", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope;
  const run = <T>(fn: (tx: any) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn, db);
  beforeEach(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic Drive readiness",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const p = await auth.project.create({
      data: { workspaceId: w.id, name: "Drive readiness" },
    });
    scope = {
      workspaceId: w.id,
      projectId: p.id,
      userId: user.id,
      role: "owner",
    };
  });
  afterEach(async () => {
    await db.$disconnect();
    await auth.$disconnect();
  });

  it("reports a Drive blocker from the recorded refresh failure", async () => {
    const connection = await run((tx) =>
      create(tx, scope, "drive_connection", {
        account: "owner@example.invalid",
        encryptedRefreshToken: "synthetic-ciphertext",
        connectedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    await run((tx) =>
      create(tx, scope, "drive_storage", {
        rootFolderId: "rootFolderABC123",
        enabled: true,
      }),
    );
    const asset = await run((tx) =>
      create(tx, scope, "assets", {
        name: "Approved Drive PNG",
        mime: "image/png",
        driveFileId: "driveFileABC123",
        usageApproved: true,
        assetStatus: "approved",
      }),
    );
    await run((tx) =>
      create(tx, scope, "autopilot_settings", {
        enabled: true,
        channels: ["test-social"],
        factKeys: ["synthetic"],
        assetIds: [asset.id],
      }),
    );
    const healthy = await run((tx) => readiness(tx, scope));
    expect(healthy.actions.drive_save.blockers).not.toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
    expect(healthy.blockers).not.toContain("GOOGLE_DRIVE_RECONNECT_REQUIRED");

    await run(async (tx) =>
      update(tx, scope, connection, {
        ...data(connection),
        lastRefreshFailedAt: "2026-10-01T08:00:00.000Z",
        lastRefreshErrorCode: "invalid_grant",
      }),
    );
    const broken = await run((tx) => readiness(tx, scope));
    // The state also depends on whether the OAuth client is configured here.
    expect(broken.actions.drive_save.state).not.toBe("ready");
    expect(broken.actions.drive_save.blockers).toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
    for (const action of ["postiz_live", "postiz_schedule"] as const)
      expect(broken.actions[action].blockers).toContain(
        "GOOGLE_DRIVE_RECONNECT_REQUIRED",
      );
    expect(broken.blockers).toContain("GOOGLE_DRIVE_RECONNECT_REQUIRED");
    expect(broken.state).not.toBe("live_ready");
  });

  it("keeps publishing unblocked when no Drive-only asset is in use", async () => {
    await run((tx) =>
      create(tx, scope, "drive_connection", {
        encryptedRefreshToken: "synthetic-ciphertext",
        lastRefreshFailedAt: "2026-10-01T08:00:00.000Z",
        lastRefreshErrorCode: "invalid_grant",
      }),
    );
    const result = await run((tx) => readiness(tx, scope));
    expect(result.actions.drive_save.blockers).toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
    expect(result.actions.postiz_live.blockers).not.toContain(
      "GOOGLE_DRIVE_RECONNECT_REQUIRED",
    );
    expect(result.blockers).not.toContain("GOOGLE_DRIVE_RECONNECT_REQUIRED");
  });
});
