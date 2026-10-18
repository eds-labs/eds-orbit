import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity, list, update } from "../src/shared.ts";
import { registeredConnectionProvider } from "../src/platform/modules/contributions.ts";
import { connectEmail } from "../src/platform/email/connection.ts";
import { sendQueuedEmail } from "../src/platform/email/send.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import {
  setMailFactoriesForTests,
  type FetchedMessage,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import {
  handleInboundEmail,
  syncEmailDelivery,
} from "../src/modules/support/channels/email.ts";
import { replyToTicket } from "../src/modules/support/workspace.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const ENV = {
  ORBIT_SUPPORT: "true",
  ORBIT_EMAIL: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const ACCOUNT = {
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: "support@desk.example",
  fromAddress: "support@desk.example",
  fromName: "Desk Support",
  password: "synthetic-mailbox-password",
};
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

/** A raw message; with `attachment`, multipart with one PNG and one .exe. */
function mime(
  headers: Record<string, string>,
  body = "My withdrawal is stuck.",
  attachment = false,
) {
  const head = {
    From: "Anna Customer <anna@example.org>",
    To: ACCOUNT.fromAddress,
    Subject: "Withdrawal stuck",
    Date: "Sat, 17 Oct 2026 10:00:00 +0000",
    "Message-ID": `<${randomUUID()}@example.org>`,
    ...headers,
  };
  const lines = Object.entries(head).map(([k, v]) => `${k}: ${v}`);
  if (!attachment)
    return Buffer.from(
      [...lines, "Content-Type: text/plain; charset=utf-8", "", body, ""].join(
        "\r\n",
      ),
    );
  const b = "orbit-boundary";
  return Buffer.from(
    [
      ...lines,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      `--${b}`,
      'Content-Type: image/png; name="screen.png"',
      'Content-Disposition: attachment; filename="screen.png"',
      "Content-Transfer-Encoding: base64",
      "",
      PNG.toString("base64"),
      `--${b}`,
      'Content-Type: application/octet-stream; name="tool.exe"',
      'Content-Disposition: attachment; filename="tool.exe"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("MZ...").toString("base64"),
      `--${b}--`,
      "",
    ].join("\r\n"),
  );
}

/**
 * The support e-mail channel (WP5.3) on the WP4.7 mailbox with IMAP and SMTP
 * stubs: new tickets, threading, reopening, loop protection, acknowledgement
 * limits, routing, dedupe and delivery states of agent replies.
 */
describe.skipIf(!enabled)("support e-mail channel", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  let inboxId = "";
  const sent: OutgoingMail[] = [];
  let uid = 0;
  const mailbox: FetchedMessage[] = [];
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);

  /** Delivers raw mail to the stub mailbox, fetches it and runs support's jobs. */
  async function receive(raw: Buffer) {
    mailbox.push({ uid: ++uid, source: raw } as FetchedMessage);
    await fetchInbound(scope);
    const jobs = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) =>
        data(j).topic === "support_email_inbound" &&
        data(j).status === "queued",
    );
    for (const job of jobs) {
      await handleInboundEmail(scope, data(job).resourceId);
      await run(async (tx) => {
        const row = await entity(tx, scope, "jobs", job.id);
        await update(tx, scope, row, { ...data(row), status: "succeeded" });
      });
    }
  }
  const tickets = () =>
    run((tx) =>
      tx.supportTicket.findMany({
        where: { projectId: scope.projectId },
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
  /** Sends every queued e-mail through the stub and syncs delivery states. */
  async function flush() {
    const queued = (
      await run((tx) => list(tx, scope, "email_messages"))
    ).filter((m) => data(m).status === "queued");
    for (const m of queued) await sendQueuedEmail(scope, m.id);
    await syncEmailDelivery(scope);
  }

  beforeAll(async () => {
    Object.assign(process.env, ENV, {
      EXECUTION_MODE: "live",
      ENABLE_EXTERNAL_WRITES: "true",
    });
    setObjectStoreForTests(store);
    setMailFactoriesForTests({
      checkHost: async () => undefined,
      transport: () => ({
        verify: async () => undefined,
        send: async (mail) => {
          sent.push(mail);
          return { accepted: mail.to, rejected: [] };
        },
        close: () => undefined,
      }),
      mailbox: () => ({
        verify: async () => undefined,
        fetchNew: async (state, limits) => ({
          uidValidity: "1",
          messages: mailbox
            .filter((m) => m.uid > state.lastUid)
            .slice(0, limits.max),
          skipped: [],
        }),
      }),
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic support e-mail" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support e-mail" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    const connection = await run((tx) => connectEmail(tx, scope, ACCOUNT));
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...connection.data },
      ACCOUNT.password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", connection.id);
      await update(tx, scope, current, { ...data(current), ...checked });
      await tx.projectModule.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      inboxId = (
        await createInbox(tx, scope, {
          name: "Desk",
          channels: ["email"],
          emailAddress: ACCOUNT.fromAddress,
        })
      ).inbox.id;
    });
  });
  afterEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(async () => {
    for (const name of [
      ...Object.keys(ENV),
      "EXECUTION_MODE",
      "ENABLE_EXTERNAL_WRITES",
    ])
      delete process.env[name];
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("creates a ticket from a new mail with attachments and acknowledges it", async () => {
    sent.length = 0;
    await receive(mime({}, "My withdrawal is stuck.", true));
    const [ticket] = await tickets();
    expect(ticket).toMatchObject({
      inboxId,
      channel: "email",
      subject: "Withdrawal stuck",
      status: "new",
    });
    const messages = await messagesOf(ticket!.id);
    expect(messages.map((m) => m.kind)).toEqual(["customer", "system"]);
    const attachments = await run((tx) =>
      tx.supportAttachment.findMany({ where: { messageId: messages[0]!.id } }),
    );
    // The PNG is kept; the executable is not an allowed type.
    expect(attachments.map((a) => a.name)).toEqual(["screen.png"]);
    await flush();
    const ack = sent.find((m) => m.to.includes("anna@example.org"))!;
    expect(ack.subject).toBe(`Re: Withdrawal stuck [#${ticket!.number}]`);
    expect(ack.headers["Auto-Submitted"]).toBe("auto-generated");
    expect(
      (await messagesOf(ticket!.id)).find((m) => m.kind === "system"),
    ).toMatchObject({ deliveryState: "sent" });
  });

  it("threads a reply by headers and by subject token, and reopens", async () => {
    const first = mime({ Subject: "Login fails" });
    await receive(first);
    const ticket = (await tickets()).find((t) => t.subject === "Login fails")!;
    const firstId = /Message-ID: (<[^>]+>)/.exec(first.toString())![1]!;
    await run((tx) =>
      tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: "pending_customer" },
      }),
    );
    await receive(
      mime(
        { Subject: "Re: Login fails", "In-Reply-To": firstId },
        "Still broken",
      ),
    );
    await receive(
      mime({ Subject: `Another try [#${ticket.number}]` }, "Third message"),
    );
    // The same token from someone else opens a new ticket.
    await receive(
      mime(
        {
          From: "Mallory <mallory@example.org>",
          Subject: `Hijack [#${ticket.number}]`,
        },
        "Not mine",
      ),
    );
    const after = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } }),
    );
    expect(after.status).toBe("open");
    const customer = (await messagesOf(ticket.id)).filter(
      (m) => m.kind === "customer",
    );
    expect(customer.map((m) => m.bodyText.trim())).toEqual([
      "My withdrawal is stuck.",
      "Still broken",
      "Third message",
    ]);
    expect(
      (await tickets()).some((t) => t.subject === `Hijack [#${ticket.number}]`),
    ).toBe(true);
  });

  it("ignores unthreaded automatic mail and never acknowledges it", async () => {
    const before = (await tickets()).length;
    await flush();
    sent.length = 0;
    await receive(
      mime({ Subject: "Out of office", "Auto-Submitted": "auto-replied" }),
    );
    expect((await tickets()).length).toBe(before);
    await flush();
    expect(sent).toEqual([]);
  });

  it("caps acknowledgements per sender", async () => {
    await flush();
    sent.length = 0;
    for (let i = 0; i < 5; i++)
      await receive(
        mime({
          From: "Spammy <spammy@example.org>",
          Subject: `Question ${i}`,
        }),
      );
    await flush();
    expect(
      sent.filter((m) => m.to.includes("spammy@example.org")),
    ).toHaveLength(3);
  });

  it("handles the same inbound mail only once", async () => {
    await receive(mime({ Subject: "Twice" }));
    const inbound = (await run((tx) => list(tx, scope, "inbound_emails"))).find(
      (r) => data(r).subject === "Twice",
    )!;
    // A retried job sees the message it already recorded.
    await handleInboundEmail(scope, inbound.id);
    const twice = (await tickets()).filter((t) => t.subject === "Twice");
    expect(twice).toHaveLength(1);
    expect(
      (await messagesOf(twice[0]!.id)).filter((m) => m.kind === "customer"),
    ).toHaveLength(1);
  });

  it("routes by the inbox address", async () => {
    const other = await run(
      async (tx) =>
        (
          await createInbox(tx, scope, {
            name: "Billing",
            channels: ["email"],
            emailAddress: "billing@desk.example",
          })
        ).inbox.id,
    );
    await receive(mime({ To: "Billing@Desk.example", Subject: "Invoice" }));
    expect(
      (await tickets()).find((t) => t.subject === "Invoice")?.inboxId,
    ).toBe(other);
  });

  it("sends an agent reply in the thread and maps sent, unknown and bounced", async () => {
    const raw = mime({ Subject: "Reply me" });
    await receive(raw);
    const ticket = (await tickets()).find((t) => t.subject === "Reply me")!;
    await flush();
    sent.length = 0;
    const agent = { ...scope, userId: "agent-1" };
    const reply = await run((tx) =>
      replyToTicket(tx, agent, ticket.id, { bodyText: "We fixed it." }),
    );
    expect(reply.deliveryState).toBe("pending");
    await flush();
    const mail = sent.find((m) => m.text.includes("We fixed it."))!;
    const customerId = /Message-ID: (<[^>]+>)/.exec(raw.toString())![1]!;
    expect(mail.to).toEqual(["anna@example.org"]);
    expect(mail.inReplyTo).toBe(customerId);
    expect(mail.references).toContain(customerId);
    const stored = (await messagesOf(ticket.id)).find(
      (m) => m.id === reply.id,
    )!;
    expect(stored.deliveryState).toBe("sent");
    expect(stored.externalId).toMatch(/^<orbit\.[0-9a-f-]{36}@desk\.example>$/);

    // The customer's answer to the reply threads by its Message-ID.
    await receive(
      mime(
        { Subject: "Re: Reply me", "In-Reply-To": stored.externalId! },
        "Thanks",
      ),
    );
    expect(
      (await messagesOf(ticket.id)).filter((m) => m.kind === "customer"),
    ).toHaveLength(2);

    // A bounce report naming the reply and its recipient marks it bounced
    // (the platform needs both since WP4.7 review fix F-4).
    await receive(
      mime(
        {
          From: "Mail Delivery System <mailer-daemon@desk.example>",
          Subject: "Undelivered Mail Returned to Sender",
          "Content-Type": "text/plain",
        },
        `Delivery to anna@example.org failed for message ${stored.externalId}`,
      ),
    );
    await syncEmailDelivery(scope);
    expect(
      (await messagesOf(ticket.id)).find((m) => m.id === reply.id)!
        .deliveryState,
    ).toBe("bounced");

    // A transmit that broke after the hand-over is never resent: unknown.
    const second = await run((tx) =>
      replyToTicket(tx, agent, ticket.id, { bodyText: "One more thing." }),
    );
    await run(async (tx) => {
      const rows = await list(tx, scope, "email_messages");
      const row = rows.find((r) => data(r).text === "One more thing.")!;
      await update(tx, scope, row, { ...data(row), status: "outcome_unknown" });
    });
    await syncEmailDelivery(scope);
    expect(
      (await messagesOf(ticket.id)).find((m) => m.id === second.id)!
        .deliveryState,
    ).toBe("unknown");
  });

  it("marks a reply not_sent without the mail channel", async () => {
    await receive(mime({ Subject: "No mailbox later" }));
    const ticket = (await tickets()).find(
      (t) => t.subject === "No mailbox later",
    )!;
    delete process.env.ORBIT_EMAIL;
    const reply = await run((tx) =>
      replyToTicket(tx, { ...scope, userId: "agent-1" }, ticket.id, {
        bodyText: "Can you see this?",
      }),
    );
    expect(reply.deliveryState).toBe("not_sent");
  });

  it("does nothing while support is off", async () => {
    const before = (await tickets()).length;
    delete process.env.ORBIT_SUPPORT;
    await receive(mime({ Subject: "While off" }));
    expect((await tickets()).length).toBe(before);
  });

  it("never mails a claimed address and threads by headers only from the ticket's contact (review fix 1)", async () => {
    // An anonymous widget visitor who typed someone else's address.
    const widgetInbox = await run(
      async (tx) =>
        (
          await createInbox(tx, scope, {
            name: "Widget",
            channels: ["widget"],
            allowedOrigins: ["https://desk.example.invalid"],
          })
        ).inbox.id,
    );
    const claimed = await run((tx) =>
      tx.supportContact.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          claimedEmail: "victim@example.org",
        },
      }),
    );
    const widgetTicket = await run((tx) =>
      createTicket(tx, scope, {
        inboxId: widgetInbox,
        channel: "widget",
        contactId: claimed.id,
        inbound: {
          externalId: null,
          contact: {},
          subject: "Hi",
          bodyText: "Hi",
          attachments: [],
        },
      }),
    );
    await flush();
    sent.length = 0;
    const reply = await run((tx) =>
      replyToTicket(
        tx,
        { ...scope, userId: "agent-1" },
        widgetTicket.ticketId,
        {
          bodyText: "Widget answer",
        },
      ),
    );
    await flush();
    expect(sent.filter((m) => m.to.includes("victim@example.org"))).toEqual([]);
    expect(reply.deliveryState).toBe("sent");

    // A stranger answering with the headers of Anna's thread opens a new ticket.
    const raw = mime({ Subject: "Anna thread" });
    await receive(raw);
    const annaTicket = (await tickets()).find(
      (t) => t.subject === "Anna thread",
    )!;
    const annaId = /Message-ID: (<[^>]+>)/.exec(raw.toString())![1]!;
    await receive(
      mime(
        {
          From: "Mallory <mallory@example.org>",
          Subject: "Re: Anna thread",
          "In-Reply-To": annaId,
        },
        "Injected",
      ),
    );
    expect(
      (await messagesOf(annaTicket.id)).some((m) =>
        m.bodyText.includes("Injected"),
      ),
    ).toBe(false);
  });
});
