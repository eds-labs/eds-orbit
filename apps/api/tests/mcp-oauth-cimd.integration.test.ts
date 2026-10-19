import { randomBytes, randomUUID } from "node:crypto";
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
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  changedClientFields,
  PENDING_REFERENCE_PREFIX,
} from "../src/platform/mcp-auth/plugins.ts";
import {
  grantClientDeps,
  revokeClientGrants,
} from "../src/platform/mcp-auth/grants.ts";
import {
  createFlowDriver,
  metadata,
  origin,
  withFlags as baseWithFlags,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M1, Task 7: the CIMD host policy, client audit events, the
// revocation of grants when a client's security-relevant metadata changes, and
// the refresh check against the grant. Real flows through the Fastify app with
// ORBIT_MCP_OAUTH=true; clients are served in-process (cimdFetch seam), and
// every client lives on its own origin so no test shares a fetch budget.

// Lets a test make the audit write of a revocation fail inside its transaction.
const eventFailure = vi.hoisted(() => ({ on: false }));
vi.mock("../src/platform/mcp-auth/events.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/platform/mcp-auth/events.ts")>();
  return {
    ...original,
    recordGrantEvent: async (
      ...args: Parameters<typeof original.recordGrantEvent>
    ) => {
      if (eventFailure.on && args[0].action === "grant.revoked")
        throw new Error("event store down");
      return original.recordGrantEvent(...args);
    },
  };
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const WEB_HOP = "10.0.3.4";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let counter = 0;
const clientUrl = (name: string) =>
  `https://${name}${++counter}.client.test/doc.json`;
/** A client document whose client_uri shares the client_id origin. */
const doc = (clientId: string, extra: Json = {}) =>
  metadata(clientId, { client_uri: new URL(clientId).origin, ...extra });

// The transport: records every call, serves mutable documents, never caches.
const calls: string[] = [];
const documents: Record<string, Json | string> = {};
const transport = (async (input: string | URL | Request) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  calls.push(url);
  const body = documents[url];
  return body === undefined
    ? new Response("not found", { status: 404 })
    : new Response(typeof body === "string" ? body : JSON.stringify(body), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
}) as typeof fetch;

const HOSTS = "client.test,localhost,127.0.0.1";

describe("changedClientFields", () => {
  const base = {
    name: "App",
    uri: "https://app.test",
    redirectUris: ["https://app.test/a", "https://app.test/b"],
    postLogoutRedirectUris: [] as string[],
    jwksUri: null as string | null,
    jwks: null as string | null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: ["openid"],
  };
  it("reports the security-relevant fields that differ, never values", () => {
    expect(changedClientFields(base as never, { ...base } as never)).toEqual(
      [],
    );
    // Order of list members does not matter.
    expect(
      changedClientFields(
        base as never,
        {
          ...base,
          redirectUris: [...base.redirectUris].reverse(),
        } as never,
      ),
    ).toEqual([]);
    expect(
      changedClientFields(
        base as never,
        {
          ...base,
          redirectUris: [...base.redirectUris, "https://app.test/c"],
          jwksUri: "https://app.test/jwks.json",
          name: "Other",
          tokenEndpointAuthMethod: "private_key_jwt",
        } as never,
      ),
    ).toEqual([
      "client_name",
      "redirect_uris",
      "jwks_uri",
      "token_endpoint_auth_method",
    ]);
  });
  it("compares inline jwks by content, not by key order", () => {
    const a = JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", x: "k" }],
    });
    const reordered = JSON.stringify({
      keys: [{ x: "k", crv: "Ed25519", kty: "OKP" }],
    });
    const changed = JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", x: "other" }],
    });
    expect(
      changedClientFields(
        { ...base, jwks: a } as never,
        { ...base, jwks: reordered } as never,
      ),
    ).toEqual([]);
    expect(
      changedClientFields(
        { ...base, jwks: a } as never,
        { ...base, jwks: changed } as never,
      ),
    ).toEqual(["jwks"]);
  });
});

describe.skipIf(!enabled)("CIMD client policy and audit", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let auth: ReturnType<typeof makeAuth>;
  let config: ReturnType<typeof loadConfig>;
  let cookie = "";
  let userId = "";
  let workspaceId = "";
  let projectId = "";
  let otherWorkspaceId = "";
  let otherProjectId = "";
  const clientIds: string[] = [];
  let currentClient = "";

  const driver = createFlowDriver({
    app: () => app,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({ workspaceId, projectIds: [projectId] }),
    get defaultClientId() {
      return currentClient;
    },
  });
  const { inject, authorize, select, connect, exchange, refresh } = driver;

  /** Registers a client document and makes it the flow's default client. */
  function client(name: string, extra: Json = {}) {
    const id = clientUrl(name);
    clientIds.push(id);
    documents[id] = doc(id, extra);
    currentClient = id;
    return id;
  }
  const events = (clientId: string, action?: string) =>
    authDb.mcpGrantEvent.findMany({
      where: { clientId, ...(action ? { action } : {}) },
      orderBy: { createdAt: "asc" },
    });
  const tokensFor = async (clientId: string) => {
    const flow = await connect({ clientId });
    const response = await exchange(flow, { client_id: clientId });
    expect(response.statusCode).toBe(200);
    return response.json() as Json;
  };
  const grantOf = (clientId: string) =>
    authDb.mcpGrant.findFirstOrThrow({
      where: { userId, clientId, workspaceId },
      orderBy: { createdAt: "desc" },
    });
  const expectRejected = async (clientId: string) => {
    const { response, location } = await authorize({ client_id: clientId });
    // Never a selection, never a redirect to the client.
    expect(location?.pathname).not.toBe("/connect");
    expect(location?.pathname).not.toBe("/connect/login");
    expect(String(response.headers.location ?? "")).not.toContain(
      "client.test/cb",
    );
    expect(await authDb.oauthClient.count({ where: { clientId } })).toBe(0);
  };

  beforeAll(async () => {
    ({ app, auth, config } = await baseWithFlags(
      { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_CIMD_HOSTS: HOSTS },
      transport,
    ));
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const created = await auth.api.signUpEmail({
      body: { email, name: "Synthetic CIMD user", password },
    });
    userId = created.user.id;
    const make = async (name: string) =>
      authDb.workspace.create({
        data: {
          name,
          members: { create: { userId, role: "owner" } },
          projects: { create: { name: `${name} project` } },
        },
        include: { projects: true },
      });
    const first = await make("Synthetic CIMD workspace");
    const second = await make("Synthetic CIMD second workspace");
    workspaceId = first.id;
    projectId = first.projects[0]!.id;
    otherWorkspaceId = second.id;
    otherProjectId = second.projects[0]!.id;
    const r = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      session: false,
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set!])
      .map((v) => v.split(";")[0])
      .join("; ");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await authDb.mcpGrantEvent.deleteMany({ where: { userId } });
    await authDb.mcpGrantEvent.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await authDb.mcpGrant.deleteMany({ where: { userId } });
    await authDb.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await authDb.user.deleteMany({ where: { id: userId } });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await app?.close();
    await closeDatabase();
  });

  describe("host and URL policy (no fetch for a refused client_id)", () => {
    it("a client_id outside ORBIT_MCP_CIMD_HOSTS is rejected before any fetch", async () => {
      const id = "https://evil.example/c.json";
      documents[id] = doc(id);
      clientIds.push(id);
      const before = calls.length;
      await expectRejected(id);
      // A look-alike host is not a subdomain of an allowed one either.
      const lookalike = "https://notclient.test/c.json";
      documents[lookalike] = doc(lookalike);
      clientIds.push(lookalike);
      await expectRejected(lookalike);
      expect(calls.slice(before)).toEqual([]);
    });

    it("loopback, http, credentials, fragment and IP-literal client_ids are rejected", async () => {
      // `localhost` and `127.0.0.1` are on the host list of this app, so only
      // the URL validation can refuse them.
      const refused = [
        "https://127.0.0.1/c.json",
        "https://localhost/c.json",
        "http://client.test/c.json",
        "https://u:p@client.test/c.json",
        "https://client.test/c.json#x",
      ];
      const before = calls.length;
      for (const id of refused) {
        clientIds.push(id);
        documents[id] = doc("https://client.test/c.json");
        await expectRejected(id);
      }
      expect(calls.slice(before)).toEqual([]);
    });

    it("metadata with a secret or symmetric auth method is rejected", async () => {
      const variants: Json[] = [
        { client_secret: "s3cret" },
        { token_endpoint_auth_method: "client_secret_basic" },
        { token_endpoint_auth_method: "client_secret_post" },
        { token_endpoint_auth_method: "client_secret_jwt" },
      ];
      for (const [i, extra] of variants.entries()) {
        const id = client(`symmetric${i}-`, extra);
        await expectRejected(id);
        expect(calls).toContain(id);
      }
    });

    it("oversized metadata (> 5 KB) is rejected", async () => {
      const id = client("oversized-", { client_name: "x".repeat(6000) });
      expect(JSON.stringify(documents[id]).length).toBeGreaterThan(5 * 1024);
      await expectRejected(id);
    });
  });

  describe("client audit events", () => {
    it("first use writes client.registered, a changed document writes client.refreshed", async () => {
      const id = client("events-");
      expect(await events(id)).toHaveLength(0);

      const first = await authorize({ client_id: id });
      expect(first.location?.pathname).toBe("/connect");
      const registered = await events(id, "client.registered");
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({ clientId: id, userId: "system" });

      // Resolving an unchanged document again writes nothing.
      await authorize({ client_id: id });
      expect(await events(id, "client.registered")).toHaveLength(1);
      expect(await events(id, "client.refreshed")).toHaveLength(0);

      documents[id] = doc(id, {
        client_name: "Renamed client",
        redirect_uris: ["https://client.test/cb", "https://client.test/cb2"],
      });
      await authorize({ client_id: id });
      const refreshed = await events(id, "client.refreshed");
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]).toMatchObject({ clientId: id, userId: "system" });
      expect(refreshed[0]!.detail).toMatchObject({
        changed: ["client_name", "redirect_uris"],
      });
      // Identifiers and field names only.
      expect(JSON.stringify(refreshed[0]!.detail)).not.toContain("cb2");
      expect(JSON.stringify(refreshed[0]!.detail)).not.toContain("Renamed");
    });

    it("a failing audit write cannot break the OAuth request", async () => {
      const id = client("auditfail-");
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(authDb.mcpGrantEvent, "create").mockRejectedValue(
        new Error("audit store down"),
      );
      const { location } = await authorize({ client_id: id });
      expect(location?.pathname).toBe("/connect");
      // The client itself was stored.
      expect(await authDb.oauthClient.count({ where: { clientId: id } })).toBe(
        1,
      );
    });

    it("the callbacks swallow an audit failure and log it", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(authDb.mcpGrantEvent, "create").mockRejectedValue(
        new Error("audit store down"),
      );
      const deps = grantClientDeps();
      await expect(
        deps.onClientCreated({ clientId: "https://x.client.test/c.json" }),
      ).resolves.toBeUndefined();
      await expect(
        deps.onClientRefreshed({
          clientId: "https://x.client.test/c.json",
          changed: ["client_name"],
        }),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalled();
    });

    it("a failing revocation is logged at error level, rolled back and still audited", async () => {
      const id = client("revokefail-");
      await tokensFor(id);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      eventFailure.on = true;
      try {
        await expect(
          grantClientDeps().onClientRefreshed({
            clientId: id,
            changed: ["redirect_uris"],
          }),
        ).rejects.toThrow("event store down");
      } finally {
        eventFailure.on = false;
      }
      expect(logged).toHaveBeenCalled();
      expect(String(logged.mock.calls[0]![0])).toMatch(/revoke/i);
      // The transaction rolled back: the grant is untouched, the failure is on record.
      expect((await grantOf(id)).status).toBe("active");
      const refreshed = await events(id, "client.refreshed");
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]!.detail).toMatchObject({
        changed: ["redirect_uris"],
        revocationFailed: true,
      });
    });
  });

  describe("a changed client revokes its grants", () => {
    it("redirect_uris change revokes active grants and pending selections", async () => {
      const id = client("changed-");
      const tokens = await tokensFor(id);
      const active = await grantOf(id);
      expect(active.status).toBe("active");

      // A pending selection of another workspace for the same client.
      const { location } = await authorize({ client_id: id });
      const selected = await select(location!.search.slice(1), {
        workspaceId: otherWorkspaceId,
        projectIds: [otherProjectId],
      });
      expect(selected.statusCode).toBe(200);
      const pending = await authDb.mcpGrant.findFirstOrThrow({
        where: { userId, clientId: id, workspaceId: otherWorkspaceId },
      });
      expect(pending.status).toBe("pending");
      const reference = {
        clientId: id,
        userId,
        referenceId: workspaceId,
      };
      expect(await authDb.oauthRefreshToken.count({ where: reference })).toBe(
        1,
      );

      documents[id] = doc(id, {
        redirect_uris: ["https://client.test/cb", "https://client.test/other"],
      });
      // The next call resolves the changed document: here the refresh itself.
      const after = await refresh(tokens.refresh_token, id);
      expect(after.statusCode).toBe(400);
      expect(after.json().error).toBe("invalid_grant");

      expect(
        await authDb.mcpGrant.findUniqueOrThrow({ where: { id: active.id } }),
      ).toMatchObject({ status: "revoked", revokedBy: "client_changed" });
      expect(
        await authDb.mcpGrant.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({ status: "revoked", revokedBy: "client_changed" });
      expect(await authDb.oauthConsent.count({ where: reference })).toBe(0);
      expect(await authDb.oauthRefreshToken.count({ where: reference })).toBe(
        0,
      );
      expect(await authDb.oauthAccessToken.count({ where: reference })).toBe(0);

      const revoked = await events(id, "grant.revoked");
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({
        grantId: active.id,
        userId,
        workspaceId,
        detail: { by: "system", reason: "client_changed" },
      });
      const refreshed = await events(id, "client.refreshed");
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]!.detail).toMatchObject({
        changed: ["redirect_uris"],
        revokedGrants: 1,
      });
    });

    it("a jwks_uri change revokes, a rename alone keeps the grant", async () => {
      const id = client("jwks-");
      const tokens = await tokensFor(id);
      const grant = await grantOf(id);

      documents[id] = doc(id, { client_name: "Only renamed" });
      const kept = await refresh(tokens.refresh_token, id);
      expect(kept.statusCode).toBe(200);
      expect((await grantOf(id)).status).toBe("active");
      const renamed = await events(id, "client.refreshed");
      expect(renamed).toHaveLength(1);
      expect(renamed[0]!.detail).toMatchObject({ changed: ["client_name"] });
      expect(await events(id, "grant.revoked")).toHaveLength(0);

      documents[id] = doc(id, {
        client_name: "Only renamed",
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: new URL("/jwks.json", id).href,
      });
      documents[new URL("/jwks.json", id).href] = {
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            alg: "EdDSA",
            use: "sig",
          },
        ],
      };
      await authorize({ client_id: id });
      expect(
        await authDb.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ status: "revoked", revokedBy: "client_changed" });
    });

    it("a token_endpoint_auth_method downgrade alone revokes (WP-M5)", async () => {
      const id = client("downgrade-");
      const jwksUri = new URL("/jwks.json", id).href;
      documents[jwksUri] = {
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            alg: "EdDSA",
            use: "sig",
          },
        ],
      };
      documents[id] = doc(id, {
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: jwksUri,
      });
      // The grant becomes active at consent; no token exchange is needed.
      const flow = await connect({ clientId: id });
      expect(flow.final.searchParams.get("code")).toBeTruthy();
      const grant = await grantOf(id);
      expect(grant.status).toBe("active");

      // Same keys, but the client no longer authenticates at all.
      documents[id] = doc(id, {
        token_endpoint_auth_method: "none",
        jwks_uri: jwksUri,
      });
      await authorize({ client_id: id });
      const refreshed = await events(id, "client.refreshed");
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]!.detail).toMatchObject({
        changed: ["token_endpoint_auth_method"],
        revokedGrants: 1,
      });
      expect(
        await authDb.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ status: "revoked", revokedBy: "client_changed" });
    });

    it("the client callback revokes on any auth method change", async () => {
      const id = client("method-");
      await tokensFor(id);
      expect((await grantOf(id)).status).toBe("active");
      await grantClientDeps().onClientRefreshed({
        clientId: id,
        changed: ["token_endpoint_auth_method"],
      });
      expect(await grantOf(id)).toMatchObject({
        status: "revoked",
        revokedBy: "client_changed",
      });
    });

    it("revokeClientGrants revokes every active grant of the client only", async () => {
      const id = client("direct-");
      const other = client("direct-other-");
      await tokensFor(id);
      await tokensFor(other);
      const count = await revokeClientGrants(id, "client_changed");
      expect(count).toBe(1);
      expect((await grantOf(id)).status).toBe("revoked");
      expect((await grantOf(other)).status).toBe("active");
      // Nothing left to revoke.
      expect(await revokeClientGrants(id, "client_changed")).toBe(0);
      expect(await events(id, "grant.revoked")).toHaveLength(1);
      expect(await events(other, "grant.revoked")).toHaveLength(0);
    });
  });

  describe("an outstanding authorization code dies with its grant", () => {
    const issuedFor = (id: string) => ({
      clientId: id,
      userId,
      referenceId: workspaceId,
    });
    const expectNoTokens = async (id: string) => {
      expect(
        await authDb.oauthRefreshToken.count({ where: issuedFor(id) }),
      ).toBe(0);
      expect(
        await authDb.oauthAccessToken.count({ where: issuedFor(id) }),
      ).toBe(0);
    };

    it("code issued, then the client document changes: the exchange fails and mints nothing", async () => {
      const id = client("code-changed-");
      const flow = await connect({ clientId: id });
      expect(flow.final.searchParams.get("code")).toBeTruthy();
      documents[id] = doc(id, {
        redirect_uris: ["https://client.test/cb", "https://client.test/other"],
      });
      const r = await exchange(flow, { client_id: id });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_grant");
      await expectNoTokens(id);
      expect((await grantOf(id)).status).toBe("revoked");
      // A later grant starts clean (token times have one-second precision).
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const again = await tokensFor(id);
      expect((await refresh(again.refresh_token, id)).statusCode).toBe(200);
    });

    it("code issued, then the user revokes the grant: the exchange fails and mints nothing", async () => {
      const id = client("code-revoked-");
      const flow = await connect({ clientId: id });
      const grant = await grantOf(id);
      const revoked = await inject({
        method: "DELETE",
        url: `/api/mcp-grants/${grant.id}`,
      });
      expect(revoked.statusCode).toBe(204);
      const r = await exchange(flow, { client_id: id });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_grant");
      await expectNoTokens(id);
    });

    it("a code of another client or workspace is left alone", async () => {
      const id = client("code-own-");
      const other = client("code-other-");
      const flow = await connect({ clientId: other });
      await tokensFor(id);
      await revokeClientGrants(id, "client_changed");
      const r = await exchange(flow, { client_id: other });
      expect(r.statusCode).toBe(200);
    });

    it("the normal code exchange still works", async () => {
      const id = client("code-ok-");
      const flow = await connect({ clientId: id });
      const r = await exchange(flow, { client_id: id });
      expect(r.statusCode).toBe(200);
      expect(r.json().refresh_token).toBeTruthy();
    });
  });

  describe("refresh needs an active grant", () => {
    it("a normal refresh still works", async () => {
      const id = client("refresh-ok-");
      const tokens = await tokensFor(id);
      const rotated = await refresh(tokens.refresh_token, id);
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().refresh_token).toBeTruthy();
    });

    it("refresh after the grant row was revoked directly in the DB is invalid_grant", async () => {
      const id = client("refresh-revoked-");
      const tokens = await tokensFor(id);
      const grant = await grantOf(id);
      await authDb.mcpGrant.update({
        where: { id: grant.id },
        data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
      });
      // The tokens are still there: only the grant check can refuse.
      const reference = { clientId: id, userId, referenceId: workspaceId };
      expect(await authDb.oauthRefreshToken.count({ where: reference })).toBe(
        1,
      );
      const r = await refresh(tokens.refresh_token, id);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_grant");
      // Nothing was rotated.
      const row = await authDb.oauthRefreshToken.findFirstOrThrow({
        where: reference,
      });
      expect(row.revoked).toBeNull();
      expect(row.rotatedAt).toBeNull();
    });

    it("a stale refresh token does not work again after a later re-grant", async () => {
      const id = client("refresh-regrant-");
      const stale = await tokensFor(id);
      const grant = await grantOf(id);
      // Revoked without deleting the tokens, as an in-flight refresh would leave them.
      await authDb.mcpGrant.update({
        where: { id: grant.id },
        data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
      });
      // Token times have one-second precision: a re-grant in the very second
      // of the revocation is refused on purpose (fail safe).
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const fresh = await tokensFor(id);
      expect((await grantOf(id)).status).toBe("active");
      const old = await refresh(stale.refresh_token, id);
      expect(old.statusCode).toBe(400);
      expect(old.json().error).toBe("invalid_grant");
      const again = await refresh(fresh.refresh_token, id);
      expect(again.statusCode, again.body).toBe(200);
    });

    it("a refresh token replaced by a new selection keeps working", async () => {
      const id = client("refresh-replaced-");
      const tokens = await tokensFor(id);
      // Selecting again replaces the active grant at once (revokedBy replaced).
      const { location } = await authorize({ client_id: id });
      expect((await select(location!.search.slice(1))).statusCode).toBe(200);
      expect((await grantOf(id)).status).toBe("active");
      expect((await refresh(tokens.refresh_token, id)).statusCode).toBe(200);
    });

    it("a token whose reference is not a grant's workspace is refused", async () => {
      const id = client("refresh-pending-");
      const tokens = await tokensFor(id);
      await authDb.oauthRefreshToken.updateMany({
        where: { clientId: id, userId },
        data: { referenceId: `${PENDING_REFERENCE_PREFIX}x` },
      });
      const r = await refresh(tokens.refresh_token, id);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_grant");
    });
  });
});

describe.skipIf(!enabled)("dynamic client registration", () => {
  const registered: string[] = [];
  const registerBody = JSON.stringify({
    client_name: "Synthetic DCR client",
    redirect_uris: ["https://client.test/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const register = (app: Awaited<ReturnType<typeof buildServer>>, ip: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/oauth2/register",
      remoteAddress: WEB_HOP,
      headers: { "content-type": "application/json", "x-orbit-client-ip": ip },
      payload: registerBody,
    });

  afterAll(async () => {
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: registered } },
    });
    await closeDatabase();
  });

  it("DCR off: POST /api/auth/oauth2/register is 403", async () => {
    const { app } = await baseWithFlags(
      { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_DCR: "false" },
      transport,
    );
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/oauth2/register",
        headers: { origin, "content-type": "application/json" },
        payload: registerBody,
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("AUTH_ENDPOINT_DISABLED");
    } finally {
      await app.close();
    }
  });

  it("DCR on: sixth registration within 60 s is 429", async () => {
    const { app } = await baseWithFlags(
      { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_DCR: "true" },
      transport,
    );
    try {
      const ip = "198.51.100.77";
      for (let i = 0; i < 5; i++) {
        const r = await register(app, ip);
        expect(r.statusCode, r.body).toBe(201);
        registered.push(r.json().client_id);
      }
      const sixth = await register(app, ip);
      expect(sixth.statusCode).toBe(429);
      // Another address has its own budget.
      const other = await register(app, "198.51.100.78");
      expect(other.statusCode).toBe(201);
      registered.push(other.json().client_id);
    } finally {
      await app.close();
    }
  });
});
