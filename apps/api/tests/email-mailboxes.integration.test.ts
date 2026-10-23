import { randomBytes } from "node:crypto";
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
  defaultEmailConnection,
  disconnectEmail,
  emailMailboxes,
} from "../src/platform/email/connection.ts";
import { queueEmail, sendQueuedEmail } from "../src/platform/email/send.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import {
  setMailFactoriesForTests,
  type FetchedMessage,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const ENV = {
  ORBIT_EMAIL: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const account = (local: string, domain = "desk.example") => ({
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: `${local}@${domain}`,
  fromAddress: `${local}@${domain}`,
  fromName: `Desk ${local}`,
  password: `synthetic-${local}-password`,
});
const SUPPORT = account("support");
const PARTNERS = account("partnerships", "partners.example");

const mime = (headers: Record<string, string>, body = "Hello.") =>
  Buffer.from(
    Object.entries({
      From: "Customer <customer@example.org>",
      Subject: "A question",
      Date: "Sun, 18 Oct 2026 10:00:00 +0000",
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
      "\r\n\r\n" +
      body +
      "\r\n",
  );

type StubMessage = FetchedMessage & { seen?: boolean };

/**
 * Several mailboxes per project: each connected address is its own mailbox
 * with its own receiving state and first sync; sending picks the mailbox
 * (the default one unless named); re-connecting an address updates it.
 */
describe.skipIf(!enabled)("several e-mail mailboxes per project", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  const sent: OutgoingMail[] = [];
  const logins: string[] = [];
  /** One stub INBOX per mailbox address. */
  const boxes = new Map<string, StubMessage[]>();
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const box = (a: { fromAddress: string }) => boxes.get(a.fromAddress) ?? [];

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    setMailFactoriesForTests({
      checkHost: async () => undefined,
      transport: (a, password) => ({
        verify: async () => undefined,
        send: async (mail) => {
          sent.push({ ...mail, headers: { ...mail.headers, password } });
          return { accepted: mail.to, rejected: [] };
        },
        close: () => undefined,
      }),
      mailbox: (a) => ({
        verify: async () => undefined,
        scan: async () => {
          logins.push(a.fromAddress);
          return {
            uidValidity: "1",
            top: Math.max(0, ...box(a).map((m) => m.uid)),
            unseen: box(a)
              .filter((m) => !m.seen)
              .map((m) => m.uid),
          };
        },
        fetchUids: async (uids) => ({
          messages: box(a).filter((m) => uids.includes(m.uid)),
          skipped: [],
        }),
        move: async () => "moved" as const,
        fetchNew: async (state, limits) => {
          logins.push(a.fromAddress);
          return {
            uidValidity: "1",
            messages: box(a)
              .filter((m) => m.uid > state.lastUid)
              .slice(0, limits.max),
            skipped: [],
          };
        },
      }),
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic mailboxes" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic mailboxes" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
  });
  afterEach(() => {
    Object.assign(process.env, ENV);
    delete process.env.EXECUTION_MODE;
    delete process.env.ENABLE_EXTERNAL_WRITES;
  });
  afterAll(async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  /** Connects (or re-connects) an address and runs the login check. */
  const connect = async (a: ReturnType<typeof account>) => {
    const row = await run((tx) => connectEmail(tx, scope, a));
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...row.data },
      a.password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", row.id);
      await update(tx, scope, current, { ...data(current), ...checked });
    });
    return row.id;
  };
  const inboundOf = async (connectionId: string) =>
    (await run((tx) => list(tx, scope, "inbound_emails")))
      .map((r) => data(r))
      .filter((r) => r.connectionId === connectionId);

  let supportId = "";
  let partnersId = "";

  it("adds a mailbox per address and updates the same address in place", async () => {
    supportId = await connect(SUPPORT);
    partnersId = await connect(PARTNERS);
    expect(partnersId).not.toBe(supportId);
    // The same address again (any case) updates that mailbox, not a new one.
    const again = await run((tx) =>
      connectEmail(tx, scope, {
        ...SUPPORT,
        fromAddress: SUPPORT.fromAddress.toUpperCase(),
        fromName: "Desk Support",
        password: "synthetic-new-password",
      }),
    );
    expect(again.id).toBe(supportId);
    // New settings need a new login check before the mailbox is used.
    expect(again.data).toMatchObject({
      status: "configured",
      fromName: "Desk Support",
    });
    expect(JSON.stringify(again.data)).not.toContain("synthetic-new-password");
    await connect({ ...SUPPORT, password: "synthetic-new-password" });
    const mailboxes = await run((tx) => emailMailboxes(tx, scope));
    expect(mailboxes.map((m) => m.id)).toEqual([supportId, partnersId]);
  });

  it("sends member mail from the default mailbox: the first connected", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    expect((await run((tx) => defaultEmailConnection(tx, scope)))?.id).toBe(
      supportId,
    );
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["member@example.org"],
        subject: "Task assigned",
        text: "Body",
        moduleId: "tasks",
        automatic: true,
      }),
    );
    await sendQueuedEmail(scope, row.id);
    expect(sent.at(-1)).toMatchObject({
      from: { address: SUPPORT.fromAddress },
      messageId: `<orbit.${row.id}@desk.example>`,
    });
  });

  it("sends through a named mailbox with its address, password and Message-ID domain", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["partner@example.org"],
        subject: "Partnership",
        text: "Body",
        moduleId: "support",
        connectionId: partnersId,
      }),
    );
    await sendQueuedEmail(scope, row.id);
    expect(sent.at(-1)).toMatchObject({
      from: { address: PARTNERS.fromAddress, name: PARTNERS.fromName },
      messageId: `<orbit.${row.id}@partners.example>`,
      headers: { password: PARTNERS.password },
    });
    expect(
      data(await run((tx) => entity(tx, scope, "email_messages", row.id))),
    ).toMatchObject({ status: "sent", connectionId: partnersId });
  });

  it("refuses a named mailbox that is not a verified mailbox of the project", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const other = await run((tx) =>
      tx.entity.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "connectors",
          data: { provider: "telegram", status: "read_verified" },
        },
      }),
    );
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["partner@example.org"],
        subject: "Wrong mailbox",
        text: "Body",
        moduleId: "support",
        connectionId: other.id,
      }),
    );
    const before = sent.length;
    await sendQueuedEmail(scope, row.id);
    expect(sent).toHaveLength(before);
    expect(
      data(await run((tx) => entity(tx, scope, "email_messages", row.id))),
    ).toMatchObject({ status: "failed", code: "EMAIL_NOT_CONNECTED" });
  });

  it("fetches every mailbox separately, each with its own first sync", async () => {
    // Before the first sync: read mail is never fetched, unread is backlog.
    boxes.set(SUPPORT.fromAddress, [
      { uid: 1, seen: true, source: mime({ "Message-ID": "<s-old@x.org>" }) },
      { uid: 2, source: mime({ "Message-ID": "<s-unread@x.org>" }) },
    ]);
    boxes.set(PARTNERS.fromAddress, [
      { uid: 7, source: mime({ "Message-ID": "<p-unread@x.org>" }) },
    ]);
    logins.length = 0;
    expect(await fetchInbound(scope)).toMatchObject({
      status: "ok",
      stored: 2,
    });
    expect(new Set(logins)).toEqual(
      new Set([SUPPORT.fromAddress, PARTNERS.fromAddress]),
    );
    expect((await inboundOf(supportId)).map((r) => r.messageId)).toEqual([
      "<s-unread@x.org>",
    ]);
    expect(await inboundOf(partnersId)).toMatchObject([
      { messageId: "<p-unread@x.org>", backlog: true },
    ]);
    // Each mailbox keeps its own state row.
    const states = (
      await run((tx) => list(tx, scope, "email_inbound_state"))
    ).map((r) => data(r));
    expect(states.map((s) => [s.connectionId, s.lastUid]).sort()).toEqual(
      [
        [supportId, 2],
        [partnersId, 7],
      ].sort(),
    );
    // New mail in one mailbox is fetched for that mailbox only, not backlog.
    box(PARTNERS).push({
      uid: 8,
      seen: true,
      source: mime({ "Message-ID": "<p-new@x.org>" }),
    });
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1 });
    const fresh = (await inboundOf(partnersId)).find(
      (r) => r.messageId === "<p-new@x.org>",
    );
    expect(fresh).toBeDefined();
    expect(fresh!.backlog).toBeUndefined();
    expect(await inboundOf(supportId)).toHaveLength(1);
  });

  it("marks a bounce only for messages the receiving mailbox sent", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["gone@example.org"],
        subject: "Will bounce",
        text: "Body",
        moduleId: "support",
        connectionId: partnersId,
      }),
    );
    await sendQueuedEmail(scope, row.id);
    const report = (id: string) =>
      mime(
        {
          From: "Mail Delivery System <MAILER-DAEMON@mailbox.example.com>",
          "Message-ID": `<dsn-${id}@mailbox.example.com>`,
          "Content-Type":
            'multipart/report; report-type=delivery-status; boundary="b"',
        },
        [
          "--b",
          "Content-Type: message/delivery-status",
          "",
          "Final-Recipient: rfc822; gone@example.org",
          "Action: failed",
          "--b",
          "Content-Type: text/rfc822-headers",
          "",
          `Message-ID: <orbit.${row.id}@partners.example>`,
          "--b--",
        ].join("\r\n"),
      );
    // The report arrives in the other mailbox: it marks nothing.
    box(SUPPORT).push({ uid: 3, source: report("support") });
    expect(await fetchInbound(scope)).toMatchObject({ bounced: 0 });
    const message = async () =>
      data(await run((tx) => entity(tx, scope, "email_messages", row.id)));
    expect((await message()).deliveryState).toBeUndefined();
    box(PARTNERS).push({ uid: 9, source: report("partners") });
    expect(await fetchInbound(scope)).toMatchObject({ bounced: 1 });
    expect(await message()).toMatchObject({ deliveryState: "bounced" });
  });

  it("removes an unused mailbox with its state; the default moves on", async () => {
    const removed = await run((tx) =>
      disconnectEmail(tx, scope, { connectorId: supportId }),
    );
    expect(removed).toMatchObject({ removed: supportId });
    const rows = await run((tx) => list(tx, scope, "connectors"));
    expect(rows.map((r) => r.id)).not.toContain(supportId);
    const states = (
      await run((tx) => list(tx, scope, "email_inbound_state"))
    ).map((r) => data(r).connectionId);
    expect(states).not.toContain(supportId);
    expect((await run((tx) => defaultEmailConnection(tx, scope)))?.id).toBe(
      partnersId,
    );
    const audits = await run((tx) =>
      tx.auditEvent.findMany({
        where: { projectId: scope.projectId, action: "email.disconnected" },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain("password");
    await expect(
      run((tx) => disconnectEmail(tx, scope, { connectorId: supportId })),
    ).rejects.toThrow("EMAIL_MAILBOX_NOT_FOUND");
  });
});
