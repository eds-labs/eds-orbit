import { randomBytes, randomUUID } from "node:crypto";
import { authDb, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity, list, update } from "../src/shared.ts";
import { registeredConnectionProvider } from "../src/platform/modules/contributions.ts";
import { connectEmail } from "../src/platform/email/connection.ts";
import {
  setMailFactoriesForTests,
  type EmailAccount,
  type FetchedMessage,
  type MailboxReader,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";

// A mailbox server in memory for the fetch-path tests: UIDs, UIDVALIDITY, the
// seen flag and INTERNALDATE behave like IMAP, and every call is recorded.

export const MAIL_ENV = {
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

export type FakeMessage = {
  uid: number;
  source: Buffer;
  seen: boolean;
  internalDate: Date;
};

export class FakeImap {
  uidValidity = "1";
  private nextUid = 1;
  inbox: FakeMessage[] = [];
  folders = new Map<string, { uidValidity: string; messages: FakeMessage[] }>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** Runs inside each fetch, before the sources are returned. */
  duringFetch: (() => Promise<void>) | null = null;
  scanError: Error | null = null;

  deliver(
    source: Buffer,
    options: { seen?: boolean; internalDate?: Date } = {},
  ) {
    const uid = this.nextUid++;
    this.inbox.push({
      uid,
      source,
      seen: options.seen ?? false,
      internalDate: options.internalDate ?? new Date(),
    });
    return uid;
  }
  markRead(uid: number) {
    this.inbox.find((m) => m.uid === uid)!.seen = true;
  }
  expunge(uid: number) {
    this.inbox = this.inbox.filter((m) => m.uid !== uid);
  }
  /** Moves a message to `folder` and returns its UID there. */
  move(uid: number, folder: string) {
    const message = this.inbox.find((m) => m.uid === uid)!;
    this.expunge(uid);
    return this.file(folder, message.source, message);
  }
  /** Puts a message into a folder (not the INBOX) and returns its UID there. */
  file(
    folder: string,
    source: Buffer,
    options: { seen?: boolean; internalDate?: Date } = {},
  ) {
    const box = this.folders.get(folder) ?? {
      uidValidity: "77",
      messages: [] as FakeMessage[],
    };
    this.folders.set(folder, box);
    const uid = box.messages.length + 1;
    box.messages.push({
      uid,
      source,
      seen: options.seen ?? false,
      internalDate: options.internalDate ?? new Date(),
    });
    return uid;
  }
  /** Moves a filed message back: a new UID above every earlier one. */
  moveBack(folder: string, uid: number) {
    const box = this.folders.get(folder)!;
    const message = box.messages.find((m) => m.uid === uid)!;
    box.messages = box.messages.filter((m) => m.uid !== uid);
    return this.deliver(message.source, {
      seen: message.seen,
      internalDate: message.internalDate,
    });
  }
  /** The server rebuilt the INBOX: a new UIDVALIDITY, UIDs numbered again. */
  rebuild(uidValidity: string) {
    this.uidValidity = uidValidity;
    this.nextUid = 1;
    for (const message of this.inbox) message.uid = this.nextUid++;
  }
  used(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }
  private sources(found: FakeMessage[], maxBytes: number, dates: boolean) {
    const messages: FetchedMessage[] = found
      .filter((m) => m.source.byteLength <= maxBytes)
      .map((m) => ({
        uid: m.uid,
        source: m.source,
        ...(dates ? { internalDate: m.internalDate } : {}),
      }));
    const skipped = found
      .filter((m) => m.source.byteLength > maxBytes)
      .map((m) => m.uid);
    return { messages, skipped };
  }
  /** The methods every reader has had since before the webmail module. */
  legacyReader(): MailboxReader {
    return {
      verify: async () => undefined,
      scan: async () => {
        this.record("scan", []);
        if (this.scanError) throw this.scanError;
        return {
          uidValidity: this.uidValidity,
          top: this.nextUid - 1,
          unseen: this.inbox.filter((m) => !m.seen).map((m) => m.uid),
        };
      },
      fetchUids: async (uids, maxBytes, ...rest) => {
        this.record("fetchUids", [uids, maxBytes, ...rest]);
        const found = this.inbox.filter((m) => uids.includes(m.uid));
        await this.duringFetch?.();
        return this.sources(
          found,
          maxBytes,
          Boolean(
            (rest[0] as { internalDate?: boolean } | undefined)?.internalDate,
          ),
        );
      },
      fetchNew: async (state, limits, ...rest) => {
        this.record("fetchNew", [state, limits, ...rest]);
        const from = this.uidValidity === state.uidValidity ? state.lastUid : 0;
        const found = this.inbox
          .filter((m) => m.uid > from)
          .slice(0, limits.max);
        await this.duringFetch?.();
        return {
          uidValidity: this.uidValidity,
          ...this.sources(
            found,
            limits.maxBytes,
            Boolean((limits as { internalDate?: boolean }).internalDate),
          ),
        };
      },
      move: async () => "moved" as const,
    };
  }
  /** A reader with the methods the webmail module added. */
  reader(): MailboxReader {
    return {
      ...this.legacyReader(),
      searchSince: async (since) => {
        this.record("searchSince", [since]);
        return this.inbox
          .filter((m) => m.internalDate.getTime() >= since.getTime())
          .map((m) => m.uid);
      },
      fetchFolderMessage: async (ref, maxBytes) => {
        this.record("fetchFolderMessage", [ref, maxBytes]);
        const box =
          ref.folder.toUpperCase() === "INBOX"
            ? { uidValidity: this.uidValidity, messages: this.inbox }
            : this.folders.get(ref.folder);
        if (!box) return null;
        if (box.uidValidity !== ref.uidValidity)
          return "uid_validity_changed" as const;
        const message = box.messages.find((m) => m.uid === ref.uid);
        if (!message) return null;
        if (message.source.byteLength > maxBytes) return "too_large" as const;
        return { source: message.source };
      },
    };
  }
}

export function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  return { objects, store };
}

/** Installs the fake server per mailbox and an SMTP stub into `sent`. */
export function installMail(
  reader: (account: EmailAccount) => MailboxReader,
  sent: OutgoingMail[],
  store: ObjectStore,
) {
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
    mailbox: reader,
  });
}

export type MailProject = {
  scope: Scope;
  connectionId: string;
  run: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>;
  workspaceId: string;
};

export const mailAccount = (address: string) => ({
  smtpHost: "smtp.mailbox.example.com",
  imapHost: "imap.mailbox.example.com",
  username: address,
  fromAddress: address,
  password: "synthetic-mailbox-password",
});

/** A project with one verified mailbox and, when given, enabled modules. */
export async function mailProject(
  name: string,
  address: string,
  modules: string[] = [],
): Promise<MailProject> {
  const workspace = await authDb.workspace.create({ data: { name } });
  const project = await authDb.project.create({
    data: { workspaceId: workspace.id, name },
  });
  const scope: Scope = {
    workspaceId: workspace.id,
    projectId: project.id,
    userId: "owner-setup",
    role: "owner",
  };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const connectionId = await addMailbox({ scope, run } as MailProject, address);
  await run(async (tx) => {
    for (const moduleId of modules)
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
  return { scope, run, connectionId, workspaceId: workspace.id };
}

/** Connects and verifies one more mailbox of the project. */
export async function addMailbox(project: MailProject, address: string) {
  const { scope, run } = project;
  const account = mailAccount(address);
  const connection = await run((tx) => connectEmail(tx, scope, account));
  const checked = await registeredConnectionProvider("email")!.check!(
    { ...connection.data },
    account.password,
  );
  await run(async (tx) => {
    const current = await entity(tx, scope, "connectors", connection.id);
    await update(tx, scope, current, { ...data(current), ...checked });
  });
  return connection.id as string;
}

/** Writes the webmail marker straight onto the row, as setSharedClient would. */
export async function markMailbox(project: MailProject, connectionId: string) {
  const { scope, run } = project;
  await run(async (tx) => {
    const current = await entity(tx, scope, "connectors", connectionId);
    await update(tx, scope, current, {
      ...data(current),
      webmailClient: true,
    });
  });
}

export const inboundRows = (project: MailProject) =>
  project.run((tx) => list(tx, project.scope, "inbound_emails"));

export const stateRow = async (project: MailProject, connectionId: string) => {
  const rows = await project.run((tx) =>
    list(tx, project.scope, "email_inbound_state"),
  );
  return rows.map(data).find((d) => d.connectionId === connectionId) ?? null;
};

export const queuedJobs = async (project: MailProject, topic: string) =>
  (await project.run((tx) => list(tx, project.scope, "jobs"))).filter(
    (j) => data(j).topic === topic,
  );

/** A raw plain-text message; a null Message-ID leaves the header out. */
export function rawMail(
  headers: Record<string, string | null> = {},
  body = "Hello from a customer.",
) {
  const merged: Record<string, string | null> = {
    From: "Anna Customer <anna@example.org>",
    To: "info@desk.example",
    Subject: "A question",
    Date: "Sat, 17 Oct 2026 10:00:00 +0000",
    "Message-ID": `<${randomUUID()}@example.org>`,
    ...headers,
  };
  const lines = Object.entries(merged)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return Buffer.from(
    [...lines, "Content-Type: text/plain; charset=utf-8", "", body, ""].join(
      "\r\n",
    ),
  );
}
