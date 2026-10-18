import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
  connectEmail,
  disconnectEmail,
} from "../src/platform/email/connection.ts";
import { sendQueuedEmail } from "../src/platform/email/send.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import {
  setMailFactoriesForTests,
  type FetchedMessage,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import {
  archiveInbox,
  createInbox,
  listMailboxes,
  updateInbox,
} from "../src/modules/support/inboxes.ts";
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
  EXECUTION_MODE: "live",
  ENABLE_EXTERNAL_WRITES: "true",
};
const account = (address: string) => ({
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: address,
  fromAddress: address,
  fromName: `Desk ${address.split("@")[0]}`,
  password: `synthetic-${address}-password`,
});
const SUPPORT = account("support@desk.example");
const PARTNERS = account("partnerships@partners.example");
const HELLO = account("hello@desk.example");

const mime = (headers: Record<string, string>, body = "Hello there.") =>
  Buffer.from(
    Object.entries({
      From: "Anna Customer <anna@example.org>",
      To: SUPPORT.fromAddress,
      Subject: "A question",
      Date: "Sun, 18 Oct 2026 10:00:00 +0000",
      "Message-ID": `<${randomUUID()}@example.org>`,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
      "\r\n\r\n" +
      body +
      "\r\n",
  );

/**
 * Support on several mailboxes of one project: each e-mail inbox is bound
 * to one verified mailbox, mail is routed by the mailbox that received it,
 * every answer goes out through the inbox's own mailbox, and the setup
 * from before (one mailbox, an unbound inbox) keeps working.
 */
describe.skipIf(!enabled)("support inboxes on several mailboxes", () => {
  const workspaces: string[] = [];
  const sent: OutgoingMail[] = [];
  const boxes = new Map<string, FetchedMessage[]>();
  let uid = 0;
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const box = (a: { fromAddress: string }) => boxes.get(a.fromAddress) ?? [];
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);

  /** A project with support on and the given mailboxes connected. */
  async function project(...accounts: ReturnType<typeof account>[]) {
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic support mailboxes" },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support mailboxes" },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: row.id,
      userId: "owner-setup",
      role: "owner",
    };
    await run(scope, (tx) =>
      tx.projectModule.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      }),
    );
    const ids: string[] = [];
    for (const a of accounts) ids.push(await connect(scope, a));
    // The first sync of every mailbox is done: what follows is new mail.
    await fetchInbound(scope);
    return { scope, ids };
  }
  async function connect(scope: Scope, a: ReturnType<typeof account>) {
    const row = await run(scope, (tx) => connectEmail(tx, scope, a));
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...row.data },
      a.password,
    );
    await run(scope, async (tx) => {
      const current = await entity(tx, scope, "connectors", row.id);
      await update(tx, scope, current, { ...data(current), ...checked });
    });
    return row.id;
  }
  /** Delivers raw mail into one mailbox, fetches and runs support's jobs. */
  async function receive(
    scope: Scope,
    a: { fromAddress: string },
    raw: Buffer,
  ) {
    boxes.set(a.fromAddress, [...box(a), { uid: ++uid, source: raw }]);
    await fetchInbound(scope);
    const jobs = (await run(scope, (tx) => list(tx, scope, "jobs"))).filter(
      (j) =>
        data(j).topic === "support_email_inbound" &&
        data(j).status === "queued",
    );
    for (const job of jobs) {
      await handleInboundEmail(scope, data(job).resourceId);
      await run(scope, async (tx) => {
        const row = await entity(tx, scope, "jobs", job.id);
        await update(tx, scope, row, { ...data(row), status: "succeeded" });
      });
    }
  }
  async function flush(scope: Scope) {
    const queued = (
      await run(scope, (tx) => list(tx, scope, "email_messages"))
    ).filter((m) => data(m).status === "queued");
    for (const m of queued) await sendQueuedEmail(scope, m.id);
    await syncEmailDelivery(scope);
  }
  const ticketBySubject = async (scope: Scope, subject: string) =>
    (
      await run(scope, (tx) =>
        tx.supportTicket.findMany({ where: { projectId: scope.projectId } }),
      )
    ).find((t) => t.subject === subject);

  beforeAll(() => {
    Object.assign(process.env, ENV);
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
      mailbox: (a) => ({
        verify: async () => undefined,
        scan: async () => ({
          uidValidity: "1",
          top: Math.max(0, ...box(a).map((m) => m.uid)),
          unseen: box(a).map((m) => m.uid),
        }),
        fetchUids: async (uids) => ({
          messages: box(a).filter((m) => uids.includes(m.uid)),
          skipped: [],
        }),
        fetchNew: async (state, limits) => ({
          uidValidity: "1",
          messages: box(a)
            .filter((m) => m.uid > state.lastUid)
            .slice(0, limits.max),
          skipped: [],
        }),
      }),
    });
  });
  afterEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("routes by the receiving mailbox and answers from the inbox's own address", async () => {
    const { scope, ids } = await project(SUPPORT, PARTNERS);
    const [supportId, partnersId] = ids as [string, string];
    const support = await run(scope, (tx) =>
      createInbox(tx, scope, {
        name: "Support",
        channels: ["email"],
        emailConnectionId: supportId,
      }),
    );
    const partners = await run(scope, (tx) =>
      createInbox(tx, scope, {
        name: "Partnerships",
        channels: ["email"],
        emailConnectionId: partnersId,
        emailAddress: "Partnerships@Partners.example",
      }),
    );
    // The address comes from the mailbox.
    expect(support.inbox).toMatchObject({
      emailConnectionId: supportId,
      emailAddress: SUPPORT.fromAddress,
    });
    expect(partners.inbox.emailAddress).toBe(PARTNERS.fromAddress);

    // The receiving mailbox decides, not a copied To header.
    await receive(
      scope,
      PARTNERS,
      mime({ To: SUPPORT.fromAddress, Subject: "Co-marketing" }),
    );
    await receive(scope, SUPPORT, mime({ Subject: "Login fails" }));
    const deal = (await ticketBySubject(scope, "Co-marketing"))!;
    expect(deal.inboxId).toBe(partners.inbox.id);
    expect((await ticketBySubject(scope, "Login fails"))!.inboxId).toBe(
      support.inbox.id,
    );

    // Acknowledgements leave from the inbox's mailbox.
    sent.length = 0;
    await flush(scope);
    const ack = (subject: string) =>
      sent.find((m) => m.subject.startsWith(`Re: ${subject}`))!;
    expect(ack("Co-marketing").from.address).toBe(PARTNERS.fromAddress);
    expect(ack("Co-marketing").messageId).toMatch(/@partners\.example>$/);
    expect(ack("Login fails").from.address).toBe(SUPPORT.fromAddress);

    // An agent reply too, threaded; the answer to it continues the ticket.
    sent.length = 0;
    const reply = await run(scope, (tx) =>
      replyToTicket(tx, { ...scope, userId: "agent-1" }, deal.id, {
        bodyText: "Let us talk.",
      }),
    );
    await flush(scope);
    const mail = sent.find((m) => m.text.includes("Let us talk."))!;
    expect(mail.from).toMatchObject({
      address: PARTNERS.fromAddress,
      name: PARTNERS.fromName,
    });
    const stored = await run(scope, (tx) =>
      tx.supportMessage.findUniqueOrThrow({ where: { id: reply.id } }),
    );
    expect(stored).toMatchObject({ deliveryState: "sent" });
    expect(stored.externalId).toMatch(/@partners\.example>$/);
    await receive(
      scope,
      PARTNERS,
      mime(
        {
          To: PARTNERS.fromAddress,
          Subject: "Re: Co-marketing",
          "In-Reply-To": stored.externalId!,
        },
        "Sounds good",
      ),
    );
    const customer = await run(scope, (tx) =>
      tx.supportMessage.findMany({
        where: { ticketId: deal.id, kind: "customer" },
      }),
    );
    expect(customer).toHaveLength(2);

    // The mailbox list the inbox form offers, without any credential.
    const mailboxes = await run(scope, (tx) => listMailboxes(tx, scope));
    expect(mailboxes).toEqual([
      expect.objectContaining({
        id: supportId,
        address: SUPPORT.fromAddress,
        verified: true,
        isDefault: true,
        inboxId: support.inbox.id,
      }),
      expect.objectContaining({
        id: partnersId,
        address: PARTNERS.fromAddress,
        verified: true,
        isDefault: false,
        inboxId: partners.inbox.id,
      }),
    ]);
    expect(JSON.stringify(mailboxes)).not.toContain("password");
    expect(JSON.stringify(mailboxes)).not.toContain("encryptedCredential");
  });

  it("refuses address claims outside the inbox's own verified mailbox", async () => {
    const { scope, ids } = await project(SUPPORT, HELLO);
    const [supportId, helloId] = ids as [string, string];
    const other = await project(PARTNERS);
    const unverified = await run(scope, (tx) =>
      connectEmail(tx, scope, account("admin@desk.example")),
    );
    await run(scope, (tx) =>
      createInbox(tx, scope, {
        name: "Support",
        channels: ["email"],
        emailConnectionId: supportId,
      }),
    );
    const attempt = (body: Record<string, unknown>) =>
      run(scope, (tx) =>
        createInbox(tx, scope, { name: "Claim", channels: ["email"], ...body }),
      );
    // An address that is not the mailbox's own.
    await expect(
      attempt({
        emailConnectionId: helloId,
        emailAddress: "support@desk.example",
      }),
    ).rejects.toThrow("INBOX_ADDRESS_NOT_MAILBOX");
    // A mailbox already answering for another live inbox.
    await expect(attempt({ emailConnectionId: supportId })).rejects.toThrow(
      "INBOX_MAILBOX_TAKEN",
    );
    // An unverified mailbox, another project's mailbox, or none at all.
    await expect(attempt({ emailConnectionId: unverified.id })).rejects.toThrow(
      "INBOX_MAILBOX_INVALID",
    );
    await expect(attempt({ emailConnectionId: other.ids[0] })).rejects.toThrow(
      "INBOX_MAILBOX_INVALID",
    );
    await expect(
      attempt({ emailAddress: "hello@desk.example" }),
    ).rejects.toThrow("INBOX_MAILBOX_INVALID");
    // An update cannot move an inbox onto a taken mailbox either.
    const hello = await attempt({ emailConnectionId: helloId });
    await expect(
      run(scope, (tx) =>
        updateInbox(tx, scope, hello.inbox.id, {
          version: hello.inbox.version,
          emailConnectionId: supportId,
        }),
      ),
    ).rejects.toThrow("INBOX_MAILBOX_TAKEN");
    // While its own mailbox waits for a login check, the inbox stays editable.
    await run(scope, async (tx) => {
      const row = await entity(tx, scope, "connectors", helloId);
      await update(tx, scope, row, { ...data(row), status: "configured" });
    });
    const renamed = await run(scope, (tx) =>
      updateInbox(tx, scope, hello.inbox.id, {
        version: hello.inbox.version,
        name: "Hello again",
      }),
    );
    expect(renamed).toMatchObject({ emailConnectionId: helloId });
    // The database refuses a second live inbox on one mailbox, too.
    await expect(
      run(scope, (tx) =>
        tx.supportInbox.create({
          data: {
            id: randomUUID(),
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            name: "Raw",
            channels: ["email"],
            emailAddress: HELLO.fromAddress,
            emailConnectionId: helloId,
            createdBy: scope.userId,
          },
        }),
      ),
    ).rejects.toThrow();
    // A widget-only inbox has no mailbox.
    const widget = await run(scope, (tx) =>
      createInbox(tx, scope, {
        name: "Widget",
        channels: ["widget"],
        allowedOrigins: ["https://desk.example"],
        emailConnectionId: helloId,
      }),
    );
    expect(widget.inbox.emailConnectionId).toBeNull();
  });

  it("refuses to remove a mailbox while a live inbox uses it", async () => {
    const { scope, ids } = await project(SUPPORT, HELLO);
    const [, helloId] = ids as [string, string];
    const hello = await run(scope, (tx) =>
      createInbox(tx, scope, {
        name: "Hello",
        channels: ["email"],
        emailConnectionId: helloId,
      }),
    );
    await expect(
      run(scope, (tx) => disconnectEmail(tx, scope, { connectorId: helloId })),
    ).rejects.toThrow("EMAIL_MAILBOX_IN_USE");
    // Archived, the inbox lets go of the mailbox; then it can be removed.
    await run(scope, (tx) => archiveInbox(tx, scope, hello.inbox.id));
    await run(scope, (tx) =>
      disconnectEmail(tx, scope, { connectorId: helloId }),
    );
    const archived = await run(scope, (tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: hello.inbox.id } }),
    );
    expect(archived.emailConnectionId).toBeNull();
    expect(
      (await run(scope, (tx) => list(tx, scope, "connectors"))).map(
        (r) => r.id,
      ),
    ).not.toContain(helloId);
  });

  it("keeps the single-mailbox setup from before working unchanged", async () => {
    const { scope, ids } = await project(SUPPORT);
    // An inbox as it was before mailboxes were bound: address only.
    const legacy = await run(scope, (tx) =>
      tx.supportInbox.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          name: "Support",
          channels: ["email"],
          emailAddress: SUPPORT.fromAddress,
          createdBy: scope.userId,
        },
      }),
    );
    await receive(scope, SUPPORT, mime({ Subject: "Before the deploy" }));
    const ticket = (await ticketBySubject(scope, "Before the deploy"))!;
    expect(ticket.inboxId).toBe(legacy.id);
    sent.length = 0;
    await flush(scope);
    expect(sent.at(-1)?.from.address).toBe(SUPPORT.fromAddress);

    // The migration's backfill binds it by its address.
    const sql = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202610180005_support_inbox_mailbox/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf("WITH candidates"));
    await run(scope, (tx) => tx.$executeRawUnsafe(backfill));
    const bound = await run(scope, (tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: legacy.id } }),
    );
    expect(bound.emailConnectionId).toBe(ids[0]);
    await receive(scope, SUPPORT, mime({ Subject: "After the deploy" }));
    expect((await ticketBySubject(scope, "After the deploy"))!.inboxId).toBe(
      legacy.id,
    );
  });

  it("never routes a new mailbox's mail to an unbound inbox by its typed address", async () => {
    const { scope } = await project(SUPPORT, HELLO);
    // A leftover unbound inbox claims hello@ by its typed address only.
    await run(scope, (tx) =>
      tx.supportInbox.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          name: "Typed",
          channels: ["email"],
          emailAddress: HELLO.fromAddress,
          createdBy: scope.userId,
        },
      }),
    );
    // hello@ is not the default mailbox and no inbox is bound to it.
    await receive(
      scope,
      HELLO,
      mime({ To: HELLO.fromAddress, Subject: "Nobody home" }),
    );
    // Fetched and kept, but no inbox answers for that mailbox.
    const fetched = (
      await run(scope, (tx) => list(tx, scope, "inbound_emails"))
    ).map((r) => data(r).subject);
    expect(fetched).toContain("Nobody home");
    expect(await ticketBySubject(scope, "Nobody home")).toBeUndefined();
  });
});
