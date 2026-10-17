import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../src/platform/mcp-auth/plugins.ts";
import { recordSelection } from "../src/platform/mcp-auth/grants.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  cimdFetchFor,
  clientIp,
  createFlowDriver,
  ISSUER,
  jwtPayload,
  metadata,
  origin,
  pkce,
  queryOf,
  REDIRECT_URI,
  SCOPES,
  withFlags as baseWithFlags,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M1, Task 4: workspace/project grants and the consent flow
// (authorize -> /connect selection -> consent -> code -> token) through the
// real Fastify app with ORBIT_MCP_OAUTH=true. CIMD clients are served
// in-process through the `cimdFetch` seam; nothing leaves the process.
// Tests run in order and share one session (sign-in is limited per file).

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const CLIENT_ID = "https://client.test/client.json";
const OTHER_CLIENT_ID = "https://client.test/other.json";
const DENY_CLIENT_ID = "https://client.test/deny.json";
const EXPIRED_CLIENT_ID = "https://client.test/expired.json";
const TWO_SESSIONS_CLIENT_ID = "https://client.test/two-sessions.json";
const FAILED_CONSENT_CLIENT_ID = "https://client.test/failed-consent.json";
const REFUSAL_CLIENT_ID = "https://client.test/refusal.json";
const CLAIMS_CLIENT_ID = "https://client.test/claims.json";
const PKJWT_CLIENT_ID = "https://client.test/pkjwt.json";

/** ES256 key pair with the public half as a JWK for the CIMD document. */
function es256Key(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "ES256",
    use: "sig",
  };
  return { privateKey, jwk };
}
const clientKey = es256Key("client-key");
const wrongKey = es256Key("client-key");

const documents: Record<string, Json> = {
  [CLIENT_ID]: metadata(CLIENT_ID),
  [OTHER_CLIENT_ID]: metadata(OTHER_CLIENT_ID),
  [DENY_CLIENT_ID]: metadata(DENY_CLIENT_ID),
  [EXPIRED_CLIENT_ID]: metadata(EXPIRED_CLIENT_ID),
  [TWO_SESSIONS_CLIENT_ID]: metadata(TWO_SESSIONS_CLIENT_ID),
  [FAILED_CONSENT_CLIENT_ID]: metadata(FAILED_CONSENT_CLIENT_ID),
  [REFUSAL_CLIENT_ID]: metadata(REFUSAL_CLIENT_ID),
  [CLAIMS_CLIENT_ID]: metadata(CLAIMS_CLIENT_ID),
  [PKJWT_CLIENT_ID]: metadata(PKJWT_CLIENT_ID, {
    token_endpoint_auth_method: "private_key_jwt",
    jwks: { keys: [clientKey.jwk] },
  }),
};
const cimdFetch = cimdFetchFor(documents);
const withFlags = (flags: Parameters<typeof baseWithFlags>[0]) =>
  baseWithFlags(flags, cimdFetch);

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A private_key_jwt client assertion (RFC 7523) signed with ES256. */
function clientAssertion(clientId: string, key: KeyObject) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url({ alg: "ES256", kid: "client-key", typ: "JWT" })}.${b64url(
    {
      iss: clientId,
      sub: clientId,
      aud: `${ISSUER}/oauth2/token`,
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
    },
  )}`;
  const signature = createSign("SHA256")
    .update(input)
    .sign({ key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${input}.${signature}`;
}

describe.skipIf(!enabled)("MCP grants and consent, flag off", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    ({ app } = await withFlags({ ORBIT_MCP_OAUTH: "false" }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("the connect routes do not exist while the flag is off", async () => {
    for (const [method, url] of [
      ["GET", "/api/mcp-connect/request?client_id=x"],
      ["POST", "/api/mcp-connect/selection"],
      ["POST", "/api/mcp-connect/consent"],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: { origin },
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(r.statusCode).toBe(404);
    }
  });
});

describe.skipIf(!enabled)("MCP grants and consent, flag on", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let config: ReturnType<typeof loadConfig>;
  let cookie: string;
  /** A second session of the same user. */
  let secondCookie: string;
  let userId: string;
  let sessionId: string;
  let workspaceId: string, emptyWorkspaceId: string, foreignWorkspaceId: string;
  let projectA: string, projectB: string, foreignProject: string;
  const users: string[] = [];
  const workspaces: string[] = [];
  const clientIds = [
    CLIENT_ID,
    OTHER_CLIENT_ID,
    DENY_CLIENT_ID,
    EXPIRED_CLIENT_ID,
    TWO_SESSIONS_CLIENT_ID,
    FAILED_CONSENT_CLIENT_ID,
    REFUSAL_CLIENT_ID,
    CLAIMS_CLIENT_ID,
    PKJWT_CLIENT_ID,
  ];

  const driver = createFlowDriver({
    app: () => app,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({ workspaceId, projectIds: [projectA] }),
    defaultClientId: CLIENT_ID,
  });
  const { inject, authorize, select, consent, connect, exchange, refresh } =
    driver;

  /** Runs `fn` as the user's second session. */
  async function inSecondSession<T>(fn: () => Promise<T>) {
    const first = cookie;
    cookie = secondCookie;
    try {
      return await fn();
    } finally {
      cookie = first;
    }
  }

  const grants = (clientId = CLIENT_ID) =>
    authDb.mcpGrant.findMany({
      where: { userId, clientId },
      orderBy: { createdAt: "asc" },
    });
  const events = (clientId = CLIENT_ID) =>
    authDb.mcpGrantEvent.findMany({
      where: { userId, clientId },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    let auth: ReturnType<typeof makeAuth>;
    ({ app, auth, config } = await withFlags({
      ORBIT_MCP_OAUTH: "true",
      ORBIT_MCP_CIMD_HOSTS: "client.test",
    }));
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const created = await auth.api.signUpEmail({
      body: { email, name: "Synthetic MCP flow user", password },
    });
    userId = created.user.id;
    users.push(userId);
    const stranger = await auth.api.signUpEmail({
      body: {
        email: `${randomUUID()}@example.invalid`,
        name: "Synthetic MCP stranger",
        password,
      },
    });
    users.push(stranger.user.id);

    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP workspace",
        members: { create: { userId, role: "owner" } },
        projects: {
          create: [{ name: "Synthetic A" }, { name: "Synthetic B" }],
        },
      },
      include: { projects: true },
    });
    workspaceId = workspace.id;
    projectA = workspace.projects.find((p) => p.name === "Synthetic A")!.id;
    projectB = workspace.projects.find((p) => p.name === "Synthetic B")!.id;
    // A workspace the user belongs to, with a project the user is not in.
    const empty = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP empty workspace",
        members: { create: { userId, role: "viewer" } },
        projects: { create: { name: "Synthetic hidden" } },
      },
    });
    emptyWorkspaceId = empty.id;
    const foreign = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP foreign workspace",
        members: { create: { userId: stranger.user.id, role: "owner" } },
        projects: { create: { name: "Synthetic foreign" } },
      },
      include: { projects: true },
    });
    foreignWorkspaceId = foreign.id;
    foreignProject = foreign.projects[0]!.id;
    workspaces.push(workspaceId, emptyWorkspaceId, foreignWorkspaceId);

    const signIn = async () => {
      const r = await inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers["set-cookie"];
      return (Array.isArray(set) ? set : [set!])
        .map((v) => v.split(";")[0])
        .join("; ");
    };
    secondCookie = await signIn();
    cookie = await signIn();
    const session = await inject({ url: "/api/auth/get-session" });
    sessionId = session.json().session.id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await authDb.mcpGrantEvent.deleteMany({ where: { userId: { in: users } } });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await app?.close();
    await closeDatabase();
  });

  let firstFlowTokens: Json;

  it("full flow issues an audience-bound token", async () => {
    const flow = await connect();
    expect(flow.steps).toEqual(["select", "consent", "redirect_uri"]);
    expect(`${flow.final.origin}${flow.final.pathname}`).toBe(REDIRECT_URI);
    expect(flow.final.searchParams.get("code")).toBeTruthy();
    expect(flow.final.searchParams.get("state")).toBe("st-1");
    expect(flow.final.searchParams.get("iss")).toBe(ISSUER);

    const token = await exchange(flow);
    expect(token.statusCode).toBe(200);
    firstFlowTokens = token.json();
    expect(firstFlowTokens.refresh_token).toBeTruthy();
    const access = jwtPayload(firstFlowTokens.access_token);
    expect(access.aud).toContain(config.MCP_RESOURCE);
    expect(access.exp - access.iat).toBe(600);
    expect(access[ORBIT_WORKSPACE_CLAIM]).toBe(workspaceId);
    expect(access.azp).toBe(CLIENT_ID);
    expect(access.iss).toBe(ISSUER);

    const rows = await grants();
    const active = rows.filter((g) => g.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      workspaceId,
      projectIds: [projectA],
      allCurrentProjects: false,
      scopes: SCOPES.split(" "),
      expiresAt: null,
    });
    expect(active[0]!.activatedAt).toBeInstanceOf(Date);
    // Issuing the code consumed the selection: it no longer belongs to the session.
    expect(active[0]!.sessionId).toBeNull();
    const actions = (await events()).filter((e) => e.grantId === active[0]!.id);
    expect(actions.map((e) => e.action)).toEqual([
      "grant.selected",
      "grant.activated",
    ]);
    // Events never carry token material.
    const serialized = JSON.stringify(await events());
    expect(serialized).not.toContain(firstFlowTokens.refresh_token);
    expect(serialized).not.toContain(flow.final.searchParams.get("code")!);
  });

  it("the request route describes the client, the scopes and the user's workspaces", async () => {
    const { location } = await authorize();
    const r = await inject({
      url: `/api/mcp-connect/request?${queryOf(location!)}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.client).toEqual({
      id: CLIENT_ID,
      name: "Synthetic /client.json",
      uri: "https://client.test",
    });
    expect(body.scopes).toEqual(SCOPES.split(" "));
    const mine = body.workspaces.find((w: Json) => w.id === workspaceId);
    expect(mine.role).toBe("owner");
    expect(mine.projects.map((p: Json) => p.id).sort()).toEqual(
      [projectA, projectB].sort(),
    );
    const empty = body.workspaces.find((w: Json) => w.id === emptyWorkspaceId);
    expect(empty.projects).toEqual([]);
    expect(
      body.workspaces.find((w: Json) => w.id === foreignWorkspaceId),
    ).toBeUndefined();
  });

  it("UserInfo returns sub, email and email_verified", async () => {
    const r = await inject({
      url: "/api/auth/oauth2/userinfo",
      session: false,
      headers: { authorization: `Bearer ${firstFlowTokens.access_token}` },
    });
    expect(r.statusCode).toBe(200);
    const info = r.json();
    expect(info.sub).toBe(userId);
    expect(info.email).toMatch(/@example\.invalid$/);
    expect(info.email_verified).toBe(false);
  });

  it("a new client always reaches the consent step", async () => {
    const client = await authDb.oauthClient.findUnique({
      where: { clientId: OTHER_CLIENT_ID },
    });
    expect(client).toBeNull();
    const flow = await connect({ clientId: OTHER_CLIENT_ID });
    expect(flow.steps).toEqual(["select", "consent", "redirect_uri"]);
    const stored = await authDb.oauthClient.findUniqueOrThrow({
      where: { clientId: OTHER_CLIENT_ID },
    });
    expect(stored.skipConsent).not.toBe(true);
    expect(
      (await grants(OTHER_CLIENT_ID)).filter((g) => g.status === "active"),
    ).toHaveLength(1);
  });

  it("selection for one client does not carry over to another client", async () => {
    // A selection for CLIENT_ID in this session ...
    const first = await authorize();
    const selected = await select(queryOf(first.location!));
    expect(selected.statusCode).toBe(200);
    expect(new URL(selected.json().next).searchParams.get("code")).toBeTruthy();
    // ... does not let OTHER_CLIENT_ID continue past the selection step.
    const other = await authorize({ client_id: OTHER_CLIENT_ID });
    expect(other.location?.pathname).toBe("/connect");
    const resumed = await inject({
      method: "POST",
      url: "/api/auth/oauth2/continue",
      headers: { accept: "application/json" },
      payload: { postLogin: true, oauth_query: queryOf(other.location!) },
    });
    expect(resumed.statusCode).toBe(200);
    const next = new URL(resumed.json().url, origin);
    expect(next.pathname).toBe("/connect");
    expect(next.searchParams.get("ba_pl")).toBeNull();
    // Without a selection the consent endpoint refuses to record consent.
    const direct = await inject({
      method: "POST",
      url: "/api/auth/oauth2/consent",
      headers: { accept: "application/json" },
      payload: { accept: true, oauth_query: queryOf(other.location!) },
    });
    expect(direct.statusCode).toBe(400);
    expect(direct.json().error).toBe("set_workspace");
    // The selection for CLIENT_ID ended in a code (its consent was stored),
    // which consumed it: nothing of this session carries over.
    expect(
      (await grants()).filter((g) => g.sessionId === sessionId),
    ).toHaveLength(0);
  });

  it("private_key_jwt client authenticates with a signed assertion", async () => {
    const flow = await connect({ clientId: PKJWT_CLIENT_ID });
    const form = (key: KeyObject) => ({
      client_id: PKJWT_CLIENT_ID,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion(PKJWT_CLIENT_ID, key),
    });
    const wrong = await exchange(flow, form(wrongKey.privateKey));
    expect(wrong.json().error).toBe("invalid_client");
    const right = await exchange(flow, form(clientKey.privateKey));
    expect(right.statusCode).toBe(200);
    expect(jwtPayload(right.json().access_token).azp).toBe(PKJWT_CLIENT_ID);
  });

  it("wrong code_verifier is invalid_grant", async () => {
    const flow = await connect();
    const r = await exchange(flow, { code_verifier: pkce().verifier });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_grant");
  });

  it("unregistered redirect_uri is rejected without redirecting", async () => {
    const { response, location } = await authorize({
      redirect_uri: "https://evil.test/cb",
    });
    // Better Auth shows its own error page instead of redirecting to the client.
    expect(response.statusCode).toBe(302);
    expect(location!.origin).toBe(origin);
    expect(location!.pathname).toBe("/api/auth/error");
    expect(location!.searchParams.get("error")).toBe("invalid_redirect");
    expect(String(location)).not.toContain("evil.test");
  });

  it("missing resource is invalid_target without a redirect", async () => {
    for (const resource of [
      null,
      "https://evil.test/mcp",
      `${config.MCP_RESOURCE}/x`,
    ]) {
      const { response, location } = await authorize({ resource });
      expect(response.statusCode).toBe(400);
      expect(location).toBeUndefined();
      expect(response.json().error).toBe("invalid_target");
    }
    // Nothing was issued: no token with the MCP audience exists for a request
    // without resource, because no code was issued at all.
  });

  it("tampered signed query returns 400 OAUTH_REQUEST_INVALID", async () => {
    const { location } = await authorize();
    const tampered = new URLSearchParams(queryOf(location!));
    tampered.set("state", "other");
    const request = await inject({
      url: `/api/mcp-connect/request?${tampered}`,
    });
    expect(request.statusCode).toBe(400);
    expect(request.json().error.code).toBe("OAUTH_REQUEST_INVALID");
    const before = (await grants()).length;
    const selected = await select(tampered.toString());
    expect(selected.statusCode).toBe(400);
    expect(selected.json().error.code).toBe("OAUTH_REQUEST_INVALID");
    expect((await grants()).length).toBe(before);
    const consented = await consent(tampered.toString());
    expect(consented.statusCode).toBe(400);
    expect(consented.json().error.code).toBe("OAUTH_REQUEST_INVALID");
    const missing = await inject({ url: "/api/mcp-connect/request" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("OAUTH_REQUEST_INVALID");
  });

  it("expired signed query activates nothing", async () => {
    const { location } = await authorize({ client_id: EXPIRED_CLIENT_ID });
    const selected = await select(queryOf(location!));
    expect(selected.statusCode).toBe(200);
    const next = new URL(selected.json().next, origin);
    expect(next.pathname).toBe("/connect");
    const [pending] = await grants(EXPIRED_CLIENT_ID);
    expect(pending!.status).toBe("pending");
    expect(pending!.sessionId).toBe(sessionId);
    expect(pending!.expiresAt!.getTime() - pending!.createdAt.getTime()).toBe(
      600_000,
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 601_000);
    const r = await consent(queryOf(next));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("OAUTH_REQUEST_EXPIRED");
    const request = await inject({
      url: `/api/mcp-connect/request?${queryOf(next)}`,
    });
    expect(request.json().error.code).toBe("OAUTH_REQUEST_EXPIRED");
    vi.useRealTimers();

    const after = await grants(EXPIRED_CLIENT_ID);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("pending");
    expect((await events(EXPIRED_CLIENT_ID)).map((e) => e.action)).toEqual([
      "grant.selected",
    ]);
  });

  it("deny keeps no access: the pending grant is revoked as denied", async () => {
    const { location } = await authorize({ client_id: DENY_CLIENT_ID });
    const selected = await select(queryOf(location!));
    const next = new URL(selected.json().next, origin);
    const denied = await consent(queryOf(next), { accept: false, scopes: [] });
    expect(denied.statusCode).toBe(200);
    const redirect = new URL(denied.json().redirect);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("code")).toBeNull();
    const rows = await grants(DENY_CLIENT_ID);
    const newest = rows.at(-1)!;
    expect(newest).toMatchObject({ status: "revoked", revokedBy: "denied" });
    expect(rows.some((g) => g.status === "active")).toBe(false);
    const actions = (await events(DENY_CLIENT_ID)).map((e) => e.action);
    expect(actions.at(-1)).toBe("grant.denied");
  });

  it("a consent for an already active grant updates its scopes", async () => {
    const narrow = SCOPES.split(" ").filter((x) => x !== "orbit:propose");
    const first = await connect({
      clientId: DENY_CLIENT_ID,
      consent: { scopes: narrow },
    });
    expect(first.steps).toEqual(["select", "consent", "redirect_uri"]);
    const [granted] = (await grants(DENY_CLIENT_ID)).filter(
      (g) => g.status === "active",
    );
    expect(granted!.scopes).toEqual(narrow);
    // The stored consent lacks orbit:propose, so after the selection replaced
    // the grant the consent page runs again and widens the active grant.
    const second = await connect({ clientId: DENY_CLIENT_ID });
    expect(second.steps).toEqual(["select", "consent", "redirect_uri"]);
    const active = (await grants(DENY_CLIENT_ID)).filter(
      (g) => g.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(granted!.id);
    expect(active[0]!.scopes).toEqual(SCOPES.split(" "));
    const updates = (await events(DENY_CLIENT_ID)).filter(
      (e) => e.grantId === active[0]!.id && e.action === "grant.activated",
    );
    expect(updates.map((e) => e.detail)).toEqual([
      { replaced: granted!.id },
      { updated: true },
    ]);
  });

  it("a pending selection never yields a code through another session's consent", async () => {
    // Session 1 selects project A and leaves the consent page open.
    const first = await authorize({ client_id: TWO_SESSIONS_CLIENT_ID });
    const selected = await select(queryOf(first.location!));
    expect(new URL(selected.json().next, origin).pathname).toBe("/connect");
    // Session 2 grants A and B; its consent is stored for the workspace.
    const second = await inSecondSession(() =>
      connect({
        clientId: TWO_SESSIONS_CLIENT_ID,
        selection: { projectIds: [projectA, projectB] },
      }),
    );
    expect(second.final.searchParams.get("code")).toBeTruthy();
    const [broad] = (await grants(TWO_SESSIONS_CLIENT_ID)).filter(
      (g) => g.status === "active",
    );
    expect(broad!.projectIds.sort()).toEqual([projectA, projectB].sort());
    // Session 1 authorizes again: its selection is still pending, so the
    // stored consent of session 2 must not hand out a code; consent runs.
    const again = await authorize({ client_id: TWO_SESSIONS_CLIENT_ID });
    expect(again.location?.pathname).toBe("/connect");
    expect(again.location?.searchParams.get("code")).toBeNull();
    expect(again.location?.searchParams.get("ba_pl")).toBe(sessionId);
    // Accepting makes session 1's narrower choice the one active grant.
    const consented = await consent(queryOf(again.location!));
    expect(consented.statusCode).toBe(200);
    expect(
      new URL(consented.json().redirect).searchParams.get("code"),
    ).toBeTruthy();
    const active = (await grants(TWO_SESSIONS_CLIENT_ID)).filter(
      (g) => g.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.projectIds).toEqual([projectA]);
    expect(
      (await grants(TWO_SESSIONS_CLIENT_ID)).find((g) => g.id === broad!.id),
    ).toMatchObject({ status: "revoked", revokedBy: "replaced" });
    // No pending row of this flow is left behind a code.
    expect(
      (await grants(TWO_SESSIONS_CLIENT_ID)).filter(
        (g) => g.status === "pending" && g.sessionId === null,
      ),
    ).toHaveLength(0);
  });

  it("an accepted consent that ends without a code leaves no pending grant behind a later code", async () => {
    const { location } = await authorize({
      client_id: FAILED_CONSENT_CLIENT_ID,
    });
    const selected = await select(queryOf(location!));
    const next = new URL(selected.json().next, origin);
    expect(next.pathname).toBe("/connect");
    // The client is disabled while the user consents: the library stores the
    // consent, then its authorize pass fails without issuing a code.
    await authDb.oauthClient.update({
      where: { clientId: FAILED_CONSENT_CLIENT_ID },
      data: { disabled: true },
    });
    const failed = await consent(queryOf(next));
    const redirect =
      failed.statusCode === 200 ? new URL(failed.json().redirect) : undefined;
    expect(redirect?.searchParams.get("code") ?? null).toBeNull();
    await authDb.oauthClient.update({
      where: { clientId: FAILED_CONSENT_CLIENT_ID },
      data: { disabled: false },
    });
    // The accepted consent activated the selection before the provider
    // stored it, so the later code is backed by the one active grant.
    const later = await authorize({ client_id: FAILED_CONSENT_CLIENT_ID });
    expect(later.location?.searchParams.get("code")).toBeTruthy();
    const rows = await grants(FAILED_CONSENT_CLIENT_ID);
    expect(rows.filter((g) => g.status === "active")).toHaveLength(1);
    expect(rows.filter((g) => g.status === "pending")).toHaveLength(0);
    expect(rows.every((g) => g.sessionId === null)).toBe(true);
  });

  it("a top-level authorize never hands a code to the client for a pending selection", async () => {
    // Register the client, then hold a pending selection for it.
    const first = await authorize({ client_id: REFUSAL_CLIENT_ID });
    expect(first.location?.pathname).toBe("/connect");
    const pending = await recordSelection({
      userId,
      sessionId,
      clientId: REFUSAL_CLIENT_ID,
      workspaceId,
      projectIds: [projectA],
    });
    expect(pending.status).toBe("pending");
    // A consent stored under the pending placeholder (which Orbit never
    // stores itself) would let the provider issue a code from authorize.
    const now = new Date();
    await authDb.oauthConsent.create({
      data: {
        id: randomUUID(),
        clientId: REFUSAL_CLIENT_ID,
        userId,
        referenceId: `pending:${pending.id}`,
        scopes: SCOPES.split(" "),
        resources: [config.MCP_RESOURCE],
        requestedUserInfoClaims: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const refused = await authorize({ client_id: REFUSAL_CLIENT_ID });
    expect(refused.response.statusCode).toBe(400);
    expect(refused.response.headers.location).toBeUndefined();
    expect(refused.response.body).not.toContain("code=");
    expect(refused.response.json().error).toBe("consent_required");
    const [row] = await grants(REFUSAL_CLIENT_ID);
    expect(row).toMatchObject({ status: "pending", sessionId });
  });

  it("consent bodies with claims or malformed scopes activate nothing", async () => {
    const { location } = await authorize({ client_id: CLAIMS_CLIENT_ID });
    const selected = await select(queryOf(location!));
    const next = queryOf(new URL(selected.json().next, origin));
    const direct = (body: Json) =>
      inject({
        method: "POST",
        url: "/api/auth/oauth2/consent",
        headers: { accept: "application/json" },
        payload: { accept: true, oauth_query: next, ...body },
      });
    const claims = await direct({ claims: {} });
    expect(claims.statusCode).toBe(400);
    expect(claims.json().error).toBe("invalid_request");
    for (const scope of ["", "openid  orbit:read", "openid "]) {
      const r = await direct({ scope });
      expect(r.statusCode).toBe(400);
    }
    const rows = await grants(CLAIMS_CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(
      await authDb.oauthConsent.count({
        where: { clientId: CLAIMS_CLIENT_ID },
      }),
    ).toBe(0);
    expect(
      await authDb.oauthConsent.count({
        where: { referenceId: `pending:${rows[0]!.id}` },
      }),
    ).toBe(0);
    // A well-formed answer still works and activates the selection.
    const ok = await direct({ scope: "openid orbit:read" });
    expect(ok.statusCode).toBe(200);
    expect(new URL(ok.json().url).searchParams.get("code")).toBeTruthy();
    const [active] = await grants(CLAIMS_CLIENT_ID);
    expect(active).toMatchObject({
      status: "active",
      scopes: ["openid", "orbit:read"],
    });
  });

  it("re-consent replaces the active grant", async () => {
    const [old] = (await grants()).filter((g) => g.status === "active");
    expect(old).toBeDefined();
    const flow = await connect({
      selection: { projectIds: [projectA, projectB] },
    });
    // The stored consent covers the request, so the selection itself replaced the grant.
    expect(flow.steps).toEqual(["select", "redirect_uri"]);
    expect(flow.final.searchParams.get("code")).toBeTruthy();
    const rows = await grants();
    const active = rows.filter((g) => g.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(old!.id);
    expect(active[0]!.projectIds.sort()).toEqual([projectA, projectB].sort());
    expect(active[0]!.scopes).toEqual(old!.scopes);
    const replaced = rows.find((g) => g.id === old!.id)!;
    expect(replaced).toMatchObject({
      status: "revoked",
      revokedBy: "replaced",
    });
    expect(replaced.revokedAt).toBeInstanceOf(Date);
    const activated = (await events()).filter(
      (e) => e.grantId === active[0]!.id && e.action === "grant.activated",
    );
    expect(activated).toHaveLength(1);
    expect(activated[0]!.detail).toMatchObject({ replaced: old!.id });

    const token = await exchange(flow);
    expect(token.statusCode).toBe(200);
    expect(jwtPayload(token.json().access_token)[ORBIT_WORKSPACE_CLAIM]).toBe(
      workspaceId,
    );

    // "All current projects" is stored as a flag, evaluated at call time.
    const all = await connect({ selection: { projectIds: "all_current" } });
    expect(all.final.searchParams.get("code")).toBeTruthy();
    const [current] = (await grants()).filter((g) => g.status === "active");
    expect(current).toMatchObject({ allCurrentProjects: true, projectIds: [] });
  });

  it("an unconsumed selection serves one authorization, then selection runs again", async () => {
    // A selection whose continuation never ran (e.g. the page was closed).
    const selection = await recordSelection({
      userId,
      sessionId,
      clientId: CLIENT_ID,
      workspaceId,
      projectIds: [projectA],
    });
    expect(selection.status).toBe("active");
    // The next authorization of that client uses it; the stored consent
    // covers the request, so the code comes straight from authorize ...
    const { location } = await authorize();
    expect(`${location!.origin}${location!.pathname}`).toBe(REDIRECT_URI);
    expect(location!.searchParams.get("code")).toBeTruthy();
    // ... and issuing it consumed the selection.
    expect(
      (await grants()).filter((g) => g.sessionId === sessionId),
    ).toHaveLength(0);
    const again = await authorize();
    expect(again.location?.pathname).toBe("/connect");
    expect(again.location?.searchParams.get("ba_pl")).toBeNull();
  });

  it("workspace without projects cannot be granted", async () => {
    const { location } = await authorize();
    const before = (await grants()).length;
    const empty = await select(queryOf(location!), {
      workspaceId: emptyWorkspaceId,
      projectIds: "all_current",
    });
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error.code).toBe("NO_PROJECTS");
    const foreign = await select(queryOf(location!), {
      workspaceId: foreignWorkspaceId,
      projectIds: [foreignProject],
    });
    expect(foreign.statusCode).toBe(404);
    const outside = await select(queryOf(location!), {
      projectIds: [foreignProject],
    });
    expect(outside.statusCode).toBe(404);
    expect((await grants()).length).toBe(before);
  });

  it("refresh rotates; replay after 30 s revokes the family", async () => {
    const flow = await connect();
    const first = (await exchange(flow)).json();
    const rotated = await refresh(first.refresh_token);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(jwtPayload(second.access_token)[ORBIT_WORKSPACE_CLAIM]).toBe(
      workspaceId,
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const replay = await refresh(first.refresh_token);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
    const newer = await refresh(second.refresh_token);
    expect(newer.statusCode).toBe(400);
    expect(newer.json().error).toBe("invalid_grant");
    vi.useRealTimers();

    const replays = (await events()).filter(
      (e) => e.action === "token.refresh_replay",
    );
    expect(replays).toHaveLength(1);
    expect(replays[0]).toMatchObject({
      workspaceId,
      detail: { error: "invalid_grant" },
    });
    const serialized = JSON.stringify(replays);
    expect(serialized).not.toContain(first.refresh_token);
    expect(serialized).not.toContain(second.refresh_token);
  });
});
