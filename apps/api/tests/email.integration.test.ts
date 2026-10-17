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
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { registeredConnectionProvider } from "../src/platform/modules/contributions.ts";
import { connectEmail } from "../src/platform/email/connection.ts";
import {
  queueEmail,
  sendQueuedEmail,
  skipEmailForPause,
} from "../src/platform/email/send.ts";
import { fetchInbound } from "../src/platform/email/inbound.ts";
import {
  MailSendError,
  setMailFactoriesForTests,
  type FetchedMessage,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const ENV = {
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
  username: "support@eds-labs.example",
  fromAddress: "support@eds-labs.example",
  fromName: "EDS Support",
  password: "synthetic-mailbox-password",
};

/** A raw RFC 5322 message. */
const mime = (
  headers: Record<string, string>,
  body = "Hello, I have a question.",
) =>
  Buffer.from(
    Object.entries({
      From: "Customer <customer@example.org>",
      To: ACCOUNT.fromAddress,
      Subject: "A question",
      Date: "Sat, 17 Oct 2026 10:00:00 +0000",
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
 * E-mail over the project's mailbox (WP4.7), with SMTP and IMAP replaced by
 * stubs: the connection, sending with every outcome, and receiving with
 * dedupe, auto-reply and bounce handling.
 */
describe.skipIf(!enabled)("e-mail over SMTP and IMAP", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  const sent: OutgoingMail[] = [];
  let sendError: MailSendError | null = null;
  let inbox: { uidValidity: string; messages: FetchedMessage[] } = {
    uidValidity: "1",
    messages: [],
  };
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    setMailFactoriesForTests({
      checkHost: async (host) => {
        if (host.endsWith(".internal"))
          throw new MailSendError("MAIL_HOST_NOT_PUBLIC");
      },
      transport: () => ({
        verify: async () => undefined,
        send: async (mail) => {
          if (sendError) throw sendError;
          sent.push(mail);
          return { accepted: mail.to, rejected: [] };
        },
        close: () => undefined,
      }),
      mailbox: () => ({
        verify: async () => undefined,
        fetchNew: async (state, limits) => {
          const from =
            inbox.uidValidity === state.uidValidity ? state.lastUid : 0;
          const fresh = inbox.messages.filter((m) => m.uid > from);
          const batch = fresh.slice(0, limits.max);
          return {
            uidValidity: inbox.uidValidity,
            messages: batch.filter((m) => m.source.length <= limits.maxBytes),
            skipped: batch
              .filter((m) => m.source.length > limits.maxBytes)
              .map((m) => m.uid),
          };
        },
      }),
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic e-mail" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic e-mail" },
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
    sendError = null;
  });
  afterAll(async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    setMailFactoriesForTests(null);
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  const connect = async () => {
    const row = await run((tx) => connectEmail(tx, scope, ACCOUNT));
    // The check logs in to both sides and sends nothing.
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...row.data },
      ACCOUNT.password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", row.id);
      await update(tx, scope, current, { ...data(current), ...checked });
    });
    return row.id;
  };
  const message = (id: string) =>
    run(async (tx) => data(await entity(tx, scope, "email_messages", id)));

  it("stores the connection without its password and refuses private hosts", async () => {
    await expect(
      run((tx) =>
        connectEmail(tx, scope, { ...ACCOUNT, smtpHost: "mail.internal" }),
      ),
    ).rejects.toThrow("MAIL_HOST_NOT_PUBLIC");
    await expect(
      run((tx) =>
        connectEmail(tx, scope, { ...ACCOUNT, smtpHost: "10.0.0.1" }),
      ),
    ).rejects.toThrow();
    const id = await connect();
    const [row] = (await run((tx) => list(tx, scope, "connectors"))).filter(
      (r) => r.id === id,
    );
    expect(JSON.stringify(row!.data)).not.toContain(ACCOUNT.password);
    expect(data(row!)).toMatchObject({
      provider: "email",
      status: "read_verified",
      smtpPort: 465,
      smtpTls: "implicit",
      imapPort: 993,
    });
    process.env.ORBIT_EMAIL = "false";
    await expect(run((tx) => connectEmail(tx, scope, ACCOUNT))).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("writes a receipt instead of sending outside live mode", async () => {
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["member@example.org"],
        subject: "Hello",
        text: "Body",
        moduleId: "tasks",
      }),
    );
    await sendQueuedEmail(scope, row.id);
    expect(sent).toHaveLength(0);
    expect(await message(row.id)).toMatchObject({ status: "test_receipt" });
    // A finished message is never sent again.
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    await sendQueuedEmail(scope, row.id);
    expect(sent).toHaveLength(0);
  });

  it("sends in live mode with an Orbit Message-ID and marks automatic mail", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
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
      from: { address: ACCOUNT.fromAddress, name: ACCOUNT.fromName },
      to: ["member@example.org"],
      messageId: `<orbit.${row.id}@eds-labs.example>`,
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Orbit-Message": row.id,
      },
    });
    expect(await message(row.id)).toMatchObject({
      status: "sent",
      accepted: 1,
    });
    // Header injection through the subject is refused.
    await expect(
      run((tx) =>
        queueEmail(tx, scope, {
          to: ["member@example.org"],
          subject: "Hi\r\nBcc: x@example.org",
          text: "Body",
          moduleId: "tasks",
        }),
      ),
    ).rejects.toThrow();
  });

  it("knows a refusal, a retry and an unclear outcome apart", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const queue = () =>
      run((tx) =>
        queueEmail(tx, scope, {
          to: ["member@example.org"],
          subject: "Outcome",
          text: "Body",
          moduleId: "tasks",
        }),
      );
    // 5xx: refused for good.
    sendError = new MailSendError("EENVELOPE", "RCPT TO", 550);
    const refused = await queue();
    await sendQueuedEmail(scope, refused.id);
    expect(await message(refused.id)).toMatchObject({
      status: "rejected",
      responseCode: 550,
    });
    // Nothing handed over: retried, then failed after three attempts.
    sendError = new MailSendError("ECONNECTION", "CONN");
    const flaky = await queue();
    for (let i = 0; i < 2; i++)
      await expect(sendQueuedEmail(scope, flaky.id)).rejects.toThrow(
        "EMAIL_SEND_RETRY",
      );
    await sendQueuedEmail(scope, flaky.id);
    expect(await message(flaky.id)).toMatchObject({
      status: "failed",
      attempts: 3,
    });
    // Broken after the hand-over: never sent again, an exception instead.
    sendError = new MailSendError("ETIMEDOUT", "DATA");
    const unclear = await queue();
    await sendQueuedEmail(scope, unclear.id);
    expect(await message(unclear.id)).toMatchObject({
      status: "outcome_unknown",
    });
    sendError = null;
    const before = sent.length;
    await sendQueuedEmail(scope, unclear.id);
    expect(sent).toHaveLength(before);
    const exceptions = (await run((tx) => list(tx, scope, "exceptions"))).map(
      (row) => data(row).code,
    );
    expect(exceptions).toContain("EMAIL_OUTCOME_UNKNOWN");
    // A crash while sending counts as unclear too.
    const crashed = await queue();
    await run(async (tx) => {
      const row = await entity(tx, scope, "email_messages", crashed.id);
      await update(tx, scope, row, { ...data(row), status: "sending" });
    });
    await sendQueuedEmail(scope, crashed.id);
    expect(sent).toHaveLength(before);
    expect(await message(crashed.id)).toMatchObject({
      status: "outcome_unknown",
      code: "INTERRUPTED",
    });
  });

  it("receives new mail once, keeps the raw message encrypted and hands it to the module", async () => {
    inbox = {
      uidValidity: "7",
      messages: [
        { uid: 1, source: mime({ "Message-ID": "<q1@example.org>" }) },
        {
          uid: 2,
          source: mime(
            {
              "Message-ID": "<ooo@example.org>",
              "Auto-Submitted": "auto-replied",
              Subject: "Out of office",
            },
            "I am away.",
          ),
        },
        // Larger than the file limit allows: skipped, not fetched.
        {
          uid: 3,
          source: mime(
            { "Message-ID": "<big@example.org>" },
            "x".repeat(11 * 1024 * 1024),
          ),
        },
      ],
    };
    const first = await fetchInbound(scope);
    expect(first).toMatchObject({ status: "ok", stored: 2, skipped: 1 });
    const rows = (await run((tx) => list(tx, scope, "inbound_emails"))).map(
      (r) => data(r),
    );
    expect(rows.map((r) => r.messageId).sort()).toEqual([
      "<ooo@example.org>",
      "<q1@example.org>",
    ]);
    const question = rows.find((r) => r.messageId === "<q1@example.org>")!;
    expect(question).toMatchObject({
      from: "customer@example.org",
      subject: "A question",
      automatic: false,
    });
    expect(question.text).toContain("I have a question");
    expect(
      rows.find((r) => r.messageId === "<ooo@example.org>")!.automatic,
    ).toBe(true);
    // The raw message is a platform file, encrypted at rest.
    const file = await run((tx) =>
      tx.file.findFirstOrThrow({ where: { id: question.fileId } }),
    );
    expect(file).toMatchObject({
      moduleId: "platform",
      mime: "message/rfc822",
    });
    expect(
      Buffer.from(objects.get(file.key)!).includes("I have a question"),
    ).toBe(false);
    // One job per message for the module that takes e-mail.
    const jobs = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    );
    expect(jobs).toHaveLength(2);

    // Nothing new: nothing stored.
    expect(await fetchInbound(scope)).toMatchObject({ stored: 0 });
    // A new UIDVALIDITY fetches everything again, without duplicates.
    inbox = {
      uidValidity: "8",
      messages: [
        { uid: 1, source: mime({ "Message-ID": "<q1@example.org>" }) },
        { uid: 2, source: mime({ "Message-ID": "<q2@example.org>" }) },
      ],
    };
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1 });
  });

  it("marks a bounced Orbit message and does not hand the report to modules", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["gone@example.org"],
        subject: "Will bounce",
        text: "Body",
        moduleId: "tasks",
      }),
    );
    await sendQueuedEmail(scope, row.id);
    const jobsBefore = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    ).length;
    inbox = {
      uidValidity: "8",
      messages: [
        {
          uid: 10,
          source: mime(
            {
              From: "Mail Delivery System <MAILER-DAEMON@mailbox.example.com>",
              "Message-ID": "<dsn1@mailbox.example.com>",
              Subject: "Undelivered Mail Returned to Sender",
              "Content-Type":
                'multipart/report; report-type=delivery-status; boundary="b"',
            },
            [
              "--b",
              "Content-Type: text/plain",
              "",
              "The mail could not be delivered.",
              "--b",
              "Content-Type: text/rfc822-headers",
              "",
              `Message-ID: <orbit.${row.id}@eds-labs.example>`,
              "--b--",
            ].join("\r\n"),
          ),
        },
      ],
    };
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1, bounced: 1 });
    expect(await message(row.id)).toMatchObject({ deliveryState: "bounced" });
    const jobsAfter = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    ).length;
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("fetches nothing without platform files", async () => {
    process.env.ORBIT_FILES = "false";
    inbox = {
      uidValidity: "8",
      messages: [
        { uid: 20, source: mime({ "Message-ID": "<later@example.org>" }) },
      ],
    };
    expect(await fetchInbound(scope)).toMatchObject({
      status: "files_not_configured",
    });
    process.env.ORBIT_FILES = "true";
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1 });
  });

  it("records a message the pause blocked as skipped, not waiting forever", async () => {
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["member@example.org"],
        subject: "Paused",
        text: "Body",
        moduleId: "tasks",
      }),
    );
    await run((tx) => skipEmailForPause(tx, { resourceId: row.id }));
    expect(await message(row.id)).toMatchObject({
      status: "skipped",
      code: "PROJECT_PAUSED",
    });
  });
});
