import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { fetchInbound, INBOUND_KIND } from "../src/platform/email/inbound.ts";
import { setMailboxOwner } from "../src/platform/email/ownership.ts";
import {
  archiveInboundEmail,
  lastArchiveError,
  requestInboundArchive,
} from "../src/platform/email/archive.ts";
import {
  folderPath,
  setMailFactoriesForTests,
  MailSendError,
  type FetchedMessage,
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
const ACCOUNT = {
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: "invoices@desk.example",
  fromAddress: "invoices@desk.example",
  password: "synthetic-mailbox-password",
};
// The worker's permanent-error pattern (apps/worker/src/main.ts).
const PERMANENT =
  /BUDGET|NOT_|REQUIRED|EXPIRED|EVIDENCE|CAPABILITY|POLICY|PAUSED|UNKNOWN|REFUSAL|UNSUPPORTED/;
const mime = () =>
  Buffer.from(
    [
      "From: Vendor <vendor@example.org>",
      `To: ${ACCOUNT.fromAddress}`,
      "Subject: Invoice",
      "Date: Sat, 17 Oct 2026 10:00:00 +0000",
      `Message-ID: <${randomUUID()}@example.org>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Attached.",
      "",
    ].join("\r\n"),
  );

describe.skipIf(!enabled)("inbound e-mail archive", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  let connectionId = "";
  const mailbox: FetchedMessage[] = [];
  const moves: Array<{ uid: number; folder: string }> = [];
  let moveResult: "moved" | "missing" | "uid_validity_changed" = "moved";
  let moveError: Error | null = null;
  let uid = 0;
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);

  /** Delivers one message and returns its inbound row id. */
  async function receive() {
    const before = new Set(
      (await run((tx) => list(tx, scope, INBOUND_KIND))).map((r) => r.id),
    );
    mailbox.push({ uid: ++uid, source: mime() } as FetchedMessage);
    await fetchInbound(scope);
    const rows = await run((tx) => list(tx, scope, INBOUND_KIND));
    return rows.find((r) => !before.has(r.id))!.id;
  }
  const inbound = (id: string) =>
    run(async (tx) => data(await entity(tx, scope, INBOUND_KIND, id)));
  const request = (id: string, module = "finance") =>
    run((tx) =>
      requestInboundArchive(tx, scope, id, "Orbit/Processed", module),
    );

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
        send: async (mail) => ({ accepted: mail.to, rejected: [] }),
        close: () => undefined,
      }),
      mailbox: () => ({
        verify: async () => undefined,
        scan: async () => ({
          uidValidity: "1",
          top: Math.max(0, ...mailbox.map((m) => m.uid)),
          unseen: mailbox.map((m) => m.uid),
        }),
        fetchUids: async (uids) => ({
          messages: mailbox.filter((m) => uids.includes(m.uid)),
          skipped: [],
        }),
        fetchNew: async (state, limits) => ({
          uidValidity: "1",
          messages: mailbox
            .filter((m) => m.uid > state.lastUid)
            .slice(0, limits.max),
          skipped: [],
        }),
        move: async (state, folder) => {
          if (moveError) throw moveError;
          if (moveResult === "moved") moves.push({ uid: state.uid, folder });
          return moveResult;
        },
      }),
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic archive" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic archive" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    const connection = await run((tx) => connectEmail(tx, scope, ACCOUNT));
    connectionId = connection.id;
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...connection.data },
      ACCOUNT.password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", connection.id);
      await update(tx, scope, current, { ...data(current), ...checked });
      await setMailboxOwner(tx, scope, connection.id, "finance");
    });
    await fetchInbound(scope);
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

  it("moves the message after the owner requests it", async () => {
    moveResult = "moved";
    const id = await receive();
    await request(id);
    await archiveInboundEmail(scope, id);
    const row = await inbound(id);
    expect(row.archivedAt).toEqual(expect.any(String));
    expect(row.archiveFolder).toBe("Orbit/Processed");
    expect(row.archiveError).toBeNull();
    expect(moves).toEqual([{ uid: row.uid, folder: "Orbit/Processed" }]);
    expect(await run((tx) => lastArchiveError(tx, scope, connectionId))).toBe(
      null,
    );
  });

  it("refuses a module that does not own the mailbox", async () => {
    const id = await receive();
    await expect(request(id, "support")).rejects.toMatchObject({
      code: "EMAIL_ARCHIVE_NOT_OWNER",
      status: 403,
    });
    expect((await inbound(id)).archiveFolder).toBeUndefined();
  });

  it("records a missing message without retrying", async () => {
    moveResult = "missing";
    const id = await receive();
    await request(id);
    await archiveInboundEmail(scope, id);
    const row = await inbound(id);
    expect(row.archiveError).toBe("MISSING");
    expect(row.archivedAt).toBeUndefined();
    expect(await run((tx) => lastArchiveError(tx, scope, connectionId))).toBe(
      "MISSING",
    );
    moveResult = "moved";
  });

  it("records a changed UIDVALIDITY as permanent", async () => {
    moveResult = "uid_validity_changed";
    const id = await receive();
    await request(id);
    await archiveInboundEmail(scope, id);
    expect((await inbound(id)).archiveError).toBe("UID_VALIDITY_CHANGED");
    moveResult = "moved";
  });

  it("records an auth failure as permanent and an IMAP error as retryable", async () => {
    const id = await receive();
    await request(id);
    moveError = new MailSendError("IMAP_AUTH");
    const auth = await archiveInboundEmail(scope, id).catch((e) => e);
    expect(auth.message).toBe("EMAIL_ARCHIVE_AUTH_REQUIRED");
    expect(PERMANENT.test(auth.message)).toBe(true);
    expect((await inbound(id)).archiveError).toBe("IMAP_AUTH");
    moveError = new MailSendError("IMAP_ERROR");
    const transient = await archiveInboundEmail(scope, id).catch((e) => e);
    expect(PERMANENT.test(transient.message)).toBe(false);
    expect((await inbound(id)).archiveError).toBe("IMAP_ERROR");
    moveError = null;
    // Recovered: the next run archives and clears the error.
    await archiveInboundEmail(scope, id);
    const row = await inbound(id);
    expect(row.archivedAt).toEqual(expect.any(String));
    expect(row.archiveError).toBeNull();
  });

  it("is idempotent", async () => {
    moves.length = 0;
    const id = await receive();
    await request(id);
    await request(id);
    const jobs = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).resourceId === id && data(j).topic === "email_archive",
    );
    expect(jobs).toHaveLength(1);
    await archiveInboundEmail(scope, id);
    await archiveInboundEmail(scope, id);
    await request(id);
    expect(moves).toHaveLength(1);
  });

  it("keeps a recorded error on a repeated request and retries only on demand", async () => {
    moveResult = "missing";
    const id = await receive();
    await request(id);
    await archiveInboundEmail(scope, id);
    await request(id);
    expect((await inbound(id)).archiveError).toBe("MISSING");
    expect(await run((tx) => lastArchiveError(tx, scope, connectionId))).toBe(
      "MISSING",
    );
    const topics = async () =>
      (await run((tx) => list(tx, scope, "jobs"))).filter(
        (j) => data(j).resourceId === id && data(j).topic === "email_archive",
      );
    expect(await topics()).toHaveLength(1);
    moveResult = "moved";
    await run((tx) =>
      requestInboundArchive(tx, scope, id, "Orbit/Processed", "finance", {
        retry: true,
      }),
    );
    expect(await topics()).toHaveLength(2);
    await archiveInboundEmail(scope, id);
    const row = await inbound(id);
    expect(row.archivedAt).toEqual(expect.any(String));
    expect(row.archiveError).toBeNull();
  });

  it("records a mailbox that is no longer connected", async () => {
    const id = await receive();
    await request(id);
    await run(async (tx) => {
      const c = await entity(tx, scope, "connectors", connectionId);
      await update(tx, scope, c, { ...data(c), status: "configured" });
    });
    const error = await archiveInboundEmail(scope, id).catch((e) => e);
    expect(error.message).toBe("EMAIL_ARCHIVE_NOT_CONNECTED");
    expect((await inbound(id)).archiveError).toBe("NOT_CONNECTED");
  });

  it("translates the folder to the server's hierarchy delimiter", () => {
    expect(folderPath("Orbit/Processed", "/")).toBe("Orbit/Processed");
    expect(folderPath("Orbit/Processed", ".")).toBe("Orbit.Processed");
  });
});
