import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { data, entity, list, update, create } from "../src/shared.ts";
import { connectEmail } from "../src/platform/email/connection.ts";
import {
  fetchInbound,
  mailboxHasConsumer,
} from "../src/platform/email/inbound.ts";
import {
  closeMailboxLocks,
  withMailboxLock,
} from "../src/platform/email/mailbox-lock.ts";
import { setMailboxOwner } from "../src/platform/email/ownership.ts";
import {
  discardImportedRow,
  ensureIngested,
  inboundRowForImport,
  readMailboxMessage,
  setSharedClient,
  sharedClientActive,
} from "../src/platform/email/shared-client.ts";
import {
  MailSendError,
  setMailFactoriesForTests,
  type EmailAccount,
  type MailboxReader,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { handleInboundEmail } from "../src/modules/support/channels/email.ts";
import { supportRetention } from "../src/modules/support/privacy.ts";
import { registeredEmailInbound } from "../src/platform/modules/contributions.ts";
import {
  FakeImap,
  inboundRows,
  installMail,
  mailAccount,
  MAIL_ENV,
  mailProject,
  markMailbox,
  memoryStore,
  queuedJobs,
  rawMail,
  stateRow,
  type MailProject,
} from "./shared-mailbox-fixture.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);
const BACKLOG = "email_inbound_backlog";
const HOUR = 3600_000;

describe.skipIf(!enabled)("mailboxes shared with a webmail client", () => {
  let imap: FakeImap;
  let project: MailProject;
  let readerOf: (account: EmailAccount) => MailboxReader;
  const sent: OutgoingMail[] = [];
  const { store } = memoryStore();
  const workspaces: string[] = [];

  const rows = () => inboundRows(project);
  const uidsOf = async () =>
    (await rows()).map((r) => data(r).uid as number).sort((a, b) => a - b);
  const state = () => stateRow(project, project.connectionId);
  const snapshots = () => project.run((tx) => list(tx, project.scope, BACKLOG));
  const pass = () => fetchInbound(project.scope);
  const barrier = (
    selection: { uids: number[] } | { all: true },
    options?: { timeoutMs?: number },
  ) => ensureIngested(project.scope, project.connectionId, selection, options);
  const runSupportJobs = async () => {
    for (const job of await queuedJobs(project, "support_email_inbound"))
      if (data(job).status === "queued") {
        await handleInboundEmail(project.scope, data(job).resourceId);
        await project.run(async (tx) => {
          const row = await entity(tx, project.scope, "jobs", job.id);
          await update(tx, project.scope, row, {
            ...data(row),
            status: "succeeded",
          });
        });
      }
  };
  /** A marked mailbox with a Support inbox, its first sync done on nothing. */
  async function sharedProject(modules = ["support"], bindInbox = true) {
    const made = await mailProject(
      "Synthetic shared mailbox",
      "info@desk.example",
      modules,
    );
    workspaces.push(made.workspaceId);
    await markMailbox(made, made.connectionId);
    if (bindInbox)
      await made.run((tx) =>
        createInbox(tx, made.scope, {
          name: "Desk",
          channels: ["email"],
          emailConnectionId: made.connectionId,
        }),
      );
    return made;
  }
  async function resetState() {
    await project.run((tx) =>
      tx.entity.deleteMany({
        where: {
          projectId: project.scope.projectId,
          kind: "email_inbound_state",
        },
      }),
    );
  }

  beforeAll(() => {
    Object.assign(process.env, MAIL_ENV, { ORBIT_WEBMAIL: "true" });
    readerOf = () => imap.reader();
    installMail((account) => readerOf(account), sent, store);
  });
  beforeEach(async () => {
    Object.assign(process.env, MAIL_ENV, { ORBIT_WEBMAIL: "true" });
    delete process.env.FILES_PROJECT_QUOTA_BYTES;
    imap = new FakeImap();
    readerOf = () => imap.reader();
    sent.length = 0;
    project = await sharedProject();
    await pass();
    imap.calls.length = 0;
  });
  afterEach(() => {
    imap.duringFetch = null;
    imap.scanError = null;
  });
  afterAll(async () => {
    for (const name of [
      ...Object.keys(MAIL_ENV),
      "ORBIT_WEBMAIL",
      "ORBIT_FINANCE",
      "FILES_PROJECT_QUOTA_BYTES",
    ])
      delete process.env[name];
    closeMailboxLocks();
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  describe("the marker", () => {
    it("needs both the flag and the marker", () => {
      expect(sharedClientActive({ webmailClient: true })).toBe(true);
      expect(sharedClientActive({})).toBe(false);
      expect(sharedClientActive({ webmailClient: "true" })).toBe(false);
      delete process.env.ORBIT_WEBMAIL;
      expect(sharedClientActive({ webmailClient: true })).toBe(false);
    });

    it("is set and cleared, and survives saving the mailbox again", async () => {
      const { scope, run, connectionId } = project;
      const stored = () =>
        run(async (tx) =>
          data(await entity(tx, scope, "connectors", connectionId)),
        );
      await run((tx) => setSharedClient(tx, scope, connectionId, false));
      expect("webmailClient" in (await stored())).toBe(false);
      await run((tx) => setSharedClient(tx, scope, connectionId, true));
      expect((await stored()).webmailClient).toBe(true);
      await run((tx) =>
        connectEmail(tx, scope, mailAccount("info@desk.example")),
      );
      expect((await stored()).webmailClient).toBe(true);
    });
  });

  describe("the six races", () => {
    it("(a) keeps backlog mail a client reads before it is fetched", async () => {
      await resetState();
      for (let i = 0; i < 30; i++)
        imap.deliver(rawMail({ Subject: `Backlog ${i}` }));
      await pass();
      expect((await rows()).length).toBe(25);
      imap.markRead(26);
      await pass();
      expect(await uidsOf()).toContain(26);
      expect((await rows()).length).toBe(30);
    });

    it("(a) keeps new mail a client reads before the next pass", async () => {
      const uid = imap.deliver(rawMail());
      imap.markRead(uid);
      await pass();
      expect(await uidsOf()).toEqual([uid]);
    });

    it("(b) ingests a message before it is moved, leaving the cursor", async () => {
      const uid = imap.deliver(rawMail());
      expect(await barrier({ uids: [uid] })).toEqual({ status: "ok" });
      expect((await state())!.lastUid).toBe(0);
      imap.move(uid, "Archive");
      await pass();
      expect(await uidsOf()).toEqual([uid]);
    });

    it("(c) ingests everything pending before delete and expunge", async () => {
      const first = imap.deliver(rawMail());
      const second = imap.deliver(rawMail());
      expect(await barrier({ all: true })).toEqual({ status: "ok" });
      expect((await state())!.lastUid).toBe(0);
      imap.expunge(first);
      imap.expunge(second);
      await pass();
      expect(await uidsOf()).toEqual([first, second]);
    });

    it("(d) does not store a message twice when it goes away and comes back", async () => {
      const uid = imap.deliver(rawMail({ "Message-ID": "<roam@example.org>" }));
      await barrier({ uids: [uid] });
      const away = imap.move(uid, "Archive");
      const back = imap.moveBack("Archive", away);
      await pass();
      expect(back).toBeGreaterThan(uid);
      expect((await rows()).length).toBe(1);
    });

    it("(e) picks up mail read around a UIDVALIDITY change, without duplicates", async () => {
      const seen = imap.deliver(
        rawMail({ "Message-ID": "<known@example.org>" }),
      );
      await pass();
      imap.markRead(seen);
      imap.deliver(rawMail({ "Message-ID": "<read-recently@example.org>" }), {
        seen: true,
      });
      imap.deliver(rawMail({ "Message-ID": "<read-long-ago@example.org>" }), {
        seen: true,
        internalDate: new Date(Date.now() - 24 * 30 * HOUR),
      });
      imap.deliver(rawMail({ "Message-ID": "<unread-old@example.org>" }), {
        internalDate: new Date(Date.now() - 24 * 30 * HOUR),
      });
      imap.rebuild("2");
      await pass();
      expect(imap.used("searchSince")).toHaveLength(1);
      const ids = (await rows()).map((r) => data(r).messageId).sort();
      expect(ids).toEqual([
        "<known@example.org>",
        "<read-recently@example.org>",
        "<unread-old@example.org>",
      ]);
      expect((await state())!.uidValidity).toBe("2");
    });

    it("(f) does not miss mail arriving in the middle of a pass", async () => {
      const first = imap.deliver(rawMail());
      let late = 0;
      imap.duringFetch = async () => {
        imap.duringFetch = null;
        late = imap.deliver(rawMail());
      };
      await pass();
      expect(await uidsOf()).toEqual([first]);
      expect((await state())!.lastUid).toBe(first);
      await pass();
      expect(await uidsOf()).toEqual([first, late]);
    });

    it("(f) reads mail arriving during a backlog after the backlog", async () => {
      await resetState();
      const old = imap.deliver(rawMail());
      let late = 0;
      imap.duringFetch = async () => {
        imap.duringFetch = null;
        late = imap.deliver(rawMail(), { seen: true });
      };
      await pass();
      expect(await uidsOf()).toEqual([old]);
      await pass();
      expect(await uidsOf()).toEqual([old, late]);
    });
  });

  describe("the barrier", () => {
    it("waits for a running pass and never stores a message twice", async () => {
      const uid = imap.deliver(rawMail());
      let release = () => {};
      const gate = new Promise<void>((done) => (release = done));
      let started = () => {};
      const running = new Promise<void>((done) => (started = done));
      imap.duringFetch = async () => {
        imap.duringFetch = null;
        started();
        await gate;
      };
      const worker = pass();
      await running;
      expect(await barrier({ uids: [uid] }, { timeoutMs: 200 })).toEqual({
        status: "retry",
        reason: "busy",
      });
      expect((await rows()).length).toBe(0);
      const waiting = barrier({ uids: [uid] });
      release();
      await worker;
      expect(await waiting).toEqual({ status: "ok" });
      expect((await rows()).length).toBe(1);
    });

    it("runs with a concurrent pass without duplicates", async () => {
      for (let i = 0; i < 5; i++) imap.deliver(rawMail());
      const outcomes = await Promise.all([barrier({ all: true }), pass()]);
      expect(outcomes[0]).toEqual({ status: "ok" });
      expect((await rows()).length).toBe(5);
      expect(new Set(await uidsOf()).size).toBe(5);
    });

    it("makes a pass skip while it holds the lock", async () => {
      const uid = imap.deliver(rawMail());
      await withMailboxLock(project.connectionId, 1000, async () => {
        const result = await pass();
        expect(result.status).toBe("ok");
        expect(await uidsOf()).toEqual([]);
      });
      await pass();
      expect(await uidsOf()).toEqual([uid]);
    });

    it("needs no fetch for what the cursor has passed", async () => {
      const uid = imap.deliver(rawMail());
      await pass();
      imap.calls.length = 0;
      expect(await barrier({ uids: [uid, 999] })).toEqual({ status: "ok" });
      expect((await rows()).length).toBe(1);
      expect(
        imap.used("fetchUids").flatMap((c) => c.args[0] as number[]),
      ).toEqual([999]);
    });

    it("does not count the cursor as proof inside a backlog", async () => {
      await resetState();
      const [a, b] = [imap.deliver(rawMail()), imap.deliver(rawMail())];
      await project.run((tx) =>
        create(tx, project.scope, "email_inbound_state", {
          connectionId: project.connectionId,
          uidValidity: "1",
          lastUid: b,
          backlogUntil: b,
        }),
      );
      await project.run((tx) =>
        create(tx, project.scope, BACKLOG, {
          connectionId: project.connectionId,
          uidValidity: "1",
          until: b,
          uids: [a, b],
          overflow: 0,
        }),
      );
      expect(await barrier({ uids: [a] })).toEqual({ status: "ok" });
      expect(await uidsOf()).toEqual([a]);
      expect(data((await rows())[0]).backlog).toBe(true);
    });

    it("leaves old read mail alone before the first sync", async () => {
      await resetState();
      const read = imap.deliver(rawMail(), { seen: true });
      const unread = imap.deliver(rawMail());
      expect(await barrier({ uids: [read, unread] })).toEqual({ status: "ok" });
      expect(await uidsOf()).toEqual([unread]);
    });

    it("refuses more than it can do in one go", async () => {
      const uids = Array.from({ length: 51 }, () => imap.deliver(rawMail()));
      expect(await barrier({ uids })).toEqual({
        status: "retry",
        reason: "too_many",
      });
      expect(await barrier({ all: true })).toEqual({
        status: "retry",
        reason: "too_many",
      });
      expect((await rows()).length).toBe(0);
      expect(await barrier({ uids: uids.slice(0, 50) })).toEqual({
        status: "ok",
      });
    });

    it("counts only what is still pending against the limit", async () => {
      const uids = Array.from({ length: 51 }, () => imap.deliver(rawMail()));
      await barrier({ uids: uids.slice(0, 50) });
      expect(await barrier({ uids })).toEqual({ status: "ok" });
      expect((await rows()).length).toBe(51);
    });

    it("lets go of a message too large to keep", async () => {
      const big = Buffer.concat([
        rawMail(),
        Buffer.alloc(11 * 1024 * 1024, 97),
      ]);
      const uid = imap.deliver(big);
      expect(await barrier({ uids: [uid] })).toEqual({ status: "ok" });
      expect((await rows()).length).toBe(0);
    });

    it("answers imap_error and records it when the server fails", async () => {
      const uid = imap.deliver(rawMail());
      imap.scanError = new MailSendError("IMAP_ERROR");
      expect(await barrier({ uids: [uid] })).toEqual({
        status: "retry",
        reason: "imap_error",
      });
      expect((await state())!.lastError).toBe("IMAP_ERROR");
    });

    it("gives up at its deadline", async () => {
      const uid = imap.deliver(rawMail());
      imap.duringFetch = () => new Promise((done) => setTimeout(done, 400));
      expect(await barrier({ uids: [uid] }, { timeoutMs: 50 })).toEqual({
        status: "retry",
        reason: "busy",
      });
      expect((await rows()).length).toBe(0);
    });

    it("refuses a mailbox without the marker", async () => {
      delete process.env.ORBIT_WEBMAIL;
      expect(await barrier({ all: true })).toEqual({
        status: "retry",
        reason: "ingest_failed",
      });
    });
  });

  describe("a message that cannot be stored", () => {
    it("refuses the barrier and records why", async () => {
      process.env.FILES_PROJECT_QUOTA_BYTES = "1";
      const uid = imap.deliver(rawMail());
      expect(await barrier({ uids: [uid] })).toEqual({
        status: "retry",
        reason: "ingest_failed",
      });
      expect((await state())!.lastError).toBe("FILES_QUOTA_EXCEEDED");
      expect((await rows()).length).toBe(0);
    });

    it("ends a pass with the cursor before it, and the next one goes on", async () => {
      const uid = imap.deliver(rawMail());
      process.env.FILES_PROJECT_QUOTA_BYTES = "1";
      expect((await pass()).status).toBe("error");
      expect(await state()).toMatchObject({
        lastUid: 0,
        lastError: "FILES_QUOTA_EXCEEDED",
      });
      delete process.env.FILES_PROJECT_QUOTA_BYTES;
      await pass();
      expect(await uidsOf()).toEqual([uid]);
      expect(await state()).toMatchObject({ lastUid: uid, lastError: null });
    });

    it("keeps its backlog position", async () => {
      await resetState();
      const uid = imap.deliver(rawMail());
      process.env.FILES_PROJECT_QUOTA_BYTES = "1";
      await pass();
      expect(await state()).toMatchObject({ lastUid: 0, backlogUntil: uid });
      expect((await snapshots()).length).toBe(1);
      delete process.env.FILES_PROJECT_QUOTA_BYTES;
      await pass();
      expect(await uidsOf()).toEqual([uid]);
      expect(await state()).toMatchObject({ backlogUntil: null });
      expect(await snapshots()).toEqual([]);
    });
  });

  describe("the backlog snapshot", () => {
    it("is written once, in its own row, and removed at the end", async () => {
      await resetState();
      for (let i = 0; i < 60; i++) imap.deliver(rawMail());
      await pass();
      const [first] = await snapshots();
      expect(data(first).uids).toHaveLength(60);
      expect("uids" in (await state())!).toBe(false);
      await pass();
      const [second] = await snapshots();
      expect(second!.id).toBe(first!.id);
      expect(second!.version).toBe(first!.version);
      await pass();
      expect((await rows()).length).toBe(60);
      expect(await snapshots()).toEqual([]);
      expect(await state()).toMatchObject({ lastUid: 60, backlogUntil: null });
    });

    it("is capped and counts what did not fit", async () => {
      await resetState();
      for (let i = 0; i < 5003; i++) imap.deliver(Buffer.from("x"));
      await barrier({ uids: [5002] });
      const [row] = await snapshots();
      expect(data(row).uids).toHaveLength(5000);
      expect(data(row).overflow).toBe(3);
      expect(data(row).until).toBe(5003);
      // Above the end of the capped list counts as pending.
      expect(await uidsOf()).toEqual([5002]);
      expect(await barrier({ all: true })).toEqual({
        status: "retry",
        reason: "too_many",
      });
    });

    it("lists what did not fit in a later pass", async () => {
      await resetState();
      const [a, b, c] = [
        imap.deliver(rawMail()),
        imap.deliver(rawMail()),
        imap.deliver(rawMail()),
      ];
      await project.run(async (tx) => {
        await create(tx, project.scope, "email_inbound_state", {
          connectionId: project.connectionId,
          uidValidity: "1",
          lastUid: 0,
          backlogUntil: c,
        });
        await create(tx, project.scope, BACKLOG, {
          connectionId: project.connectionId,
          uidValidity: "1",
          until: c,
          uids: [a],
          overflow: 2,
        });
      });
      await pass();
      expect(await uidsOf()).toEqual([a]);
      expect((await state())!.backlogUntil).toBe(c);
      await pass();
      expect(await uidsOf()).toEqual([a, b, c]);
      expect(await state()).toMatchObject({ lastUid: c, backlogUntil: null });
      expect(await snapshots()).toEqual([]);
    });
  });

  describe("mail without a Message-ID", () => {
    it("is one message by its raw source, whatever its UID", async () => {
      const raw = rawMail({ "Message-ID": null });
      const uid = imap.deliver(raw);
      await barrier({ uids: [uid] });
      const away = imap.move(uid, "Archive");
      imap.moveBack("Archive", away);
      await pass();
      const all = await rows();
      expect(all.length).toBe(1);
      expect(data(all[0]).rawSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps its hash when retention reduces the row", async () => {
      const raw = rawMail({ "Message-ID": null });
      imap.deliver(raw);
      await pass();
      await runSupportJobs();
      const [row] = await rows();
      const hash = data(row).rawSha256;
      // A takeover records such a mail under a stand-in id on an imported ticket.
      await project.run((tx) =>
        tx.supportTicket.updateMany({
          where: { projectId: project.scope.projectId },
          data: { importSource: "mailbox_import" },
        }),
      );
      await supportRetention(
        project.scope,
        new Date(Date.now() + 5 * 365 * 24 * HOUR),
      );
      const [reduced] = await rows();
      expect(data(reduced).retainedUntil).toEqual(expect.any(String));
      expect(data(reduced).rawSha256).toBe(hash);
      expect(data(reduced).text).toBeUndefined();
    });
  });

  it("sends no acknowledgement for old mail moved back into the INBOX", async () => {
    const uid = imap.deliver(rawMail({ Subject: "From last year" }), {
      internalDate: new Date(Date.now() - 73 * HOUR),
    });
    await pass();
    expect(data((await rows())[0])).toMatchObject({ uid, backlog: true });
    await runSupportJobs();
    const messages = await project.run((tx) =>
      tx.supportMessage.findMany({
        where: { projectId: project.scope.projectId },
      }),
    );
    expect(messages.map((m) => m.kind)).toEqual(["customer"]);
  });

  it("acknowledges mail that really is new", async () => {
    imap.deliver(rawMail({ Subject: "Just now" }), {
      internalDate: new Date(Date.now() - HOUR),
    });
    await pass();
    expect(data((await rows())[0]).backlog).toBeUndefined();
    await runSupportJobs();
    const messages = await project.run((tx) =>
      tx.supportMessage.findMany({
        where: { projectId: project.scope.projectId },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(messages.map((m) => m.kind)).toEqual(["customer", "system"]);
  });

  describe("a mailbox no module would act on", () => {
    beforeEach(async () => {
      project = await sharedProject(["support"], false);
      // Not the default mailbox's fallback: no unbound inbox exists either.
      await pass();
      imap.calls.length = 0;
    });

    it("is not stored, and its cursor moves on", async () => {
      const uid = imap.deliver(rawMail());
      await pass();
      expect(await rows()).toEqual([]);
      expect((await state())!.lastUid).toBe(uid);
    });

    it("answers the barrier without storing or reading", async () => {
      const uid = imap.deliver(rawMail());
      expect(await barrier({ uids: [uid] })).toEqual({ status: "ok" });
      expect(await rows()).toEqual([]);
      expect(imap.calls).toEqual([]);
    });

    it("is stored as soon as Support would route it", async () => {
      const { scope, run, connectionId } = project;
      await run((tx) =>
        createInbox(tx, scope, {
          name: "Desk",
          channels: ["email"],
          emailConnectionId: connectionId,
        }),
      );
      const uid = imap.deliver(rawMail());
      await pass();
      expect(await uidsOf()).toEqual([uid]);
    });

    it("keeps Support's default-mailbox fallback", async () => {
      const { scope, run } = project;
      await run((tx) =>
        tx.supportInbox.create({
          data: {
            id: crypto.randomUUID(),
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            name: "Legacy",
            channels: ["email"],
            emailAddress: "info@desk.example",
            createdBy: scope.userId,
          },
        }),
      );
      const uid = imap.deliver(rawMail());
      await pass();
      expect(await uidsOf()).toEqual([uid]);
    });

    it("counts Finance when it owns the mailbox", async () => {
      process.env.ORBIT_FINANCE = "true";
      try {
        project = await sharedProject(["finance"], false);
        const { scope, run, connectionId } = project;
        const consumer = (tx: Parameters<Parameters<typeof run>[0]>[0]) =>
          entity(tx, scope, "connectors", connectionId).then((row) =>
            mailboxHasConsumer(tx, scope, row),
          );
        expect(await run(consumer)).toBe(false);
        await run((tx) => setMailboxOwner(tx, scope, connectionId, "finance"));
        expect(await run(consumer)).toBe(true);
      } finally {
        delete process.env.ORBIT_FINANCE;
      }
    });

    it("never counts a module that takes no mail", async () => {
      const { scope, run, connectionId } = project;
      const consumer = () =>
        run((tx) =>
          entity(tx, scope, "connectors", connectionId).then((row) =>
            mailboxHasConsumer(tx, scope, row),
          ),
        );
      const registered = registeredEmailInbound() as unknown as Array<
        Record<string, unknown>
      >;
      // As the webmail module registers: follows removals, takes no mail.
      const inert: Record<string, unknown> = {
        owner: "support",
        mailboxUse: {
          inUse: async () => 0,
          release: async () => undefined,
          receivesMail: async () => true,
        },
      };
      registered.push(inert);
      try {
        expect(await consumer()).toBe(false);
        // The same module with a queue class would count: the test can tell.
        inert.queueClass = "support_email_inbound";
        expect(await consumer()).toBe(true);
      } finally {
        registered.splice(registered.indexOf(inert), 1);
      }
    });
  });

  describe("readMailboxMessage", () => {
    const ref = (uid: number, folder = "Archive", uidValidity = "77") => ({
      folder,
      uid,
      uidValidity,
    });
    const read = (r: ReturnType<typeof ref>, maxBytes = 1024 * 1024) =>
      readMailboxMessage(project.scope, project.connectionId, r, maxBytes);

    it("reads a message of any folder", async () => {
      const raw = rawMail();
      const uid = imap.file("Archive", raw);
      expect(Buffer.from((await read(ref(uid)))!.source)).toEqual(raw);
    });

    it("answers null when the message or the folder is gone", async () => {
      imap.file("Archive", rawMail());
      expect(await read(ref(99))).toBeNull();
      expect(await read(ref(1, "Nowhere"))).toBeNull();
    });

    it("refuses a UID from another UIDVALIDITY", async () => {
      imap.file("Archive", rawMail());
      await expect(read(ref(1, "Archive", "1"))).rejects.toMatchObject({
        code: "WEBMAIL_UID_VALIDITY_CHANGED",
        status: 409,
      });
    });

    it("refuses what is larger than asked for", async () => {
      const uid = imap.file("Archive", rawMail());
      await expect(read(ref(uid), 10)).rejects.toMatchObject({
        code: "WEBMAIL_MESSAGE_TOO_LARGE",
        status: 413,
      });
    });

    it("still reads the INBOX through a reader without folder access", async () => {
      readerOf = () => imap.legacyReader();
      const raw = rawMail();
      const uid = imap.deliver(raw);
      const inbox = ref(uid, "INBOX", "1");
      expect(Buffer.from((await read(inbox))!.source)).toEqual(raw);
      await expect(read(ref(uid, "INBOX", "9"))).rejects.toMatchObject({
        code: "WEBMAIL_UID_VALIDITY_CHANGED",
      });
      expect(await read(ref(uid, "Archive", "1"))).toBeNull();
    });
  });

  describe("inboundRowForImport", () => {
    const importing = (
      uid: number,
      source: Buffer,
      folder = "INBOX",
      uidValidity = "1",
    ) =>
      inboundRowForImport(
        project.scope,
        project.connectionId,
        { folder, uid, uidValidity },
        source,
      );

    it("runs an INBOX message through the normal ingest once", async () => {
      const raw = rawMail();
      const uid = imap.deliver(raw);
      const first = await importing(uid, raw);
      const [row] = await rows();
      expect(row!.id).toBe(first.inboundId);
      expect(data(row)).toMatchObject({
        connectionId: project.connectionId,
        uid,
        uidValidity: "1",
        fileId: first.fileId,
        backlog: true,
      });
      expect(await queuedJobs(project, "support_email_inbound")).toHaveLength(
        1,
      );
      expect(await importing(uid, raw)).toEqual({ ...first, created: false });
      await pass();
      expect((await rows()).length).toBe(1);
    });

    it("reuses the row of a message the pass already read", async () => {
      const raw = rawMail();
      const uid = imap.deliver(raw);
      await pass();
      const [row] = await rows();
      expect((await importing(uid, raw)).inboundId).toBe(row!.id);
    });

    it("gives a row polling cannot match to a message of another folder", async () => {
      const raw = rawMail({ "Message-ID": "<filed@example.org>" });
      const uid = imap.file("Archive", raw);
      const made = await importing(uid, raw, "Archive", "77");
      const d = data((await rows())[0]);
      expect(d.importedFromConnectionId).toBe(project.connectionId);
      expect(d.fileId).toBe(made.fileId);
      for (const key of ["connectionId", "uid", "uidValidity"])
        expect(key in d).toBe(false);
      expect(await queuedJobs(project, "support_email_inbound")).toEqual([]);
      expect(await importing(uid, raw, "Archive", "77")).toEqual({
        ...made,
        created: false,
      });
      // Moved back into the INBOX, it is an ordinary message again.
      imap.deliver(raw);
      await pass();
      expect((await rows()).length).toBe(2);
    });

    it("gives a reduced row its original back", async () => {
      const raw = rawMail();
      const uid = imap.deliver(raw);
      const first = await importing(uid, raw);
      await project.run(async (tx) => {
        const row = await entity(
          tx,
          project.scope,
          "inbound_emails",
          first.inboundId,
        );
        await update(tx, project.scope, row, {
          messageId: data(row).messageId,
          connectionId: data(row).connectionId,
          uid,
          uidValidity: "1",
          retainedUntil: new Date().toISOString(),
        });
      });
      const again = await importing(uid, raw);
      expect(again.inboundId).toBe(first.inboundId);
      expect(again.fileId).toEqual(expect.any(String));
      const d = data((await rows())[0]);
      expect(d.fileId).toBe(again.fileId);
      expect("retainedUntil" in d).toBe(false);
    });

    it("refuses while the mailbox is busy", async () => {
      const raw = rawMail();
      const uid = imap.deliver(raw);
      await withMailboxLock(project.connectionId, 1000, async () => {
        await expect(importing(uid, raw)).rejects.toMatchObject({
          code: "EMAIL_MAILBOX_BUSY",
          status: 409,
        });
      });
    }, 15_000);

    it("says whether this call made the row", async () => {
      const inbox = rawMail();
      const uid = imap.deliver(inbox);
      expect((await importing(uid, inbox)).created).toBe(true);
      expect((await importing(uid, inbox)).created).toBe(false);
      const filed = rawMail();
      const fileUid = imap.file("Archive", filed);
      expect((await importing(fileUid, filed, "Archive", "77")).created).toBe(
        true,
      );
      expect((await importing(fileUid, filed, "Archive", "77")).created).toBe(
        false,
      );
    });

    const fileLive = (id: string) =>
      project.run((tx) => tx.file.count({ where: { id, deletedAt: null } }));

    it("discards a folder message's row and its original", async () => {
      const raw = rawMail();
      const uid = imap.file("Archive", raw);
      const made = await importing(uid, raw, "Archive", "77");
      expect(await fileLive(made.fileId)).toBe(1);
      await discardImportedRow(project.scope, made.inboundId);
      expect(await rows()).toEqual([]);
      expect(await fileLive(made.fileId)).toBe(0);
    });

    it("never discards an INBOX row", async () => {
      const raw = rawMail();
      const uid = imap.deliver(raw);
      const made = await importing(uid, raw);
      await discardImportedRow(project.scope, made.inboundId);
      expect((await rows()).map((r) => r.id)).toEqual([made.inboundId]);
      expect(await fileLive(made.fileId)).toBe(1);
    });

    it("ignores a row that does not exist", async () => {
      await expect(
        discardImportedRow(project.scope, crypto.randomUUID()),
      ).resolves.toBeUndefined();
    });
  });

  describe("the barrier and the project lock", () => {
    /** The barrier's answer while a writer holds the project lock. */
    async function whileLocked(work: () => Promise<unknown>) {
      let release = () => {};
      const gate = new Promise<void>((done) => (release = done));
      let locked = () => {};
      const holding = new Promise<void>((done) => (locked = done));
      const holder = project.run(async () => {
        locked();
        await gate;
      });
      await holding;
      try {
        return await Promise.race([
          work(),
          new Promise((done) => setTimeout(() => done("blocked"), 3000)),
        ]);
      } finally {
        release();
        await holder;
      }
    }

    it("is not held up when the mailbox has no consumer", async () => {
      project = await sharedProject(["support"], false);
      await pass();
      const uid = imap.deliver(rawMail());
      expect(await whileLocked(() => barrier({ uids: [uid] }))).toEqual({
        status: "ok",
      });
    });

    it("is not held up when everything asked for is already stored", async () => {
      const uid = imap.deliver(rawMail());
      await barrier({ uids: [uid] });
      expect(await whileLocked(() => barrier({ uids: [uid] }))).toEqual({
        status: "ok",
      });
    });
  });
});
