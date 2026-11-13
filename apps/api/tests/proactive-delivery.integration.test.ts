import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { notifyMembers } from "../src/platform/notifications/members.ts";
import {
  connectTelegram,
  disconnectTelegram,
  handleTelegramWebhook,
} from "../src/platform/connections/telegram.ts";
import { deliverNotification, proactiveTestHooks } from "../src/platform/proactive/delivery.ts";
import { collectDigest, runDigest } from "../src/platform/proactive/digest.ts";
import {
  DEFAULT_PREFERENCES,
  inQuietHours,
  routeOf,
  savePreferences,
  readPreferences,
} from "../src/platform/proactive/preferences.ts";
import { enqueue } from "../src/platform/jobs/enqueue.ts";
import { setSystemMailSinkForTests, type SystemMail } from "../src/platform/email/system-mail.ts";
import { data } from "../src/platform/shared.ts";
import { proactiveFixture, type ProactiveFixture } from "./support/proactive-fixture.ts";

// Delivery of member notices (ADR 0023 items 3, 5, 6; plan WP4.1): the
// per-notice decision job, quiet hours, the digest (each item once, system
// sender, titles and links only) and per-user Telegram linked in the
// user's own personal space (only that chat, once per key, ended by /stop
// or unlinking, never customer content).

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_NOTIFICATIONS: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_TELEGRAM: "true",
  ORBIT_EMAIL: "true",
  APP_ORIGIN: "https://orbit.example",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const TOKEN_A = "123456789:AAsyntheticTelegramTokenForTests_0123456";
const TOKEN_B = "987654321:AAsyntheticTelegramTokenForTests_6543210";
type Call = { token: string; method: string; body: Record<string, any> };

describe.skipIf(!enabled)("Proactive delivery (ADR 0023)", () => {
  let f: ProactiveFixture;
  let personalOwner: Scope;
  let personalEditor: Scope;
  const calls: Call[] = [];
  const mails: SystemMail[] = [];
  let updateId = 1;

  const telegramFetch = async (url: string | URL, init: RequestInit = {}) => {
    const parts = String(url).split("/");
    const method = parts.pop()!;
    const token = parts.pop()!.replace(/^bot/, "");
    calls.push({ token, method, body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(
      JSON.stringify({ ok: true, result: method.startsWith("send") ? { message_id: calls.length } : true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // Notices only: the bot's own replies to /start and /stop are left out.
  const isReply = (c: Call) => /^(Verbunden|Beendet|Hinweise|Bereits)/.test(String(c.body.text ?? ""));
  const sent = (token: string) =>
    calls.filter((c) => c.token === token && c.method === "sendMessage" && !isReply(c));

  /** Connects a bot to a personal space and links `chat` with the one-time code, as the user does. */
  async function link(personal: Scope, token: string, chat: number) {
    const { linkCode } = await connectTelegram(personal, { token }, { fetch: telegramFetch as never });
    const hook = calls.filter((c) => c.method === "setWebhook").at(-1)!;
    const connectionId = String(hook.body.url).split("/").pop()!;
    const secret = hook.body.secret_token as string;
    const message = (text: string) => ({
      update_id: updateId++,
      message: { message_id: updateId, chat: { id: chat, type: "private" }, from: { id: chat }, text },
    });
    const post = (text: string) =>
      handleTelegramWebhook(
        { projectId: personal.projectId, connectionId, secret, body: message(text) },
        { fetch: telegramFetch as never },
      );
    expect((await post(`/start ${linkCode}`)).handled).toBe("linked");
    return { post };
  }

  const prefs = (personal: Scope, patch: Record<string, unknown>) =>
    scoped(personal.workspaceId, personal.projectId, async (tx) => {
      const { version } = await readPreferences(tx, personal);
      return savePreferences(tx, personal, { version, ...patch });
    });

  const notify = (userIds: string[], key: string, severity: "info" | "attention" | "urgent" = "attention", body = "") =>
    scoped(f.workspaceId, f.businessId, (tx) =>
      notifyMembers(tx, f.business, {
        kind: "ai_budget_threshold",
        userIds,
        title: "Synthetic threshold title",
        body,
        link: `/manage/p/${f.businessId}/ai/budget`,
        dedupeKey: key,
        severity,
      }),
    );

  /** Runs every queued delivery job of the business project once. */
  async function deliverAll() {
    for (const job of await f.jobs(f.businessId, "notification_delivery"))
      if (!(job as Record<string, unknown>).outcome) await deliverNotification(f.worker(f.businessId), job.id);
  }
  const outcomeOf = async (key: string, userId: string) => {
    const [row] = (await f.notices(f.businessId, userId)).filter((n) => n.dedupeKey === key);
    const job = (await f.jobs(f.businessId, "notification_delivery")).find(
      (j: Record<string, unknown>) => j.resourceId === row!.id,
    ) as Record<string, any> | undefined;
    return job?.outcome as { email: string; telegram: string } | undefined;
  };
  const emails = () =>
    scoped(f.workspaceId, f.businessId, async (tx) =>
      (await tx.entity.findMany({ where: { projectId: f.businessId, kind: "email_messages" } })).map(data),
    );

  beforeAll(async () => {
    process.env.ORBIT_PROACTIVE = "true";
    proactiveTestHooks.fetch = telegramFetch as never;
    setSystemMailSinkForTests((mail) => mails.push(mail));
    f = await proactiveFixture("Synthetic delivery org");
    personalOwner = await f.personal(f.owner);
    personalEditor = await f.personal(f.editor);
  });
  beforeEach(() => {
    process.env.ORBIT_PROACTIVE = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_PROACTIVE;
    proactiveTestHooks.fetch = undefined;
    setSystemMailSinkForTests(null);
    await f?.cleanup();
    await closeDatabase();
  });

  it("decides quiet hours in the user's time zone, overnight included", () => {
    const p = {
      ...DEFAULT_PREFERENCES,
      timeZone: "Europe/Berlin",
      quietHours: { enabled: true, start: "22:00", end: "07:00", urgentBreaks: false },
    };
    // 21:30 UTC in November is 22:30 in Berlin: quiet.
    expect(inQuietHours(p, new Date("2026-11-10T21:30:00Z"))).toBe(true);
    expect(inQuietHours(p, new Date("2026-11-10T05:59:00Z"))).toBe(true);
    expect(inQuietHours(p, new Date("2026-11-10T06:00:00Z"))).toBe(false);
    expect(routeOf(p, "email", "attention", new Date("2026-11-10T21:30:00Z"))).toBe("digest");
    expect(routeOf(p, "email", "urgent", new Date("2026-11-10T21:30:00Z"))).toBe("digest");
    const breaking = { ...p, quietHours: { ...p.quietHours, urgentBreaks: true } };
    expect(routeOf(breaking, "email", "urgent", new Date("2026-11-10T21:30:00Z"))).toBe("immediate");
    expect(routeOf(p, "email", "attention", new Date("2026-11-10T12:00:00Z"))).toBe("immediate");
  });

  it("sends Telegram only to the linked chat of that user, once per key, with no body", async () => {
    const owner = await link(personalOwner, TOKEN_A, 1001);
    await link(personalEditor, TOKEN_B, 2002);
    const key = `test:tg:${randomUUID()}`;
    await notify([f.owner], key, "attention", "Customer wrote: secret body text");
    await notify([f.owner], key, "attention");
    await deliverAll();
    const messages = sent(TOKEN_A);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body.chat_id).toBe("1001");
    expect(messages[0]!.body.text).toContain(`https://orbit.example/manage/p/${f.businessId}/ai/budget`);
    expect(messages[0]!.body.text).not.toContain("secret body text");
    // The other user's bot got nothing for this notice.
    expect(sent(TOKEN_B)).toHaveLength(0);
    expect(await outcomeOf(key, f.owner)).toMatchObject({ telegram: "sent", email: "queued" });
    // A repeat runs no second delivery.
    await deliverAll();
    expect(sent(TOKEN_A)).toHaveLength(1);
    // /stop ends delivery at once.
    expect((await owner.post("/stop")).handled).toBe("stopped");
    const after = `test:tg:${randomUUID()}`;
    await notify([f.owner], after);
    await deliverAll();
    expect(sent(TOKEN_A)).toHaveLength(1);
    expect(await outcomeOf(after, f.owner)).toMatchObject({ telegram: "none" });
  });

  it("stops after unlinking", async () => {
    const key = `test:unlink:${randomUUID()}`;
    await disconnectTelegram(personalEditor, { fetch: telegramFetch as never });
    await notify([f.editor], key);
    await deliverAll();
    expect(sent(TOKEN_B)).toHaveLength(0);
    expect(await outcomeOf(key, f.editor)).toMatchObject({ telegram: "none" });
  });

  it("defers e-mail and Telegram during quiet hours into one digest that holds each item once", async () => {
    const viewerSpace = await f.personal(f.viewer);
    await link(viewerSpace, "555555555:AAsyntheticTelegramTokenForTests_5555555", 3003);
    // Quiet all day: start and end around the current minute.
    const now = new Date();
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    await prefs(viewerSpace, {
      quietHours: {
        enabled: true,
        start: hhmm(new Date(now.getTime() - 3_600_000)),
        end: hhmm(new Date(now.getTime() + 3_600_000)),
        urgentBreaks: false,
      },
    });
    const before = (await emails()).length;
    const key = `test:quiet:${randomUUID()}`;
    await notify([f.viewer], key, "attention");
    await deliverAll();
    expect(await outcomeOf(key, f.viewer)).toMatchObject({ email: "digest", telegram: "digest" });
    expect((await emails()).length).toBe(before);
    expect(calls.filter((c) => c.body.chat_id === "3003" && c.method === "sendMessage" && !isReply(c))).toHaveLength(0);
    const items = await collectDigest(f.workspaceId, f.viewer, new Date(now.getTime() - 60_000), new Date(Date.now() + 60_000));
    expect(items.email.map((i) => i.title)).toEqual(["Synthetic threshold title"]);
    // The digest job: one e-mail through the system sender, one Telegram message.
    mails.length = 0;
    const slot = new Date(Date.now() + 60_000).toISOString();
    await scoped(f.workspaceId, viewerSpace.projectId, async (tx) => {
      const { writeState } = await import("../src/platform/proactive/preferences.ts");
      await writeState(tx, viewerSpace, { lastDigestAt: new Date(now.getTime() - 60_000).toISOString() });
      await enqueue(tx, viewerSpace, "notification_digest", viewerSpace.projectId, `digest:${slot}`, new Date(), { slot });
    });
    const [digestJob] = await f.jobs(viewerSpace.projectId, "notification_digest");
    await runDigest(f.worker(viewerSpace.projectId), digestJob!.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("Synthetic threshold title");
    expect(mails[0]!.text).toContain(`https://orbit.example/manage/p/${f.businessId}/ai/budget`);
    expect(calls.filter((c) => c.body.chat_id === "3003" && c.method === "sendMessage" && !isReply(c))).toHaveLength(1);
    // A second digest of a later slot finds nothing new.
    const later = new Date(Date.now() + 120_000).toISOString();
    await scoped(f.workspaceId, viewerSpace.projectId, (tx) =>
      enqueue(tx, viewerSpace, "notification_digest", viewerSpace.projectId, `digest:${later}`, new Date(), { slot: later }),
    );
    const jobs = await f.jobs(viewerSpace.projectId, "notification_digest");
    await runDigest(f.worker(viewerSpace.projectId), jobs.at(-1)!.id);
    expect(mails).toHaveLength(1);
    // A rerun of the first job is a no-op.
    await runDigest(f.worker(viewerSpace.projectId), digestJob!.id);
    expect(mails).toHaveLength(1);
  });

  it("keeps the preferences in the personal space: row-level security hides them from every other project", async () => {
    await prefs(personalEditor, { digest: { time: "07:30" } });
    const count = (projectId: string) =>
      scoped(f.workspaceId, projectId, (tx) =>
        tx.entity.count({ where: { kind: "notification_preferences" } }),
      );
    expect(await count(personalEditor.projectId)).toBe(1);
    expect(await count(f.businessId)).toBe(0);
    expect(await count(personalOwner.projectId)).toBe(0);
  });

  it("re-checks the recipient at send time: a member who left gets nothing", async () => {
    const user = await f.user("leaver");
    await f.addMember(user, "editor");
    const projectId = f.businessId;
    const { authDb } = await import("../../../packages/db/src/index.ts");
    await authDb.projectMember.create({ data: { workspaceId: f.workspaceId, projectId, userId: user, role: "editor" } });
    const key = `test:left:${randomUUID()}`;
    await notify([user], key);
    await authDb.projectMember.delete({ where: { projectId_userId: { projectId, userId: user } } });
    await deliverAll();
    const job = (await f.jobs(projectId, "notification_delivery")).find(
      (j: Record<string, unknown>) => j.userId === user,
    ) as Record<string, any>;
    expect(job.outcome).toMatchObject({ reason: "NO_ACCESS", telegram: "none" });
  });
});
