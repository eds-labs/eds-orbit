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
  type MailFactories,
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
  let inbox: {
    uidValidity: string;
    messages: (FetchedMessage & { seen?: boolean })[];
  } = {
    uidValidity: "1",
    messages: [],
  };
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const factories: MailFactories = {
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
      scan: async () => ({
        uidValidity: inbox.uidValidity,
        top: Math.max(0, ...inbox.messages.map((m) => m.uid)),
        unseen: inbox.messages.filter((m) => !m.seen).map((m) => m.uid),
      }),
      fetchUids: async (uids, maxBytes) => {
        const picked = inbox.messages.filter((m) => uids.includes(m.uid));
        return {
          messages: picked
            .filter((m) => m.source.length <= maxBytes)
            .map(({ uid, source }) => ({ uid, source })),
          skipped: picked
            .filter((m) => m.source.length > maxBytes)
            .map((m) => m.uid),
        };
      },
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
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    setMailFactoriesForTests(factories);
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
              "Content-Type: message/delivery-status",
              "",
              "Reporting-MTA: dns; mailbox.example.com",
              "",
              "Final-Recipient: rfc822; gone@example.org",
              "Action: failed",
              "Status: 5.1.1",
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

  it("does not let one hostile message block the mailbox", async () => {
    const nested = (depth: number) =>
      Array.from(
        { length: depth },
        (_, i) =>
          `--b${i}\r\nContent-Type: multipart/mixed; boundary="b${i + 1}"\r\n\r\n`,
      ).join("") + `--b${depth}\r\nContent-Type: text/plain\r\n\r\ndeep\r\n`;
    inbox = {
      uidValidity: "8",
      messages: [
        // Deeper than the parser allows: postal-mime throws.
        {
          uid: 30,
          source: mime(
            {
              "Message-ID": "<deep@example.org>",
              "Content-Type": 'multipart/mixed; boundary="b0"',
            },
            nested(300),
          ),
        },
        // Headers above the parser's 2 MB limit: postal-mime throws.
        {
          uid: 31,
          source: mime({
            "Message-ID": "<huge-header@example.org>",
            "X-Pad": "a".repeat(3 * 1024 * 1024),
          }),
        },
        // NUL in subject and text: Postgres jsonb refuses \u0000.
        {
          uid: 32,
          source: mime(
            {
              "Message-ID": "<nul@example.org>",
              Subject: "=?utf-8?B?SGkAdGhlcmU=?=",
            },
            "a\u0000b",
          ),
        },
        // Oversized threading fields stay bounded in the row.
        {
          uid: 33,
          source: mime({
            "Message-ID": "<long@example.org>",
            "In-Reply-To": `<${"r".repeat(5000)}@example.org>`,
            References: Array.from(
              { length: 60 },
              (_, i) => `<${i}${"x".repeat(2000)}@example.org>`,
            ).join(" "),
          }),
        },
        { uid: 34, source: mime({ "Message-ID": "<after@example.org>" }) },
      ],
    };
    const result = await fetchInbound(scope);
    expect(result).toMatchObject({ status: "ok", stored: 5 });
    const rows = (await run((tx) => list(tx, scope, "inbound_emails")))
      .map((r) => data(r))
      .filter((r) => r.uid >= 30 && r.uid <= 34);
    expect(rows.map((r) => r.uid).sort()).toEqual([30, 31, 32, 33, 34]);
    // An unreadable message keeps its raw file and is flagged.
    const deep = rows.find((r) => r.uid === 30)!;
    expect(deep).toMatchObject({ unreadable: true, automatic: false });
    expect(deep.fileId).toBeTruthy();
    expect(rows.find((r) => r.uid === 32)).toMatchObject({
      subject: "Hi there",
      text: expect.stringContaining("ab"),
    });
    const long = rows.find((r) => r.uid === 33)!;
    expect(long.inReplyTo.length).toBeLessThanOrEqual(998);
    expect(long.references.every((r: string) => r.length <= 998)).toBe(true);
    // Nothing is fetched again.
    expect(await fetchInbound(scope)).toMatchObject({ stored: 0 });
  });

  it("marks bounced only by a delivery report naming the message's recipient", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: ["alice@example.org"],
        subject: "Report check",
        text: "Body",
        moduleId: "tasks",
      }),
    );
    await sendQueuedEmail(scope, row.id);
    const ref = `<orbit.${row.id}@eds-labs.example>`;
    const report = (type: string, part: string) =>
      [
        "--b",
        "Content-Type: text/plain",
        "",
        "Report.",
        "--b",
        `Content-Type: ${type}`,
        "",
        part,
        "--b",
        "Content-Type: text/rfc822-headers",
        "",
        `Message-ID: ${ref}`,
        "--b--",
      ].join("\r\n");
    inbox = {
      uidValidity: "8",
      messages: [
        // A read receipt (MDN) is a multipart/report, not a bounce.
        {
          uid: 40,
          source: mime(
            {
              From: "Alice <alice@example.org>",
              "Message-ID": "<mdn1@example.org>",
              "Content-Type":
                'multipart/report; report-type=disposition-notification; boundary="b"',
            },
            report(
              "message/disposition-notification",
              `Final-Recipient: rfc822; alice@example.org\r\nOriginal-Message-ID: ${ref}\r\nDisposition: manual-action/MDN-sent-manually; displayed`,
            ),
          ),
        },
        // A forged report for an address the message never went to.
        {
          uid: 41,
          source: mime(
            {
              From: "postmaster@attacker.example",
              "Message-ID": "<forged@attacker.example>",
              "Content-Type":
                'multipart/report; report-type=delivery-status; boundary="b"',
            },
            report(
              "message/delivery-status",
              "Final-Recipient: rfc822; mallory@attacker.example\r\nAction: failed\r\nStatus: 5.1.1",
            ),
          ),
        },
        // Another address that merely contains the recipient's.
        {
          uid: 43,
          source: mime(
            {
              From: "MAILER-DAEMON@mailbox.example.com",
              "Message-ID": "<dsn-similar@mailbox.example.com>",
              "Content-Type":
                'multipart/report; report-type=delivery-status; boundary="b"',
            },
            report(
              "message/delivery-status",
              "Final-Recipient: rfc822; malice@example.org\r\nAction: failed\r\nStatus: 5.1.1",
            ),
          ),
        },
        // A "delayed" warning: the message may still arrive.
        {
          uid: 44,
          source: mime(
            {
              From: "MAILER-DAEMON@mailbox.example.com",
              "Message-ID": "<dsn-delayed@mailbox.example.com>",
              "Content-Type":
                'multipart/report; report-type=delivery-status; boundary="b"',
            },
            report(
              "message/delivery-status",
              "Final-Recipient: rfc822; alice@example.org\r\nAction: delayed\r\nStatus: 4.4.7",
            ),
          ),
        },
        // A human reply from a postmaster address quoting the thread.
        {
          uid: 42,
          source: mime(
            {
              From: "postmaster@customer.example",
              "Message-ID": "<human@customer.example>",
              "In-Reply-To": ref,
            },
            "Thanks, we will look into it.",
          ),
        },
      ],
    };
    const jobsBefore = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    ).length;
    expect(await fetchInbound(scope)).toMatchObject({ stored: 5, bounced: 0 });
    expect((await message(row.id)).deliveryState).toBeUndefined();
    // Not bounces, so the modules get them.
    const jobsAfter = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    ).length;
    expect(jobsAfter).toBe(jobsBefore + 5);
  });

  it("does not hand Orbit's own messages back to the modules", async () => {
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    // A notice to a member whose address is the mailbox itself, or a
    // provider that copies sent mail into the INBOX: it comes back in.
    const row = await run((tx) =>
      queueEmail(tx, scope, {
        to: [ACCOUNT.fromAddress],
        subject: "Notice",
        text: "Body",
        moduleId: "tasks",
        automatic: true,
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
          uid: 50,
          source: mime({
            From: `EDS Support <${ACCOUNT.fromAddress}>`,
            "Message-ID": `<orbit.${row.id}@eds-labs.example>`,
            "X-Orbit-Message": row.id,
          }),
        },
      ],
    };
    await fetchInbound(scope);
    const jobsAfter = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === "fixture_email",
    ).length;
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("refuses a reply to automatic mail (no auto-reply loops)", async () => {
    inbox = {
      uidValidity: "8",
      messages: [
        {
          uid: 60,
          source: mime({
            "Message-ID": "<vacation@example.org>",
            "Auto-Submitted": "auto-replied",
            Subject: "Away",
          }),
        },
      ],
    };
    await fetchInbound(scope);
    await expect(
      run((tx) =>
        queueEmail(tx, scope, {
          to: ["customer@example.org"],
          subject: "Re: Away",
          text: "Thanks",
          moduleId: "tasks",
          inReplyTo: "<vacation@example.org>",
        }),
      ),
    ).rejects.toThrow("EMAIL_REPLY_TO_AUTOMATIC");
  });

  it("does not log in to the mailbox while e-mail is off", async () => {
    const id = await connect();
    const row = await run((tx) => entity(tx, scope, "connectors", id));
    let logins = 0;
    setMailFactoriesForTests({
      checkHost: async () => undefined,
      transport: () => ({
        verify: async () => void logins++,
        send: async () => ({ accepted: [], rejected: [] }),
        close: () => undefined,
      }),
      mailbox: () => ({
        verify: async () => void logins++,
        scan: async () => ({ uidValidity: "1", top: 0, unseen: [] }),
        fetchUids: async () => ({ messages: [], skipped: [] }),
        fetchNew: async () => ({ uidValidity: "1", messages: [], skipped: [] }),
      }),
    });
    process.env.ORBIT_EMAIL = "false";
    try {
      await expect(
        registeredConnectionProvider("email")!.check!(
          { ...data(row) },
          ACCOUNT.password,
        ),
      ).rejects.toThrow("NOT_FOUND");
      expect(logins).toBe(0);
    } finally {
      setMailFactoriesForTests(factories);
    }
  });

  it("takes only unread mail on the first sync and marks it as backlog", async () => {
    // A mailbox connected for the first time: no inbound state yet.
    await run((tx) =>
      tx.entity.deleteMany({
        where: { projectId: scope.projectId, kind: "email_inbound_state" },
      }),
    );
    const msg = (uid: number, seen: boolean) => ({
      uid,
      seen,
      source: mime({ "Message-ID": `<backlog-${uid}@example.org>` }),
    });
    inbox = {
      uidValidity: "30",
      messages: [
        msg(10, true),
        msg(11, false),
        msg(12, true),
        // More unread mail than one pass takes (25).
        ...Array.from({ length: 26 }, (_, i) => msg(20 + i, false)),
      ],
    };
    const rowsOf = async () =>
      (await run((tx) => list(tx, scope, "inbound_emails")))
        .map((r) => data(r))
        .filter((r) => String(r.messageId).startsWith("<backlog-"));
    expect(await fetchInbound(scope)).toMatchObject({ stored: 25 });
    expect(await fetchInbound(scope)).toMatchObject({ stored: 2 });
    const rows = await rowsOf();
    // Read mail from before the first sync is never fetched.
    expect(
      rows.map((r) => r.uid).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([11, ...Array.from({ length: 26 }, (_, i) => 20 + i)]);
    expect(rows.every((r) => r.backlog === true)).toBe(true);
    // After the backlog, new mail is fetched read or not, and is not backlog.
    inbox.messages.push(msg(50, true));
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1 });
    const fresh = (await rowsOf()).find((r) => r.uid === 50)!;
    expect(fresh.backlog).toBeUndefined();
    expect(await fetchInbound(scope)).toMatchObject({ stored: 0 });
  });

  it("starts over with unread mail only after a UIDVALIDITY change", async () => {
    inbox = {
      uidValidity: "31",
      messages: [
        {
          uid: 1,
          seen: true,
          source: mime({ "Message-ID": "<reset-read@example.org>" }),
        },
        {
          uid: 2,
          source: mime({ "Message-ID": "<reset-unread@example.org>" }),
        },
      ],
    };
    expect(await fetchInbound(scope)).toMatchObject({ stored: 1 });
    const ids = (await run((tx) => list(tx, scope, "inbound_emails"))).map(
      (r) => data(r).messageId,
    );
    expect(ids).toContain("<reset-unread@example.org>");
    expect(ids).not.toContain("<reset-read@example.org>");
  });

  it("fetches nothing without platform files", async () => {
    process.env.ORBIT_FILES = "false";
    inbox = {
      uidValidity: "8",
      messages: [
        { uid: 100, source: mime({ "Message-ID": "<later@example.org>" }) },
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
