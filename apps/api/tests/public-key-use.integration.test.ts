import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { revokePublicKey } from "../src/platform/http/public-api.ts";
import { registeredPublicKeyUses } from "../src/platform/modules/contributions.ts";
import { createInbox, updateInbox } from "../src/modules/support/inboxes.ts";
import { enableWidgetKey } from "../src/modules/support/widget.ts";
import { verifiedMailbox } from "./fixtures/mailbox.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const SITE = "https://desk.example.invalid";

/**
 * Revoking a public key releases the module that used it (F-5): a Support
 * inbox whose widget key is revoked on the public keys page lets go of it
 * in the same project transaction, and the keys list names the user.
 */
describe.skipIf(!enabled)("public key uses (F-5)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let foreign: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${owner.projectId}${url}`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const widgetSession = (publicKey: string) =>
    app.inject({
      method: "POST",
      url: `/api/public/support/${publicKey}/session`,
      headers: { origin: SITE, [CLIENT_IP_HEADER]: ip() },
    });
  const enableSupport = (scope: Scope) =>
    scoped(scope.workspaceId, scope.projectId, (tx) =>
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
  const newInbox = (scope: Scope, name: string) =>
    scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) =>
        (
          await createInbox(tx, scope, {
            name,
            channels: ["widget"],
            allowedOrigins: [SITE],
          })
        ).inbox.id,
    );
  /** A widget inbox of the signed-in owner's project with a key from its route. */
  const widgetInbox = async (name: string) => {
    const inboxId = await newInbox(owner, name);
    const response = await call(
      "POST",
      `/support/inboxes/${inboxId}/widget-key`,
    );
    expect(response.statusCode).toBe(200);
    const { keyId, publicKey } = response.json() as {
      keyId: string;
      publicKey: string;
    };
    return { inboxId, keyId, publicKey };
  };
  const pointer = (scope: Scope, inboxId: string) =>
    scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) =>
        (await tx.supportInbox.findUniqueOrThrow({ where: { id: inboxId } }))
          .publicClientKeyId,
    );
  const key = (id: string) =>
    authDb.publicClientKey.findUniqueOrThrow({ where: { id } });
  const audits = (scope: Scope, action: string) =>
    scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { projectId: scope.projectId, action },
        orderBy: { createdAt: "asc" },
      }),
    );

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_PUBLIC_INGRESS: "true",
    });
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic key owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic public key uses",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic public key uses" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: created.user.id,
      role: "owner",
    };
    // A second project the signed-in owner is no member of.
    const other = await authDb.workspace.create({
      data: { name: "Synthetic foreign key uses" },
    });
    workspaces.push(other.id);
    const otherProject = await authDb.project.create({
      data: { workspaceId: other.id, name: "Synthetic foreign key uses" },
    });
    foreign = {
      workspaceId: other.id,
      projectId: otherProject.id,
      userId: "owner-setup",
      role: "owner",
    };
    await enableSupport(owner);
    await enableSupport(foreign);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((v) => v!.split(";")[0])
      .join("; ");
  });
  afterEach(() => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_PUBLIC_INGRESS: "true",
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_PUBLIC_INGRESS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("clears the inbox's key when the key is revoked on the public keys route", async () => {
    const { inboxId, keyId, publicKey } = await widgetInbox("Desk app");
    expect((await widgetSession(publicKey)).statusCode).toBe(201);

    const revoked = await call("POST", `/public-keys/${keyId}/revoke`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).not.toBeNull();

    const listed = await call("GET", "/support/inboxes");
    expect(listed.statusCode).toBe(200);
    const inbox = (listed.json().items as any[]).find((i) => i.id === inboxId);
    expect(inbox.publicClientKeyId).toBeNull();
    expect((await widgetSession(publicKey)).statusCode).toBe(404);

    const keyAudits = (await audits(owner, "public_key.revoked")).filter(
      (a) => a.resourceId === keyId,
    );
    const released = (
      await audits(owner, "support.inbox.widget_key_released")
    ).filter((a) => a.resourceId === inboxId);
    expect(keyAudits).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(released[0]!.metadata).toEqual({ inboxId });
    for (const entry of [...keyAudits, ...released])
      expect(JSON.stringify(entry)).not.toContain(publicKey);
  });

  it("says which inbox uses a key", async () => {
    const { keyId } = await widgetInbox("Help center");
    const unused = await call("POST", "/public-keys", {
      moduleId: "support",
      allowedOrigins: [SITE],
    });
    expect(unused.statusCode).toBe(201);
    const unusedId = unused.json().id as string;
    const { keyId: revokedId } = await widgetInbox("Old site");
    expect(
      (await call("POST", `/public-keys/${revokedId}/revoke`)).statusCode,
    ).toBe(200);

    const listed = await call("GET", "/public-keys");
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as any[];
    const item = (id: string) => items.find((i) => i.id === id);
    expect(item(keyId).usedBy).toEqual({
      moduleId: "support",
      label: "Help center",
    });
    expect(item(unusedId).usedBy).toBeNull();
    expect(item(revokedId).usedBy).toBeNull();
    // Only the existing fields and usedBy: never a secret.
    expect(Object.keys(item(keyId)).sort()).toEqual(
      [
        "allowedOrigins",
        "createdAt",
        "id",
        "moduleId",
        "publicKey",
        "revokedAt",
        "usedBy",
      ].sort(),
    );
  });

  it("heals an inbox that still points at a revoked key", async () => {
    const { inboxId, keyId } = await widgetInbox("Stale widget");
    // The state F-5 left behind: revoked, still referenced.
    const at = new Date(Date.now() - 60_000);
    await authDb.publicClientKey.update({
      where: { id: keyId },
      data: { revokedAt: at },
    });
    expect(await pointer(owner, inboxId)).toBe(keyId);

    const again = await call("POST", `/public-keys/${keyId}/revoke`);
    expect(again.statusCode).toBe(200);
    expect(await pointer(owner, inboxId)).toBeNull();
    expect((await key(keyId)).revokedAt?.getTime()).toBe(at.getTime());
  });

  it("leaves other projects alone", async () => {
    const foreignInbox = await newInbox(foreign, "Foreign desk");
    const { keyId } = await enableWidgetKey(foreign, foreignInbox);

    const response = await call("POST", `/public-keys/${keyId}/revoke`);
    expect(response.statusCode).toBe(404);
    expect(await pointer(foreign, foreignInbox)).toBe(keyId);
    expect((await key(keyId)).revokedAt).toBeNull();
    expect(
      (await audits(foreign, "support.inbox.widget_key_released")).length,
    ).toBe(0);
  });

  it("revokes nothing when a release fails", async () => {
    const { inboxId, keyId } = await widgetInbox("Fragile widget");
    const before = (await audits(owner, "public_key.revoked")).length;
    // Support's real release runs first, then one that fails.
    const uses = [
      ...registeredPublicKeyUses(),
      {
        owner: "synthetic",
        usedBy: async () => null,
        release: async () => {
          throw new Error("synthetic release failure");
        },
      },
    ];

    await expect(
      revokePublicKey(owner, keyId, undefined, uses),
    ).rejects.toThrow("synthetic release failure");
    expect((await key(keyId)).revokedAt).toBeNull();
    expect(await pointer(owner, inboxId)).toBe(keyId);
    expect((await audits(owner, "public_key.revoked")).length).toBe(before);
    expect(
      (await audits(owner, "support.inbox.widget_key_released")).filter(
        (a) => a.resourceId === inboxId,
      ),
    ).toHaveLength(0);
  });

  it("keeps the inbox's own key change working", async () => {
    const { inboxId, keyId: first } = await widgetInbox("Rotating widget");
    const count = async (action: string) =>
      (await audits(owner, action)).filter(
        (a) => a.resourceId === inboxId || a.resourceId === first,
      ).length;
    const before = {
      widgetKey: await count("support.inbox.widget_key"),
      released: await count("support.inbox.widget_key_released"),
      revoked: await count("public_key.revoked"),
    };

    const response = await call(
      "POST",
      `/support/inboxes/${inboxId}/widget-key`,
    );
    expect(response.statusCode).toBe(200);
    const second = response.json().keyId as string;
    expect(second).not.toBe(first);
    expect(await pointer(owner, inboxId)).toBe(second);
    expect((await key(first)).revokedAt).not.toBeNull();
    expect((await key(second)).revokedAt).toBeNull();
    expect(await count("support.inbox.widget_key")).toBe(before.widgetKey + 1);
    expect(await count("support.inbox.widget_key_released")).toBe(
      before.released,
    );
    expect(await count("public_key.revoked")).toBe(before.revoked + 1);
  });

  it("keeps removing the widget channel working", async () => {
    const { inboxId, keyId } = await widgetInbox("Retired widget");
    const version = await scoped(
      owner.workspaceId,
      owner.projectId,
      async (tx) =>
        (await tx.supportInbox.findUniqueOrThrow({ where: { id: inboxId } }))
          .version,
    );

    // The inbox moves to the e-mail channel only: its widget key goes.
    await scoped(owner.workspaceId, owner.projectId, async (tx) =>
      updateInbox(tx, owner, inboxId, {
        version,
        channels: ["email"],
        emailConnectionId: await verifiedMailbox(
          tx,
          owner,
          `retired-${randomUUID()}@example.invalid`,
        ),
        allowedOrigins: [],
      }),
    );

    expect(await pointer(owner, inboxId)).toBeNull();
    expect((await key(keyId)).revokedAt).not.toBeNull();
    expect(
      (await audits(owner, "public_key.revoked")).filter(
        (a) => a.resourceId === keyId,
      ),
    ).toHaveLength(1);
    expect(
      (await audits(owner, "support.inbox.widget_key_released")).filter(
        (a) => a.resourceId === inboxId,
      ),
    ).toHaveLength(0);
  });
});
