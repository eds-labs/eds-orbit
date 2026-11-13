import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  create as createEntity,
  data,
  entity,
  list,
  update,
} from "../src/shared.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import { closeMailboxLocks } from "../src/platform/email/mailbox-lock.ts";
import { setMailboxOwner } from "../src/platform/email/ownership.ts";
import { sendQueuedEmail } from "../src/platform/email/send.ts";
import { inboundRowForImport } from "../src/platform/email/shared-client.ts";
import type {
  EmailImportMode,
  EmailImportTarget,
} from "../src/platform/email/import-contract.ts";
import {
  setMailFactoriesForTests,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import { registeredEmailImports } from "../src/platform/modules/contributions.ts";
import { writeModuleSettings } from "../src/platform/modules/settings.ts";
import { myNotifications } from "../src/platform/notifications/members.ts";
import {
  createInbox,
  supportMailboxUse,
} from "../src/modules/support/inboxes.ts";
import { supportMcpActions } from "../src/modules/support/mcp-tools.ts";
import {
  supportSettingsDefaults,
  supportSettingsSchema,
} from "../src/modules/support/settings.ts";
import {
  handleInboundEmail,
  syncEmailDelivery,
} from "../src/modules/support/channels/email.ts";
import { supportPermissions } from "../src/modules/support/permissions.ts";
import {
  allowNewTicket,
  supportRetention,
} from "../src/modules/support/privacy.ts";
import {
  mergeTicket,
  replyToTicket,
} from "../src/modules/support/workspace.ts";
import {
  addMailbox,
  FakeImap,
  inboundRows,
  installMail,
  MAIL_ENV,
  mailProject,
  markMailbox,
  memoryStore,
  queuedJobs,
  rawMail,
  type MailProject,
} from "./shared-mailbox-fixture.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);
const YEARS_10 = 10 * 365 * 86_400_000;
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

/** A multipart message with these attachments. */
function withAttachments(
  parts: Array<{ name: string; mime: string; bytes: Buffer }>,
  headers: Record<string, string> = {},
) {
  const b = "orbit-boundary";
  const head = {
    From: "Anna Customer <anna@example.org>",
    To: "info@desk.example",
    Subject: "With files",
    Date: "Sat, 17 Oct 2026 10:00:00 +0000",
    "Message-ID": `<${randomUUID()}@example.org>`,
    ...headers,
  };
  return Buffer.from(
    [
      ...Object.entries(head).map(([k, v]) => `${k}: ${v}`),
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      ...parts.flatMap((p) => [
        `--${b}`,
        `Content-Type: ${p.mime}; name="${p.name}"`,
        `Content-Disposition: attachment; filename="${p.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        p.bytes.toString("base64"),
      ]),
      `--${b}--`,
      "",
    ].join("\r\n"),
  );
}

describe.skipIf(!enabled)("taking a mailbox message over as a ticket", () => {
  let info: FakeImap;
  let support: FakeImap;
  let project: MailProject;
  let supportConnection = "";
  let inboxId = "";
  let agentId = "";
  let target: EmailImportTarget;
  const sent: OutgoingMail[] = [];
  const { objects, store } = memoryStore();
  const workspaces: string[] = [];
  const users: string[] = [];

  const scope = () => project.scope;
  const run: MailProject["run"] = (fn) => project.run(fn);
  const create = (extra: Partial<EmailImportMode> = {}): EmailImportMode =>
    ({ kind: "create", destinationId: inboxId, ...extra }) as EmailImportMode;
  const tickets = () =>
    run((tx) =>
      tx.supportTicket.findMany({
        where: { projectId: scope().projectId },
        orderBy: { number: "asc" },
      }),
    );
  const messagesOf = (ticketId: string) =>
    run((tx) =>
      tx.supportMessage.findMany({
        where: { ticketId },
        orderBy: { createdAt: "asc" },
      }),
    );
  const contactNamed = (email: string) =>
    run((tx) =>
      tx.supportContact.findFirst({
        where: { projectId: scope().projectId, email },
      }),
    );
  const domainEvents = () =>
    run((tx) =>
      tx.domainEvent.count({
        where: {
          projectId: scope().projectId,
          type: { in: ["support.ticket.created", "support.message.received"] },
        },
      }),
    );
  // Mail to customers; notifications go to members at @example.invalid.
  const toMember = (to: string[]) =>
    to.some((a) => a.endsWith("@example.invalid"));
  const allOutbound = () => run((tx) => list(tx, scope(), "email_messages"));
  const outbound = async () =>
    (await allOutbound()).filter((m) => !toMember(data(m).to as string[]));
  const customerMail = () => sent.filter((m) => !toMember(m.to));

  /** What the webmail module does for one message, short of its claim row. */
  async function convert(
    raw: Buffer,
    mode: EmailImportMode,
    folder = "INBOX",
    connectionId = project.connectionId,
  ) {
    const uid = folder === "INBOX" ? info.deliver(raw) : info.file(folder, raw);
    const uidValidity = folder === "INBOX" ? info.uidValidity : "77";
    const row = await inboundRowForImport(
      scope(),
      connectionId,
      { folder, uid, uidValidity },
      raw,
    );
    const prepared = await target.prepare(scope(), {
      source: raw,
      connectionId,
      inboundId: row.inboundId,
    });
    try {
      const result = await run((tx) =>
        target.commit(tx, scope(), prepared, mode),
      );
      if (result.duplicate) await target.discard(scope(), prepared);
      return { ...result, ...row, prepared };
    } catch (error) {
      await target.discard(scope(), prepared);
      throw error;
    }
  }
  async function runSupportJobs() {
    for (const job of await queuedJobs(project, "support_email_inbound"))
      if (data(job).status === "queued") {
        await handleInboundEmail(scope(), data(job).resourceId);
        await run(async (tx) => {
          const row = await entity(tx, scope(), "jobs", job.id);
          await update(tx, scope(), row, {
            ...data(row),
            status: "succeeded",
          });
        });
      }
  }
  async function flush() {
    for (const m of await allOutbound())
      if (data(m).status === "queued") await sendQueuedEmail(scope(), m.id);
    await syncEmailDelivery(scope());
  }
  const liveFiles = () =>
    run((tx) =>
      tx.file.count({
        where: {
          projectId: scope().projectId,
          moduleId: "support",
          deletedAt: null,
        },
      }),
    );

  beforeAll(() => {
    installMail(
      (account) =>
        account.fromAddress === "info@desk.example"
          ? info.reader()
          : support.reader(),
      sent,
      store,
    );
  });
  beforeEach(async () => {
    Object.assign(process.env, MAIL_ENV, {
      ORBIT_WEBMAIL: "true",
      ORBIT_NOTIFICATIONS: "true",
    });
    info = new FakeImap();
    support = new FakeImap();
    sent.length = 0;
    project = await mailProject("Synthetic takeover", "info@desk.example", [
      "support",
    ]);
    workspaces.push(project.workspaceId);
    await markMailbox(project, project.connectionId);
    supportConnection = await addMailbox(project, "support@desk.example");
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Agent",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(user.id);
    agentId = user.id;
    await authDb.workspaceMember.create({
      data: {
        workspaceId: project.workspaceId,
        userId: user.id,
        role: "viewer",
      },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: project.workspaceId,
        projectId: scope().projectId,
        userId: user.id,
        role: "editor",
      },
    });
    inboxId = await run(
      async (tx) =>
        (
          await createInbox(tx, scope(), {
            name: "Desk",
            channels: ["email"],
            emailConnectionId: supportConnection,
            aiMode: "draft",
            assignmentPolicy: "fixed",
            defaultAssigneeUserId: agentId,
          })
        ).inbox.id,
    );
    await run((tx) =>
      writeModuleSettings(
        tx,
        scope(),
        "support",
        supportSettingsSchema,
        {
          ...supportSettingsDefaults(),
          categories: [{ key: "billing", label: "Billing" }],
        },
        1,
      ),
    );
    target = registeredEmailImports().get("support.ticket")!;
    await fetchInbound(scope());
  });
  afterAll(async () => {
    for (const name of [
      ...Object.keys(MAIL_ENV),
      "ORBIT_WEBMAIL",
      "ORBIT_NOTIFICATIONS",
      "ORBIT_FINANCE",
    ])
      delete process.env[name];
    closeMailboxLocks();
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  describe("what it offers", () => {
    it("is registered behind its own permission for owners and editors", () => {
      expect(target.permission).toMatchObject({
        key: "support.tickets.import",
        defaultRoles: ["owner", "editor"],
      });
      expect(supportPermissions).toContain(target.permission);
    });

    it("follows the module's activation", async () => {
      expect(await run((tx) => target.active(tx, scope()))).toBe(true);
      delete process.env.ORBIT_SUPPORT;
      expect(await run((tx) => target.active(tx, scope()))).toBe(false);
    });

    it("lists only live e-mail inboxes with their own verified mailbox", async () => {
      await run((tx) =>
        tx.supportInbox.create({
          data: {
            id: randomUUID(),
            workspaceId: scope().workspaceId,
            projectId: scope().projectId,
            name: "Unbound on the default mailbox",
            channels: ["email"],
            createdBy: scope().userId,
          },
        }),
      );
      const destinations = await run((tx) => target.destinations(tx, scope()));
      expect(destinations).toHaveLength(1);
      expect(destinations[0]).toMatchObject({
        id: inboxId,
        name: "Desk",
        address: "support@desk.example",
        priorities: ["low", "normal", "high", "urgent"],
      });
      expect(destinations[0]!.categories.length).toBeGreaterThan(0);
      // The mailbox loses its verification: no reply could leave.
      await run(async (tx) => {
        const c = await entity(tx, scope(), "connectors", supportConnection);
        await update(tx, scope(), c, { ...data(c), status: "configured" });
      });
      expect(await run((tx) => target.destinations(tx, scope()))).toEqual([]);
    });

    it("finds tickets by number, subject and exact id, never merged ones", async () => {
      const first = await convert(
        rawMail({ Subject: "Payment declined" }),
        create(),
      );
      const second = await convert(rawMail({ Subject: "Other" }), create());
      const search = (q: string) =>
        run((tx) => target.searchRecords(tx, scope(), q));
      expect((await search(`#${first.number}`)).map((h) => h.id)).toEqual([
        first.recordId,
      ]);
      expect((await search(String(first.number))).map((h) => h.id)).toEqual([
        first.recordId,
      ]);
      expect((await search("payment")).map((h) => h.id)).toEqual([
        first.recordId,
      ]);
      const byId = await search(second.recordId);
      expect(byId).toEqual([
        {
          id: second.recordId,
          number: second.number,
          title: "Other",
          status: "new",
        },
      ]);
      await run((tx) =>
        mergeTicket(tx, scope(), second.recordId, {
          intoTicketId: first.recordId,
        }),
      );
      expect(await search("Other")).toEqual([]);
      expect(await search(`#${second.number}`)).toEqual([]);
      // A replay still finds the number of a ticket merged since.
      expect((await search(second.recordId)).map((h) => h.number)).toEqual([
        second.number,
      ]);
    });
  });

  describe("a new ticket", () => {
    it("keeps the channel, starts no AI or agent and mails nobody", async () => {
      const raw = rawMail({ Subject: "Please help" });
      const done = await convert(raw, create());
      expect(done.duplicate).toBe(false);
      const [ticket] = await tickets();
      expect(ticket).toMatchObject({
        id: done.recordId,
        channel: "email",
        inboxId,
        importSource: "mailbox_import",
        subject: "Please help",
      });
      expect(await queuedJobs(project, "support_triage")).toEqual([]);
      expect(await queuedJobs(project, "support_draft")).toEqual([]);
      expect(await domainEvents()).toBe(0);
      await runSupportJobs();
      await flush();
      expect(await outbound()).toEqual([]);
      expect(customerMail()).toEqual([]);
      expect((await messagesOf(ticket!.id)).map((m) => m.kind)).toEqual([
        "customer",
      ]);
    });

    it("assigns and tells the team as usual", async () => {
      const done = await convert(rawMail(), create());
      const [ticket] = await tickets();
      expect(ticket!.id).toBe(done.recordId);
      expect(ticket!.assigneeUserId).toBe(agentId);
      const { items } = await myNotifications({
        ...scope(),
        userId: agentId,
        role: "editor",
      } as Scope);
      expect((items as Array<{ kind: string }>).map((n) => n.kind)).toContain(
        "support_ticket_assigned",
      );
    });

    it("applies the subject, priority and category chosen", async () => {
      const categories = (
        await run((tx) => target.destinations(tx, scope()))
      )[0]!.categories;
      await convert(
        rawMail(),
        create({
          subject: "  Chosen subject ",
          priority: "urgent",
          category: categories[0],
        } as Partial<EmailImportMode>),
      );
      const [ticket] = await tickets();
      expect(ticket).toMatchObject({
        subject: "Chosen subject",
        priority: "urgent",
        category: categories[0],
      });
      const normal = await convert(rawMail(), create());
      const rows = await tickets();
      const second = rows.find((t) => t.id === normal.recordId)!;
      expect(second.priority).toBe("normal");
      expect(ticket!.firstResponseDueAt!.getTime()).toBeLessThan(
        second.firstResponseDueAt!.getTime(),
      );
    });

    it("refuses what the module does not know, and cleans up", async () => {
      const raw = withAttachments([
        { name: "a.png", mime: "image/png", bytes: PNG },
      ]);
      for (const [extra, code] of [
        [{ destinationId: randomUUID() }, "EMAIL_IMPORT_DESTINATION_INVALID"],
        [{ priority: "whenever" }, "EMAIL_IMPORT_PRIORITY_INVALID"],
        [{ category: "not_a_category" }, "EMAIL_IMPORT_CATEGORY_INVALID"],
      ] as const)
        await expect(
          convert(raw, create(extra as Partial<EmailImportMode>), "Archive"),
        ).rejects.toMatchObject({ code });
      expect(await liveFiles()).toBe(0);
      expect(await tickets()).toEqual([]);
    });

    it("refuses an unusable sender before any contact exists", async () => {
      const contacts = () =>
        run((tx) =>
          tx.supportContact.count({ where: { projectId: scope().projectId } }),
        );
      await expect(
        convert(rawMail({ From: "not an address" }), create()),
      ).rejects.toMatchObject({ code: "EMAIL_IMPORT_ADDRESS_INVALID" });
      expect(await contacts()).toBe(0);
      expect(await tickets()).toEqual([]);
    });

    it("answers at the Reply-To when the member says so", async () => {
      const raw = rawMail({
        From: "Anna Customer <anna@example.org>",
        "Reply-To": "Billing <billing@example.org>",
      });
      const done = await convert(
        raw,
        create({ customerAddress: "reply_to" } as Partial<EmailImportMode>),
      );
      const ticket = (await tickets()).find((t) => t.id === done.recordId)!;
      const contact = await contactNamed("billing@example.org");
      expect(ticket.contactId).toBe(contact!.id);
      expect(await contactNamed("anna@example.org")).toBeNull();
    });

    it("uses the From address by default and without a Reply-To", async () => {
      const first = await convert(
        rawMail({ "Reply-To": "billing@example.org" }),
        create(),
      );
      const second = await convert(
        rawMail(),
        create({ customerAddress: "reply_to" } as Partial<EmailImportMode>),
      );
      const contact = await contactNamed("anna@example.org");
      const rows = await tickets();
      for (const id of [first.recordId, second.recordId])
        expect(rows.find((t) => t.id === id)!.contactId).toBe(contact!.id);
    });
  });

  describe("attachments", () => {
    it("keeps the channel's rules and counts what it leaves out", async () => {
      const raw = withAttachments([
        ...Array.from({ length: 11 }, (_, i) => ({
          name: `p${i}.png`,
          mime: "image/png",
          bytes: PNG,
        })),
        {
          name: "tool.exe",
          mime: "application/octet-stream",
          bytes: Buffer.from("MZ"),
        },
      ]);
      const done = await convert(raw, create());
      expect(done.prepared.fileIds).toHaveLength(10);
      expect(done.prepared.skippedAttachments).toBe(2);
      const [message] = await messagesOf(done.recordId);
      const attachments = await run((tx) =>
        tx.supportAttachment.findMany({ where: { messageId: message!.id } }),
      );
      expect(attachments).toHaveLength(10);
      expect(await liveFiles()).toBe(10);
    });

    it("removes them when asked to discard", async () => {
      const raw = withAttachments([
        { name: "a.png", mime: "image/png", bytes: PNG },
      ]);
      const prepared = await target.prepare(scope(), {
        source: raw,
        connectionId: project.connectionId,
        inboundId: randomUUID(),
      });
      expect(await liveFiles()).toBe(1);
      await target.discard(scope(), prepared);
      expect(await liveFiles()).toBe(0);
    });
  });

  describe("the reply", () => {
    it("leaves from the inbox's mailbox, in the customer's thread", async () => {
      const id = "<original@example.org>";
      const done = await convert(rawMail({ "Message-ID": id }), create());
      const reply = await run((tx) =>
        replyToTicket(tx, { ...scope(), userId: agentId }, done.recordId, {
          bodyText: "We can help.",
        }),
      );
      expect(reply.deliveryState).toBe("pending");
      await flush();
      expect(customerMail()).toHaveLength(1);
      expect(customerMail()[0]).toMatchObject({
        from: { address: "support@desk.example" },
        to: ["anna@example.org"],
        inReplyTo: id,
      });
      expect(customerMail()[0]!.references).toContain(id);
      expect(customerMail()[0]!.subject).toContain(`[#${done.number}]`);
    });

    const automaticTicket = async () => {
      const id = "<newsletter@example.org>";
      const done = await convert(
        rawMail({ "Message-ID": id, "Auto-Submitted": "auto-generated" }),
        create(),
      );
      return { id, ticketId: done.recordId };
    };

    it("lets a person answer mail marked automatic, over the HTTP route", async () => {
      const { id, ticketId } = await automaticTicket();
      const origin = process.env.APP_ORIGIN!;
      const account = {
        email: `${randomUUID()}@example.invalid`,
        password: randomBytes(24).toString("base64url"),
      };
      const created = await makeAuth().api.signUpEmail({
        body: { ...account, name: "Synthetic support owner" },
      });
      users.push(created.user.id);
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project.workspaceId,
          userId: created.user.id,
          role: "owner",
        },
      });
      const app = await buildServer();
      try {
        const signedIn = await app.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          headers: { origin, [CLIENT_IP_HEADER]: "198.18.7.21" },
          payload: account,
        });
        expect(signedIn.statusCode).toBe(200);
        const set = signedIn.headers["set-cookie"];
        const cookie = (Array.isArray(set) ? set : [set])
          .map((v) => v!.split(";")[0])
          .join("; ");
        const reply = await app.inject({
          method: "POST",
          url: `/api/projects/${scope().projectId}/support/tickets/${ticketId}/replies`,
          headers: { origin, cookie, [CLIENT_IP_HEADER]: "198.18.7.22" },
          payload: { bodyText: "A person answers." },
        });
        expect(reply.statusCode).toBeLessThan(300);
      } finally {
        await app.close();
      }
      await flush();
      expect(customerMail()[0]!.inReplyTo).toBe(id);
    });

    it("keeps the automatic-mail guard for a reply no person made here", async () => {
      const { ticketId } = await automaticTicket();
      await expect(
        run((tx) =>
          replyToTicket(tx, { ...scope(), userId: agentId }, ticketId, {
            bodyText: "Nobody decided this.",
          }),
        ),
      ).rejects.toMatchObject({
        code: "EMAIL_REPLY_TO_AUTOMATIC",
        status: 409,
      });
    });

    it("keeps the automatic-mail guard on the MCP route", async () => {
      const { ticketId } = await automaticTicket();
      const ticket = (await tickets()).find((t) => t.id === ticketId)!;
      const action = supportMcpActions[
        "support.mcp.support_send_reply"
      ] as unknown as {
        onApproved(tx: DbTx, scope: Scope, row: unknown): Promise<unknown>;
      };
      await expect(
        run(async (tx) => {
          const row = await createEntity(tx, scope(), "action_requests", {
            actionType: "support.mcp.support_send_reply",
            status: "approved",
            requestedBy: { kind: "mcp", userId: agentId },
            payload: {
              actorId: agentId,
              args: { ticketId, bodyText: "Standing rule, no person." },
              idempotencyKey: randomUUID(),
              ceilingMicros: 0,
              approvalContext: {
                projectId: scope().projectId,
                ticketId,
                ticketNumber: ticket.number,
                contactId: ticket.contactId,
                recipient: "anna@example.org",
                channel: "email",
                inboxId,
                emailConnectionId: supportConnection,
              },
            },
          });
          return action.onApproved(tx, scope(), row);
        }),
      ).rejects.toMatchObject({ code: "EMAIL_REPLY_TO_AUTOMATIC" });
    });

    it("does not fall back to the default mailbox", async () => {
      const done = await convert(rawMail(), create());
      await run((tx) =>
        tx.supportInbox.update({
          where: { id: inboxId },
          data: { emailConnectionId: null },
        }),
      );
      const reply = await run((tx) =>
        replyToTicket(tx, { ...scope(), userId: agentId }, done.recordId, {
          bodyText: "Nowhere to send from.",
        }),
      );
      expect(reply.deliveryState).toBe("not_sent");
      expect(await outbound()).toEqual([]);
    });

    it("keeps made-up ids out of the mail headers", async () => {
      const done = await convert(
        rawMail({ "Message-ID": null } as never),
        create(),
      );
      await run((tx) =>
        replyToTicket(tx, { ...scope(), userId: agentId }, done.recordId, {
          bodyText: "Hello.",
        }),
      );
      await flush();
      expect(customerMail()[0]!.inReplyTo).toBeUndefined();
      expect(customerMail()[0]!.references ?? []).toEqual([]);
    });
  });

  describe("adding to an existing ticket", () => {
    const seed = async () => {
      const made = await convert(rawMail({ Subject: "Base" }), create());
      await run((tx) =>
        tx.supportTicket.update({
          where: { id: made.recordId },
          data: { status: "resolved", resolvedAt: new Date() },
        }),
      );
      return made;
    };

    it("reopens and notifies without AI, events or mail", async () => {
      const base = await seed();
      const before = await domainEvents();
      const done = await convert(rawMail({ Subject: "More" }), {
        kind: "append",
        recordId: base.recordId,
      });
      expect(done).toMatchObject({
        recordId: base.recordId,
        number: base.number,
        duplicate: false,
      });
      const ticket = (await tickets()).find((t) => t.id === base.recordId)!;
      expect(ticket.status).toBe("open");
      expect(ticket.resolvedAt).toBeNull();
      expect(await domainEvents()).toBe(before);
      expect(await queuedJobs(project, "support_draft")).toEqual([]);
      expect(await outbound()).toEqual([]);
      const { items } = await myNotifications({
        ...scope(),
        userId: agentId,
        role: "editor",
      } as Scope);
      expect((items as Array<{ kind: string }>).map((n) => n.kind)).toContain(
        "support_customer_replied",
      );
    });

    it("credits the ticket's customer when the sender is that customer", async () => {
      const base = await seed();
      await convert(rawMail(), { kind: "append", recordId: base.recordId });
      const customer = (await messagesOf(base.recordId)).filter(
        (m) => m.kind === "customer",
      );
      const ticket = (await tickets()).find((t) => t.id === base.recordId)!;
      expect(customer.map((m) => m.authorContactId)).toEqual([
        ticket.contactId,
        ticket.contactId,
      ]);
    });

    it("credits another sender as themselves", async () => {
      const base = await seed();
      await convert(rawMail({ From: "Bob <bob@example.org>" }), {
        kind: "append",
        recordId: base.recordId,
      });
      const bob = await contactNamed("bob@example.org");
      const last = (await messagesOf(base.recordId)).at(-1)!;
      expect(last.authorContactId).toBe(bob!.id);
      const ticket = (await tickets()).find((t) => t.id === base.recordId)!;
      expect(ticket.contactId).not.toBe(bob!.id);
    });

    it("leaves an unusable sender without an author", async () => {
      const base = await seed();
      await convert(rawMail({ From: "nonsense" }), {
        kind: "append",
        recordId: base.recordId,
      });
      expect((await messagesOf(base.recordId)).at(-1)!.authorContactId).toBe(
        null,
      );
    });

    it("refuses a ticket of nobody", async () => {
      await expect(
        convert(rawMail(), { kind: "append", recordId: randomUUID() }),
      ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
    });

    it("follows a merge to the ticket that lives on", async () => {
      const source = await seed();
      const into = await convert(rawMail({ Subject: "Into" }), create());
      await run((tx) =>
        mergeTicket(tx, scope(), source.recordId, {
          intoTicketId: into.recordId,
        }),
      );
      const done = await convert(rawMail({ Subject: "Late" }), {
        kind: "append",
        recordId: source.recordId,
      });
      expect(done.recordId).toBe(into.recordId);
    });
  });

  describe("a message that is already there", () => {
    it("answers with the existing ticket and writes nothing", async () => {
      const raw = withAttachments([
        { name: "a.png", mime: "image/png", bytes: PNG },
      ]);
      const first = await convert(raw, create(), "Archive");
      const again = await convert(raw, create(), "Archive");
      expect(again).toMatchObject({
        recordId: first.recordId,
        number: first.number,
        duplicate: true,
      });
      expect(await tickets()).toHaveLength(1);
      expect(await liveFiles()).toBe(1);
    });

    it("points at the ticket holding it, wherever the member aimed", async () => {
      const raw = rawMail();
      const first = await convert(raw, create(), "Archive");
      const other = await convert(rawMail(), create());
      const again = await convert(
        raw,
        { kind: "append", recordId: other.recordId },
        "Archive",
      );
      expect(again).toMatchObject({
        recordId: first.recordId,
        duplicate: true,
      });
      expect((await messagesOf(other.recordId)).length).toBe(1);
    });

    it("follows a merge", async () => {
      const raw = rawMail();
      const first = await convert(raw, create(), "Archive");
      const into = await convert(rawMail(), create());
      await run((tx) =>
        mergeTicket(tx, scope(), first.recordId, {
          intoTicketId: into.recordId,
        }),
      );
      const again = await convert(raw, create(), "Archive");
      expect(again).toMatchObject({
        recordId: into.recordId,
        number: into.number,
        duplicate: true,
      });
    });

    it("does not let a forged Message-ID join someone else's ticket", async () => {
      const id = "<shared-id@example.org>";
      const victim = await convert(
        rawMail({
          "Message-ID": id,
          From: "Victim <victim@example.org>",
          Subject: "Private",
        }),
        create(),
        "Archive",
      );
      const forged = rawMail({
        "Message-ID": id,
        From: "Mallory <mallory@example.org>",
        Subject: "Forged",
      });
      const done = await convert(forged, create());
      expect(done.duplicate).toBe(false);
      expect(done.recordId).not.toBe(victim.recordId);
      expect((await messagesOf(victim.recordId)).length).toBe(1);
      const [message] = await messagesOf(done.recordId);
      expect(message!.externalId).toBe(
        `<inbound.${done.inboundId}@orbit.invalid>`,
      );
      // Taking the same forged mail over again finds its own ticket.
      const row = await inboundRowForImport(
        scope(),
        project.connectionId,
        { folder: "INBOX", uid: 1, uidValidity: "1" },
        forged,
      );
      const prepared = await target.prepare(scope(), {
        source: forged,
        connectionId: project.connectionId,
        inboundId: row.inboundId,
      });
      const repeat = await run((tx) =>
        target.commit(tx, scope(), prepared, create()),
      );
      expect(repeat).toMatchObject({
        recordId: done.recordId,
        duplicate: true,
      });
    });

    it("refuses an appended forgery too", async () => {
      const id = "<shared-append@example.org>";
      const victim = await convert(
        rawMail({ "Message-ID": id, From: "victim@example.org" }),
        create(),
        "Archive",
      );
      const mine = await convert(
        rawMail({ From: "mallory@example.org", Subject: "Mine" }),
        create(),
      );
      const done = await convert(
        rawMail({ "Message-ID": id, From: "mallory@example.org" }),
        { kind: "append", recordId: mine.recordId },
      );
      expect(done).toMatchObject({ recordId: mine.recordId, duplicate: false });
      expect((await messagesOf(victim.recordId)).length).toBe(1);
      expect((await messagesOf(mine.recordId)).length).toBe(2);
    });
  });

  describe("Support's own handling around a takeover", () => {
    it("does not count takeovers against the abuse cap", async () => {
      for (let i = 0; i < 11; i++) await convert(rawMail(), create());
      expect(
        await run((tx) => allowNewTicket(tx, scope(), "anna@example.org")),
      ).toBe(true);
    });

    it("threads a customer's answer to the original address", async () => {
      const id = "<first-contact@example.org>";
      const done = await convert(rawMail({ "Message-ID": id }), create());
      await fetchInbound(scope());
      info.deliver(
        rawMail({
          "In-Reply-To": id,
          Subject: "Re: A question",
          "Message-ID": "<answer@example.org>",
        }),
      );
      await fetchInbound(scope());
      await runSupportJobs();
      const customer = (await messagesOf(done.recordId)).filter(
        (m) => m.kind === "customer",
      );
      expect(customer.map((m) => m.externalId)).toEqual([
        id,
        "<answer@example.org>",
      ]);
    });

    it("keeps listening for a takeover of mail without a Message-ID", async () => {
      await convert(rawMail({ "Message-ID": null } as never), create());
      await fetchInbound(scope());
      const count = (await inboundRows(project)).length;
      info.deliver(rawMail({ Subject: "Another" }));
      await fetchInbound(scope());
      expect((await inboundRows(project)).length).toBe(count + 1);
    });

    it("still hears a takeover behind hundreds of newer ones", async () => {
      const oldest = await convert(rawMail(), create(), "Archive");
      const { contactId } = (await tickets()).find(
        (t) => t.id === oldest.recordId,
      )!;
      const base = {
        workspaceId: scope().workspaceId,
        projectId: scope().projectId,
      };
      const newer = Array.from({ length: 210 }, (_, i) => ({
        ...base,
        id: randomUUID(),
        number: 1000 + i,
        inboxId,
        contactId,
        subject: `Newer ${i}`,
        channel: "email",
        importSource: "mailbox_import",
      }));
      await run(async (tx) => {
        await tx.supportTicket.update({
          where: { id: oldest.recordId },
          data: { updatedAt: new Date(Date.now() - 86_400_000) },
        });
        await tx.supportTicket.createMany({ data: newer });
        await tx.supportMessage.createMany({
          data: newer.flatMap((t) =>
            [0, 1, 2].map((n) => ({
              ...base,
              id: randomUUID(),
              ticketId: t.id,
              kind: "customer",
              bodyText: "Filler",
              channel: "email",
              externalId: `<newer-${t.number}-${n}@example.org>`,
              visibleToCustomer: true,
            })),
          ),
        });
      });
      expect(
        await run((tx) =>
          supportMailboxUse.receivesMail!(tx, scope(), project.connectionId),
        ),
      ).toBe(true);
    });

    it("does not hear a mailbox no takeover came from", async () => {
      await convert(rawMail(), create(), "Archive");
      const other = await addMailbox(project, "other@desk.example");
      expect(
        await run((tx) => supportMailboxUse.receivesMail!(tx, scope(), other)),
      ).toBe(false);
    });

    it("stops listening at that address when the ticket is closed", async () => {
      const done = await convert(rawMail(), create());
      await fetchInbound(scope());
      await run((tx) =>
        tx.supportTicket.update({
          where: { id: done.recordId },
          data: { status: "closed", closedAt: new Date() },
        }),
      );
      const count = (await inboundRows(project)).length;
      info.deliver(rawMail({ Subject: "Unrelated" }));
      await fetchInbound(scope());
      expect((await inboundRows(project)).length).toBe(count);
    });

    it("still drops mail to that address that answers no takeover", async () => {
      const done = await convert(rawMail(), create());
      await fetchInbound(scope());
      info.deliver(rawMail({ From: "stranger@example.org", Subject: "Hello" }));
      await fetchInbound(scope());
      await runSupportJobs();
      expect(await tickets()).toHaveLength(1);
      expect((await messagesOf(done.recordId)).length).toBe(1);
    });

    it("does not thread at a mailbox no longer under the webmail rules", async () => {
      const id = "<before-rollback@example.org>";
      const done = await convert(rawMail({ "Message-ID": id }), create());
      await fetchInbound(scope());
      delete process.env.ORBIT_WEBMAIL;
      info.deliver(rawMail({ "In-Reply-To": id, Subject: "Re: x" }));
      await fetchInbound(scope());
      await runSupportJobs();
      expect((await messagesOf(done.recordId)).length).toBe(1);
    });

    it("leaves a message alone when its job runs after the takeover", async () => {
      const done = await convert(
        rawMail({ To: "support@desk.example" }),
        create(),
        "INBOX",
        supportConnection,
      );
      await runSupportJobs();
      expect(await tickets()).toHaveLength(1);
      expect((await messagesOf(done.recordId)).length).toBe(1);
      expect(customerMail()).toEqual([]);
    });

    it("sends no acknowledgement when the channel's job gets there first", async () => {
      const raw = rawMail({ To: "support@desk.example" });
      const row = await inboundRowForImport(
        scope(),
        supportConnection,
        { folder: "INBOX", uid: 1, uidValidity: "1" },
        raw,
      );
      await runSupportJobs();
      await flush();
      expect(await outbound()).toEqual([]);
      const prepared = await target.prepare(scope(), {
        source: raw,
        connectionId: supportConnection,
        inboundId: row.inboundId,
      });
      const done = await run((tx) =>
        target.commit(tx, scope(), prepared, create()),
      );
      expect(done.duplicate).toBe(true);
      expect(await tickets()).toHaveLength(1);
    });

    it("still runs AI and events for tickets of the channel", async () => {
      support.deliver(rawMail({ To: "support@desk.example" }));
      await fetchInbound(scope());
      await runSupportJobs();
      const [ticket] = await tickets();
      expect(ticket!.importSource).toBeNull();
      expect((await queuedJobs(project, "support_triage")).length).toBe(1);
      expect(await domainEvents()).toBe(1);
    });
  });

  it("still hands an INBOX message that was taken over to Finance", async () => {
    process.env.ORBIT_FINANCE = "true";
    try {
      await run(async (tx) => {
        await tx.projectModule.create({
          data: {
            workspaceId: scope().workspaceId,
            projectId: scope().projectId,
            moduleId: "finance",
            enabled: true,
            moduleVersion: "1.0.0",
          },
        });
        await setMailboxOwner(tx, scope(), project.connectionId, "finance");
      });
      const done = await convert(rawMail({ Subject: "Invoice 42" }), create());
      expect((await tickets()).map((t) => t.id)).toEqual([done.recordId]);
      const jobs = await queuedJobs(project, "finance_mail_receipt");
      expect(jobs.map((j) => data(j).resourceId)).toEqual([done.inboundId]);
      expect(await queuedJobs(project, "support_email_inbound")).toEqual([]);
      // The next pass meets the same message: no second row, no second job.
      await fetchInbound(scope());
      expect(
        (await inboundRows(project)).filter(
          (r) => data(r).connectionId === project.connectionId,
        ),
      ).toHaveLength(1);
      expect(await queuedJobs(project, "finance_mail_receipt")).toHaveLength(1);
    } finally {
      delete process.env.ORBIT_FINANCE;
    }
  });

  describe("retention", () => {
    const later = () => new Date(Date.now() + YEARS_10);
    const rowById = async (id: string) =>
      (await inboundRows(project)).find((r) => r.id === id);

    it("finds the original of a message from another folder", async () => {
      const done = await convert(
        rawMail({ "Message-ID": "<archived@example.org>" }),
        create(),
        "Archive",
      );
      const objectsBefore = objects.size;
      const applied = await supportRetention(scope(), later());
      expect(applied.rawMails).toBe(1);
      expect(objects.size).toBeLessThan(objectsBefore);
      const d = data(await rowById(done.inboundId));
      expect(d.retainedUntil).toEqual(expect.any(String));
      expect(d.fileId).toBeUndefined();
      expect(d.importedFromConnectionId).toBe(project.connectionId);
      expect(d.connectionId).toBeNull();
    });

    it("finds the original recorded under a stand-in id", async () => {
      const done = await convert(
        rawMail({ "Message-ID": null } as never),
        create(),
        "Archive",
      );
      const applied = await supportRetention(scope(), later());
      expect(applied.rawMails).toBe(1);
      expect(data(await rowById(done.inboundId)).retainedUntil).toEqual(
        expect.any(String),
      );
    });

    it("removes that row with its closed ticket", async () => {
      const done = await convert(
        rawMail({ "Message-ID": null } as never),
        create(),
        "Archive",
      );
      await run((tx) =>
        tx.supportTicket.update({
          where: { id: done.recordId },
          data: { status: "closed", closedAt: new Date() },
        }),
      );
      await supportRetention(scope(), later());
      expect(await tickets()).toEqual([]);
      expect(await rowById(done.inboundId)).toBeUndefined();
    });

    it("leaves mail of the channel without a Message-ID as it was", async () => {
      support.deliver(
        rawMail({ "Message-ID": null, To: "support@desk.example" } as never),
      );
      await fetchInbound(scope());
      await runSupportJobs();
      const before = (await inboundRows(project)).find(
        (r) => data(r).connectionId === supportConnection,
      )!;
      await supportRetention(scope(), later());
      const after = await rowById(before.id);
      expect(data(after)).toEqual(data(before));
    });
  });
});
