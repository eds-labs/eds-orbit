import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, data, encrypt } from "../shared.ts";
import {
  configureMatomoSchedule,
  runScheduledMatomo,
} from "./matomo-schedule.ts";
import { archiveMission } from "./mission-archive.ts";
import { sweepProject } from "./lifecycle.ts";
import {
  archiveConversation,
  createConversation,
  listConversations,
} from "./chat.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("archiving missions and chats", () => {
  let scope: Scope, workspaceId: string, userId: string;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  beforeAll(async () => {
    userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        email: userId + "@example.invalid",
        name: "Archive fixture",
      },
    });
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Isolated archive",
          members: { create: { userId, role: "owner" } },
        },
      })
    ).id;
    const project = await authDb.project.create({
      data: { workspaceId, name: "Archive fixture" },
    });
    scope = { workspaceId, projectId: project.id, userId, role: "owner" };
  });
  afterAll(async () => {
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    if (userId) await authDb.user.delete({ where: { id: userId } });
    await closeDatabase();
  });

  it("hides an archived mission from planning and restores its status", async () => {
    const mission = await run((tx) =>
      create(tx, scope, "missions", {
        title: "Archive me",
        status: "ready",
        startAt: new Date(Date.now() - 3600000).toISOString(),
        endAt: new Date(Date.now() + 86400000).toISOString(),
        channels: ["test"],
        maxContents: 1,
      }),
    );
    await expect(
      run((tx) =>
        archiveMission(
          tx,
          { ...scope, role: "editor" },
          {
            missionId: mission.id,
            version: mission.version,
            archived: true,
          },
        ),
      ),
    ).rejects.toThrow("OWNER_REQUIRED");
    const archived = await run((tx) =>
      archiveMission(tx, scope, {
        missionId: mission.id,
        version: mission.version,
        archived: true,
      }),
    );
    expect(data(archived)).toMatchObject({
      status: "archived",
      statusBeforeArchive: "ready",
    });
    expect(await run((tx) => sweepProject(tx, scope))).toMatchObject({
      queued: 0,
    });
    const restored = await run((tx) =>
      archiveMission(tx, scope, {
        missionId: mission.id,
        version: archived.version,
        archived: false,
      }),
    );
    expect(data(restored).status).toBe("ready");
    expect(data(restored).statusBeforeArchive).toBeUndefined();
  });

  it("refuses to archive a mission with a running job", async () => {
    const mission = await run((tx) =>
      create(tx, scope, "missions", { title: "Busy", status: "completed" }),
    );
    await run((tx) =>
      create(tx, scope, "jobs", {
        topic: "generation",
        resourceId: mission.id,
        status: "running",
      }),
    );
    await expect(
      run((tx) =>
        archiveMission(tx, scope, {
          missionId: mission.id,
          version: mission.version,
          archived: true,
        }),
      ),
    ).rejects.toThrow("MISSION_RUN_IN_PROGRESS");
  });

  it("archives a chat for its user only and lists it separately", async () => {
    const first = await createConversation(scope);
    const second = await createConversation(scope);
    await archiveConversation(scope, first.id, { archived: true });
    const active = await listConversations(scope);
    const archived = await listConversations(scope, undefined, true);
    expect(active.items.map((c) => c.id)).toContain(second.id);
    expect(active.items.map((c) => c.id)).not.toContain(first.id);
    expect(archived.items.map((c) => c.id)).toEqual([first.id]);
    await archiveConversation(scope, first.id, { archived: false });
    expect((await listConversations(scope)).items.map((c) => c.id)).toContain(
      first.id,
    );
    expect((await listConversations(scope, undefined, true)).items).toEqual([]);
  });
  it("runs saved Matomo imports at most every 12 hours and records failures", async () => {
    const connector = await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "matomo",
        status: "read_verified",
        siteId: 3,
        baseUrl: "https://matomo.example.invalid",
        encryptedCredential: encrypt("synthetic", process.env.CREDENTIAL_KEY!),
      }),
    );
    const input = {
      enabled: true,
      connectorId: connector.id,
      siteId: 3,
      siteTimezone: "Europe/Berlin",
      currency: "EUR",
      methods: ["VisitsSummary.get"],
    };
    await expect(
      run((tx) => configureMatomoSchedule(tx, scope, { ...input, siteId: 4 })),
    ).rejects.toThrow("MATOMO_CONNECTOR_SCOPE");
    await run((tx) => configureMatomoSchedule(tx, scope, input));
    vi.stubEnv("CREDENTIAL_KEY", "");
    const now = new Date("2026-10-01T06:00:00Z");
    expect(await runScheduledMatomo(scope, now)).toEqual({
      ran: true,
      failed: 2,
    });
    expect(
      await runScheduledMatomo(scope, new Date(now.valueOf() + 3600_000)),
    ).toEqual({ ran: false });
    expect(
      await runScheduledMatomo(scope, new Date(now.valueOf() + 12 * 3600_000)),
    ).toMatchObject({ ran: true });
    vi.unstubAllEnvs();
    const failures = await run((tx) =>
      tx.entity.count({
        where: {
          projectId: scope.projectId,
          kind: "exceptions",
          data: { path: ["code"], equals: "MATOMO_SCHEDULED_IMPORT_FAILED" },
        },
      }),
    );
    expect(failures).toBeGreaterThan(0);
  });
});
