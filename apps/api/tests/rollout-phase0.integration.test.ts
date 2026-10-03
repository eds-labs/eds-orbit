import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list, update } from "../src/shared.ts";
import { configureAutopilot, planAutopilot } from "../src/modules/autopilot.ts";
import { channelSlots } from "../src/modules/agents/scheduling.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// The psql variable is replaced with the project id, as `psql -v project_id=…` does.
const sql = (file: string, projectId: string) =>
  readFileSync(`scripts/rollout/${file}`, "utf8").replaceAll(
    ":'project_id'",
    `'${projectId}'`,
  );

/**
 * The Phase 0 preview of the rollout plan must predict exactly the days the
 * deployed planAutopilot (J3.2) skips, and must run in a read-only transaction.
 */
describe.skipIf(!enabled)("Rollout Phase 0 read-only queries", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let days: { quota: string; spacing: string; free: string };
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const readOnly = (file: string) =>
    run(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return tx.$queryRawUnsafe<Array<Record<string, any>>>(
        sql(file, project.owner.projectId),
      );
    });
  const publication = (at: Date, status = "intent_created") =>
    run((tx) =>
      create(tx, project.owner, "publications", {
        contentId: "00000000-0000-4000-8000-000000000030",
        channel: X,
        status,
        scheduledAt: at.toISOString(),
      }),
    );

  beforeAll(async () => {
    project = await createPackageProject();
    const { owner } = project;
    await run(async (tx) => {
      await tx.project.update({
        where: { id: owner.projectId },
        data: { mode: "autopilot" },
      });
      const policy = (await list(tx, owner, "policies")).find(
        (row) => data(row).active === true,
      )!;
      // Two posts a day, two hours apart: quota and spacing can be told apart.
      await update(tx, owner, policy, {
        ...data(policy),
        maxPerDay: 2,
        minIntervalMinutes: 120,
      });
      await configureAutopilot(tx, owner, {
        enabled: true,
        channels: [X],
        factKeys: ["beta.access"],
        assetIds: [],
        planWeekday: new Date().getDay(),
        planTime: "00:00",
      });
    });
    const slots = (
      await run((tx) => channelSlots(tx, owner, { channels: [X] }))
    ).channels[0]!.slots.filter((slot) => slot.free);
    const [spacing, free, quota] = [slots[0]!, slots[1]!, slots[2]!];
    days = { spacing: spacing.date, free: free.date, quota: quota.date };
    const at = (slot: { at: string }, hours: number) =>
      new Date(Date.parse(slot.at) + hours * 3600000);
    // Thirty minutes after the 17:00 slot: inside the spacing.
    await publication(at(spacing, 0.5));
    // One post at 09:00: below the quota and far from the slot. A canceled
    // post at the slot itself no longer counts.
    await publication(at(free, -8));
    await publication(at(free, 0), "canceled");
    // Two posts in the morning: the daily quota is used.
    await publication(at(quota, -9));
    await publication(at(quota, -7));
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("returns the context for picking the window", async () => {
    const [row] = await readOnly("phase0-context.sql");
    expect(row).toMatchObject({
      timezone: "Europe/Berlin",
      project_mode: "autopilot",
      autopilot_enabled: "true",
      plan_time: "00:00",
      max_per_day: "2",
      min_interval_minutes: "120",
    });
    expect(row!.posting_times).toMatchObject({ [X]: "17:00" });
    expect(Number(row!.open_publications)).toBe(4);
  });

  it("predicts exactly the days the deployed planner skips", async () => {
    const preview = await readOnly("phase0-autopilot-skip-preview.sql");
    const byDay = Object.fromEntries(preview.map((row) => [row.day, row]));
    expect(byDay[days.quota]).toMatchObject({ will_skip: true });
    expect(Number(byDay[days.quota]!.same_day_count)).toBe(2);
    expect(byDay[days.spacing]).toMatchObject({ will_skip: true });
    expect(byDay[days.spacing]!.too_close_publications).toHaveLength(1);
    expect(byDay[days.free]).toMatchObject({ will_skip: false });

    const planned = await run((tx) => planAutopilot(tx, project.owner));
    const skipped = (planned.skipped ?? []).map((skip) => skip.slot).sort();
    expect(skipped).toEqual(
      preview
        .filter((row) => row.will_skip)
        .map((row) => `${row.channel}|${row.day}`)
        .sort(),
    );
    // After planning, the free day is planned and the skipped days are not.
    const after = await readOnly("phase0-autopilot-skip-preview.sql");
    const now = Object.fromEntries(after.map((row) => [row.day, row]));
    expect(now[days.free]).toMatchObject({ already_planned: true });
    expect(now[days.quota]).toMatchObject({ already_planned: false });
    // A post added to an already planned day never makes the preview skip it.
    await publication(new Date(Date.parse(now[days.free]!.slot_at) + 1800000));
    const planned2 = await readOnly("phase0-autopilot-skip-preview.sql");
    expect(planned2.find((row) => row.day === days.free)).toMatchObject({
      already_planned: true,
      will_skip: false,
    });
  });
});
