import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  encrypt,
  entity,
  exception,
  list,
  update,
} from "../../../shared.ts";
import {
  checkPostizQueue,
  nextPostizQueueCheckAt,
  POSTIZ_QUEUE_CHECK_MS,
} from "./postiz-queue-watch.ts";
import { forcePublishingBackend } from "../../../../tests/support/marketing-backend.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("Postiz queue watch with a real database", () => {
  let scope: Scope, workspaceId: string, userId: string;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  const start = new Date("2026-10-02T08:00:00.000Z");
  const queued = (minutesAgo: number, integration = "telegram-1") => ({
    id: "post-" + minutesAgo + "-" + integration,
    state: "QUEUE",
    publishDate: new Date(start.valueOf() - minutesAgo * 60_000).toISOString(),
    integration: { id: integration },
  });
  let response: () => Promise<unknown[]>;
  const ranges: { startDate: string; endDate: string }[] = [];
  const deps = {
    createClient: () => ({
      listPosts: async (range: { startDate: string; endDate: string }) => {
        ranges.push(range);
        return (await response()) as any;
      },
    }),
  };
  const exceptions = () =>
    run(async (tx) =>
      (await list(tx, scope, "exceptions")).map((e) => ({
        code: data(e).code,
        status: data(e).status,
        title: data(e).title,
      })),
    );

  beforeAll(async () => {
    userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        email: userId + "@example.invalid",
        name: "Postiz queue watch fixture",
      },
    });
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Isolated Postiz queue watch",
          members: { create: { userId, role: "owner" } },
        },
      })
    ).id;
    const project = await authDb.project.create({
      data: { workspaceId, name: "Postiz queue watch fixture" },
    });
    scope = { workspaceId, projectId: project.id, userId, role: "owner" };
  });
  afterAll(async () => {
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    if (userId) await authDb.user.delete({ where: { id: userId } });
    await closeDatabase();
  });

  it("does nothing without a Postiz connector with assigned channels", async () => {
    response = async () => [queued(60)];
    expect(await checkPostizQueue(scope, start, deps)).toEqual({
      checked: false,
    });
    expect(ranges).toEqual([]);
    expect(await run((tx) => nextPostizQueueCheckAt(tx, scope))).toBeNull();
  });

  it("opens one exception for an overdue queue and closes it once Postiz delivers", async () => {
    await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "postiz",
        baseUrl: "https://postiz.example.invalid/public/v1",
        status: "write_verified",
        encryptedCredential: encrypt(
          "synthetic-no-live-token",
          process.env.CREDENTIAL_KEY!,
        ),
        channels: [
          { id: "telegram-1", identifier: "telegram", name: "Desk" },
          { id: "facebook-1", identifier: "facebook", name: "Other" },
        ],
        assignedIntegrationIds: ["telegram-1"],
      }),
    );
    // Only the unassigned channel is late: no alarm.
    response = async () => [queued(60, "facebook-1"), queued(5)];
    expect(await checkPostizQueue(scope, start, deps)).toEqual({
      checked: true,
      status: "ok",
      overdue: 0,
    });
    expect(await exceptions()).toEqual([]);
    expect(Date.parse(ranges[0].endDate)).toBe(start.valueOf());

    // Within the interval the check is skipped, so the API budget is kept.
    expect(
      await checkPostizQueue(
        scope,
        new Date(start.valueOf() + POSTIZ_QUEUE_CHECK_MS - 1000),
        deps,
      ),
    ).toEqual({ checked: false });
    expect(
      (await run((tx) => nextPostizQueueCheckAt(tx, scope)))?.toISOString(),
    ).toBe(new Date(start.valueOf() + POSTIZ_QUEUE_CHECK_MS).toISOString());

    const second = new Date(start.valueOf() + POSTIZ_QUEUE_CHECK_MS);
    response = async () => [queued(60), queued(30)];
    expect(await checkPostizQueue(scope, second, deps)).toEqual({
      checked: true,
      status: "stalled",
      overdue: 2,
    });
    const third = new Date(second.valueOf() + POSTIZ_QUEUE_CHECK_MS);
    expect(await checkPostizQueue(scope, third, deps)).toMatchObject({
      status: "stalled",
    });
    expect(await exceptions()).toEqual([
      {
        code: "POSTIZ_QUEUE_STALLED",
        status: "open",
        title: "Postiz is not sending scheduled posts",
      },
    ]);

    response = async () => [];
    const fourth = new Date(third.valueOf() + POSTIZ_QUEUE_CHECK_MS);
    expect(await checkPostizQueue(scope, fourth, deps)).toMatchObject({
      status: "ok",
    });
    expect(await exceptions()).toEqual([
      {
        code: "POSTIZ_QUEUE_STALLED",
        status: "resolved",
        title: "Postiz is not sending scheduled posts",
      },
    ]);
  });

  it("records an unreadable Postiz without throwing and resolves it on the next success", async () => {
    const base = new Date(start.valueOf() + 10 * POSTIZ_QUEUE_CHECK_MS);
    response = async () => {
      throw new Error("network down");
    };
    expect(await checkPostizQueue(scope, base, deps)).toEqual({
      checked: true,
      status: "unavailable",
      overdue: 0,
    });
    expect((await exceptions()).filter((e) => e.status === "open")).toEqual([
      {
        code: "POSTIZ_QUEUE_CHECK_FAILED",
        status: "open",
        title: "Orbit cannot read the Postiz queue",
      },
    ]);
    response = async () => [];
    await checkPostizQueue(
      scope,
      new Date(base.valueOf() + POSTIZ_QUEUE_CHECK_MS),
      deps,
    );
    expect((await exceptions()).filter((e) => e.status === "open")).toEqual([]);
  });

  describe("on the Social backend (WP1)", () => {
    const notices = () =>
      run(async (tx) =>
        (await list(tx, scope, "exceptions")).map((e): Record<string, any> => ({
          ...data(e),
          id: e.id,
          version: e.version,
        })),
      );
    const writes = () =>
      run(async (tx) => ({
        versions: await tx.entityVersion.count({
          where: { projectId: scope.projectId },
        }),
        audits: await tx.auditEvent.count({
          where: { projectId: scope.projectId },
        }),
        publications: await tx.socialPublication.count({
          where: { projectId: scope.projectId },
        }),
      }));
    const backend = (value: "postiz" | "postiz_draining" | "social") =>
      run((tx) => forcePublishingBackend(tx, scope, value));

    it("stops without a Postiz backlog: no Postiz call, no next check, its open notices resolved once", async () => {
      const base = new Date(start.valueOf() + 20 * POSTIZ_QUEUE_CHECK_MS);
      response = async () => {
        throw new Error("network down");
      };
      await checkPostizQueue(scope, base, deps);
      await checkPostizQueue(
        scope,
        new Date(base.valueOf() + POSTIZ_QUEUE_CHECK_MS),
        deps,
      );
      // Another notice of the project stays open whatever the backend.
      await run((tx) =>
        exception(tx, scope, "REMOTE_POST_MISSING", randomUUID()),
      );
      const failed = (await notices()).find(
        (e) => e.code === "POSTIZ_QUEUE_CHECK_FAILED" && e.status === "open",
      )!;
      expect(failed.count).toBe(2);

      await backend("social");
      const calls = ranges.length;
      const later = new Date(base.valueOf() + 5 * POSTIZ_QUEUE_CHECK_MS);
      expect(await checkPostizQueue(scope, later, deps)).toEqual({
        checked: false,
      });
      expect(ranges.length).toBe(calls);
      expect(await run((tx) => nextPostizQueueCheckAt(tx, scope))).toBeNull();
      const after = await notices();
      expect(after.find((e) => e.id === failed.id)).toMatchObject({
        status: "resolved",
        resolvedBy: scope.userId,
        resolution: "publishing_backend_social",
        resolvedAt: expect.any(String),
        count: 2,
        title: "Orbit cannot read the Postiz queue",
      });
      expect(
        after.filter((e) => e.status === "open").map((e) => e.code),
      ).toEqual(["REMOTE_POST_MISSING"]);
      const history = await run(async (tx) => ({
        audits: await tx.auditEvent.findMany({
          where: {
            projectId: scope.projectId,
            action: "marketing.postiz_queue_notice_resolved",
          },
        }),
        version: await tx.entityVersion.findFirstOrThrow({
          where: { entityId: failed.id },
          orderBy: { version: "desc" },
        }),
      }));
      expect(history.audits.map((a) => [a.resourceId, a.metadata])).toEqual([
        [
          failed.id,
          {
            code: "POSTIZ_QUEUE_CHECK_FAILED",
            count: 2,
            reason: "publishing_backend_social",
          },
        ],
      ]);
      expect(history.version).toMatchObject({
        version: failed.version + 1,
        data: expect.objectContaining({ status: "resolved" }),
      });

      // Later passes find nothing to do and write nothing.
      const before = await writes();
      expect(
        await checkPostizQueue(
          scope,
          new Date(later.valueOf() + 3 * POSTIZ_QUEUE_CHECK_MS),
          deps,
        ),
      ).toEqual({ checked: false });
      expect(await writes()).toEqual(before);
      expect(ranges.length).toBe(calls);
    });

    it("keeps watching with a Postiz backlog, while draining and on Postiz, and reopens nothing", async () => {
      // Still on Social, but Postiz holds a scheduled post of the project.
      const pending = await run((tx) =>
        create(tx, scope, "publications", {
          channel: "telegram-1",
          status: "scheduled_remote",
          scheduledAt: start.toISOString(),
          test: false,
        }),
      );
      const sends = (await writes()).publications;
      response = async () => [];
      let at = new Date(start.valueOf() + 40 * POSTIZ_QUEUE_CHECK_MS);
      expect(
        await run((tx) => nextPostizQueueCheckAt(tx, scope)),
      ).not.toBeNull();
      expect(await checkPostizQueue(scope, at, deps)).toEqual({
        checked: true,
        status: "ok",
        overdue: 0,
      });
      await run(async (tx) =>
        update(tx, scope, await entity(tx, scope, "publications", pending.id), {
          ...data(pending),
          status: "canceled",
        }),
      );
      for (const value of ["postiz_draining", "postiz"] as const) {
        await backend(value);
        at = new Date(at.valueOf() + POSTIZ_QUEUE_CHECK_MS);
        expect(await checkPostizQueue(scope, at, deps)).toMatchObject({
          checked: true,
          status: "ok",
        });
      }
      // The rollback reopened nothing: resolved notices stay resolved.
      expect(
        (await notices())
          .filter((e) => String(e.code).startsWith("POSTIZ_QUEUE_"))
          .map((e) => e.status),
      ).not.toContain("open");
      expect((await writes()).publications).toBe(sends);
    });
  });
});
