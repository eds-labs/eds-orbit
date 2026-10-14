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
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { data, entity } from "../src/shared.ts";
import { decryptCredential } from "../src/platform/connections/connections.ts";

// The provider clients as the connection checks create them: no network.
const mocked = vi.hoisted(() => ({
  clients: [] as Array<{ provider: string; options: any }>,
  groups: "ok" as "ok" | "missing",
}));
vi.mock("../../../packages/connectors/src/index.ts", async (original) => {
  const actual =
    await original<
      typeof import("../../../packages/connectors/src/index.ts")
    >();
  return {
    ...actual,
    createPostizClient: (options: any) => {
      mocked.clients.push({ provider: "postiz", options });
      return {
        baseUrl: actual.normalizePostizBaseUrl(options.baseUrl),
        capabilities: actual.postizCapabilities,
        listIntegrations: async () => [
          { id: "ch-1", name: "Synthetic X", identifier: "x", disabled: false },
        ],
        listGroups: async () => {
          if (mocked.groups === "missing")
            throw new actual.ConnectorError(
              "PROVIDER_NOT_FOUND",
              "not_sent",
              false,
              404,
            );
          return [{ id: "g-1", name: "Synthetic group" }];
        },
      };
    },
    createMatomoClient: (options: any) => {
      mocked.clients.push({ provider: "matomo", options });
      return {
        capabilities: { report: true },
        report: async () => [],
      };
    },
  };
});

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const CREDENTIAL = "synthetic-credential-0123456789";

/**
 * Connections (WP2.5c): the platform creates, encrypts and checks them; the
 * provider a module contributes normalizes its fields and runs the check.
 * Characterizes the `connector` and `connector-health` actions.
 */
describe.skipIf(!enabled)("Connections", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let cookie = "";
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const action = (name: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${scope.projectId}/actions/${name}`,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload,
    });
  const connect = (payload: object) =>
    action("connector", { credential: CREDENTIAL, ...payload });
  const stored = (id: string) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) =>
      data(await entity(tx, scope, "connectors", id)),
    );

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic connections owner", password },
    });
    users.push(created.user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic connections",
        members: { create: { userId: created.user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set])
      .map((v) => v!.split(";")[0])
      .join("; ");
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      payload: { name: "Synthetic connections", workspaceId: workspace.id },
    });
    expect(project.statusCode).toBe(201);
    scope = {
      workspaceId: workspace.id,
      projectId: project.json().id,
      userId: created.user.id,
      role: "owner",
    };
  });
  beforeEach(() => {
    mocked.clients.length = 0;
    mocked.groups = "ok";
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("stores a new connection encrypted and never returns the credential", async () => {
    const response = await connect({
      provider: "postiz",
      baseUrl: "https://postiz.example.invalid/public/v1/",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(CREDENTIAL);
    expect(response.body).not.toContain("encryptedCredential");
    const body = response.json();
    expect(body.data).toEqual({
      provider: "postiz",
      // Normalized by the Postiz provider.
      baseUrl: "https://postiz.example.invalid/api/public/v1",
      status: "configured",
      capabilities: [],
    });
    const row = await stored(body.id);
    expect(row.encryptedCredential).not.toContain(CREDENTIAL);
    expect(decryptCredential(row)).toBe(CREDENTIAL);
  });

  it("refuses an unknown provider and a non-HTTPS address", async () => {
    const unknown = await connect({ provider: "github" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("VALIDATION_FAILED");
    const http = await connect({
      provider: "matomo",
      baseUrl: "http://matomo.example.invalid",
      siteId: "3",
    });
    expect(http.statusCode).toBe(400);
    expect(http.json().error.code).toBe("HTTPS_REQUIRED");
  });

  it("checks Postiz with the stored credential and records channels and groups", async () => {
    const id = (
      await connect({
        provider: "postiz",
        baseUrl: "https://postiz.example.invalid",
      })
    ).json().id;
    mocked.groups = "missing";
    const checked = await action("connector-health", { connectorId: id });
    expect(checked.statusCode).toBe(200);
    expect(checked.body).not.toContain(CREDENTIAL);
    expect(mocked.clients).toEqual([
      {
        provider: "postiz",
        options: {
          baseUrl: "https://postiz.example.invalid/api/public/v1",
          token: CREDENTIAL,
        },
      },
    ]);
    expect(await stored(id)).toMatchObject({
      status: "read_verified",
      channels: [{ id: "ch-1", name: "Synthetic X" }],
      // A Postiz without groups (404) is fine.
      groups: [],
      baseUrl: "https://postiz.example.invalid/api/public/v1",
      connection: { connected: true, provider: "postiz", channelCount: 1 },
      verifiedAt: expect.any(String),
      lastSuccessfulConnection: expect.any(String),
    });
  });

  it("checks Matomo for its site and refuses a Slack check", async () => {
    const matomo = (
      await connect({
        provider: "matomo",
        baseUrl: "https://matomo.example.invalid",
        siteId: "3",
      })
    ).json().id;
    const checked = await action("connector-health", { connectorId: matomo });
    expect(checked.statusCode).toBe(200);
    expect(mocked.clients[0]!.options).toEqual({
      baseUrl: "https://matomo.example.invalid",
      token: CREDENTIAL,
      allowedSiteIds: [3],
    });
    expect(await stored(matomo)).toMatchObject({
      status: "read_verified",
      capabilities: { report: true },
    });

    const slack = (await connect({ provider: "slack", channelId: "C1" })).json()
      .id;
    const refused = await action("connector-health", { connectorId: slack });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe(
      "SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION",
    );
    expect((await stored(slack)).status).toBe("configured");
  });

  it("blocks the connections of a module that is off (WP2.4)", async () => {
    const id = (
      await connect({
        provider: "postiz",
        baseUrl: "https://postiz.example.invalid",
      })
    ).json().id;
    process.env.ORBIT_MODULES = "true";
    try {
      const off = await app.inject({
        method: "PUT",
        url: `/api/projects/${scope.projectId}/modules/marketing`,
        headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(200);
      for (const response of [
        await connect({ provider: "slack", channelId: "C1" }),
        await action("connector-health", { connectorId: id }),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("MODULE_DISABLED");
      }
      expect(mocked.clients).toEqual([]);
    } finally {
      await app.inject({
        method: "PUT",
        url: `/api/projects/${scope.projectId}/modules/marketing`,
        headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
        payload: { enabled: true },
      });
      delete process.env.ORBIT_MODULES;
    }
  });
});
