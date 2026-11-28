import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../../../../packages/db/src/index.ts";
import { CLIENT_IP_HEADER } from "../../../client-ip.ts";
import {
  createConnection,
  grantConnection,
} from "../../../platform/administration/connections.ts";
import {
  openSecret,
  sealSecret,
} from "../../../platform/connections/secrets.ts";
import { makeAuth } from "../../../platform/tenancy/auth.ts";
import { buildServer } from "../../../server.ts";
import { GOOGLE_SEARCH_CONSOLE_CALLBACK } from "./google-app.ts";
import { GOOGLE_SEARCH_CONSOLE_SCOPE } from "./google-http.ts";
import { googleSearchConsoleOAuthStateCleanup } from "./google-state.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const testApp = {
  clientId: "synthetic-orbit-test.apps.googleusercontent.com",
  clientSecret: "synthetic-orbit-test-client-secret",
};
const testCode = "synthetic-google-oauth-code";
const testRefresh = "synthetic-google-oauth-refresh";
const testAccess = "synthetic-google-oauth-access";
const provider = "google-search-console";
const users = ["owner", "secondOwner", "editor"] as const;
type Member = (typeof users)[number];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!enabled)("Google Search Console OAuth through Orbit", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let foreignWorkspaceId = "";
  let foreignProjectId = "";
  let appConnectionId = "";
  let grantId = "";
  const members = new Map<Member, { id: string; cookie: string }>();
  const origin = () => loadConfig().APP_ORIGIN;
  const projectApi = (project: string) => `/api/projects/${project}/seo`;
  const result = (project: string, state: "connected" | "error") =>
    `/manage/p/${project}/integrations/seo/search-console?connection=${state}`;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const memberId = (who: Member) => members.get(who)!.id;
  const projectScope = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(workspaceId, projectId, work);
  const request = (
    member: Member | null,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(member ? { cookie: members.get(member)!.cookie } : {}),
        origin: origin(),
        [CLIENT_IP_HEADER]: ip(),
      },
      ...(payload ? { payload } : {}),
    });
  const start = (member: Member, project: string, connectionId?: string) =>
    request(
      member,
      "POST",
      `${projectApi(project)}/providers/${provider}/connect`,
      {
        ...(connectionId ? { connectionId } : {}),
      },
    );
  const begin = async (who: Member = "owner", connectionId?: string) => {
    const response = await start(who, projectId, connectionId);
    expect(response.statusCode, response.body).toBe(200);
    const authorize = new URL(response.json().authorizeUrl);
    const state = authorize.searchParams.get("state")!;
    return { authorize, state, response };
  };
  const callback = (member: Member | null, state: string, cancel = false) =>
    request(
      member,
      "GET",
      `${GOOGLE_SEARCH_CONSOLE_CALLBACK}?${new URLSearchParams({
        state,
        ...(cancel ? { error: "access_denied" } : { code: testCode }),
      })}`,
    );
  const accounts = () =>
    authDb.connection.findMany({
      where: {
        workspaceId,
        projectId,
        provider: `seo.account.${provider}`,
        revokedAt: null,
      },
    });
  const stateRow = (state: string) =>
    projectScope((tx) =>
      tx.seoOAuthState.findUniqueOrThrow({ where: { stateHash: sha(state) } }),
    );
  const tokens = (refreshToken = testRefresh) =>
    Response.json({
      access_token: testAccess,
      refresh_token: refreshToken,
      scope: GOOGLE_SEARCH_CONSOLE_SCOPE,
    });

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SEO = "true";
    app = await buildServer();
    for (const who of users) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const { user } = await makeAuth().api.signUpEmail({
        body: { email, password, name: `Synthetic SEO ${who}` },
      });
      members.set(who, { id: user.id, cookie: "" });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: origin(), [CLIENT_IP_HEADER]: ip() },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers["set-cookie"];
      members.get(who)!.cookie = (Array.isArray(cookies) ? cookies : [cookies])
        .map((cookie) => cookie!.split(";")[0])
        .join("; ");
    }

    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic Google OAuth",
          members: {
            create: users.map((who) => ({
              userId: memberId(who),
              role: "viewer",
            })),
          },
        },
      })
    ).id;
    projectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic SEO" },
      })
    ).id;
    await authDb.projectMember.createMany({
      data: users.map((who) => ({
        workspaceId,
        projectId,
        userId: memberId(who),
        role: who === "editor" ? "editor" : "owner",
      })),
    });

    foreignWorkspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic second organization",
          members: { create: { userId: memberId("owner"), role: "owner" } },
        },
      })
    ).id;
    foreignProjectId = (
      await authDb.project.create({
        data: {
          workspaceId: foreignWorkspaceId,
          name: "Synthetic foreign SEO",
        },
      })
    ).id;

    for (const scope of [
      { workspaceId, projectId },
      { workspaceId: foreignWorkspaceId, projectId: foreignProjectId },
    ])
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        tx.projectModule.upsert({
          where: {
            workspaceId_projectId_moduleId: { ...scope, moduleId: "seo" },
          },
          create: {
            ...scope,
            moduleId: "seo",
            enabled: true,
            moduleVersion: "0.1.0",
            changedBy: memberId("owner"),
          },
          update: { enabled: true },
        }),
      );

    const admin = {
      userId: `synthetic-admin-${randomUUID()}`,
      role: "admin" as const,
    };
    const connection = await createConnection(admin, {
      provider: `seo.app.${provider}`,
      label: "Synthetic Google application",
      config: {},
      secret: JSON.stringify(testApp),
    });
    appConnectionId = connection.id;
    const grant = { workspaceId, purposes: ["seo_oauth"], modules: ["seo"] };
    await grantConnection(admin, appConnectionId, grant);
    const projectGrant = await grantConnection(admin, appConnectionId, {
      ...grant,
      projectId,
    });
    grantId = projectGrant.id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (appConnectionId)
      await authDb.connection.deleteMany({ where: { id: appConnectionId } });
    await authDb.workspace.deleteMany({
      where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
    });
    await authDb.user.deleteMany({
      where: { id: { in: [...members.values()].map(({ id }) => id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("requires a project owner and refuses an OAuth app granted only to another organization", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("unexpected outbound call"));
    vi.stubGlobal("fetch", fetchMock);
    expect((await start("editor", projectId)).statusCode).toBe(403);
    const foreign = await start("owner", foreignProjectId);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error.code).toBe("SEO_GOOGLE_APP_NOT_GRANTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the project panel usable when the granted app credential is invalid", async () => {
    const secret = await authDb.connectionSecret.findFirstOrThrow({
      where: { connectionId: appConnectionId, state: "active" },
    });
    const where = { id: secret.id };
    await authDb.connectionSecret.update({
      where,
      data: sealSecret("synthetic incompatible OAuth application data"),
    });
    try {
      const panel = await request("owner", "GET", projectApi(projectId));
      expect(panel.statusCode).toBe(200);
      expect(panel.json().providers).toEqual([
        expect.objectContaining({ id: provider, appReady: false }),
      ]);
      expect((await start("owner", projectId)).json().error.code).toBe(
        "SEO_GOOGLE_APP_INVALID",
      );
    } finally {
      await authDb.connectionSecret.update({
        where,
        data: { ciphertext: secret.ciphertext, keyId: secret.keyId },
      });
    }
  });

  it("binds PKCE state to the same owner and tenant, stores the token in the vault and rejects replay", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokens());
    vi.stubGlobal("fetch", fetchMock);
    const { authorize, state, response } = await begin();
    expect(authorize.origin + authorize.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: testApp.clientId,
      redirect_uri: new URL(GOOGLE_SEARCH_CONSOLE_CALLBACK, origin()).href,
      response_type: "code",
      scope: GOOGLE_SEARCH_CONSOLE_SCOPE,
      access_type: "offline",
      prompt: "consent select_account",
      code_challenge_method: "S256",
    });
    expect(response.body).not.toContain(testApp.clientSecret);

    const stored = await stateRow(state);
    expect(stored).toMatchObject({
      workspaceId,
      projectId,
      userId: memberId("owner"),
      appConnectionId,
      usedAt: null,
    });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
      600_000,
    );
    expect(stored.stateHash).not.toContain(state);

    expect((await callback(null, state)).statusCode).toBe(401);
    expect((await callback("editor", state)).statusCode).toBe(403);
    expect((await callback("secondOwner", state)).headers.location).toBe(
      result(projectId, "error"),
    );
    expect(
      (await callback("owner", state.replace(projectId, foreignProjectId)))
        .headers.location,
    ).toBe(result(foreignProjectId, "error"));
    expect(fetchMock).not.toHaveBeenCalled();

    const finished = await callback("owner", state);
    expect(finished.statusCode).toBe(302);
    expect(finished.headers.location).toBe(result(projectId, "connected"));
    expect(finished.headers["cache-control"]).toBe("no-store");
    expect(finished.body).not.toContain(testAccess);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const verifier = (init.body as URLSearchParams).get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(stored.verifierCiphertext).not.toBe(verifier);
    expect(await stateRow(state)).toMatchObject({
      usedAt: expect.any(Date),
      verifierCiphertext: "",
      verifierKeyId: "",
    });

    const connections = await accounts();
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    const secret = await authDb.connectionSecret.findFirstOrThrow({
      where: { connectionId: connection.id, state: "active" },
    });
    expect(secret.ciphertext).not.toContain(testRefresh);
    expect(JSON.parse(openSecret(secret))).toEqual({
      clientId: testApp.clientId,
      refreshToken: testRefresh,
    });

    const replay = await callback("owner", state);
    expect(replay.headers.location).toBe(result(projectId, "error"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (await start("owner", foreignProjectId, connection.id)).statusCode,
    ).toBe(404);

    const replacement = "synthetic-rotated-refresh-token";
    fetchMock.mockResolvedValue(tokens(replacement));
    const changed = await begin("owner", connection.id);
    expect((await callback("owner", changed.state)).headers.location).toBe(
      result(projectId, "connected"),
    );
    expect((await accounts()).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: connection.id, label: connection.label },
    ]);
    const rotated = await authDb.connectionSecret.findFirstOrThrow({
      where: { connectionId: connection.id, state: "active" },
    });
    expect(rotated.version).toBe(secret.version + 1);
    expect(JSON.parse(openSecret(rotated)).refreshToken).toBe(replacement);

    const disconnected = await request(
      "owner",
      "DELETE",
      `${projectApi(projectId)}/providers/${provider}/connections/${connection.id}`,
    );
    expect(disconnected.statusCode).toBe(204);
    expect(await accounts()).toHaveLength(0);
    const obsolete = await authDb.connectionSecret.findMany({
      where: { connectionId: connection.id },
    });
    expect(obsolete).toHaveLength(2);
    expect(
      obsolete.every(
        ({ ciphertext, keyId }) => ciphertext === "" && keyId === "wiped",
      ),
    ).toBe(true);
  });

  it("consumes cancellation, rejects expired state and never reaches Google for either", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("unexpected outbound call"));
    vi.stubGlobal("fetch", fetchMock);
    const cancelled = await begin();
    expect(
      (await callback("owner", cancelled.state, true)).headers.location,
    ).toBe(result(projectId, "error"));
    expect((await callback("owner", cancelled.state)).headers.location).toBe(
      result(projectId, "error"),
    );
    expect((await stateRow(cancelled.state)).usedAt).toBeInstanceOf(Date);

    const expired = await begin();
    await projectScope((tx) =>
      tx.seoOAuthState.update({
        where: { stateHash: sha(expired.state) },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    expect((await callback("owner", expired.state)).headers.location).toBe(
      result(projectId, "error"),
    );
    await googleSearchConsoleOAuthStateCleanup.run({
      workspaceId,
      projectId,
      userId: "worker",
      role: "owner",
    });
    const expiredAfterSweep = await projectScope((tx) =>
      tx.seoOAuthState.findUnique({ where: { stateHash: sha(expired.state) } }),
    );
    expect(expiredAfterSweep).toBeNull();
    expect((await stateRow(cancelled.state)).usedAt).toBeInstanceOf(Date);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks the current owner and app grant after the token exchange and saves neither lost grant", async () => {
    const memberKey = { projectId, userId: memberId("secondOwner") };
    const owned = await begin("secondOwner");
    const before = await accounts();
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      await authDb.projectMember.update({
        where: { projectId_userId: memberKey },
        data: { role: "editor" },
      });
      return tokens();
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(
        (await callback("secondOwner", owned.state)).headers.location,
      ).toBe(result(projectId, "error"));
      expect(await accounts()).toEqual(before);
      expect((await stateRow(owned.state)).usedAt).toBeInstanceOf(Date);
    } finally {
      await authDb.projectMember.update({
        where: { projectId_userId: memberKey },
        data: { role: "owner" },
      });
    }

    const granted = await begin();
    fetchMock.mockImplementationOnce(async () => {
      await authDb.connectionGrant.update({
        where: { id: grantId },
        data: { revokedAt: new Date() },
      });
      return tokens();
    });
    try {
      expect((await callback("owner", granted.state)).headers.location).toBe(
        result(projectId, "error"),
      );
      expect(await accounts()).toEqual(before);
    } finally {
      await authDb.connectionGrant.update({
        where: { id: grantId },
        data: { revokedAt: null },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
