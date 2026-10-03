import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, list, update } from "../src/shared.ts";
import { channelSlots } from "../src/modules/agents/scheduling.ts";
import {
  createPackageProject,
  LINKEDIN,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Fixed clock around the end of daylight saving time in Berlin (2026-10-25).
const NOW = new Date("2026-10-23T14:00:00Z");

describe.skipIf(!enabled)(
  "Slot overview for scheduling packages (J3.0)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const setPolicy = (changes: Record<string, unknown>) =>
      run(async (tx) => {
        const row = (await list(tx, project.owner, "policies")).find(
          (p) => data(p).active === true,
        )!;
        await update(tx, project.owner, row, { ...data(row), ...changes });
      });
    const slots = (query: Record<string, unknown> = {}) =>
      run((tx) => channelSlots(tx, project.owner, query, NOW));
    const day = (
      result: Awaited<ReturnType<typeof slots>>,
      channel: string,
      date: string,
    ) =>
      result.channels
        .find((c) => c.channelId === channel)!
        .slots.find((s) => s.date === date)!;

    beforeAll(async () => {
      project = await createPackageProject();
      await setPolicy({
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2027-01-01T00:00:00.000Z",
        maxPerDay: 1,
        minIntervalMinutes: 120,
      });
    });
    afterAll(async () => {
      await project.cleanup();
      await closeDatabase();
    });

    it("puts X slots at 17:00 Berlin across the change from summer to winter time", async () => {
      const result = await slots({ channels: [X], days: 5 });
      const x = result.channels[0]!;
      expect(x.postingTime).toBe("17:00");
      expect(x.slots.map((s) => [s.date, s.at])).toEqual([
        ["2026-10-23", "2026-10-23T15:00:00.000Z"],
        ["2026-10-24", "2026-10-24T15:00:00.000Z"],
        ["2026-10-25", "2026-10-25T16:00:00.000Z"],
        ["2026-10-26", "2026-10-26T16:00:00.000Z"],
        ["2026-10-27", "2026-10-27T16:00:00.000Z"],
      ]);
      // One hour ahead is shorter than the two-hour minimum lead.
      expect(x.slots[0]).toMatchObject({
        free: false,
        reasons: ["TOO_SOON"],
      });
    });

    it("shows a day planned by the autopilot as occupied and suggests the next free slot", async () => {
      const mission = await run((tx) =>
        create(tx, project.owner, "missions", {
          title: "Autopilot X slot",
          status: "ready",
          autopilot: true,
          autopilotSlot: `${X}|2026-10-24`,
          channels: [X],
          plannedSlotAt: "2026-10-24T15:00:00.000Z",
        }),
      );
      const result = await slots({ channels: [X], days: 5 });
      expect(day(result, X, "2026-10-24")).toMatchObject({
        free: false,
        reasons: expect.arrayContaining(["DAILY_QUOTA"]),
        occupiedBy: [
          {
            kind: "autopilot",
            id: mission.id,
            at: "2026-10-24T15:00:00.000Z",
          },
        ],
      });
      expect(result.channels[0]!.nextFree).toBe("2026-10-25T16:00:00.000Z");
    });

    it("counts an active publication for the day and its spacing, but not a canceled one", async () => {
      await run(async (tx) => {
        await create(tx, project.owner, "publications", {
          contentId: "00000000-0000-4000-8000-000000000010",
          channel: TELEGRAM,
          status: "intent_created",
          scheduledAt: "2026-10-26T08:30:00.000Z",
        });
        await create(tx, project.owner, "publications", {
          contentId: "00000000-0000-4000-8000-000000000011",
          channel: TELEGRAM,
          status: "canceled",
          scheduledAt: "2026-10-27T08:00:00.000Z",
        });
      });
      const result = await slots({ channels: [TELEGRAM], days: 5 });
      // Telegram has no posting time: 09:00 Berlin is the default.
      expect(result.channels[0]!.postingTime).toBe("09:00");
      expect(day(result, TELEGRAM, "2026-10-26")).toMatchObject({
        at: "2026-10-26T08:00:00.000Z",
        free: false,
        reasons: expect.arrayContaining(["DAILY_QUOTA", "SPACING"]),
      });
      expect(day(result, TELEGRAM, "2026-10-27").free).toBe(true);
    });

    it("closes slots in quiet hours and manual calendar blocks", async () => {
      await run((tx) =>
        create(tx, project.owner, "calendar_blocks", {
          title: "Launch freeze",
          channels: [X],
          startAt: "2026-10-27T00:00:00.000Z",
          endAt: "2026-10-28T00:00:00.000Z",
          reason: "Synthetic freeze",
          status: "active",
        }),
      );
      await setPolicy({ quietStart: 8, quietEnd: 10 });
      try {
        const result = await slots({ days: 5 });
        expect(day(result, X, "2026-10-27").reasons).toContain(
          "CALENDAR_BLOCK",
        );
        expect(day(result, TELEGRAM, "2026-10-25").reasons).toContain(
          "QUIET_HOURS",
        );
        expect(day(result, X, "2026-10-25").free).toBe(true);
      } finally {
        await setPolicy({ quietStart: undefined, quietEnd: undefined });
      }
    });

    it("ends with the policy window and closes channels the policy does not allow", async () => {
      await setPolicy({ endAt: "2026-10-26T00:00:00.000Z" });
      try {
        const result = await slots({ channels: [X, LINKEDIN], days: 5 });
        expect(day(result, X, "2026-10-26").reasons).toContain(
          "OUTSIDE_POLICY",
        );
        expect(day(result, X, "2026-10-25").free).toBe(true);
        const linkedin = result.channels.find((c) => c.channelId === LINKEDIN)!;
        expect(
          linkedin.slots.every((s) =>
            s.reasons.includes("CHANNEL_NOT_APPROVED"),
          ),
        ).toBe(true);
        expect(linkedin.nextFree).toBeNull();
      } finally {
        await setPolicy({ endAt: "2027-01-01T00:00:00.000Z" });
      }
    });

    it("is readable by viewers and bounded to fourteen days", async () => {
      await expect(
        run((tx) => channelSlots(tx, project.viewer, { days: 3 }, NOW)),
      ).resolves.toMatchObject({ days: 3 });
      await expect(slots({ days: 30 })).rejects.toThrow();
    });
  },
);
