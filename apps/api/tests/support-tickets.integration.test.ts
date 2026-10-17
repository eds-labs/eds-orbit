import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createInbox, archiveInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import type { NormalizedInbound } from "../src/modules/support/channels/adapter.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Ticket creation (WP5.1): per-project numbers without gaps, contacts by
 * e-mail, idempotency per channel message, SLA due times from the settings,
 * and no message text or address outside the message rows (Q-12a).
 */
describe.skipIf(!enabled)("support ticket creation", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let a: Scope, b: Scope;
  const inboxes = new Map<string, string>();

  const inbound = (
    over: Partial<NormalizedInbound> = {},
  ): NormalizedInbound => ({
    externalId: `<${randomUUID()}@mail.example.invalid>`,
    contact: { email: "Customer@Example.invalid", name: "Synthetic Customer" },
    subject: "Cannot log in",
    bodyText: "Secret body text 4711",
    attachments: [],
    ...over,
  });
  const run = <T>(s: Scope, fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn);
  const ticket = (
    s: Scope,
    over: Partial<NormalizedInbound> = {},
    now?: Date,
  ) =>
    run(s, (tx) =>
      createTicket(tx, s, {
        inboxId: inboxes.get(s.projectId)!,
        channel: "email",
        inbound: inbound(over),
        ...(now ? { now } : {}),
      }),
    );

  async function project(): Promise<Scope> {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic support",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic support tickets",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support tickets" },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: row.id,
      userId: user.id,
      role: "owner",
    };
    await run(scope, async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      const { inbox } = await createInbox(tx, scope, {
        name: "Mail",
        channels: ["email"],
        emailAddress: "support@example.invalid",
      });
      inboxes.set(scope.projectId, inbox.id);
    });
    return scope;
  }

  beforeAll(async () => {
    registerModules();
    process.env.ORBIT_SUPPORT = "true";
    a = await project();
    b = await project();
  });
  afterEach(() => {
    process.env.ORBIT_SUPPORT = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("numbers tickets per project without gaps under parallel creation", async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ticket(a, { contact: { email: `p${i}@example.invalid` } }),
      ),
    );
    expect(created.map((t) => t.number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await ticket(b)).number).toBe(1);
  });

  it("reuses a contact by case-insensitive e-mail and skips deleted contacts", async () => {
    const first = await ticket(a, {
      contact: { email: "Same@Example.invalid" },
    });
    const second = await ticket(a, {
      contact: { email: "same@example.INVALID" },
    });
    expect(second.contactId).toBe(first.contactId);
    await run(a, (tx) =>
      tx.supportContact.update({
        where: { id: first.contactId },
        data: { deletedAt: new Date() },
      }),
    );
    const third = await ticket(a, {
      contact: { email: "same@example.invalid" },
    });
    expect(third.contactId).not.toBe(first.contactId);
  });

  it("is idempotent per channel and external id", async () => {
    const externalId = `<${randomUUID()}@mail.example.invalid>`;
    const first = await ticket(a, { externalId });
    const again = await ticket(a, { externalId });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(first.duplicate).toBe(false);
  });

  it("sets the status, category and SLA due times from inbox and settings", async () => {
    const now = new Date("2026-10-18T08:00:00.000Z");
    const created = await ticket(a, {}, now);
    const row = await run(a, (tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: created.ticketId } }),
    );
    expect(row).toMatchObject({
      status: "new",
      priority: "normal",
      channel: "email",
      subject: "Cannot log in",
      lastCustomerMessageAt: now,
    });
    expect(row.firstResponseDueAt?.toISOString()).toBe(
      "2026-10-19T08:00:00.000Z",
    );
    expect(row.resolutionDueAt?.toISOString()).toBe("2026-10-21T08:00:00.000Z");
    const message = await run(a, (tx) =>
      tx.supportMessage.findUniqueOrThrow({ where: { id: created.messageId } }),
    );
    expect(message).toMatchObject({
      kind: "customer",
      visibleToCustomer: true,
      authorContactId: created.contactId,
      bodyText: "Secret body text 4711",
    });
  });

  it("refuses while support is off and for archived inboxes", async () => {
    delete process.env.ORBIT_SUPPORT;
    await expect(ticket(a)).rejects.toMatchObject({ code: "SUPPORT_DISABLED" });
    process.env.ORBIT_SUPPORT = "true";
    await run(b, (tx) => archiveInbox(tx, b, inboxes.get(b.projectId)!));
    await expect(ticket(b)).rejects.toMatchObject({ code: "INBOX_ARCHIVED" });
  });

  it("keeps message text and addresses out of audit and event rows", async () => {
    await ticket(a, { contact: { email: "private@example.invalid" } });
    const rows = await run(a, async (tx) => ({
      audits: await tx.auditEvent.findMany({
        where: { projectId: a.projectId, action: { startsWith: "support." } },
      }),
      events: await tx.supportTicketEvent.findMany({
        where: { projectId: a.projectId },
      }),
    }));
    expect(rows.audits.length).toBeGreaterThan(0);
    expect(rows.events.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    for (const secret of [
      "Secret body text 4711",
      "private@example.invalid",
      "Cannot log in",
      "Synthetic Customer",
    ])
      expect(text).not.toContain(secret);
  });

  it("links attachments to the message, only with files of the same project", async () => {
    const file = (s: Scope) =>
      run(s, (tx) => {
        const id = randomUUID();
        return tx.file.create({
          data: {
            id,
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            moduleId: "support",
            key: `projects/${s.projectId}/support/${id}`,
            mime: "text/plain",
            size: 3,
            sha256: "0".repeat(64),
            encryption: "aes-256-gcm/v1",
            createdBy: s.userId,
          },
        });
      });
    const own = await file(a);
    const attachment = {
      fileId: own.id,
      name: "log.txt",
      mime: "text/plain",
      size: 3,
    };
    const created = await ticket(a, { attachments: [attachment] });
    const rows = await run(a, (tx) =>
      tx.supportAttachment.findMany({
        where: { messageId: created.messageId },
      }),
    );
    expect(rows).toMatchObject([
      { fileId: own.id, name: "log.txt", scanState: "not_scanned" },
    ]);
    const foreign = await file(b);
    await expect(
      ticket(a, { attachments: [{ ...attachment, fileId: foreign.id }] }),
    ).rejects.toThrow(/foreign key/i);
  });
});
