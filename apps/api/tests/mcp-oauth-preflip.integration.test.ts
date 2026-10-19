import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import {
  authorizationRequestHash,
  ORBIT_WORKSPACE_CLAIM,
} from "../src/platform/mcp-auth/plugins.ts";
import { EXPIRED_SELECTION_BATCH } from "../src/platform/mcp-auth/grants.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  FORM,
  jwtPayload,
  metadata,
  origin,
  pkce,
  queryOf,
  REDIRECT_URI,
  SCOPES,
  withFlags,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M5, pre-flip hardening of the OAuth server (D-M5-7): the
// resource compared normalized, the selection bound to its authorization
// request, tokens minted for a grant that is no longer active, deny after a
// replacement, concurrent activation, the sign-in continuation, abandoned
// selections and RFC 7009 revocation. Real flows through the Fastify app with
// ORBIT_MCP_OAUTH=true; each test uses its own client. Tests share one user
// and its sessions (sign-in is limited per file).

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const clientUrl = (name: string) => `https://client.test/preflip-${name}.json`;
const CLIENTS = {
  resource: clientUrl("resource"),
  binding: clientUrl("binding"),
  exchange: clientUrl("exchange"),
  rotation: clientUrl("rotation"),
  deny: clientUrl("deny"),
  conflict: clientUrl("conflict"),
  login: clientUrl("login"),
  cleanup: clientUrl("cleanup"),
  cleanupOther: clientUrl("cleanup-other"),
  revoke: clientUrl("revoke"),
  keepRace: clientUrl("keep-race"),
  lineage: clientUrl("lineage"),
  jwtOnly: clientUrl("jwt-only"),
  jwtRevoked: clientUrl("jwt-revoked"),
};
const clientIds = Object.values(CLIENTS);
const cimdFetch = cimdFetchFor(
  Object.fromEntries(clientIds.map((id) => [id, metadata(id)])),
);

/** What the /oauth2/token after-hook answers (the before-hook's text differs). */
const AFTER_HOOK_REFUSAL = "the grant behind this authorization is not active";
/** The requested scopes without offline_access: no refresh token is issued. */
const NO_REFRESH_SCOPES = SCOPES.split(" ").filter(
  (scope) => scope !== "offline_access",
);

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("base64url");

describe.skipIf(!enabled)("MCP OAuth pre-flip hardening (WP-M5)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let config: ReturnType<typeof loadConfig>;
  let cookie: string;
  let secondCookie: string;
  let userId: string;
  let sessionId: string;
  let credentials: { email: string; password: string };
  let workspaceId: string;
  let projectA: string;
  const users: string[] = [];

  const driver = createFlowDriver({
    app: () => app,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({ workspaceId, projectIds: [projectA] }),
    defaultClientId: CLIENTS.resource,
  });
  const { inject, authorize, select, consent, connect, exchange, refresh } =
    driver;

  async function inSecondSession<T>(fn: () => Promise<T>) {
    const first = cookie;
    cookie = secondCookie;
    try {
      return await fn();
    } finally {
      cookie = first;
    }
  }

  const grants = (clientId: string) =>
    authDb.mcpGrant.findMany({
      where: { userId, clientId },
      orderBy: { createdAt: "asc" },
    });
  const reference = (clientId: string) => ({
    userId,
    clientId,
    referenceId: workspaceId,
  });
  /** Authorizes, selects and stops at the consent page; returns its signed query. */
  async function selectOnly(clientId: string) {
    const { location } = await authorize({ client_id: clientId });
    expect(location?.pathname).toBe("/connect");
    const selected = await select(queryOf(location!));
    expect(selected.statusCode).toBe(200);
    const next = new URL(selected.json().next, origin);
    expect(next.pathname).toBe("/connect");
    return { first: location!, next };
  }
  /**
   * Waits until another connection of this database waits on a row lock
   * while running a statement that mentions `table` (so a lock wait of
   * another test file never counts).
   */
  async function waitForLockWait(table: string) {
    const pattern = `%"${table}"%`;
    // Up to 5 s (250 x 20 ms), so a loaded CI runner does not flake; the
    // happy path returns on the first hit.
    for (let i = 0; i < 250; i++) {
      const [row] = await authDb.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid() AND query ILIKE ${pattern}`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no request is waiting on the lock");
  }
  /** Holds a transaction open until `release` runs, then commits `finish`. */
  function holdTransaction(
    lock: (
      tx: Parameters<Parameters<typeof authDb.$transaction>[0]>[0],
    ) => Promise<unknown>,
    finish: (
      tx: Parameters<Parameters<typeof authDb.$transaction>[0]>[0],
    ) => Promise<unknown> = async () => {},
  ) {
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const done = authDb.$transaction(
      async (tx) => {
        await lock(tx);
        locked();
        await released;
        await finish(tx);
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    return { isLocked, release, done };
  }

  beforeAll(async () => {
    let auth: ReturnType<typeof makeAuth>;
    ({ app, auth, config } = await withFlags(
      { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_CIMD_HOSTS: "client.test" },
      cimdFetch,
    ));
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const created = await auth.api.signUpEmail({
      body: { email, name: "Synthetic MCP pre-flip user", password },
    });
    userId = created.user.id;
    users.push(userId);
    credentials = { email, password };
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP pre-flip workspace",
        members: { create: { userId, role: "owner" } },
        projects: { create: [{ name: "Synthetic A" }] },
      },
      include: { projects: true },
    });
    workspaceId = workspace.id;
    projectA = workspace.projects[0]!.id;
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
    sessionId = (await inject({ url: "/api/auth/get-session" })).json().session
      .id;
  });

  afterAll(async () => {
    await authDb.mcpGrantEvent.deleteMany({ where: { userId: { in: users } } });
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("a resource in another spelling is accepted, bound and issued in its canonical form", async () => {
    const canonical = new URL(config.MCP_RESOURCE);
    const variant = `${canonical.protocol}//${canonical.host.toUpperCase()}${canonical.pathname}/`;
    expect(variant).not.toBe(config.MCP_RESOURCE);
    const { location, verifier } = await authorize({
      client_id: CLIENTS.resource,
      resource: variant,
    });
    expect(location?.pathname).toBe("/connect");
    // The signed query, and so the code and consent, carry the canonical value.
    expect(location!.searchParams.getAll("resource")).toEqual([
      config.MCP_RESOURCE,
    ]);
    const selected = await select(queryOf(location!));
    const next = new URL(selected.json().next, origin);
    const consented = await consent(queryOf(next));
    expect(consented.statusCode).toBe(200);
    const final = new URL(consented.json().redirect);
    const flow = { steps: [], final, verifier };
    const token = await exchange(flow, {
      client_id: CLIENTS.resource,
      resource: variant,
    });
    expect(token.statusCode).toBe(200);
    const access = jwtPayload(token.json().access_token);
    expect(access.aud).toContain(config.MCP_RESOURCE);
    expect(access.aud).not.toContain(variant);
    const stored = await authDb.oauthConsent.findFirstOrThrow({
      where: reference(CLIENTS.resource),
    });
    expect(stored.resources).toEqual([config.MCP_RESOURCE]);
    // Refresh with the variant spelling works the same.
    const refreshed = await inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      session: false,
      noOrigin: true,
      headers: FORM,
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.json().refresh_token,
        client_id: CLIENTS.resource,
        resource: variant,
      }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    expect(jwtPayload(refreshed.json().access_token).aud).toContain(
      config.MCP_RESOURCE,
    );
    // Another resource is still refused.
    for (const resource of [
      `${config.MCP_RESOURCE}x`,
      `${config.MCP_RESOURCE}/x`,
    ]) {
      const refused = await authorize({
        client_id: CLIENTS.resource,
        resource,
      });
      expect(refused.response.statusCode).toBe(400);
      expect(refused.response.json().error).toBe("invalid_target");
    }
  });

  it("a selection serves only the authorization request it was made for", async () => {
    // Two authorization requests of one session for the same client.
    const a = await authorize({ client_id: CLIENTS.binding, state: "st-a" });
    const b = await authorize({ client_id: CLIENTS.binding, state: "st-b" });
    expect(authorizationRequestHash(queryOf(a.location!))).not.toBe(
      authorizationRequestHash(queryOf(b.location!)),
    );
    const selected = await select(queryOf(a.location!));
    const nextA = new URL(selected.json().next, origin);
    expect(nextA.pathname).toBe("/connect");
    // The re-signed consent query of request A still names request A.
    expect(authorizationRequestHash(queryOf(nextA))).toBe(
      authorizationRequestHash(queryOf(a.location!)),
    );
    const [pending] = await grants(CLIENTS.binding);
    expect(pending).toMatchObject({
      status: "pending",
      sessionId,
      requestHash: authorizationRequestHash(queryOf(a.location!)),
    });
    // Request B neither shows nor consumes A's selection ...
    const view = await inject({
      url: `/api/mcp-connect/request?${queryOf(b.location!)}`,
    });
    expect(view.json().selection).toBeNull();
    const consentB = await consent(queryOf(b.location!));
    expect(consentB.statusCode).toBe(400);
    expect(consentB.json().error.code).toBe("OAUTH_SET_WORKSPACE");
    const directB = await inject({
      method: "POST",
      url: "/api/auth/oauth2/consent",
      headers: { accept: "application/json" },
      payload: { accept: true, oauth_query: queryOf(b.location!) },
    });
    expect(directB.statusCode).toBe(400);
    expect(directB.json().error).toBe("set_workspace");
    // ... and continuing B leads to its own selection step.
    const resumedB = await inject({
      method: "POST",
      url: "/api/auth/oauth2/continue",
      headers: { accept: "application/json" },
      payload: { postLogin: true, oauth_query: queryOf(b.location!) },
    });
    expect(resumedB.statusCode).toBe(200);
    const stepB = new URL(resumedB.json().url, origin);
    expect(stepB.pathname).toBe("/connect");
    expect(stepB.searchParams.get("ba_pl")).toBeNull();
    // A denial of B does not touch A's selection either.
    const deniedB = await consent(queryOf(b.location!), {
      accept: false,
      scopes: [],
    });
    expect(deniedB.statusCode).toBe(200);
    expect((await grants(CLIENTS.binding))[0]).toMatchObject({
      id: pending!.id,
      status: "pending",
      sessionId,
    });
    // A's own consent activates it and ends in A's code.
    const consentA = await consent(queryOf(nextA));
    expect(consentA.statusCode).toBe(200);
    const final = new URL(consentA.json().redirect);
    expect(final.searchParams.get("code")).toBeTruthy();
    expect(final.searchParams.get("state")).toBe("st-a");
    const [active] = await grants(CLIENTS.binding);
    expect(active).toMatchObject({
      id: pending!.id,
      status: "active",
      sessionId: null,
    });
  });

  it("a code exchanged after its grant was revoked mints no usable token", async () => {
    const flow = await connect({ clientId: CLIENTS.exchange });
    const [grant] = (await grants(CLIENTS.exchange)).filter(
      (g) => g.status === "active",
    );
    // The revocation commits while the exchange already holds the code: its
    // cleanup finds no code and no tokens yet (simulated: only the status).
    await authDb.mcpGrant.update({
      where: { id: grant!.id },
      data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
    });
    const token = await exchange(flow, { client_id: CLIENTS.exchange });
    expect(token.statusCode).toBe(400);
    expect(token.json().error).toBe("invalid_grant");
    expect(token.json().error_description).toBe(AFTER_HOOK_REFUSAL);
    expect(token.body).not.toContain("access_token");
    expect(
      await authDb.oauthRefreshToken.count({
        where: reference(CLIENTS.exchange),
      }),
    ).toBe(0);
    expect(
      await authDb.oauthAccessToken.count({
        where: reference(CLIENTS.exchange),
      }),
    ).toBe(0);
  });

  it("a refresh rotated while its grant is revoked mints no usable token", async () => {
    const flow = await connect({ clientId: CLIENTS.rotation });
    const tokens = (
      await exchange(flow, { client_id: CLIENTS.rotation })
    ).json() as Json;
    const [grant] = (await grants(CLIENTS.rotation)).filter(
      (g) => g.status === "active",
    );
    // Lock the presented refresh token's row: the refresh passes its grant
    // check, then waits at the rotation. The revocation commits meanwhile.
    const hold = holdTransaction(
      (tx) =>
        tx.$queryRaw`SELECT id FROM "oauthRefreshToken"
          WHERE token = ${tokenHash(tokens.refresh_token)} FOR UPDATE`,
      (tx) =>
        tx.mcpGrant.update({
          where: { id: grant!.id },
          data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
        }),
    );
    await hold.isLocked;
    const pending = refresh(tokens.refresh_token, CLIENTS.rotation);
    await waitForLockWait("oauthRefreshToken");
    hold.release();
    await hold.done;
    const rotated = await pending;
    expect(rotated.statusCode).toBe(400);
    expect(rotated.json().error).toBe("invalid_grant");
    // Refused after the rotation (after-hook), not by the refresh check.
    expect(rotated.json().error_description).toBe(AFTER_HOOK_REFUSAL);
    expect(rotated.body).not.toContain("access_token");
    expect(
      await authDb.oauthRefreshToken.count({
        where: reference(CLIENTS.rotation),
      }),
    ).toBe(0);
    expect(
      await authDb.oauthAccessToken.count({
        where: reference(CLIENTS.rotation),
      }),
    ).toBe(0);
  });

  it("the token check waits for an uncommitted revocation of the grant", async () => {
    const flow = await connect({ clientId: CLIENTS.keepRace });
    const [grant] = (await grants(CLIENTS.keepRace)).filter(
      (g) => g.status === "active",
    );
    // The revocation has changed the row but not committed yet when the
    // exchange stores its tokens: the check must wait for its outcome
    // instead of reading the old, still active row version.
    const hold = holdTransaction((tx) =>
      tx.mcpGrant.update({
        where: { id: grant!.id },
        data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
      }),
    );
    await hold.isLocked;
    const pending = exchange(flow, { client_id: CLIENTS.keepRace });
    await waitForLockWait("McpGrant");
    hold.release();
    await hold.done;
    const token = await pending;
    expect(token.statusCode).toBe(400);
    expect(token.json().error_description).toBe(AFTER_HOOK_REFUSAL);
    expect(
      await authDb.oauthRefreshToken.count({
        where: reference(CLIENTS.keepRace),
      }),
    ).toBe(0);
  });

  it("a re-grant right after a revocation does not keep tokens of the revoked lineage", async () => {
    const flow = await connect({ clientId: CLIENTS.lineage });
    const tokens = (
      await exchange(flow, { client_id: CLIENTS.lineage })
    ).json() as Json;
    const [grant] = (await grants(CLIENTS.lineage)).filter(
      (g) => g.status === "active",
    );
    // While the refresh waits at its rotation, the grant is revoked and the
    // same reference is granted again before the new tokens are stored.
    const hold = holdTransaction(
      (tx) =>
        tx.$queryRaw`SELECT id FROM "oauthRefreshToken"
          WHERE token = ${tokenHash(tokens.refresh_token)} FOR UPDATE`,
      async (tx) => {
        const now = new Date();
        await tx.mcpGrant.update({
          where: { id: grant!.id },
          data: { status: "revoked", revokedAt: now, revokedBy: userId },
        });
        await tx.mcpGrant.create({
          data: {
            userId,
            clientId: CLIENTS.lineage,
            workspaceId,
            projectIds: [projectA],
            scopes: grant!.scopes,
            status: "active",
            activatedAt: now,
          },
        });
      },
    );
    await hold.isLocked;
    const pending = refresh(tokens.refresh_token, CLIENTS.lineage);
    await waitForLockWait("oauthRefreshToken");
    hold.release();
    await hold.done;
    const rotated = await pending;
    expect(rotated.statusCode).toBe(400);
    expect(rotated.json().error_description).toBe(AFTER_HOOK_REFUSAL);
    expect(
      await authDb.oauthRefreshToken.count({
        where: reference(CLIENTS.lineage),
      }),
    ).toBe(0);
    // The re-grant itself is untouched.
    expect(
      (await grants(CLIENTS.lineage)).filter((g) => g.status === "active"),
    ).toHaveLength(1);
  });

  it("an exchange without offline_access (JWT only) is kept for an active grant and refused for a revoked one", async () => {
    /** The browser flow up to the code, without offline_access. */
    async function connectWithoutRefresh(clientId: string) {
      const { location, verifier } = await authorize({
        client_id: clientId,
        scope: NO_REFRESH_SCOPES.join(" "),
      });
      const selected = await select(queryOf(location!));
      const next = new URL(selected.json().next, origin);
      expect(next.pathname).toBe("/connect");
      const consented = await consent(queryOf(next), {
        scopes: NO_REFRESH_SCOPES,
      });
      expect(consented.statusCode).toBe(200);
      return { steps: [], final: new URL(consented.json().redirect), verifier };
    }
    const kept = await exchange(await connectWithoutRefresh(CLIENTS.jwtOnly), {
      client_id: CLIENTS.jwtOnly,
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().refresh_token).toBeUndefined();
    expect(jwtPayload(kept.json().access_token)[ORBIT_WORKSPACE_CLAIM]).toBe(
      workspaceId,
    );

    const flow = await connectWithoutRefresh(CLIENTS.jwtRevoked);
    const [grant] = (await grants(CLIENTS.jwtRevoked)).filter(
      (g) => g.status === "active",
    );
    await authDb.mcpGrant.update({
      where: { id: grant!.id },
      data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
    });
    const refused = await exchange(flow, { client_id: CLIENTS.jwtRevoked });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("invalid_grant");
    expect(refused.json().error_description).toBe(AFTER_HOOK_REFUSAL);
    expect(refused.body).not.toContain("access_token");
    for (const table of [authDb.oauthRefreshToken, authDb.oauthAccessToken])
      expect(
        await (table as typeof authDb.oauthRefreshToken).count({
          where: reference(CLIENTS.jwtRevoked),
        }),
      ).toBe(0);
  });

  it("a deny after a replacement drops the replaced grant's consent and tokens", async () => {
    const narrow = SCOPES.split(" ").filter((x) => x !== "orbit:propose");
    const first = await connect({
      clientId: CLIENTS.deny,
      consent: { scopes: narrow },
    });
    const tokens = (
      await exchange(first, { client_id: CLIENTS.deny })
    ).json() as Json;
    const [old] = (await grants(CLIENTS.deny)).filter(
      (g) => g.status === "active",
    );
    // The new selection replaces the grant at once; the stored consent lacks
    // orbit:propose, so the consent page runs, and the user denies.
    const { next } = await selectOnly(CLIENTS.deny);
    const replaced = await grants(CLIENTS.deny);
    expect(replaced.find((g) => g.id === old!.id)).toMatchObject({
      status: "revoked",
      revokedBy: "replaced",
    });
    const replacement = replaced.find((g) => g.status === "active")!;
    expect(replacement.id).not.toBe(old!.id);
    const denied = await consent(queryOf(next), { accept: false, scopes: [] });
    expect(denied.statusCode).toBe(200);
    expect(new URL(denied.json().redirect).searchParams.get("error")).toBe(
      "access_denied",
    );
    const after = await grants(CLIENTS.deny);
    expect(after.some((g) => g.status === "active")).toBe(false);
    expect(after.find((g) => g.id === replacement.id)).toMatchObject({
      status: "revoked",
      revokedBy: "denied",
      sessionId: null,
    });
    expect(
      await authDb.oauthConsent.count({ where: reference(CLIENTS.deny) }),
    ).toBe(0);
    expect(
      await authDb.oauthRefreshToken.count({ where: reference(CLIENTS.deny) }),
    ).toBe(0);
    const refreshed = await refresh(tokens.refresh_token, CLIENTS.deny);
    expect(refreshed.statusCode).toBe(400);
    expect(refreshed.json().error).toBe("invalid_grant");
    const denial = await authDb.mcpGrantEvent.findFirstOrThrow({
      where: { userId, clientId: CLIENTS.deny, action: "grant.denied" },
    });
    expect(denial.grantId).toBe(replacement.id);
  });

  it("concurrent activation leaves one active grant and refuses the other (GRANT_CONFLICT)", async () => {
    // Two sessions each hold a pending selection for the same reference.
    const one = await selectOnly(CLIENTS.conflict);
    const two = await inSecondSession(() => selectOnly(CLIENTS.conflict));
    const pendings = await grants(CLIENTS.conflict);
    expect(pendings.map((g) => g.status)).toEqual(["pending", "pending"]);
    const [first, second] = pendings;
    // Session 1's activation has checked for an active grant and waits on
    // its own row; session 2 activates and commits meanwhile.
    const hold = holdTransaction(
      (tx) =>
        tx.$queryRaw`SELECT id FROM "McpGrant" WHERE id = ${first!.id}::uuid FOR UPDATE`,
    );
    await hold.isLocked;
    const pendingOne = consent(queryOf(one.next));
    await waitForLockWait("McpGrant");
    const answerTwo = await inSecondSession(() => consent(queryOf(two.next)));
    expect(answerTwo.statusCode).toBe(200);
    expect(
      new URL(answerTwo.json().redirect).searchParams.get("code"),
    ).toBeTruthy();
    hold.release();
    await hold.done;
    const answerOne = await pendingOne;
    expect(answerOne.statusCode).toBe(409);
    expect(answerOne.json().error.code).toBe("OAUTH_GRANT_CONFLICT");
    expect(answerOne.body).not.toContain("code=");
    const rows = await grants(CLIENTS.conflict);
    expect(rows.filter((g) => g.status === "active").map((g) => g.id)).toEqual([
      second!.id,
    ]);
    expect(rows.find((g) => g.id === first!.id)!.status).toBe("pending");
  });

  it("characterization: the sign-in continuation re-runs authorize for the new session and issues no code", async () => {
    // A pending selection in this session for exactly the request that a
    // signed-out browser will continue after signing in.
    const { challenge } = pkce();
    const params = {
      client_id: CLIENTS.login,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      state: "st-login",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: config.MCP_RESOURCE,
    };
    const inSession = await authorize(params);
    const selected = await select(queryOf(inSession.location!));
    expect(new URL(selected.json().next, origin).pathname).toBe("/connect");
    const [pending] = await grants(CLIENTS.login);
    expect(pending).toMatchObject({ status: "pending", sessionId });
    // The signed-out authorization of the same request ends at the login page.
    const signedOut = await inject({
      url: `/api/auth/oauth2/authorize?${new URLSearchParams(params)}`,
      session: false,
    });
    expect(signedOut.statusCode).toBe(302);
    const login = new URL(signedOut.headers.location as string, origin);
    expect(login.pathname).toBe("/connect/login");
    expect(authorizationRequestHash(queryOf(login))).toBe(pending!.requestHash);
    // Signing in with the signed query: the provider's sign-in after-hook
    // re-runs authorize for the new session (an internal pass). The new
    // session has no selection, so it answers with the selection step as
    // JSON; no code is issued and the other session's pending selection is
    // neither used nor changed.
    const signIn = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      session: false,
      payload: { ...credentials, oauth_query: queryOf(login) },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.headers.location).toBeUndefined();
    const body = signIn.json();
    expect(body.redirect).toBe(true);
    const next = new URL(body.url, origin);
    expect(next.pathname).toBe("/connect");
    expect(next.searchParams.get("code")).toBeNull();
    expect(next.searchParams.get("ba_pl")).toBeNull();
    expect(signIn.body).not.toContain("code=");
    expect(await grants(CLIENTS.login)).toEqual([pending]);
    expect(
      await authDb.oauthConsent.count({ where: { clientId: CLIENTS.login } }),
    ).toBe(0);
    const codes = await authDb.verification.count({
      where: {
        AND: [
          { value: { contains: "authorization_code" } },
          { value: { contains: CLIENTS.login } },
        ],
      },
    });
    expect(codes).toBe(0);
  });

  it("a new selection deletes the user's abandoned pending selections (bounded)", async () => {
    const past = new Date(Date.now() - 3_600_000);
    const row = (clientId: string, extra: Json = {}) => ({
      userId,
      clientId,
      workspaceId,
      scopes: [],
      status: "pending",
      sessionId: randomUUID(),
      createdAt: new Date(past.getTime() - 600_000),
      expiresAt: past,
      ...extra,
    });
    await authDb.mcpGrant.createMany({
      data: [
        ...Array.from({ length: EXPIRED_SELECTION_BATCH }, () =>
          row(CLIENTS.cleanupOther),
        ),
        row(CLIENTS.cleanup),
        row(CLIENTS.cleanup),
      ],
    });
    // Kept: a pending selection still within its TTL, revoked history, and
    // another user's abandoned selection.
    const fresh = await authDb.mcpGrant.create({
      data: row(CLIENTS.cleanup, {
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      }),
    });
    const revoked = await authDb.mcpGrant.create({
      data: row(CLIENTS.cleanup, { status: "revoked", revokedAt: past }),
    });
    const stranger = await authDb.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.invalid`,
        name: "Synthetic MCP stranger",
        emailVerified: false,
      },
    });
    users.push(stranger.id);
    await authDb.workspaceMember.create({
      data: { workspaceId, userId: stranger.id, role: "viewer" },
    });
    const foreign = await authDb.mcpGrant.create({
      data: row(CLIENTS.cleanup, { userId: stranger.id }),
    });
    const expired = () =>
      authDb.mcpGrant.count({
        where: { userId, status: "pending", expiresAt: { lt: new Date() } },
      });
    expect(await expired()).toBe(EXPIRED_SELECTION_BATCH + 2);

    await selectOnly(CLIENTS.cleanup);
    expect(await expired()).toBe(2);
    await selectOnly(CLIENTS.cleanup);
    expect(await expired()).toBe(0);
    for (const kept of [fresh, revoked, foreign])
      expect(
        await authDb.mcpGrant.findUnique({ where: { id: kept.id } }),
      ).not.toBeNull();
    await authDb.mcpGrant.delete({ where: { id: foreign.id } });
  });

  it("RFC 7009 revocation of a refresh token keeps the grant active (decided: WP-M5)", async () => {
    const flow = await connect({ clientId: CLIENTS.revoke });
    const tokens = (
      await exchange(flow, { client_id: CLIENTS.revoke })
    ).json() as Json;
    const revoked = await inject({
      method: "POST",
      url: "/api/auth/oauth2/revoke",
      session: false,
      noOrigin: true,
      headers: FORM,
      payload: new URLSearchParams({
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
        client_id: CLIENTS.revoke,
      }).toString(),
    });
    expect(revoked.statusCode).toBe(200);
    // The client gave up that token, not the user's grant: the grant stays
    // active (and listed in Orbit) until the user or an owner revokes it.
    const active = (await grants(CLIENTS.revoke)).filter(
      (g) => g.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.revokedAt).toBeNull();
    const again = await refresh(tokens.refresh_token, CLIENTS.revoke);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_grant");
    // A new authorization works without a new consent page.
    const reconnected = await connect({ clientId: CLIENTS.revoke });
    expect(reconnected.steps).toEqual(["select", "redirect_uri"]);
    const token = await exchange(reconnected, { client_id: CLIENTS.revoke });
    expect(token.statusCode).toBe(200);
    expect(jwtPayload(token.json().access_token)[ORBIT_WORKSPACE_CLAIM]).toBe(
      workspaceId,
    );
  });
});
