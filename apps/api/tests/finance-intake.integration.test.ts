import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, list } from "../src/shared.ts";
import { CONNECTION_KIND } from "../src/platform/connections/connections.ts";
import { INBOUND_KIND } from "../src/platform/email/send.ts";
import {
  setObjectStoreForTests,
  storeFile,
} from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { bindMailbox } from "../src/modules/finance/mailboxes.ts";
import { ingestDocument } from "../src/modules/finance/intake/documents.ts";
import { handleMailReceipt } from "../src/modules/finance/intake/mail.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/finance/${name}`, import.meta.url));
const ENV = {
  ORBIT_FINANCE: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};

describe.skipIf(!enabled)("finance document intake", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);

  /** A project with finance on, optionally a bound mailbox. */
  async function setup(
    options: { settings?: Record<string, unknown>; bind?: boolean } = {},
  ) {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic",
        email: `${userId}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic finance intake",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic finance intake" },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    const bound = await run(scope, async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          moduleId: "finance",
          enabled: true,
          moduleVersion: "1.0.0",
          settings: { aiExtraction: "on", ...options.settings },
        },
      });
      const connection = await create(tx, scope, CONNECTION_KIND, {
        provider: "email",
        fromAddress: `${randomUUID()}@example.invalid`,
      });
      const mailbox =
        options.bind === false
          ? null
          : await bindMailbox(tx, scope, {
              emailConnectionId: connection.id,
            });
      return { connectionId: connection.id, mailbox };
    });
    return { scope, ...bound };
  }

  /** Stores a raw mail like the platform does and returns its inbound row id. */
  async function inbound(
    scope: Scope,
    connectionId: string,
    raw: Buffer | string,
    fields: Record<string, unknown> = {},
  ) {
    const file = await storeFile(scope, {
      moduleId: "platform",
      bytes: Buffer.from(raw),
      mime: "message/rfc822",
    });
    return run(
      scope,
      async (tx) =>
        (
          await create(tx, scope, INBOUND_KIND, {
            connectionId,
            uid: 1,
            uidValidity: "1",
            messageId: `<${randomUUID()}@example.org>`,
            automatic: false,
            unreadable: false,
            fileId: file.id,
            ...fields,
          })
        ).id,
    );
  }
  const unique = (raw: Buffer, id: string) =>
    Buffer.from(
      raw.toString().replace(/^Message-ID: .*$/m, `Message-ID: ${id}`),
    );
  const documents = (scope: Scope) =>
    run(scope, (tx) =>
      tx.financeDocument.findMany({
        where: { projectId: scope.projectId },
        orderBy: { createdAt: "asc" },
      }),
    );
  const jobsOf = async (scope: Scope, topic: string) =>
    (await run(scope, (tx) => list(tx, scope, "jobs"))).filter(
      (j) => data(j).topic === topic,
    );

  beforeAll(() => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("creates one document per accepted attachment and ignores the inline logo", async () => {
    const { scope, connectionId, mailbox } = await setup();
    const id = await inbound(
      scope,
      connectionId,
      unique(
        fixture("receipt-inline-logo.eml"),
        `<${randomUUID()}@acme.example>`,
      ),
    );
    await handleMailReceipt(scope, id);
    const docs = await documents(scope);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      source: "email",
      mimeType: "application/pdf",
      originalName: "invoice.pdf",
      status: "received",
      mailboxId: mailbox!.id,
      inboundEmailId: id,
    });
    expect(docs[0]!.emailFileId).not.toBe(docs[0]!.fileId);
    expect(await jobsOf(scope, "finance_extract")).toHaveLength(1);
    // The extraction job requests the archive later, not intake.
    expect(await jobsOf(scope, "email_archive")).toHaveLength(0);
  });

  it("uses the eml as document when the mail has no attachment", async () => {
    const { scope, connectionId } = await setup();
    const id = await inbound(
      scope,
      connectionId,
      unique(
        fixture("receipt-body-only.eml"),
        `<${randomUUID()}@store.example>`,
      ),
    );
    await handleMailReceipt(scope, id);
    const [doc] = await documents(scope);
    expect(doc).toMatchObject({
      mimeType: "message/rfc822",
      status: "received",
    });
    expect(doc!.emailFileId).toBe(doc!.fileId);
  });

  it("does not process the same message twice", async () => {
    const { scope, connectionId } = await setup();
    const raw = unique(
      fixture("receipt-inline-logo.eml"),
      "<same@acme.example>",
    );
    const first = await inbound(scope, connectionId, raw, {
      messageId: "<same@acme.example>",
    });
    const second = await inbound(scope, connectionId, raw, {
      messageId: "<same@acme.example>",
    });
    await handleMailReceipt(scope, first);
    await handleMailReceipt(scope, second);
    expect(await documents(scope)).toHaveLength(1);
  });

  it("marks an identical file as duplicate without enqueuing extraction", async () => {
    const { scope } = await setup();
    const bytes = fixture("invoice.pdf");
    const first = await ingestDocument(scope, {
      source: "upload",
      bytes,
      mime: "application/pdf",
      name: "invoice.pdf",
    });
    const second = await ingestDocument(scope, {
      source: "upload",
      bytes,
      mime: "application/pdf",
      name: "again.pdf",
    });
    expect(first.status).toBe("received");
    expect(second).toMatchObject({
      status: "duplicate",
      duplicateOfId: first.id,
    });
    expect(await jobsOf(scope, "finance_extract")).toHaveLength(1);
    const audits = await run(scope, (tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "finance.document.received",
        },
      }),
    );
    expect(
      audits
        .map((a) => a.metadata)
        .sort((a: any, b: any) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
    ).toEqual(
      [{ source: "upload" }, { duplicate: true, source: "upload" }].sort(
        (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    );
  });

  it("ignores mail of unbound mailboxes", async () => {
    const { scope, connectionId } = await setup({ bind: false });
    const id = await inbound(
      scope,
      connectionId,
      unique(
        fixture("receipt-inline-logo.eml"),
        `<${randomUUID()}@acme.example>`,
      ),
    );
    await handleMailReceipt(scope, id);
    expect(await documents(scope)).toHaveLength(0);
    await expect(handleMailReceipt(scope, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("sets retainUntil ten years ahead", async () => {
    const { scope, connectionId } = await setup();
    const id = await inbound(
      scope,
      connectionId,
      unique(
        fixture("receipt-inline-logo.eml"),
        `<${randomUUID()}@acme.example>`,
      ),
    );
    const before = Date.now();
    await handleMailReceipt(scope, id);
    const [doc] = await documents(scope);
    const files = await run(scope, (tx) =>
      tx.file.findMany({
        where: { id: { in: [doc!.fileId, doc!.emailFileId!] } },
      }),
    );
    expect(files).toHaveLength(2);
    const expected = new Date(before);
    expected.setUTCFullYear(expected.getUTCFullYear() + 10);
    for (const file of files)
      expect(
        Math.abs(file.retainUntil!.getTime() - expected.getTime()),
      ).toBeLessThan(60_000);
  });

  it("with aiExtraction off the document waits for review and the mail is archived", async () => {
    const { scope, connectionId, mailbox } = await setup({
      settings: { aiExtraction: "off" },
    });
    const id = await inbound(
      scope,
      connectionId,
      unique(
        fixture("receipt-inline-logo.eml"),
        `<${randomUUID()}@acme.example>`,
      ),
    );
    await handleMailReceipt(scope, id);
    const [doc] = await documents(scope);
    expect(doc).toMatchObject({ status: "needs_review", flags: ["ai_off"] });
    expect(await jobsOf(scope, "finance_extract")).toHaveLength(0);
    expect(await jobsOf(scope, "email_archive")).toHaveLength(1);
    const row = await run(scope, (tx) =>
      tx.entity.findFirstOrThrow({ where: { id } }),
    );
    expect(data(row).archiveFolder).toBe(mailbox!.archiveFolder);
  });

  it("skips automatic mail and logs unreadable mail without archiving it", async () => {
    const { scope, connectionId } = await setup({
      settings: { aiExtraction: "off" },
    });
    const auto = await inbound(
      scope,
      connectionId,
      fixture("receipt-body-only.eml"),
      {
        automatic: true,
      },
    );
    const broken = await inbound(scope, connectionId, "not a mail", {
      unreadable: true,
    });
    await handleMailReceipt(scope, auto);
    await handleMailReceipt(scope, broken);
    expect(await documents(scope)).toHaveLength(0);
    expect(await jobsOf(scope, "email_archive")).toHaveLength(0);
    const audits = await run(scope, (tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "finance.mail.unreadable",
        },
      }),
    );
    expect(audits).toHaveLength(1);
  });
});
