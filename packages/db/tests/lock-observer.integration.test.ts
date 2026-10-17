import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  lockObserver,
  scoped,
  type LockSample,
} from "../src/index.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** The measurement hook of the project lock (WP4.3): off unless a measurement sets it. */
describe.skipIf(!enabled)("lockObserver", () => {
  const workspaces: string[] = [];
  const project = async () => {
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic lock observer" },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic lock observer" },
    });
    return { workspaceId: workspace.id, projectId: row.id };
  };
  afterEach(() => {
    lockObserver.observe = undefined;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("is unset by default", () => {
    expect(lockObserver.observe).toBeUndefined();
  });

  it("reports one sample per transaction, also when the work fails", async () => {
    const { workspaceId, projectId } = await project();
    const samples: LockSample[] = [];
    lockObserver.observe = (sample) => samples.push(sample);
    await scoped(workspaceId, projectId, async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await expect(
      scoped(workspaceId, projectId, async () => {
        throw new Error("SYNTHETIC_FAILURE");
      }),
    ).rejects.toThrow("SYNTHETIC_FAILURE");
    expect(samples).toHaveLength(2);
    expect(samples[0]!.holdMs).toBeGreaterThanOrEqual(25);
    expect(samples.every((s) => s.waitMs >= 0)).toBe(true);
  });

  it("shows a second transaction waiting for the first one's lock", async () => {
    const { workspaceId, projectId } = await project();
    const samples: LockSample[] = [];
    lockObserver.observe = (sample) => samples.push(sample);
    await Promise.all([
      scoped(
        workspaceId,
        projectId,
        () => new Promise((r) => setTimeout(r, 200)),
      ),
      new Promise((r) => setTimeout(r, 50)).then(() =>
        scoped(workspaceId, projectId, async () => randomUUID()),
      ),
    ]);
    expect(samples).toHaveLength(2);
    expect(Math.max(...samples.map((s) => s.waitMs))).toBeGreaterThan(100);
  });
});
