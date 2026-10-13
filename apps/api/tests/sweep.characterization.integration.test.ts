import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import { nextSweepAt, sweepProject } from "../src/modules/lifecycle.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Characterization (WP0.4, plans/orbit-modularization/04 §4.1 cut 4): the
 * entity and outbox effects of one sweepProject run and the next due time,
 * with Orbit Agents on and off. WP1.6 splits the sweep into module scheduler
 * contributions; these snapshots must stay unchanged by that split.
 */
const AT = new Date("2026-10-13T12:00:00.000Z");
const HOUR = 3600000;
const iso = (offset: number) => new Date(AT.valueOf() + offset).toISOString();
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/g;

describe.skipIf(!enabled)("Project sweep (characterization)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);

  async function fixture() {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic sweep owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic sweep",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Synthetic sweep project",
        timezone: "Europe/Berlin",
      },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    const labels = new Map<string, string>();
    await run(scope, async (tx) => {
      const make = async (
        kind: string,
        label: string,
        value: Record<string, unknown>,
      ) => {
        const row = await create(tx, scope, kind, { label, ...value });
        labels.set(row.id, label);
        return row.id;
      };
      const mission = {
        title: "Synthetic mission",
        maxContents: 1,
        completedRuns: 0,
      };
      await make("missions", "mission-due", {
        ...mission,
        status: "ready",
        startAt: iso(-HOUR),
        endAt: iso(24 * HOUR),
      });
      await make("missions", "mission-ended", {
        ...mission,
        status: "ready",
        startAt: iso(-48 * HOUR),
        endAt: iso(-HOUR),
      });
      await make("missions", "mission-later", {
        ...mission,
        status: "ready",
        startAt: iso(3 * HOUR),
        endAt: iso(48 * HOUR),
      });
      await make("missions", "mission-assignment-run", {
        ...mission,
        status: "ready",
        startAt: iso(-HOUR),
        endAt: iso(24 * HOUR),
        assignmentRunId: randomUUID(),
      });
      await make("missions", "mission-draft", {
        ...mission,
        status: "draft",
        startAt: iso(-HOUR),
        endAt: iso(24 * HOUR),
      });
      const source = {
        status: "active",
        generation: 1,
        publicUse: true,
        modelUse: true,
        authority: "website",
        maxAgeHours: 168,
        allowedOrigins: ["https://example.invalid"],
        allowedPaths: ["/"],
        syncEveryHours: 1,
      };
      const due = await make("sources", "source-sync-due", {
        ...source,
        name: "Due",
        lastSuccessfulSyncAt: iso(-3 * HOUR),
      });
      const fresh = await make("sources", "source-sync-fresh", {
        ...source,
        name: "Fresh",
        lastSuccessfulSyncAt: iso(-10 * 60000),
      });
      await make("sources", "source-no-schedule", {
        ...source,
        name: "Manual",
        syncEveryHours: undefined,
      });
      await make("sync_requests", "sync-request-due", {
        sourceId: due,
        url: "https://example.invalid/",
        expectedGeneration: 1,
      });
      await make("sync_requests", "sync-request-fresh", {
        sourceId: fresh,
        url: "https://example.invalid/",
        expectedGeneration: 1,
      });
      await make("experiments", "experiment-running", {
        status: "running",
        endAt: iso(5 * HOUR),
      });
    });
    return { scope, labels };
  }

  async function effects(f: Awaited<ReturnType<typeof fixture>>) {
    const name = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value ?? null).replace(UUID, (id) =>
          f.labels.has(id) ? `<${f.labels.get(id)}>` : "<new>",
        ),
      );
    return run(f.scope, async (tx) => {
      const entities = await tx.entity.findMany({
        where: {
          workspaceId: f.scope.workspaceId,
          projectId: f.scope.projectId,
        },
      });
      const labelOf = (id: string) => {
        const row = entities.find((e) => e.id === id);
        const d = (row?.data ?? {}) as Record<string, unknown>;
        return d.label ?? d.idempotencyKey ?? row?.kind ?? null;
      };
      return {
        entities: entities
          .map((e) => {
            const d = e.data as Record<string, unknown>;
            return name({
              kind: e.kind,
              label: d.label ?? null,
              version: e.version,
              status: d.status ?? null,
              ...(e.kind === "jobs"
                ? {
                    topic: d.topic,
                    resourceId: d.resourceId,
                    idempotencyKey: d.idempotencyKey,
                    availableAt: d.availableAt,
                  }
                : {}),
              ...(e.kind === "sync_requests"
                ? {
                    sourceId: d.sourceId,
                    expectedGeneration: d.expectedGeneration,
                  }
                : {}),
            });
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        outbox: (
          await tx.outbox.findMany({
            where: {
              workspaceId: f.scope.workspaceId,
              projectId: f.scope.projectId,
            },
          })
        )
          .map((o) =>
            name({
              topic: o.topic,
              job: labelOf(o.entityId),
              availableAt: o.availableAt.toISOString(),
            }),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    });
  }

  afterEach(() => {
    delete process.env.ORBIT_AGENTS;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it.each([
    ["Orbit Agents off (weekly autopilot path)", "false"],
    ["Orbit Agents on (assignment path)", "true"],
  ])("%s", async (_name, agents) => {
    process.env.ORBIT_AGENTS = agents;
    const f = await fixture();
    const before = await run(f.scope, (tx) => nextSweepAt(tx, f.scope, AT));
    const result = await run(f.scope, (tx) => sweepProject(tx, f.scope, AT));
    const after = await run(f.scope, (tx) => nextSweepAt(tx, f.scope, AT));
    // A second sweep at the same time must not queue anything again.
    const repeat = await run(f.scope, (tx) => sweepProject(tx, f.scope, AT));
    expect({
      result,
      repeat,
      nextSweepBefore: before?.toISOString() ?? null,
      nextSweepAfter: after?.toISOString() ?? null,
      ...(await effects(f)),
    }).toMatchSnapshot();
  });
});
