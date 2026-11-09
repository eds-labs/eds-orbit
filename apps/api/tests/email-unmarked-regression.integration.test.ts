import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { data, entity, list, update } from "../src/shared.ts";
import { connectEmail } from "../src/platform/email/connection.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import { queueEmail } from "../src/platform/email/send.ts";
import {
  setMailFactoriesForTests,
  type EmailAccount,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { handleInboundEmail } from "../src/modules/support/channels/email.ts";
import { replyToTicket } from "../src/modules/support/workspace.ts";
import { allowNewTicket } from "../src/modules/support/privacy.ts";
import {
  addMailbox,
  FakeImap,
  installMail,
  mailAccount,
  MAIL_ENV,
  mailProject,
  markMailbox,
  memoryStore,
  inboundRows,
  queuedJobs,
  rawMail,
  stateRow,
  type MailProject,
} from "./shared-mailbox-fixture.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const ROW_KEYS = [
  "attachments",
  "automatic",
  "bounceOf",
  "cc",
  "connectionId",
  "date",
  "fileId",
  "from",
  "fromName",
  "inReplyTo",
  "messageId",
  "receivedAt",
  "references",
  "subject",
  "text",
  "to",
  "uid",
  "uidValidity",
  "unreadable",
];

/**
 * ADR 0026, decision 9: with ORBIT_WEBMAIL off, or a mailbox without the
 * marker, the fetch path is what it always was. Both halves run the same
 * expectations; every one of them passes against the code from before the
 * webmail module.
 */
describe.skipIf(!enabled).each([
  { name: "flag off, marker present", flag: undefined, marked: true },
  { name: "flag on, no marker", flag: "true", marked: false },
])("unmarked fetch path: $name", ({ flag, marked }) => {
  let imap: FakeImap;
  let project: MailProject;
  const sent: OutgoingMail[] = [];
  const { store } = memoryStore();
  const workspaces: string[] = [];
  // Only the project's first mailbox holds mail; a second one stays empty.
  const reader = (account: EmailAccount) =>
    account.fromAddress === "info@desk.example"
      ? imap.legacyReader()
      : new FakeImap().legacyReader();

  beforeAll(() => {
    Object.assign(process.env, MAIL_ENV);
    if (flag) process.env.ORBIT_WEBMAIL = flag;
    else delete process.env.ORBIT_WEBMAIL;
    installMail(reader, sent, store);
  });
  beforeEach(async () => {
    imap = new FakeImap();
    sent.length = 0;
    project = await mailProject("Synthetic regression", "info@desk.example", [
      "support",
    ]);
    workspaces.push(project.workspaceId);
    if (marked) await markMailbox(project, project.connectionId);
    await fetchInbound(project.scope);
    imap.calls.length = 0;
  });
  afterAll(async () => {
    for (const name of [...Object.keys(MAIL_ENV), "ORBIT_WEBMAIL"])
      delete process.env[name];
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("asks the server for exactly what it always did and writes the same row", async () => {
    const uid = imap.deliver(rawMail({ "Message-ID": "<one@example.org>" }));
    await fetchInbound(project.scope);
    expect(imap.calls).toEqual([
      {
        method: "fetchNew",
        args: [
          { uidValidity: "1", lastUid: 0, backlogUntil: undefined },
          { max: 25, maxBytes: 10 * 1024 * 1024 },
        ],
      },
    ]);
    const [row] = await inboundRows(project);
    expect(Object.keys(data(row)).sort()).toEqual(ROW_KEYS);
    expect(data(row)).toMatchObject({
      uid,
      uidValidity: "1",
      messageId: "<one@example.org>",
    });
    expect(
      Object.keys((await stateRow(project, project.connectionId))!).sort(),
    ).toEqual([
      "backlogUntil",
      "checkedAt",
      "connectionId",
      "lastError",
      "lastUid",
      "uidValidity",
    ]);
  });

  it("keeps a message without Message-ID apart by UID only", async () => {
    const raw = rawMail({ "Message-ID": null });
    imap.deliver(raw);
    imap.deliver(raw);
    await fetchInbound(project.scope);
    const rows = await inboundRows(project);
    expect(rows.map((r) => data(r).uid).sort()).toEqual([1, 2]);
    expect(rows.every((r) => !("rawSha256" in data(r)))).toBe(true);
  });

  it("treats old mail above the cursor as new", async () => {
    imap.deliver(rawMail(), { internalDate: new Date("2020-01-01") });
    await fetchInbound(project.scope);
    const [row] = await inboundRows(project);
    expect(data(row).backlog).toBeUndefined();
  });

  it("takes only unread mail in a backlog and keeps no snapshot", async () => {
    await project.run((tx) =>
      tx.entity.deleteMany({
        where: {
          projectId: project.scope.projectId,
          kind: "email_inbound_state",
        },
      }),
    );
    for (let i = 0; i < 30; i++)
      imap.deliver(rawMail({ Subject: `Backlog ${i}` }));
    await fetchInbound(project.scope);
    expect((await inboundRows(project)).length).toBe(25);
    // Read after the first pass: the old path no longer sees it.
    imap.markRead(26);
    await fetchInbound(project.scope);
    const uids = (await inboundRows(project)).map((r) => data(r).uid as number);
    expect(uids).not.toContain(26);
    expect(uids.length).toBe(29);
    expect(
      await project.run((tx) =>
        list(tx, project.scope, "email_inbound_backlog"),
      ),
    ).toEqual([]);
    expect(imap.used("searchSince")).toEqual([]);
  });

  it("restarts on a new UIDVALIDITY from the unread mail alone", async () => {
    imap.deliver(rawMail({ "Message-ID": "<read-later@example.org>" }));
    imap.deliver(rawMail({ "Message-ID": "<still-new@example.org>" }));
    await fetchInbound(project.scope);
    imap.markRead(1);
    imap.rebuild("2");
    imap.deliver(rawMail({ "Message-ID": "<after@example.org>" }), {
      seen: true,
    });
    imap.calls.length = 0;
    await fetchInbound(project.scope);
    expect(imap.calls.map((c) => c.method)).toEqual([
      "fetchNew",
      "scan",
      "fetchUids",
    ]);
    const ids = (await inboundRows(project)).map((r) => data(r).messageId);
    expect(ids).not.toContain("<after@example.org>");
  });

  it("stores mail of a mailbox no module acts on", async () => {
    await project.run((tx) =>
      tx.projectModule.updateMany({
        where: { projectId: project.scope.projectId },
        data: { enabled: false },
      }),
    );
    imap.deliver(rawMail());
    await fetchInbound(project.scope);
    expect((await inboundRows(project)).length).toBe(1);
  });

  it("lets a failing message end the pass without moving the cursor", async () => {
    const failing = memoryStore();
    failing.store.put = async () => {
      throw new Error("OBJECT_STORE_DOWN");
    };
    installMail(reader, sent, failing.store);
    try {
      imap.deliver(rawMail());
      await expect(fetchInbound(project.scope)).rejects.toThrow();
      expect((await stateRow(project, project.connectionId))!.lastUid).toBe(0);
    } finally {
      installMail(reader, sent, store);
    }
  });

  it("does not add a marker when a mailbox is saved again", async () => {
    const saved = await project.run((tx) =>
      connectEmail(tx, project.scope, mailAccount("info@desk.example")),
    );
    if (!marked) expect("webmailClient" in data(saved)).toBe(false);
  });

  it("drops mail no inbox is routed to, even with thread headers", async () => {
    const other = await addMailbox(project, "support@desk.example");
    await project.run((tx) =>
      createInbox(tx, project.scope, {
        name: "Bound elsewhere",
        channels: ["email"],
        emailConnectionId: other,
      }),
    );
    imap.deliver(rawMail({ Subject: "Unrouted", To: "someone@desk.example" }));
    await fetchInbound(project.scope);
    for (const job of await queuedJobs(project, "support_email_inbound"))
      await handleInboundEmail(project.scope, data(job).resourceId);
    expect(
      await project.run((tx) =>
        tx.supportTicket.count({
          where: { projectId: project.scope.projectId },
        }),
      ),
    ).toBe(0);
  });

  it("refuses a reply to automatic mail on a ticket of the channel", async () => {
    const { scope, run, connectionId } = project;
    await run((tx) =>
      createInbox(tx, scope, {
        name: "Desk",
        channels: ["email"],
        emailConnectionId: connectionId,
      }),
    );
    const id = "<auto@example.org>";
    imap.deliver(
      rawMail({
        "Message-ID": id,
        Subject: "Hello",
        "List-Id": "<list.example.org>",
      }),
    );
    await fetchInbound(scope);
    await expect(
      run((tx) =>
        queueEmail(tx, scope, {
          to: ["anna@example.org"],
          subject: "Re",
          text: "Hi",
          moduleId: "support",
          inReplyTo: id,
        }),
      ),
    ).rejects.toMatchObject({ code: "EMAIL_REPLY_TO_AUTOMATIC", status: 409 });
    expect(typeof replyToTicket).toBe("function");
  });

  it("counts every new ticket of a sender against the abuse cap", async () => {
    const { scope, run, connectionId } = project;
    const inboxId = await run(
      async (tx) =>
        (
          await createInbox(tx, scope, {
            name: "Desk",
            channels: ["email"],
            emailConnectionId: connectionId,
          })
        ).inbox.id,
    );
    expect(inboxId).toEqual(expect.any(String));
    for (let i = 0; i < 10; i++) {
      imap.deliver(rawMail({ Subject: `Question ${i}` }));
      await fetchInbound(scope);
    }
    for (const job of await queuedJobs(project, "support_email_inbound"))
      await handleInboundEmail(scope, data(job).resourceId);
    expect(
      await run((tx) => allowNewTicket(tx, scope, "anna@example.org")),
    ).toBe(false);
  });

  it("keeps state and entity history shaped as before", async () => {
    const { scope, run, connectionId } = project;
    imap.deliver(rawMail());
    await fetchInbound(scope);
    const row = await run(async (tx) => {
      const states = await list(tx, scope, "email_inbound_state");
      return entity(tx, scope, "email_inbound_state", states[0]!.id);
    });
    expect(row.version).toBeGreaterThan(1);
    expect(data(row).connectionId).toBe(connectionId);
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", connectionId);
      await update(tx, scope, current, { ...data(current) });
    });
  });
});
