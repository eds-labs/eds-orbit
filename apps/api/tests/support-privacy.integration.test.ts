import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import {
  setObjectStoreForTests,
  storeFile,
} from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { myNotifications } from "../src/platform/notifications/members.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import {
  noteOnTicket,
  replyToTicket,
  updateTicket,
} from "../src/modules/support/workspace.ts";
import {
  eraseContact,
  exportContact,
  supportRetention,
} from "../src/modules/support/privacy.ts";
import { WIDGET_SESSION_KIND } from "../src/modules/support/widget.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const ENV = {
  ORBIT_SUPPORT: "true",
  ORBIT_NOTIFICATIONS: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const DAY = 86_400_000;
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

/**
 * Support privacy and operations (WP5.8): erasure and export per contact,
 * retention by the project's settings, no message text in telemetry, audit,
 * events or notifications, and abuse caps.
 */
describe.skipIf(!enabled)("support privacy and operations", () => {
  let owner: Scope;
  let inboxId = "";
  const workspaces: string[] = [];
  const users: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const ticket = (email: string, body: string, files: string[] = []) =>
    run((tx) =>
      createTicket(tx, owner, {
        inboxId,
        channel: "email",
        inbound: {
          externalId: `<${randomUUID()}@example.org>`,
          contact: { email, name: "Petra Private" },
          subject: "Private matter",
          bodyText: body,
          attachments: files.map((fileId) => ({
            fileId,
            name: "scan.png",
            mime: "image/png",
            size: PNG.length,
          })),
        },
      }),
    );
  const supportFile = async () =>
    (
      await storeFile(owner, {
        moduleId: "support",
        bytes: PNG,
        mime: "image/png",
        name: "scan.png",
      })
    ).id;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic support privacy",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support privacy" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      inboxId = (
        await createInbox(tx, owner, {
          name: "Mail",
          channels: ["email"],
          emailAddress: "s@example.invalid",
        })
      ).inbox.id;
    });
  });
  afterEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("exports a contact with tickets, messages and attachment references", async () => {
    const file = await supportFile();
    const t = await ticket("export@example.org", "Please export me", [file]);
    await run((tx) =>
      noteOnTicket(tx, owner, t.ticketId, { bodyText: "Internal remark" }),
    );
    const exported = await run((tx) => exportContact(tx, owner, t.contactId));
    expect(exported.contact).toMatchObject({ email: "export@example.org" });
    expect(exported.tickets).toHaveLength(1);
    const messages = exported.tickets[0]!.messages;
    expect(messages.map((m: any) => [m.kind, m.internal])).toEqual([
      ["customer", false],
      ["internal_note", true],
    ]);
    expect(messages[0]!.attachments).toMatchObject([
      { fileId: file, name: "scan.png" },
    ]);
    const audit = await run((tx) =>
      tx.auditEvent.findFirst({
        where: { action: "support.contact.exported" },
      }),
    );
    expect(JSON.stringify(audit!.metadata)).not.toContain("export@example.org");
  });

  it("erases a contact with every ticket, message, attachment file, identity, session and mail row", async () => {
    const file = await supportFile();
    const t = await ticket("erase@example.org", "Erase me please", [file]);
    await run((tx) =>
      replyToTicket(tx, owner, t.ticketId, { bodyText: "We will erase you." }),
    );
    await run(async (tx) => {
      await tx.supportContactIdentity.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          contactId: t.contactId,
          inboxId,
          channel: "email",
          externalUserId: "u-1",
        },
      });
      await create(tx, owner, WIDGET_SESSION_KIND, {
        sessionId: randomUUID(),
        contactId: t.contactId,
        inboxId,
      });
      // A sent reply's mail row as the e-mail channel writes it.
      const mail = await create(tx, owner, "email_messages", {
        to: ["erase@example.org"],
        text: "We will erase you.",
        status: "sent",
      });
      await tx.supportMessage.updateMany({
        where: { ticketId: t.ticketId, kind: "agent_reply" },
        data: { externalId: `<orbit.${mail.id}@example.invalid>` },
      });
    });
    const objectsBefore = objects.size;
    const result = await eraseContact(owner, t.contactId);
    expect(result).toMatchObject({ tickets: 1, files: 1, mails: 1 });
    const left = await run(async (tx) => ({
      tickets: await tx.supportTicket.count({
        where: { contactId: t.contactId },
      }),
      messages: await tx.supportMessage.count({
        where: { ticketId: t.ticketId },
      }),
      contact: await tx.supportContact.count({ where: { id: t.contactId } }),
      identities: await tx.supportContactIdentity.count({
        where: { contactId: t.contactId },
      }),
      sessions: await tx.entity.count({
        where: {
          kind: WIDGET_SESSION_KIND,
          data: { path: ["contactId"], equals: t.contactId },
        },
      }),
      file: await tx.file.count({ where: { id: file, deletedAt: null } }),
      mails: await tx.entity.count({
        where: {
          kind: "email_messages",
          data: { path: ["text"], equals: "We will erase you." },
        },
      }),
    }));
    expect(left).toEqual({
      tickets: 0,
      messages: 0,
      contact: 0,
      identities: 0,
      sessions: 0,
      file: 0,
      mails: 0,
    });
    expect(objects.size).toBe(objectsBefore - 1);
    const audit = await run((tx) =>
      tx.auditEvent.findFirst({ where: { action: "support.contact.erased" } }),
    );
    expect(JSON.stringify(audit!.metadata)).not.toContain("erase@example.org");
  });

  it("applies the retention of closed tickets, AI drafts, widget sessions and orphan contacts", async () => {
    const now = new Date();
    const oldFile = await supportFile();
    const old = await ticket("old@example.org", "Old case", [oldFile]);
    const young = await ticket("young@example.org", "Young case");
    await run(async (tx) => {
      await tx.supportTicket.update({
        where: { id: old.ticketId },
        data: {
          status: "closed",
          closedAt: new Date(now.getTime() - 25 * 30 * DAY),
        },
      });
      await tx.supportTicket.update({
        where: { id: young.ticketId },
        data: {
          status: "closed",
          closedAt: new Date(now.getTime() - 30 * DAY),
        },
      });
      await tx.supportMessage.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          ticketId: young.ticketId,
          kind: "ai_draft",
          bodyText: "Old draft",
          channel: "internal",
          visibleToCustomer: false,
          createdAt: new Date(now.getTime() - 100 * DAY),
        },
      });
      await create(tx, owner, WIDGET_SESSION_KIND, {
        sessionId: "old-session",
        contactId: young.contactId,
        lastSeenAt: new Date(now.getTime() - 40 * DAY).toISOString(),
      });
      await tx.supportContact.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          claimedEmail: "orphan@example.org",
          createdAt: new Date(now.getTime() - 40 * DAY),
        },
      });
    });
    const result = await supportRetention(owner, now);
    expect(result).toMatchObject({ tickets: 1, drafts: 1, sessions: 1 });
    expect(result.contacts).toBeGreaterThanOrEqual(2); // the old ticket's contact and the orphan
    const state = await run(async (tx) => ({
      old: await tx.supportTicket.count({ where: { id: old.ticketId } }),
      young: await tx.supportTicket.count({ where: { id: young.ticketId } }),
      drafts: await tx.supportMessage.count({
        where: { ticketId: young.ticketId, kind: "ai_draft" },
      }),
      oldFile: await tx.file.count({ where: { id: oldFile, deletedAt: null } }),
    }));
    expect(state).toEqual({ old: 0, young: 1, drafts: 0, oldFile: 0 });
  });

  it("keeps message text and addresses out of audit, events, telemetry and notifications", async () => {
    const canary = `canary-${randomUUID()}`;
    const t = await ticket(`${canary}@example.org`, `Body ${canary}`);
    await run((tx) =>
      replyToTicket(tx, owner, t.ticketId, { bodyText: `Reply ${canary}` }),
    );
    await run((tx) =>
      noteOnTicket(tx, owner, t.ticketId, { bodyText: `Note ${canary}` }),
    );
    await run((tx) =>
      updateTicket(tx, owner, t.ticketId, { priority: "high", tags: ["vip"] }),
    );
    const rows = await run(async (tx) => ({
      audit: await tx.auditEvent.findMany({
        where: { projectId: owner.projectId },
      }),
      events: await tx.supportTicketEvent.findMany({
        where: { projectId: owner.projectId },
      }),
      runs: await tx.agentRun.findMany({
        where: { projectId: owner.projectId },
      }),
      spans: await tx.agentSpan.findMany({
        where: { projectId: owner.projectId },
      }),
    }));
    const notifications = (await myNotifications(owner)).items;
    expect(JSON.stringify({ ...rows, notifications })).not.toContain(canary);
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("caps new e-mail tickets per sender and widget messages per session", async () => {
    const { allowNewTicket } =
      await import("../src/modules/support/privacy.ts");
    const results = [];
    for (let i = 0; i < 12; i++) {
      const allowed = await run((tx) =>
        allowNewTicket(tx, owner, "flood@example.org"),
      );
      results.push(allowed);
      if (allowed) await ticket("flood@example.org", `Flood ${i}`);
    }
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.at(-1)).toBe(false);
  });

  it("erases the contact's messages in other tickets and their unlinked inbound mail (review fixes 2, 8)", async () => {
    const t = await ticket("author@example.org", "Mine");
    const other = await ticket("other@example.org", "Other customer");
    await run(async (tx) => {
      await tx.supportMessage.create({
        data: {
          id: randomUUID(),
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          ticketId: other.ticketId,
          kind: "customer",
          authorContactId: t.contactId,
          bodyText: "Authored elsewhere",
          channel: "email",
          visibleToCustomer: true,
        },
      });
      await create(tx, owner, "inbound_emails", {
        messageId: "<unlinked@example.org>",
        from: "author@example.org",
        subject: "Ignored",
        text: "Unlinked text",
      });
    });
    await eraseContact(owner, t.contactId);
    const left = await run(async (tx) => ({
      authored: await tx.supportMessage.count({
        where: { bodyText: "Authored elsewhere" },
      }),
      inbound: await tx.entity.count({
        where: {
          kind: "inbound_emails",
          data: { path: ["from"], equals: "author@example.org" },
        },
      }),
    }));
    expect(left).toEqual({ authored: 0, inbound: 0 });
  });
});
