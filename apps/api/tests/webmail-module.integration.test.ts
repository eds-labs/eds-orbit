import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  scopedRead,
} from "../../../packages/db/src/index.ts";
import type { ServerModule } from "../../../packages/module-contracts/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { buildBridgeApp } from "../src/modules/webmail/bridge.ts";
import { WEBMAIL_BRIDGE_PREFIX } from "../src/modules/webmail/bridge-contract.ts";
import { webmailMailboxUse } from "../src/modules/webmail/mailboxes.ts";
import {
  purgeWebmail,
  webmailRetention,
} from "../src/modules/webmail/maintenance.ts";
import { handleToken, handoffToken } from "../src/modules/webmail/tokens.ts";
import { CONNECTION_KIND } from "../src/platform/connections/connections.ts";
import type {
  EmailImportPrepared,
  EmailImportTarget,
} from "../src/platform/email/import-contract.ts";
import {
  ensureIngested,
  inboundRowForImport,
  mailServerTargets,
  readMailboxMessage,
  setSharedClient,
} from "../src/platform/email/shared-client.ts";
import { permission } from "../src/platform/tenancy/permissions.ts";
import { buildServer } from "../src/server.ts";
import { create, DomainError } from "../src/shared.ts";

// The sync work implements these; here they only have to answer.
vi.mock("../src/platform/email/shared-client.ts", () => ({
  sharedClientActive: vi.fn(() => true),
  setSharedClient: vi.fn(async () => undefined),
  mailServerTargets: vi.fn(),
  ensureIngested: vi.fn(),
  readMailboxMessage: vi.fn(),
  inboundRowForImport: vi.fn(),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const FIXTURE_KIND = "webmail_fixture_records";
const IMPORT = permission("webmailfixture.records.import", "Import a message", [
  "owner",
  "editor",
]);
const targetCalls = {
  active: true,
  // Runs in commit before the record is written, to stage failures.
  beforeCommit: undefined as undefined | (() => void | Promise<void>),
  // Runs after prepare, to stage another attempt taking over.
  afterPrepare: undefined as undefined | (() => Promise<unknown>),
  duplicate: false,
  prepared: [] as EmailImportPrepared[],
  discarded: [] as EmailImportPrepared[],
};
const target: EmailImportTarget = {
  label: { en: "Fixture record", de: "Fixture-Eintrag" },
  permission: IMPORT,
  active: async () => targetCalls.active,
  destinations: async () => [
    {
      id: "inbox-1",
      name: "Inbox",
      address: "support@example.invalid",
      categories: [],
      priorities: [],
    },
  ],
  searchRecords: async (tx, scope, query) => {
    const rows = await tx.entity.findMany({
      where: { projectId: scope.projectId, kind: FIXTURE_KIND },
    });
    return rows
      .filter((row) => row.id === query || query === "")
      .map((row) => ({
        id: row.id,
        number: 7,
        title: "Record",
        status: "open",
      }));
  },
  prepare: async (_scope, message) => {
    const prepared = {
      fileIds: [randomUUID()],
      skippedAttachments: 1,
      payload: { inboundId: message.inboundId },
    };
    targetCalls.prepared.push(prepared);
    await targetCalls.afterPrepare?.();
    return prepared;
  },
  commit: async (tx, scope) => {
    await targetCalls.beforeCommit?.();
    if (targetCalls.duplicate) {
      const existing = await tx.entity.findFirstOrThrow({
        where: { projectId: scope.projectId, kind: FIXTURE_KIND },
      });
      return { recordId: existing.id, number: 7, duplicate: true };
    }
    const row = await create(tx, scope, FIXTURE_KIND, { actor: scope.userId });
    return { recordId: row.id, number: 7, duplicate: false };
  },
  discard: async (_scope, prepared) => {
    targetCalls.discarded.push(prepared);
  },
};
const fixtureModule: ServerModule = {
  id: "webmailfixture",
  version: "1.0.0",
  displayName: { en: "Fixture", de: "Fixture" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [{ kind: FIXTURE_KIND, description: "Test records" }],
  tables: [],
  permissions: [IMPORT],
};
// A receiving module, test only, before the server registers the modules.
registerTestModules([
  { module: fixtureModule, contributions: { emailImport: { record: target } } },
]);
registerModules();

const ENV = {
  ORBIT_WEBMAIL: "true",
  WEBMAIL_ORIGIN: "https://webmail.example.invalid",
  WEBMAIL_BRIDGE_SECRET: "synthetic-bridge-secret",
  EXECUTION_MODE: "live",
  ENABLE_EXTERNAL_WRITES: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_ADMINISTRATION: "true",
};
const TARGET_KEY = "webmailfixture.record";
const FULL = {
  canRead: true,
  canSend: true,
  canOrganize: true,
  canConvert: true,
  canManage: false,
};
const NONE = {
  canRead: false,
  canSend: false,
  canOrganize: false,
  canConvert: false,
  canManage: false,
};
const server = {
  host: "192.0.2.10",
  tlsPeerName: "imap.example.invalid",
  port: 993,
  tlsMode: "ssl" as const,
  user: "user@example.invalid",
  password: "synthetic-mail-password",
};

/** A raw message; the same id, sender and date dedupe across folders. */
const message = (id = `<${randomUUID()}@example.invalid>`, body = "Hello") =>
  Buffer.from(
    [
      ...(id ? [`Message-ID: ${id}`] : []),
      "From: Customer <customer@example.invalid>",
      "To: info@example.invalid",
      "Date: Mon, 02 Nov 2026 10:00:00 +0000",
      "Subject: Question",
      "",
      body,
    ].join("\r\n"),
  );

/**
 * The webmail module (ADR 0026): HTTP routes, bridge and takeover against a
 * real database, with the IMAP side mocked. Three members sign in (the Better
 * Auth limit); the rest get sessions written directly.
 */
describe.skipIf(!enabled)("webmail module", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let bridge: Awaited<ReturnType<typeof buildBridgeApp>>;
  const previous: Record<string, string | undefined> = {};
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "", extra: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  type Who = keyof typeof cookies;
  const call = (
    who: Who,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    project = projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project}/webmail${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const post = (
    path: string,
    payload: object,
    secret = ENV.WEBMAIL_BRIDGE_SECRET,
  ) =>
    bridge.inject({
      method: "POST",
      url: `${WEBMAIL_BRIDGE_PREFIX}${path}`,
      headers: { authorization: `Bearer ${secret}` },
      payload,
    });
  const error = (response: { json(): any }) => response.json().error?.code;
  const refusal = (response: { json(): any }) => response.json().error;
  const ownerScope = (project = projectId): Scope => ({
    workspaceId,
    projectId: project,
    userId: ids.owner,
    role: "owner",
  });

  async function seedMailbox(
    options: {
      owner?: string;
      status?: string;
      project?: string;
      enabled?: boolean;
    } = {},
  ) {
    const project = options.project ?? projectId;
    return scoped(workspaceId, project, async (tx) => {
      const connection = await create(
        tx,
        ownerScope(project),
        CONNECTION_KIND,
        {
          provider: "email",
          status: options.status ?? "read_verified",
          fromAddress: `${randomUUID()}@example.invalid`,
          fromName: "Info",
          ...(options.owner ? { ownerModule: options.owner } : {}),
        },
      );
      const mailbox = await tx.webmailMailbox.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId: project,
          emailConnectionId: connection.id,
          enabled: options.enabled ?? true,
          createdBy: ids.owner,
        },
      });
      return { mailboxId: mailbox.id, connectionId: connection.id };
    });
  }
  const grant = (
    mailboxId: string,
    userId: string,
    flags: Partial<typeof FULL> = FULL,
    project = projectId,
  ) =>
    scoped(workspaceId, project, (tx) =>
      tx.webmailMailboxGrant.create({
        data: {
          workspaceId,
          projectId: project,
          mailboxId,
          userId,
          ...NONE,
          ...flags,
          grantedBy: ids.owner,
        },
      }),
    );
  const sessionRow = (sessionId: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.webmailSession.findUniqueOrThrow({ where: { id: sessionId } }),
    );
  /** A consumed session written directly, for members who do not sign in. */
  async function seedSession(
    mailboxId: string,
    userId: string,
    options: { expiresAt?: Date; auth?: { expiresAt: Date } } = {},
  ) {
    const authSessionId = randomUUID();
    await authDb.session.create({
      data: {
        id: authSessionId,
        token: randomUUID(),
        userId,
        expiresAt: options.auth?.expiresAt ?? new Date(Date.now() + 3600_000),
      },
    });
    const sessionId = randomUUID();
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 3600_000);
    await scoped(workspaceId, projectId, (tx) =>
      tx.webmailSession.create({
        data: {
          id: sessionId,
          workspaceId,
          projectId,
          mailboxId,
          userId,
          authSessionId,
          handoffExpiresAt: new Date(Date.now() - 1000),
          handoffConsumedAt: new Date(),
          expiresAt,
        },
      }),
    );
    return {
      sessionId,
      authSessionId,
      handle: handleToken(
        { workspaceId, projectId, sessionId },
        new Date(Date.now() + 3600_000),
      ),
    };
  }
  /** The whole opening of a session: the Orbit route, then the bridge. */
  async function openAs(who: Who, mailboxId: string) {
    const opened = await call(who, "POST", `/mailboxes/${mailboxId}/session`);
    expect(opened.statusCode).toBe(201);
    const token = opened.json().fields._orbit_handoff as string;
    const consumed = await post("/handoff/consume", { token, origin });
    expect(consumed.statusCode).toBe(200);
    return consumed.json().handle as string;
  }
  const authorize = (handle: string) =>
    post("/session/authorize", { handle, task: "mail", action: "list" });
  const conversions = (mailboxId: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.webmailConversion.findMany({ where: { projectId, mailboxId } }),
    );
  const records = () =>
    scoped(workspaceId, projectId, (tx) =>
      tx.entity.count({ where: { projectId, kind: FIXTURE_KIND } }),
    );
  const audits = (action: string) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({ where: { projectId, action } }),
    );
  const setPaused = (paused: boolean) =>
    scoped(workspaceId, projectId, (tx) =>
      tx.project.update({ where: { id: projectId }, data: { paused } }),
    );

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    app = await buildServer();
    bridge = await buildBridgeApp({ bridgeSecret: ENV.WEBMAIL_BRIDGE_SECRET });
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer", "extra"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic webmail ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic webmail",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
            { userId: ids.extra, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    projectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic webmail" },
      })
    ).id;
    otherProjectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic webmail other" },
      })
    ).id;
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
      ["extra", "editor"],
    ] as const)
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId: ids[who], role },
      });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: {
          workspaceId,
          projectId,
          moduleId: "webmail",
          enabled: true,
          moduleVersion: "1.0.0",
          settings: {},
        },
      }),
    );
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
  });

  beforeEach(() => {
    Object.assign(process.env, ENV);
    vi.mocked(setSharedClient).mockClear();
    vi.mocked(mailServerTargets).mockReset();
    vi.mocked(mailServerTargets).mockResolvedValue({
      imap: server,
      smtp: { ...server, port: 465 },
    });
    vi.mocked(ensureIngested).mockReset();
    vi.mocked(ensureIngested).mockResolvedValue({ status: "ok" });
    vi.mocked(readMailboxMessage).mockReset();
    vi.mocked(inboundRowForImport).mockReset();
    vi.mocked(inboundRowForImport).mockImplementation(async () => ({
      inboundId: randomUUID(),
      fileId: randomUUID(),
    }));
    targetCalls.active = true;
    targetCalls.beforeCommit = undefined;
    targetCalls.afterPrepare = undefined;
    targetCalls.duplicate = false;
    targetCalls.prepared = [];
    targetCalls.discarded = [];
  });

  afterAll(async () => {
    await app?.close();
    await bridge?.close();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    if (workspaceId)
      await authDb.workspace.delete({ where: { id: workspaceId } });
    for (const id of users) await authDb.user.delete({ where: { id } });
    await closeDatabase();
  });

  describe("access through grants", () => {
    it("answers 404 where the module is not enabled in the project", async () => {
      const response = await call(
        "owner",
        "GET",
        "/mailboxes",
        undefined,
        otherProjectId,
      );
      expect(response.statusCode).toBe(404);
      expect(error(response)).toBe("WEBMAIL_DISABLED");
    });

    it("answers 404 for every route of a switched-off installation", async () => {
      process.env.ORBIT_WEBMAIL = "false";
      const response = await call("owner", "GET", "/mailboxes");
      expect(response.statusCode).toBe(404);
      expect(error(response)).toBe("WEBMAIL_DISABLED");
    });

    it("hides a mailbox without a grant behind the same 404", async () => {
      const { mailboxId } = await seedMailbox();
      const [listed, session, options, malformed] = await Promise.all([
        call("editor", "GET", "/mailboxes"),
        call("editor", "POST", `/mailboxes/${mailboxId}/session`),
        call("editor", "GET", `/mailboxes/${mailboxId}/convert/options`),
        call("editor", "POST", `/mailboxes/not-a-uuid/session`),
      ]);
      expect(
        listed.json().mailboxes.map((m: { id: string }) => m.id),
      ).not.toContain(mailboxId);
      for (const response of [session, options, malformed]) {
        expect(response.statusCode).toBe(404);
        expect(error(response)).toBe("WEBMAIL_MAILBOX_NOT_FOUND");
      }
    });

    it("gives a project owner nothing without a grant, until they grant themselves", async () => {
      const { mailboxId } = await seedMailbox();
      const listed = await call("owner", "GET", "/mailboxes");
      expect(
        listed.json().mailboxes.map((m: { id: string }) => m.id),
      ).not.toContain(mailboxId);
      const denied = await call(
        "owner",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      expect(denied.statusCode).toBe(404);
      const self = await call(
        "owner",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${ids.owner}`,
        {
          ...NONE,
          canRead: true,
        },
      );
      expect(self.statusCode).toBe(200);
      const granted = await call(
        "owner",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      expect(granted.statusCode).toBe(201);
      expect(
        (await audits("webmail.grant.changed")).some(
          (row) =>
            row.resourceId === mailboxId &&
            (row.metadata as { self: boolean }).self === true,
        ),
      ).toBe(true);
    });

    it("does not reach another project's mailbox through this project", async () => {
      await scoped(workspaceId, otherProjectId, (tx) =>
        tx.projectModule.upsert({
          where: {
            workspaceId_projectId_moduleId: {
              workspaceId,
              projectId: otherProjectId,
              moduleId: "webmail",
            },
          },
          create: {
            workspaceId,
            projectId: otherProjectId,
            moduleId: "webmail",
            enabled: true,
            moduleVersion: "1.0.0",
            settings: {},
          },
          update: {},
        }),
      );
      const foreign = await seedMailbox({ project: otherProjectId });
      await grant(foreign.mailboxId, ids.owner, FULL, otherProjectId);
      const response = await call(
        "owner",
        "POST",
        `/mailboxes/${foreign.mailboxId}/session`,
      );
      expect(response.statusCode).toBe(404);
      expect(error(response)).toBe("WEBMAIL_MAILBOX_NOT_FOUND");
    });

    it("counts send, organize and convert only together with read", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, {
        canSend: true,
        canOrganize: true,
        canConvert: true,
        canManage: true,
      });
      const listed = await call("editor", "GET", "/mailboxes");
      const entry = listed
        .json()
        .mailboxes.find((m: { id: string }) => m.id === mailboxId);
      expect(entry.capabilities).toEqual({
        read: false,
        send: false,
        organize: false,
        convert: false,
        manage: true,
      });
      for (const response of await Promise.all([
        call("editor", "POST", `/mailboxes/${mailboxId}/session`),
        call("editor", "GET", `/mailboxes/${mailboxId}/convert/options`),
      ]))
        expect(response.statusCode).toBe(404);
    });

    it("lets canManage administer grants without reading mail, but not its own", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canManage: true });
      const members = await call(
        "editor",
        "GET",
        `/mailboxes/${mailboxId}/grants`,
      );
      expect(members.statusCode).toBe(200);
      expect(
        members.json().members.map((m: { userId: string }) => m.userId),
      ).toEqual(expect.arrayContaining([ids.owner, ids.viewer]));
      const changed = await call(
        "editor",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${ids.viewer}`,
        { ...NONE, canRead: true },
      );
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        userId: ids.viewer,
        canRead: true,
      });
      const self = await call(
        "editor",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${ids.editor}`,
        { ...NONE, canRead: true, canManage: true },
      );
      expect(self.statusCode).toBe(403);
      expect(error(self)).toBe("WEBMAIL_SELF_GRANT_FORBIDDEN");
    });

    it("keeps settings to owners", async () => {
      expect((await call("editor", "GET", "/settings")).statusCode).toBe(403);
      expect((await call("owner", "GET", "/settings")).statusCode).toBe(200);
    });

    it("refuses a grant for someone outside the project, and removes all-false rows", async () => {
      const { mailboxId } = await seedMailbox();
      const stranger = await call(
        "owner",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${randomUUID()}`,
        { ...NONE, canRead: true },
      );
      expect(stranger.statusCode).toBe(404);
      await grant(mailboxId, ids.viewer, { canRead: true });
      const removed = await call(
        "owner",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${ids.viewer}`,
        NONE,
      );
      expect(removed.statusCode).toBe(200);
      const left = await scoped(workspaceId, projectId, (tx) =>
        tx.webmailMailboxGrant.count({
          where: { projectId, mailboxId, userId: ids.viewer },
        }),
      );
      expect(left).toBe(0);
    });

    it("refuses unknown grant fields (strict bodies)", async () => {
      const { mailboxId } = await seedMailbox();
      const response = await call(
        "owner",
        "PUT",
        `/mailboxes/${mailboxId}/grants/${ids.viewer}`,
        { ...NONE, canRead: true, owner: true },
      );
      expect(response.statusCode).toBe(400);
    });
  });

  describe("a mailbox another module owns", () => {
    it("needs finance.settings on top of the grant, and hides it otherwise", async () => {
      const { mailboxId } = await seedMailbox({ owner: "finance" });
      await grant(mailboxId, ids.editor);
      await grant(mailboxId, ids.owner);
      const listed = await call("editor", "GET", "/mailboxes");
      expect(
        listed.json().mailboxes.map((m: { id: string }) => m.id),
      ).not.toContain(mailboxId);
      const denied = await call(
        "editor",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      expect(denied.statusCode).toBe(404);
      expect(
        (await call("owner", "POST", `/mailboxes/${mailboxId}/session`))
          .statusCode,
      ).toBe(201);
    });

    it("stops an open session the moment the mailbox becomes Finance's", async () => {
      const { mailboxId, connectionId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      expect((await authorize(handle)).statusCode).toBe(200);
      await scoped(workspaceId, projectId, (tx) =>
        tx.entity.update({
          where: { id: connectionId },
          data: {
            data: {
              provider: "email",
              status: "read_verified",
              fromAddress: "x@example.invalid",
              ownerModule: "finance",
            },
          },
        }),
      );
      const refused = await authorize(handle);
      expect(refused.statusCode).toBe(403);
      expect(refusal(refused)).toBe("not_authorized");
    });

    it("always marks an opened Finance mailbox sensitive", async () => {
      const connectionId = await scoped(
        workspaceId,
        projectId,
        async (tx) =>
          (
            await create(tx, ownerScope(), CONNECTION_KIND, {
              provider: "email",
              status: "read_verified",
              fromAddress: `${randomUUID()}@example.invalid`,
              ownerModule: "finance",
            })
          ).id,
      );
      const opened = await call("owner", "POST", "/settings/mailboxes", {
        connectionId,
        sensitive: false,
      });
      expect(opened.statusCode).toBe(201);
      expect(opened.json().sensitive).toBe(true);
      expect(vi.mocked(setSharedClient)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        connectionId,
        true,
      );
    });
  });

  describe("mailbox lifecycle", () => {
    it("clears the marker and revokes sessions when a mailbox is disabled", async () => {
      const { mailboxId, connectionId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle, sessionId } = await seedSession(mailboxId, ids.editor);
      const patched = await call(
        "owner",
        "PATCH",
        `/settings/mailboxes/${mailboxId}`,
        {
          version: 1,
          enabled: false,
        },
      );
      expect(patched.statusCode).toBe(200);
      expect(vi.mocked(setSharedClient)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        connectionId,
        false,
      );
      expect((await sessionRow(sessionId)).revokedAt).not.toBeNull();
      expect(refusal(await authorize(handle))).toBe("session_revoked");
    });

    it("refuses a stale version", async () => {
      const { mailboxId } = await seedMailbox();
      const stale = await call(
        "owner",
        "PATCH",
        `/settings/mailboxes/${mailboxId}`,
        {
          version: 9,
          enabled: false,
        },
      );
      expect(stale.statusCode).toBe(409);
      expect(error(stale)).toBe("VERSION_CONFLICT");
    });

    it("closes a mailbox for good, taking its sessions along", async () => {
      const { mailboxId, connectionId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      const deleted = await call(
        "owner",
        "DELETE",
        `/settings/mailboxes/${mailboxId}`,
      );
      expect(deleted.statusCode).toBe(204);
      expect(vi.mocked(setSharedClient)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        connectionId,
        false,
      );
      expect(refusal(await authorize(handle))).toBe("session_unknown");
      expect(await audits("webmail.mailbox.closed")).not.toHaveLength(0);
    });

    it("lets the connection go when it is removed, and never blocks that", async () => {
      const { mailboxId, connectionId } = await seedMailbox();
      await scoped(workspaceId, projectId, async (tx) => {
        expect(
          await webmailMailboxUse.inUse(tx, ownerScope(), connectionId),
        ).toBe(0);
        expect(
          await webmailMailboxUse.receivesMail!(tx, ownerScope(), connectionId),
        ).toBe(false);
        await webmailMailboxUse.release(tx, ownerScope(), connectionId);
      });
      expect(vi.mocked(setSharedClient)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        connectionId,
        false,
      );
      const left = await scoped(workspaceId, projectId, (tx) =>
        tx.webmailMailbox.count({ where: { id: mailboxId } }),
      );
      expect(left).toBe(0);
    });

    it("lists a mailbox with its state and origin", async () => {
      const { mailboxId } = await seedMailbox({ status: "configured" });
      await grant(mailboxId, ids.editor, { canRead: true });
      const listed = (await call("editor", "GET", "/mailboxes")).json();
      expect(listed.origin).toBe(ENV.WEBMAIL_ORIGIN);
      expect(
        listed.mailboxes.find((m: { id: string }) => m.id === mailboxId),
      ).toMatchObject({
        status: "error",
        sync: "ok",
        lastError: "CONNECTION_NOT_VERIFIED",
      });
    });
  });

  describe("bridge", () => {
    it("is closed without the bearer secret, before reading a body", async () => {
      const wrong = await post("/session/end", {}, "wrong-secret");
      expect(wrong.statusCode).toBe(401);
      expect(refusal(wrong)).toBe("unauthorized");
      const health = await bridge.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
    });

    it("refuses unknown fields", async () => {
      const response = await post("/session/end", {
        handle: "x",
        reason: "logout",
        extra: true,
      });
      expect(response.statusCode).toBe(400);
    });

    it("consumes a handoff exactly once", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const opened = await call(
        "editor",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      expect(opened.json()).toMatchObject({
        action: `${ENV.WEBMAIL_ORIGIN}/`,
        fields: { _task: "login", _action: "login" },
      });
      const token = opened.json().fields._orbit_handoff;
      const first = await post("/handoff/consume", { token, origin });
      expect(first.statusCode).toBe(200);
      expect(first.json().user).toBe(`mb-${mailboxId}@orbit.invalid`);
      const replay = await post("/handoff/consume", { token, origin });
      expect(replay.statusCode).toBe(410);
      expect(refusal(replay)).toBe("token_consumed");
    });

    it("consumes once under concurrency", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const opened = await call(
        "editor",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      const token = opened.json().fields._orbit_handoff;
      const answers = await Promise.all(
        [1, 2, 3].map(() => post("/handoff/consume", { token, origin })),
      );
      expect(answers.filter((a) => a.statusCode === 200)).toHaveLength(1);
    });

    it("keeps the handoff when the Origin is wrong", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const opened = await call(
        "editor",
        "POST",
        `/mailboxes/${mailboxId}/session`,
      );
      const token = opened.json().fields._orbit_handoff;
      const evil = await post("/handoff/consume", {
        token,
        origin: "https://evil.example.invalid",
      });
      expect(evil.statusCode).toBe(403);
      expect(refusal(evil)).toBe("origin_mismatch");
      expect(
        (await post("/handoff/consume", { token, origin })).statusCode,
      ).toBe(200);
    });

    it("refuses a forged and an expired handoff", async () => {
      const claims = { workspaceId, projectId, sessionId: randomUUID() };
      const genuine = handoffToken(claims, new Date(Date.now() + 60_000));
      const forged = await post("/handoff/consume", {
        token: `${genuine.slice(0, -2)}xy`,
        origin,
      });
      expect(forged.statusCode).toBe(410);
      expect(refusal(forged)).toBe("token_invalid");
      const expired = await post("/handoff/consume", {
        token: handoffToken(claims, new Date(Date.now() - 1000)),
        origin,
      });
      expect(refusal(expired)).toBe("token_expired");
      const unknown = await post("/handoff/consume", {
        token: genuine,
        origin,
      });
      expect(refusal(unknown)).toBe("token_invalid");
    });

    it("authorizes with the grant's capabilities and this request's servers", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true, canSend: true });
      const handle = await openAs("editor", mailboxId);
      const answer = await authorize(handle);
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({
        ok: true,
        capabilities: ["read", "send"],
        displayName: "Info",
        imap: { host: server.host, password: server.password },
        smtp: { port: 465 },
      });
    });

    it("drops send, organize and convert while the project is paused", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      await setPaused(true);
      try {
        expect((await authorize(handle)).json().capabilities).toEqual(["read"]);
      } finally {
        await setPaused(false);
      }
      expect((await authorize(handle)).json().capabilities).toEqual([
        "read",
        "send",
        "organize",
        "convert",
      ]);
    });

    it("drops them without live sending", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      process.env.EXECUTION_MODE = "test";
      expect((await authorize(handle)).json().capabilities).toEqual(["read"]);
    });

    it("refuses a forged and an unknown handle", async () => {
      const forged = await authorize("aaa.bbb.ccc");
      expect(forged.statusCode).toBe(401);
      expect(refusal(forged)).toBe("session_unknown");
      const unknown = await authorize(
        handleToken(
          { workspaceId, projectId, sessionId: randomUUID() },
          new Date(Date.now() + 60_000),
        ),
      );
      expect(refusal(unknown)).toBe("session_unknown");
    });

    it("refuses an expired session", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor, {
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(refusal(await authorize(handle))).toBe("session_expired");
    });

    it("ends with a Better Auth logout", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle, authSessionId } = await seedSession(
        mailboxId,
        ids.editor,
      );
      expect((await authorize(handle)).statusCode).toBe(200);
      await authDb.session.delete({ where: { id: authSessionId } });
      expect(refusal(await authorize(handle))).toBe("session_revoked");
    });

    it("refuses a banned user and an expired login", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.extra);
      const stale = await seedSession(mailboxId, ids.extra, {
        auth: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(refusal(await authorize(stale.handle))).toBe("session_revoked");
      const live = await seedSession(mailboxId, ids.extra);
      await authDb.user.update({
        where: { id: ids.extra },
        data: { banned: true },
      });
      try {
        expect(refusal(await authorize(live.handle))).toBe("session_revoked");
      } finally {
        await authDb.user.update({
          where: { id: ids.extra },
          data: { banned: false },
        });
      }
    });

    it("ends at once when the grant is removed", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      expect((await authorize(handle)).statusCode).toBe(200);
      expect(
        (
          await call(
            "owner",
            "PUT",
            `/mailboxes/${mailboxId}/grants/${ids.editor}`,
            NONE,
          )
        ).statusCode,
      ).toBe(200);
      expect(refusal(await authorize(handle))).toBe("session_revoked");
    });

    it("refuses a session whose grant row is gone, even unrevoked", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      await scoped(workspaceId, projectId, (tx) =>
        tx.webmailMailboxGrant.deleteMany({ where: { projectId, mailboxId } }),
      );
      const refused = await authorize(handle);
      expect(refused.statusCode).toBe(403);
      expect(refusal(refused)).toBe("not_authorized");
    });

    it("stops when the module is switched off for the project", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      const toggle = (value: boolean) =>
        scoped(workspaceId, projectId, (tx) =>
          tx.projectModule.update({
            where: {
              workspaceId_projectId_moduleId: {
                workspaceId,
                projectId,
                moduleId: "webmail",
              },
            },
            data: { enabled: value },
          }),
        );
      await toggle(false);
      try {
        expect(refusal(await authorize(handle))).toBe("not_authorized");
      } finally {
        await toggle(true);
      }
    });

    it("stops for a member with no role in the webmail module", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.extra);
      const { handle } = await seedSession(mailboxId, ids.extra);
      const key = { projectId, userId: ids.extra, moduleId: "webmail" };
      await authDb.projectMemberModuleRole.create({
        data: { ...key, workspaceId, role: "none", changedBy: ids.owner },
      });
      try {
        expect(refusal(await authorize(handle))).toBe("not_authorized");
      } finally {
        await authDb.projectMemberModuleRole.delete({
          where: { projectId_userId_moduleId: key },
        });
      }
    });

    it("refuses a disabled mailbox and an unverified connection", async () => {
      const disabled = await seedMailbox({ enabled: false });
      await grant(disabled.mailboxId, ids.editor);
      const one = await seedSession(disabled.mailboxId, ids.editor);
      const refused = await authorize(one.handle);
      expect(refused.statusCode).toBe(409);
      expect(refusal(refused)).toBe("mailbox_unavailable");
      const unverified = await seedMailbox({ status: "configured" });
      await grant(unverified.mailboxId, ids.editor);
      const two = await seedSession(unverified.mailboxId, ids.editor);
      expect(refusal(await authorize(two.handle))).toBe("mailbox_unavailable");
    });

    it("refuses when the mail servers cannot be vetted", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const { handle } = await seedSession(mailboxId, ids.editor);
      vi.mocked(mailServerTargets).mockRejectedValue(new Error("private host"));
      const refused = await authorize(handle);
      expect(refusal(refused)).toBe("mailbox_unavailable");
      expect(refused.body).not.toContain("private host");
    });

    it("revokes the member's earlier session when a new one opens", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const first = await openAs("editor", mailboxId);
      const second = await openAs("editor", mailboxId);
      expect(refusal(await authorize(first))).toBe("session_revoked");
      expect((await authorize(second)).statusCode).toBe(200);
    });

    it("ends the session on logout and through the Orbit route", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const handle = await openAs("editor", mailboxId);
      expect(
        (await post("/session/end", { handle, reason: "logout" })).statusCode,
      ).toBe(200);
      expect(refusal(await authorize(handle))).toBe("session_revoked");
      const again = await openAs("editor", mailboxId);
      expect(
        (await call("editor", "DELETE", `/mailboxes/${mailboxId}/session`))
          .statusCode,
      ).toBe(204);
      expect(refusal(await authorize(again))).toBe("session_revoked");
    });

    it("writes lastSeenAt at most once a minute", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const { handle, sessionId } = await seedSession(mailboxId, ids.editor);
      await authorize(handle);
      await vi.waitFor(async () =>
        expect((await sessionRow(sessionId)).lastSeenAt).not.toBeNull(),
      );
      const first = (await sessionRow(sessionId)).lastSeenAt!;
      await authorize(handle);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await sessionRow(sessionId)).lastSeenAt).toEqual(first);
    });

    it("authorizes while a writer holds the project lock", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const { handle } = await seedSession(mailboxId, ids.editor);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const writer = scoped(workspaceId, projectId, async () => {
        locked();
        await gate;
      });
      await holding;
      try {
        expect((await authorize(handle)).statusCode).toBe(200);
      } finally {
        release();
        await writer;
      }
    });

    it("reads under row-level security and cannot write", async () => {
      const here = await seedMailbox();
      const foreign = await seedMailbox({ project: otherProjectId });
      await scopedRead(workspaceId, projectId, async (tx) => {
        const rows = await tx.webmailMailbox.findMany({
          where: { id: { in: [here.mailboxId, foreign.mailboxId] } },
        });
        expect(rows.map((row) => row.id)).toEqual([here.mailboxId]);
      });
      await expect(
        scopedRead(workspaceId, projectId, (tx) =>
          tx.webmailMailbox.deleteMany({ where: { id: here.mailboxId } }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("barrier", () => {
    const barrier = (handle: string, folder: string, selection: object) =>
      post("/session/barrier", {
        handle,
        operation: "move",
        folder,
        selection,
      });
    async function organizer() {
      const { mailboxId, connectionId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true, canOrganize: true });
      const { handle } = await seedSession(mailboxId, ids.editor);
      return { handle, connectionId };
    }

    it("needs organize", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const { handle } = await seedSession(mailboxId, ids.editor);
      const refused = await barrier(handle, "INBOX", { type: "all" });
      expect(refused.statusCode).toBe(403);
      expect(refusal(refused)).toBe("not_authorized");
      expect(vi.mocked(ensureIngested)).not.toHaveBeenCalled();
    });

    it.each(["INBOX", "inbox", "InBox", ""])(
      "ingests the selection of the INBOX (folder %j)",
      async (folder) => {
        const { handle, connectionId } = await organizer();
        const answer = await barrier(handle, folder, {
          type: "uids",
          uids: ["12", "14:15"],
        });
        expect(answer.json()).toEqual({ status: "ok" });
        expect(vi.mocked(ensureIngested)).toHaveBeenCalledWith(
          expect.objectContaining({ projectId, userId: ids.editor }),
          connectionId,
          { uids: [12, 14, 15] },
          expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
      },
    );

    it("answers other folders at once", async () => {
      const { handle } = await organizer();
      expect(
        (await barrier(handle, "Archive", { type: "all" })).json(),
      ).toEqual({ status: "ok" });
      expect(vi.mocked(ensureIngested)).not.toHaveBeenCalled();
    });

    it("passes a whole-folder selection through", async () => {
      const { handle, connectionId } = await organizer();
      await barrier(handle, "INBOX", { type: "all" });
      expect(vi.mocked(ensureIngested)).toHaveBeenCalledWith(
        expect.anything(),
        connectionId,
        { all: true },
        expect.anything(),
      );
    });

    it("refuses when ingesting fails or throws (fail closed)", async () => {
      const { handle } = await organizer();
      vi.mocked(ensureIngested).mockResolvedValueOnce({
        status: "retry",
        reason: "locked",
      });
      expect((await barrier(handle, "INBOX", { type: "all" })).json()).toEqual({
        status: "retry",
        reason: "locked",
      });
      vi.mocked(ensureIngested).mockRejectedValueOnce(new Error("imap down"));
      const failed = await barrier(handle, "INBOX", { type: "all" });
      expect(failed.json()).toEqual({
        status: "retry",
        reason: "ingest_failed",
      });
      expect(failed.body).not.toContain("imap down");
    });

    it("refuses a selection too large to vet", async () => {
      const { handle } = await organizer();
      const answer = await barrier(handle, "INBOX", {
        type: "uids",
        uids: ["1:4294967295"],
      });
      expect(answer.json()).toEqual({
        status: "retry",
        reason: "selection_too_large",
      });
      expect(vi.mocked(ensureIngested)).not.toHaveBeenCalled();
    });

    it("refuses a uid outside the 32-bit range", async () => {
      const { handle } = await organizer();
      const answer = await barrier(handle, "INBOX", {
        type: "uids",
        uids: ["4294967296"],
      });
      expect(answer.json().status).toBe("retry");
      expect(vi.mocked(ensureIngested)).not.toHaveBeenCalled();
    });

    it("refuses while the project is paused, as organize is dropped", async () => {
      const { handle } = await organizer();
      await setPaused(true);
      try {
        const refused = await barrier(handle, "INBOX", { type: "all" });
        expect(refusal(refused)).toBe("not_authorized");
      } finally {
        await setPaused(false);
      }
    });
  });

  describe("takeover", () => {
    const uidValidity = 777;
    const body = (uid = 41, extra: object = {}) => ({
      folder: "INBOX",
      uid,
      uidValidity,
      target: TARGET_KEY,
      mode: { kind: "create", destinationId: "inbox-1" },
      ...extra,
    });
    async function converter(who: "editor" | "owner" = "editor") {
      const { mailboxId, connectionId } = await seedMailbox();
      await grant(mailboxId, ids[who]);
      vi.mocked(readMailboxMessage).mockResolvedValue({ source: message() });
      return { mailboxId, connectionId };
    }
    const convert = (who: Who, mailboxId: string, payload: object = body()) =>
      call(who, "POST", `/mailboxes/${mailboxId}/convert`, payload);

    it("creates one record, reading only from the route's mailbox", async () => {
      const { mailboxId, connectionId } = await converter();
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({
        status: "done",
        target: TARGET_KEY,
        number: 7,
        duplicate: false,
        skippedAttachments: 1,
      });
      expect(vi.mocked(readMailboxMessage)).toHaveBeenCalledWith(
        expect.objectContaining({ projectId }),
        connectionId,
        { folder: "INBOX", uid: 41, uidValidity: "777" },
        expect.any(Number),
      );
      const [row] = await conversions(mailboxId);
      expect(row).toMatchObject({ status: "done", mode: "create" });
      expect(await audits("webmail.conversion.done")).not.toHaveLength(0);
    });

    it("returns the record again, flagged duplicate, on a repeat", async () => {
      const { mailboxId } = await converter();
      const before = await records();
      const first = await convert("editor", mailboxId);
      const second = await convert("editor", mailboxId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        recordId: first.json().recordId,
        duplicate: true,
        skippedAttachments: 0,
      });
      expect(await records()).toBe(before + 1);
    });

    it("recognizes the message after it moved folders", async () => {
      const { mailboxId } = await converter();
      await convert("editor", mailboxId);
      const moved = await convert(
        "editor",
        mailboxId,
        body(99, { folder: "Archive" }),
      );
      expect(moved.json().duplicate).toBe(true);
    });

    it("hashes the raw message when it has no Message-ID", async () => {
      const { mailboxId } = await converter();
      vi.mocked(readMailboxMessage).mockResolvedValue({
        source: message("", "first"),
      });
      await convert("editor", mailboxId);
      vi.mocked(readMailboxMessage).mockResolvedValue({
        source: message("", "second"),
      });
      const other = await convert("editor", mailboxId, body(42));
      expect(other.json().duplicate).toBe(false);
      vi.mocked(readMailboxMessage).mockResolvedValue({
        source: message("", "first"),
      });
      const same = await convert("editor", mailboxId, body(43));
      expect(same.json().duplicate).toBe(true);
    });

    it("yields one record under concurrent requests", async () => {
      const { mailboxId } = await converter();
      const before = await records();
      const answers = await Promise.all(
        [1, 2, 3, 4].map(() => convert("editor", mailboxId)),
      );
      expect(await records()).toBe(before + 1);
      expect(
        answers.filter((a) => a.statusCode === 200 && !a.json().duplicate),
      ).toHaveLength(1);
      for (const answer of answers)
        expect([200, 202]).toContain(answer.statusCode);
      expect(await conversions(mailboxId)).toHaveLength(1);
    });

    /** A claim another attempt left behind, as a crash after the claim would. */
    async function strandedClaim(
      mailboxId: string,
      leaseUntil: Date,
      source: Buffer,
    ) {
      const { dedupeKeyOf } = await import("../src/modules/webmail/convert.ts");
      vi.mocked(readMailboxMessage).mockResolvedValue({ source });
      await scoped(workspaceId, projectId, (tx) =>
        tx.webmailConversion.create({
          data: {
            id: randomUUID(),
            workspaceId,
            projectId,
            mailboxId,
            dedupeKey: "",
            attemptId: randomUUID(),
            leaseUntil,
            mode: "create",
            target: TARGET_KEY,
            folder: "INBOX",
            uid: 41,
            uidValidity: "777",
            actorId: ids.editor,
          },
        }),
      );
      const key = await dedupeKeyOf(source);
      await scoped(workspaceId, projectId, (tx) =>
        tx.webmailConversion.updateMany({
          where: { projectId, mailboxId, dedupeKey: "" },
          data: { dedupeKey: key },
        }),
      );
    }

    it("answers pending while another attempt holds the lease", async () => {
      const { mailboxId } = await converter();
      await strandedClaim(mailboxId, new Date(Date.now() + 60_000), message());
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(202);
      expect(answer.json()).toEqual({ status: "pending" });
      expect(targetCalls.prepared).toHaveLength(0);
    });

    it("recovers a crash between claim and commit once the lease ran out", async () => {
      const { mailboxId } = await converter();
      const before = await records();
      await strandedClaim(mailboxId, new Date(Date.now() - 1000), message());
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(200);
      expect(answer.json().duplicate).toBe(false);
      expect(await records()).toBe(before + 1);
      expect(await conversions(mailboxId)).toHaveLength(1);
    });

    it("discards the files and frees the message when the commit fails", async () => {
      const { mailboxId } = await converter();
      const before = await records();
      targetCalls.beforeCommit = () => {
        throw new DomainError("SYNTHETIC_COMMIT_FAILED", 409);
      };
      const failed = await convert("editor", mailboxId);
      expect(failed.statusCode).toBe(409);
      expect(error(failed)).toBe("SYNTHETIC_COMMIT_FAILED");
      expect(targetCalls.discarded).toEqual(targetCalls.prepared);
      expect(await records()).toBe(before);
      const [row] = await conversions(mailboxId);
      expect(row).toMatchObject({
        status: "failed",
        errorCode: "SYNTHETIC_COMMIT_FAILED",
      });
      targetCalls.beforeCommit = undefined;
      const retried = await convert("editor", mailboxId);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().duplicate).toBe(false);
    });

    it("discards the files of an attempt that lost its lease", async () => {
      const { mailboxId } = await converter();
      const before = await records();
      targetCalls.afterPrepare = () =>
        scoped(workspaceId, projectId, (tx) =>
          tx.webmailConversion.updateMany({
            where: { projectId, mailboxId },
            data: { attemptId: randomUUID() },
          }),
        );
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(202);
      expect(targetCalls.discarded).toHaveLength(1);
      expect(await records()).toBe(before);
    });

    it("discards the files when the target already has the message", async () => {
      const { mailboxId } = await converter();
      await scoped(workspaceId, projectId, (tx) =>
        create(tx, ownerScope(), FIXTURE_KIND, {}),
      );
      targetCalls.duplicate = true;
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(200);
      expect(answer.json().duplicate).toBe(true);
      expect(targetCalls.discarded).toHaveLength(1);
    });

    it("answers 404 for a uid that is not in the mailbox", async () => {
      const { mailboxId } = await converter();
      vi.mocked(readMailboxMessage).mockResolvedValue(null);
      const answer = await convert("editor", mailboxId, body(999));
      expect(answer.statusCode).toBe(404);
      expect(error(answer)).toBe("WEBMAIL_MESSAGE_NOT_FOUND");
      expect(await conversions(mailboxId)).toHaveLength(0);
    });

    it("answers 404 for a mailbox without a convert grant", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor, { canRead: true });
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(404);
      expect(error(answer)).toBe("WEBMAIL_MAILBOX_NOT_FOUND");
      expect(vi.mocked(readMailboxMessage)).not.toHaveBeenCalled();
    });

    it("refuses a message over the limit", async () => {
      const { mailboxId } = await converter();
      vi.mocked(readMailboxMessage).mockResolvedValue({
        source: Buffer.alloc(10 * 1024 * 1024 + 1),
      });
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(413);
      expect(error(answer)).toBe("WEBMAIL_MESSAGE_TOO_LARGE");
    });

    it("passes on a changed UIDVALIDITY", async () => {
      const { mailboxId } = await converter();
      vi.mocked(readMailboxMessage).mockRejectedValue(
        new DomainError("WEBMAIL_UID_VALIDITY_CHANGED", 409),
      );
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(409);
      expect(error(answer)).toBe("WEBMAIL_UID_VALIDITY_CHANGED");
    });

    it("reports a broken mailbox without its detail", async () => {
      const { mailboxId } = await converter();
      vi.mocked(readMailboxMessage).mockRejectedValue(
        new Error("imap.internal.example refused"),
      );
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(409);
      expect(error(answer)).toBe("WEBMAIL_MAILBOX_UNAVAILABLE");
      expect(answer.body).not.toContain("imap.internal");
    });

    it("refuses content the client tries to supply", async () => {
      const { mailboxId } = await converter();
      const answer = await convert(
        "editor",
        mailboxId,
        body(41, { subject: "forged", source: "forged" }),
      );
      expect(answer.statusCode).toBe(400);
      expect(vi.mocked(readMailboxMessage)).not.toHaveBeenCalled();
    });

    it("answers 401 to a caller without a session, whatever the body", async () => {
      const { mailboxId } = await converter();
      const answer = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/webmail/mailboxes/${mailboxId}/convert`,
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
      });
      expect(answer.statusCode).toBe(401);
    });

    it("refuses an unknown target", async () => {
      const { mailboxId } = await converter();
      const answer = await convert(
        "editor",
        mailboxId,
        body(41, { target: "nowhere.none" }),
      );
      expect(answer.statusCode).toBe(404);
      expect(error(answer)).toBe("WEBMAIL_TARGET_UNAVAILABLE");
    });

    it("refuses while the target module is inactive", async () => {
      const { mailboxId } = await converter();
      targetCalls.active = false;
      const answer = await convert("editor", mailboxId);
      expect(answer.statusCode).toBe(404);
      expect(error(answer)).toBe("WEBMAIL_TARGET_UNAVAILABLE");
      expect(
        (
          await call("editor", "GET", `/mailboxes/${mailboxId}/convert/options`)
        ).json(),
      ).toEqual({ targets: [] });
    });

    it("does not let a webmail role become a role in the receiving module", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.viewer);
      vi.mocked(readMailboxMessage).mockResolvedValue({ source: message() });
      const key = { projectId, userId: ids.viewer, moduleId: "webmail" };
      await authDb.projectMemberModuleRole.create({
        data: { ...key, workspaceId, role: "editor", changedBy: ids.owner },
      });
      try {
        const answer = await convert("viewer", mailboxId);
        expect(answer.statusCode).toBe(403);
        expect(error(answer)).toBe("FORBIDDEN");
        expect(vi.mocked(readMailboxMessage)).not.toHaveBeenCalled();
        expect(
          (
            await call(
              "viewer",
              "GET",
              `/mailboxes/${mailboxId}/convert/options`,
            )
          ).json(),
        ).toEqual({ targets: [] });
      } finally {
        await authDb.projectMemberModuleRole.delete({
          where: { projectId_userId_moduleId: key },
        });
      }
    });

    it("refuses while the project is paused", async () => {
      const { mailboxId } = await converter();
      await setPaused(true);
      try {
        const answer = await convert("editor", mailboxId);
        expect(answer.statusCode).toBe(409);
        expect(error(answer)).toBe("WEBMAIL_MAILBOX_UNAVAILABLE");
      } finally {
        await setPaused(false);
      }
    });

    it("lists targets, finds records and reports status", async () => {
      const { mailboxId } = await converter();
      const options = await call(
        "editor",
        "GET",
        `/mailboxes/${mailboxId}/convert/options`,
      );
      expect(options.json().targets[0]).toMatchObject({
        key: TARGET_KEY,
        label: target.label,
      });
      const query = `?folder=INBOX&uid=41&uidValidity=${uidValidity}`;
      expect(
        (
          await call(
            "editor",
            "GET",
            `/mailboxes/${mailboxId}/convert/status${query}`,
          )
        ).json(),
      ).toEqual({ converted: false });
      const done = await convert("editor", mailboxId);
      expect(
        (
          await call(
            "editor",
            "GET",
            `/mailboxes/${mailboxId}/convert/status${query}`,
          )
        ).json(),
      ).toEqual({
        converted: true,
        target: TARGET_KEY,
        recordId: done.json().recordId,
        number: 7,
      });
      const found = await call(
        "editor",
        "GET",
        `/mailboxes/${mailboxId}/convert/records?target=${TARGET_KEY}&q=`,
      );
      expect(found.statusCode).toBe(200);
      expect(found.json().records.length).toBeGreaterThan(0);
    });
  });

  describe("housekeeping", () => {
    it("purges finished sessions and keeps live ones", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.editor);
      const stale = await seedSession(mailboxId, ids.editor, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const live = await seedSession(mailboxId, ids.editor);
      await purgeWebmail(ownerScope());
      const left = await scoped(workspaceId, projectId, (tx) =>
        tx.webmailSession.findMany({
          where: { id: { in: [stale.sessionId, live.sessionId] } },
        }),
      );
      expect(left.map((row) => row.id)).toEqual([live.sessionId]);
    });

    it("removes the grants of members who lost the project", async () => {
      const { mailboxId } = await seedMailbox();
      await grant(mailboxId, ids.extra);
      const { sessionId } = await seedSession(mailboxId, ids.extra);
      const key = { projectId_userId: { projectId, userId: ids.extra } };
      const member = await authDb.projectMember.delete({ where: key });
      try {
        const { grants } = await purgeWebmail(ownerScope());
        expect(grants).toBeGreaterThan(0);
        const left = await scoped(workspaceId, projectId, (tx) =>
          tx.webmailMailboxGrant.count({
            where: { projectId, mailboxId, userId: ids.extra },
          }),
        );
        expect(left).toBe(0);
        expect((await sessionRow(sessionId)).revokedAt).not.toBeNull();
      } finally {
        await authDb.projectMember.create({ data: member });
      }
    });

    it("covers conversions in retention", async () => {
      const { mailboxId } = await seedMailbox();
      const old = randomUUID();
      await scoped(workspaceId, projectId, async (tx) => {
        await tx.webmailConversion.create({
          data: {
            id: old,
            workspaceId,
            projectId,
            mailboxId,
            dedupeKey: randomUUID(),
            attemptId: randomUUID(),
            leaseUntil: new Date(),
            mode: "create",
            target: TARGET_KEY,
            folder: "INBOX",
            uid: 1,
            uidValidity: "1",
            actorId: ids.owner,
          },
        });
        await tx.$executeRaw`UPDATE "WebmailConversion" SET "updatedAt" = now() - interval '40 days' WHERE id = ${old}::uuid`;
        const at = new Date();
        const result = await webmailRetention(tx, ownerScope(), {
          cutoff: new Date(at.getTime() - 30 * 86_400_000),
          at,
        });
        expect(result.result.webmailConversions).toBe(1);
      });
    });
  });

  describe("installation status", () => {
    const status = (who: Who) =>
      app.inject({
        method: "GET",
        url: "/api/admin/webmail/status",
        headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      });

    it("reports to system administrators only, even with webmail off", async () => {
      await authDb.user.update({
        where: { id: ids.owner },
        data: { role: "admin" },
      });
      try {
        expect((await status("editor")).statusCode).toBe(404);
        process.env.ORBIT_WEBMAIL = "false";
        const off = await status("owner");
        expect(off.statusCode).toBe(200);
        expect(off.json()).toEqual({
          enabled: false,
          originConfigured: true,
          bridge: "off",
        });
        process.env.ORBIT_WEBMAIL = "true";
        const on = (await status("owner")).json();
        expect(on.enabled).toBe(true);
        expect(["ok", "unreachable"]).toContain(on.bridge);
      } finally {
        await authDb.user.update({
          where: { id: ids.owner },
          data: { role: "user" },
        });
      }
    });
  });
});
