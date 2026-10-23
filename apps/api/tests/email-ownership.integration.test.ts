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
import {
  mailboxOwner,
  setMailboxOwner,
} from "../src/platform/email/ownership.ts";
import {
  setMailFactoriesForTests,
  type FetchedMessage,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { eraseContact } from "../src/modules/support/privacy.ts";
import { registerTestModules } from "../src/modules/registry.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// The fixture module "tasks" stands in for a second emailInbound consumer.
registerTestModules([tasksFixture]);

const ENV = {
  ORBIT_SUPPORT: "true",
  ORBIT_FINANCE: "true",
  ORBIT_EMAIL: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const account = (name: string) => ({
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: `${name}@desk.example`,
  fromAddress: `${name}@desk.example`,
  password: "synthetic-mailbox-password",
});
const mime = (to: string, from = "Anna <anna@example.org>") =>
  Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      "Subject: Hello",
      "Date: Sat, 17 Oct 2026 10:00:00 +0000",
      `Message-ID: <${randomUUID()}@example.org>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body text.",
      "",
    ].join("\r\n"),
  );

describe.skipIf(!enabled)("mailbox owner routing", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  const boxes = new Map<string, FetchedMessage[]>();
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);

  async function addMailbox(name: string) {
    const acc = account(name);
    const connection = await run((tx) => connectEmail(tx, scope, acc));
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...connection.data },
      acc.password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", connection.id);
      await update(tx, scope, current, { ...data(current), ...checked });
    });
    boxes.set(acc.fromAddress, []);
    return connection.id;
  }
  let uid = 0;
  const deliver = (address: string, raw: Buffer) =>
    boxes.get(address)!.push({ uid: ++uid, source: raw } as FetchedMessage);
  /** Topics of the jobs queued for the inbound rows of one mailbox address. */
  const jobsFor = async (address: string) => {
    const inbound = (await run((tx) => list(tx, scope, INBOUND_KIND))).filter(
      (r) => String(data(r).to ?? "").includes(address),
    );
    const ids = new Set(inbound.map((r) => r.id));
    return (await run((tx) => list(tx, scope, "jobs")))
      .filter((j) => ids.has(String(data(j).resourceId)))
      .map((j) => String(data(j).topic))
      .sort();
  };

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
      mailbox: (account) => {
        const messages = () => boxes.get(account.fromAddress) ?? [];
        return {
          verify: async () => undefined,
          scan: async () => ({
            uidValidity: "1",
            top: Math.max(0, ...messages().map((m) => m.uid)),
            unseen: messages().map((m) => m.uid),
          }),
          fetchUids: async (uids) => ({
            messages: messages().filter((m) => uids.includes(m.uid)),
            skipped: [],
          }),
          move: async () => "moved" as const,
          fetchNew: async (state, limits) => ({
            uidValidity: "1",
            messages: messages()
              .filter((m) => m.uid > state.lastUid)
              .slice(0, limits.max),
            skipped: [],
          }),
        };
      },
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic mailbox ownership" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic mailbox ownership" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    await run(async (tx) => {
      for (const moduleId of ["support", "tasks", "finance"])
        await tx.projectModule.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            moduleId,
            enabled: true,
            moduleVersion: "1.0.0",
          },
        });
    });
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

  it("routes owned mail only to its owner", async () => {
    const id = await addMailbox("owned");
    await fetchInbound(scope); // first sync of an empty mailbox
    await run((tx) => setMailboxOwner(tx, scope, id, "support"));
    expect(
      mailboxOwner(
        data(await run((tx) => entity(tx, scope, "connectors", id))),
      ),
    ).toBe("support");
    deliver("owned@desk.example", mime("owned@desk.example"));
    await fetchInbound(scope);
    expect(await jobsFor("owned@desk.example")).toEqual([
      "support_email_inbound",
    ]);
  });

  it("broadcasts mail of unowned mailboxes as before", async () => {
    await addMailbox("open");
    await fetchInbound(scope);
    deliver("open@desk.example", mime("open@desk.example"));
    await fetchInbound(scope);
    expect(await jobsFor("open@desk.example")).toEqual([
      "fixture_email",
      "support_email_inbound",
    ]);
  });

  it("gives an owned-only module nothing of unowned mailboxes", async () => {
    // Finance takes owned mail only: an unowned mailbox feeds Support (and
    // the broadcasting fixture), never a finance receipt job.
    await addMailbox("unclaimed");
    await fetchInbound(scope);
    deliver("unclaimed@desk.example", mime("unclaimed@desk.example"));
    await fetchInbound(scope);
    const jobs = await jobsFor("unclaimed@desk.example");
    expect(jobs).toContain("support_email_inbound");
    expect(jobs).not.toContain("finance_mail_receipt");
  });

  it("routes a finance-owned mailbox to finance only", async () => {
    const id = await addMailbox("receipts");
    await fetchInbound(scope);
    await run((tx) => setMailboxOwner(tx, scope, id, "finance"));
    deliver("receipts@desk.example", mime("receipts@desk.example"));
    await fetchInbound(scope);
    expect(await jobsFor("receipts@desk.example")).toEqual([
      "finance_mail_receipt",
    ]);
  });

  it("keeps the owner when the mailbox is saved again", async () => {
    const id = await addMailbox("resaved");
    await fetchInbound(scope);
    await run((tx) => setMailboxOwner(tx, scope, id, "support"));
    await run((tx) => connectEmail(tx, scope, account("resaved")));
    const row = await run((tx) => entity(tx, scope, "connectors", id));
    expect(mailboxOwner(data(row))).toBe("support");
    // The re-save needs a new login check, as before.
    const checked = await registeredConnectionProvider("email")!.check!(
      { ...data(row) },
      account("resaved").password,
    );
    await run(async (tx) => {
      const current = await entity(tx, scope, "connectors", id);
      await update(tx, scope, current, { ...data(current), ...checked });
    });
    deliver("resaved@desk.example", mime("resaved@desk.example"));
    await fetchInbound(scope);
    expect(await jobsFor("resaved@desk.example")).toEqual([
      "support_email_inbound",
    ]);
  });

  it("refuses a second owner", async () => {
    const id = await addMailbox("claimed");
    await run((tx) => setMailboxOwner(tx, scope, id, "finance-fixture"));
    await expect(
      run((tx) => setMailboxOwner(tx, scope, id, "support")),
    ).rejects.toMatchObject({ code: "EMAIL_MAILBOX_OWNED" });
    // The owner itself may repeat or release the claim.
    await run((tx) => setMailboxOwner(tx, scope, id, "finance-fixture"));
    await run((tx) => setMailboxOwner(tx, scope, id, null));
    await run((tx) => setMailboxOwner(tx, scope, id, "support"));
  });

  it("support refuses to bind a mailbox another module owns", async () => {
    const id = await addMailbox("finance");
    await run((tx) => setMailboxOwner(tx, scope, id, "finance-fixture"));
    await expect(
      run((tx) =>
        createInbox(tx, scope, {
          name: "Taken",
          channels: ["email"],
          emailConnectionId: id,
        }),
      ),
    ).rejects.toMatchObject({ code: "EMAIL_MAILBOX_OWNED" });
  });

  it("support erasure leaves other mailboxes' inbound mail", async () => {
    const supportBox = await addMailbox("deskerase");
    const otherBox = await addMailbox("ledger");
    await run((tx) => setMailboxOwner(tx, scope, otherBox, "finance-fixture"));
    await run((tx) =>
      createInbox(tx, scope, {
        name: "Erase desk",
        channels: ["email"],
        emailConnectionId: supportBox,
      }),
    );
    const contact = await run((tx) =>
      tx.supportContact.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          id: randomUUID(),
          email: "erase-me@example.org",
        },
      }),
    );
    const row = (connectionId: string) =>
      run(async (tx) =>
        tx.entity.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: INBOUND_KIND,
            data: { connectionId, from: "erase-me@example.org", subject: "x" },
          },
        }),
      );
    const mine = await row(supportBox);
    const theirs = await row(otherBox);
    await eraseContact(scope, contact.id);
    const left = await run((tx) =>
      tx.entity.findMany({ where: { id: { in: [mine.id, theirs.id] } } }),
    );
    expect(left.map((r) => r.id)).toEqual([theirs.id]);
  });
  it("support erasure keeps legacy and unowned mailboxes' mail erasable", async () => {
    // A fresh project: its default mailbox (the first verified) is unowned
    // and serves an unbound inbox from before the binding.
    const outer = scope;
    const project = await authDb.project.create({
      data: { workspaceId: outer.workspaceId, name: "Synthetic erasure" },
    });
    scope = { ...outer, projectId: project.id };
    try {
      await run((tx) =>
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
      const fallback = await addMailbox("legacydesk");
      const loose = await addMailbox("loose");
      const ledger = await addMailbox("ledgererase");
      await run((tx) => setMailboxOwner(tx, scope, ledger, "finance"));
      await run((tx) =>
        tx.supportInbox.create({
          data: {
            id: randomUUID(),
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            name: "Legacy desk",
            channels: ["email"],
            emailAddress: "legacydesk@desk.example",
            emailConnectionId: null,
            createdBy: "owner-setup",
          },
        }),
      );
      const contact = await run((tx) =>
        tx.supportContact.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            id: randomUUID(),
            email: "legacy-erase@example.org",
          },
        }),
      );
      const row = (connectionId: string) =>
        run((tx) =>
          tx.entity.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              kind: INBOUND_KIND,
              data: {
                connectionId,
                from: "legacy-erase@example.org",
                subject: "x",
              },
            },
          }),
        );
      const legacy = await row(fallback);
      const unowned = await row(loose);
      const finance = await row(ledger);
      await eraseContact(scope, contact.id);
      const left = await run((tx) =>
        tx.entity.findMany({
          where: { id: { in: [legacy.id, unowned.id, finance.id] } },
        }),
      );
      expect(left.map((r) => r.id)).toEqual([finance.id]);
    } finally {
      scope = outer;
    }
  });
});
