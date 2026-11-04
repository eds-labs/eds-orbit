import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { notifyMembers } from "../src/platform/notifications/members.ts";
import { notificationSummary } from "../src/platform/proactive/summary.ts";
import { notificationStream, publishNotificationWake } from "../src/platform/proactive/wake.ts";
import { closeRealtime, realtimeChannel } from "../src/platform/realtime/fanout.ts";
import { proactiveFixture, type ProactiveFixture } from "./support/proactive-fixture.ts";

// The cross-project inbox and the badge wake-up (ADR 0023 items 2 and 9,
// plan WP4.3): one transaction per project, nothing from projects the user
// left or modules hidden from them, the personal space's own notices, a
// content-free wake-up after commit, and no failure when Redis is down.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const redisUrl = process.env.REDIS_URL;
Object.assign(process.env, {
  ORBIT_NOTIFICATIONS: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_MODULE_ROLES: "true",
  EXECUTION_MODE: "test",
});

describe.skipIf(!enabled)("Cross-project notification summary (ADR 0023)", () => {
  let f: ProactiveFixture;
  let other: string;
  let personal: Scope;

  const write = (projectId: string, userIds: string[], title: string, kind = "approval_aging") =>
    scoped(f.workspaceId, projectId, (tx) =>
      notifyMembers(tx, f.scopeOf(projectId, f.owner), {
        kind,
        userIds,
        title,
        link: `/p/${projectId}/decisions`,
        dedupeKey: `test:${randomUUID()}`,
      }),
    );

  beforeAll(async () => {
    process.env.ORBIT_PROACTIVE = "true";
    f = await proactiveFixture("Synthetic summary org");
    other = await f.project("Synthetic second project", [[f.editor, "editor"]]);
    personal = await f.personal(f.editor);
  });
  beforeEach(() => {
    process.env.ORBIT_PROACTIVE = "true";
    process.env.ORBIT_REALTIME = "false";
  });
  afterAll(async () => {
    delete process.env.ORBIT_PROACTIVE;
    delete process.env.ORBIT_REALTIME;
    await closeRealtime();
    await f?.cleanup();
    await closeDatabase();
  });

  it("answers 404 while ORBIT_PROACTIVE is off", async () => {
    process.env.ORBIT_PROACTIVE = "false";
    await expect(notificationSummary(f.workspaceId, f.editor)).rejects.toMatchObject({ status: 404 });
  });

  it("isolates projects: only those the user can still reach, newest first, with the personal space's notices", async () => {
    // A project the editor is not in: never shown.
    const foreign = await f.project("Synthetic foreign project", [[f.viewer, "viewer"]]);
    await write(foreign, [f.viewer], "Foreign notice");
    await write(f.businessId, [f.editor], "Business notice");
    await write(other, [f.editor], "Second notice");
    await write(personal.projectId, [f.editor], "Personal notice", "ai_budget_threshold");
    const summary = await notificationSummary(f.workspaceId, f.editor);
    expect(summary.unread).toBe(3);
    expect(summary.items.map((i) => i.title)).toEqual(["Personal notice", "Second notice", "Business notice"]);
    expect(summary.items.some((i) => i.projectId === foreign)).toBe(false);
    expect(summary.items.find((i) => i.title === "Personal notice")).toMatchObject({ personal: true });
    expect(summary.personalSpaceId).toBe(personal.projectId);
    // Leaving a project removes its notices from the summary at once.
    await authDb.projectMember.delete({ where: { projectId_userId: { projectId: other, userId: f.editor } } });
    const after = await notificationSummary(f.workspaceId, f.editor);
    expect(after.items.map((i) => i.title)).toEqual(["Personal notice", "Business notice"]);
    expect(after.unread).toBe(2);
  });

  it("leaves out the notices of a module hidden from the user", async () => {
    const projectId = await f.project("Synthetic hidden project", [[f.editor, "editor"]]);
    await write(projectId, [f.editor], "Work notice", "work_task_completed");
    expect((await notificationSummary(f.workspaceId, f.editor)).items.some((i) => i.title === "Work notice")).toBe(true);
    await authDb.projectMemberModuleRole.create({
      data: { workspaceId: f.workspaceId, projectId, userId: f.editor, moduleId: "work", role: "none" },
    });
    expect((await notificationSummary(f.workspaceId, f.editor)).items.some((i) => i.title === "Work notice")).toBe(false);
  });

  it.skipIf(!redisUrl)("publishes a content-free wake-up on the recipient's personal-space channel after commit", async () => {
    process.env.ORBIT_REALTIME = "true";
    const listener = new Redis(redisUrl!);
    const messages: Array<{ channel: string; message: string }> = [];
    const channel = realtimeChannel(personal.projectId, notificationStream(personal.projectId));
    await listener.subscribe(channel);
    listener.on("message", (c, message) => messages.push({ channel: c, message }));
    await write(f.businessId, [f.editor], "Wake notice with a title");
    const deadline = Date.now() + 3000;
    while (!messages.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await listener.quit();
    expect(messages).toEqual([{ channel, message: "{}" }]);
    expect((await notificationSummary(f.workspaceId, f.editor)).realtime).toBe(true);
  });

  it("still writes the notice and never throws when Redis is down (the client polls)", async () => {
    process.env.ORBIT_REALTIME = "true";
    await closeRealtime();
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    try {
      await expect(publishNotificationWake(f.workspaceId, f.editor)).resolves.toBeUndefined();
      await write(f.businessId, [f.editor], "Notice while Redis is down");
      expect((await notificationSummary(f.workspaceId, f.editor)).items[0]!.title).toBe("Notice while Redis is down");
    } finally {
      await closeRealtime();
      process.env.REDIS_URL = saved;
    }
  });
});
