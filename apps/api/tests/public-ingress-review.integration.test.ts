import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { buildServer } from "../src/server.ts";
import { create, credentialKey, encrypt } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { createPublicKey } from "../src/platform/http/public-api.ts";
import {
  fixtureSignature,
  tasksFixture,
} from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const SITE = "https://widget.example.com";
const SECRET = "synthetic-fixture-webhook-secret";
// The web proxy's hop: a private-network peer whose client header is believed.
const PROXY = "10.0.0.2";
let nextClient = 1;
/** A fresh client address behind the proxy, so each test has its own buckets. */
const client = () => `198.51.100.${nextClient++}`;

/**
 * Regression tests of the public ingress security review (2026-10-17):
 * each one failed before its fix (docs/SECURITY_REVIEW.md, findings PI-*).
 */
describe.skipIf(!enabled)("public ingress review", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let publicKey = "";
  let connectionId = "";
  const workspaces: string[] = [];
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const publicCall = (
    method: "GET" | "POST",
    path: string,
    options: {
      from?: string;
      origin?: string;
      token?: string;
      contentType?: string;
      payload?: string;
      url?: string;
    } = {},
  ) =>
    app.inject({
      method,
      url: options.url ?? `/api/public/tasks/${publicKey}${path}`,
      remoteAddress: PROXY,
      headers: {
        origin: options.origin ?? SITE,
        ...(options.from ? { "x-orbit-client-ip": options.from } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(method === "POST"
          ? { "content-type": options.contentType ?? "application/json" }
          : {}),
      },
      ...(method === "POST" ? { payload: options.payload ?? "{}" } : {}),
    });
  const hook = (
    options: {
      from: string;
      connection?: string;
      body?: string;
      signature?: string;
      messageId?: string;
    } = { from: "" },
  ) => {
    const body = options.body ?? JSON.stringify({ title: "From webhook" });
    const messageId = options.messageId ?? randomUUID();
    return app.inject({
      method: "POST",
      url: `/api/hooks/fixture/${scope.workspaceId}/${scope.projectId}/${options.connection ?? connectionId}`,
      remoteAddress: PROXY,
      headers: {
        "content-type": "application/json",
        "x-orbit-client-ip": options.from,
        "x-fixture-message-id": messageId,
        "x-fixture-signature":
          options.signature ?? fixtureSignature(messageId, body, SECRET),
      },
      payload: body,
    });
  };

  beforeAll(async () => {
    app = await buildServer();
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic ingress review" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic ingress review" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    publicKey = (
      await createPublicKey(scope, {
        moduleId: "tasks",
        allowedOrigins: [SITE],
      })
    ).publicKey;
    delete process.env.ORBIT_PUBLIC_INGRESS;
    connectionId = await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "fixture",
        status: "configured",
        encryptedCredential: encrypt(SECRET, credentialKey()),
      }),
    ).then((row) => row.id);
  });
  afterEach(() => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await app?.close();
    await closeDatabase();
  });

  it("PI-1: limits new sessions per browser address, not per proxy hop", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    // 25 visitors behind the web proxy each open one session.
    const visitors: number[] = [];
    for (let i = 0; i < 25; i++)
      visitors.push(
        (await publicCall("POST", "/session", { from: client() })).statusCode,
      );
    expect(visitors).toEqual(Array(25).fill(201));
    // One address is still limited to 20 per minute.
    const from = client();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++)
      codes.push((await publicCall("POST", "/session", { from })).statusCode);
    expect(codes.slice(0, 20).every((code) => code === 201)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });

  it("PI-2: random bearer tokens do not escape the rate limit", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const from = client();
    const codes: number[] = [];
    for (let i = 0; i < 305; i++)
      codes.push(
        (
          await publicCall("GET", "/requests", {
            from,
            token: randomBytes(32).toString("base64url"),
          })
        ).statusCode,
      );
    expect(codes.slice(0, 300).every((code) => code === 401)).toBe(true);
    expect(codes.slice(300).every((code) => code === 429)).toBe(true);
  });

  it("PI-2: a foreign origin cannot flood the audit log", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const from = client();
    for (let i = 0; i < 305; i++)
      await publicCall("GET", "/requests", {
        from,
        origin: "https://evil.example",
        token: randomBytes(32).toString("base64url"),
      });
    const audits = await run((tx) =>
      tx.auditEvent.count({ where: { action: "public.origin_rejected" } }),
    );
    expect(audits).toBeLessThanOrEqual(300);
  });

  it("PI-3: random connection ids do not escape the webhook rate limit", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const from = client();
    const codes: number[] = [];
    for (let i = 0; i < 605; i++)
      codes.push((await hook({ from, connection: randomUUID() })).statusCode);
    expect(codes.slice(0, 600).every((code) => code === 404)).toBe(true);
    expect(codes.slice(600).every((code) => code === 429)).toBe(true);
    // Another address still reaches its connection.
    expect((await hook({ from: client() })).statusCode).toBe(200);
  });

  it("PI-4: the public API takes JSON bodies only", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const { token } = (
      await publicCall("POST", "/session", { from: client() })
    ).json() as { token: string };
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
    ]) {
      const response = await publicCall("POST", "/requests", {
        from: client(),
        token,
        contentType,
        payload: JSON.stringify({ title: "Simple request" }),
      });
      expect(response.statusCode).toBe(415);
    }
  });

  it("PI-5: the public API refuses prototype keys like every other route", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    for (const payload of [
      '{"__proto__":{"polluted":true}}',
      '{"a":{"constructor":{"prototype":{"polluted":true}}}}',
    ]) {
      const response = await publicCall("POST", "/session", {
        from: client(),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("PI-6: an encoded public path is a 404 before its body is parsed while off", async () => {
    // Any client can send the app's own Origin, which skips the exemption.
    const response = await publicCall("POST", "/session", {
      url: `/api/%70ublic/tasks/${publicKey}/session`,
      origin: loadConfig().APP_ORIGIN,
      from: client(),
      payload: "not json",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("PI-7: a captured delivery cannot be replayed under a new message id", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const from = client();
    const body = JSON.stringify({ title: "Captured" });
    const messageId = randomUUID();
    const signature = fixtureSignature(messageId, body, SECRET);
    expect((await hook({ from, body, messageId, signature })).statusCode).toBe(
      200,
    );
    expect(
      (await hook({ from, body, messageId: randomUUID(), signature }))
        .statusCode,
    ).toBe(401);
  });

  it("grants the Origin exemption to the exact ingress paths only (pass)", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const hookBase = `/api/hooks/fixture/${scope.workspaceId}/${scope.projectId}`;
    const keyBase = `/api/public/tasks/${publicKey}`;
    const stored = () =>
      run((tx) => tx.entity.count({ where: { kind: "inbound_webhooks" } }));
    const before = await stored();
    for (const url of [
      `${hookBase}/${connectionId.toUpperCase()}`,
      `${hookBase}/${connectionId}/`,
      `${hookBase}/${connectionId}?x=1`,
      `${hookBase}/%${connectionId.charCodeAt(0).toString(16)}${connectionId.slice(1)}`,
      `/api/hooks/FIXTURE/${scope.workspaceId}/${scope.projectId}/${connectionId}`,
      `${keyBase}/%73ession`,
      `/api/%70ublic/tasks/${publicKey}/session`,
      `${keyBase}/session/../../../../projects/${scope.projectId}/actions/retrieve`,
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        remoteAddress: PROXY,
        headers: {
          "content-type": "application/json",
          "x-orbit-client-ip": client(),
          origin: "https://evil.example",
        },
        payload: "{}",
      });
      expect([url, response.statusCode]).toEqual([url, 403]);
      expect(response.json().error.code).toBe("ORIGIN_REQUIRED");
    }
    expect(await stored()).toBe(before);
  });
});
