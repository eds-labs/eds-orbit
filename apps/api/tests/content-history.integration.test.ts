import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create } from "../src/shared.ts";
import { recentContent } from "../src/modules/agents/content-history.ts";
import {
  createPackageProject,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)("Recent content history for the operator", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const draft = (
    tx: DbTx,
    channel: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) =>
    create(tx, project.owner, "content", {
      title,
      body: `${title}. ${"Body text ".repeat(60)}`,
      type: "social",
      channel,
      status: "draft",
      ...extra,
    });
  const ageDays = (tx: DbTx, id: string, days: number) =>
    tx.entity.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - days * 86400000) },
    });
  let published: string, packaged: string;

  beforeAll(async () => {
    project = await createPackageProject();
    await run(async (tx) => {
      const autopilotMission = await create(tx, project.owner, "missions", {
        title: "Autopilot slot",
        status: "completed",
        autopilot: true,
      });
      const packageMission = await create(tx, project.owner, "missions", {
        title: "Package draft",
        status: "completed",
        packageId: "00000000-0000-4000-8000-000000000001",
      });
      const live = await draft(tx, X, "Beta is open", {
        status: "reviewed",
        missionId: autopilotMission.id,
        scheduledAt: new Date(Date.now() - 86400000).toISOString(),
      });
      published = live.id;
      await create(tx, project.owner, "publications", {
        contentId: live.id,
        channel: X,
        status: "published",
        scheduledAt: new Date(Date.now() - 86400000).toISOString(),
      });
      packaged = (
        await draft(tx, X, "Beta for teams", { missionId: packageMission.id })
      ).id;
      for (let index = 0; index < 5; index++)
        await draft(tx, TELEGRAM, `Telegram note ${index}`);
      await draft(tx, X, "Archived idea", { status: "archived" });
      await draft(tx, X, "Replaced wording", { supersededBy: packaged });
      const old = await draft(tx, X, "Last month's post");
      await ageDays(tx, old.id, 30);
      const older = await draft(tx, TELEGRAM, "Six weeks ago");
      await ageDays(tx, older.id, 42);
    });
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("lists recent drafts per channel with excerpt, status, origin and publication state", async () => {
    const history = await run((tx) => recentContent(tx, project.owner, {}));
    expect(history.days).toBe(14);
    const x = history.channels.find((c) => c.channelId === X)!;
    expect(x.items.map((item) => item.title)).toEqual([
      "Beta for teams",
      "Beta is open",
    ]);
    expect(x.items[0]).toMatchObject({
      contentId: packaged,
      status: "draft",
      origin: "package",
      publication: null,
    });
    expect(x.items[1]).toMatchObject({
      contentId: published,
      status: "reviewed",
      origin: "autopilot",
      publication: { status: "published" },
    });
    for (const item of x.items)
      expect(item.excerpt.length).toBeLessThanOrEqual(280);
  });

  it("keeps at most five per channel and follows the window and channel filter", async () => {
    const recent = await run((tx) =>
      recentContent(tx, project.owner, { channels: [TELEGRAM] }),
    );
    expect(recent.channels.map((c) => c.channelId)).toEqual([TELEGRAM]);
    expect(recent.channels[0]!.items).toHaveLength(5);
    expect(recent.truncated).toBe(false);
    const wide = await run((tx) =>
      recentContent(tx, project.owner, { days: 60 }),
    );
    const telegram = wide.channels.find((c) => c.channelId === TELEGRAM)!;
    expect(telegram.items).toHaveLength(5);
    expect(wide.truncated).toBe(true);
    expect(
      wide.channels
        .find((c) => c.channelId === X)!
        .items.map((item) => item.title),
    ).toContain("Last month's post");
  });

  it("leaves out archived and replaced drafts", async () => {
    const titles = (
      await run((tx) => recentContent(tx, project.owner, { days: 60 }))
    ).channels.flatMap((c) => c.items.map((item) => item.title));
    expect(titles).not.toContain("Archived idea");
    expect(titles).not.toContain("Replaced wording");
  });

  it("is readable by viewers and rejects an unbounded window", async () => {
    await expect(
      run((tx) => recentContent(tx, project.viewer, { days: 7 })),
    ).resolves.toMatchObject({ days: 7 });
    await expect(
      run((tx) => recentContent(tx, project.owner, { days: 365 })),
    ).rejects.toThrow();
  });
});
