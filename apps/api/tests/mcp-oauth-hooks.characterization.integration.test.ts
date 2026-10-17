import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";

// Task 0 (Track M WP-M1) characterization of Better Auth 1.7.10 + the MCP
// OAuth provider. These tests pin the behaviour later tasks rely on (hook
// arguments, referenceId propagation, the missing `resource` case, refresh
// replay). They run against an in-memory adapter and need no Orbit database,
// so they are not gated on TEST_DATABASE_URL. Orbit's own auth instance
// (basePath "/api/auth") is mirrored; nothing here ships.

const ORIGIN = "http://localhost:3999";
const BASE_PATH = "/api/auth";
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = "https://client.test/client.json";
const REDIRECT_URI = "https://client.test/callback";
const SCOPES = "openid offline_access mcp:tools";

type Json = Record<string, unknown>;
type Recorded = {
  shouldRedirect: Json[];
  consentReferenceId: Json[];
  claims: Json[];
  afterToken: { path: string; returned: unknown }[];
};

// The memory adapter needs every model registered up front. These are the
// models of core + jwt + mcp (oauth provider) + cimd; beforeAll also adds any
// other table of the merged schema and records the list for the plan.
const db: Record<string, Json[]> = Object.fromEntries(
  [
    "user",
    "session",
    "account",
    "verification",
    "jwks",
    "oauthClient",
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthConsent",
    "oauthClientAssertion",
    "oauthResource",
    "oauthClientResource",
  ].map((name) => [name, []]),
);
const modelNames: string[] = [];
const rec: Recorded = {
  shouldRedirect: [],
  consentReferenceId: [],
  claims: [],
  afterToken: [],
};
// Mirrors how Orbit will use the hooks: the pending selection is keyed by the
// session id the hooks receive. `ws-<sessionId>` stands in for a workspace id.
const selected = new Set<string>();

const cimdDocument = {
  client_id: CLIENT_ID,
  client_name: "Characterization client",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: SCOPES,
};

// Audit seam: a global before hook sees the presented refresh token before the
// provider mutates anything, a global after hook sees the provider's answer.
type ReplayAudit = {
  presentedRowRevoked: boolean;
  rotationWindowOpen: boolean;
  userId?: unknown;
  clientId?: unknown;
  referenceId?: unknown;
};
const audit: { before: ReplayAudit[]; after: Json[] } = {
  before: [],
  after: [],
};

const makeCharacterizationAuth = (
  database: Record<string, Json[]>,
  extra: { disabledPaths?: string[] } = {},
) =>
  betterAuth({
    database: memoryAdapter(database),
    ...extra,
    secret: "characterization-secret-characterization-secret",
    baseURL: ORIGIN,
    basePath: BASE_PATH,
    trustedOrigins: [ORIGIN],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = ctx.body as {
          grant_type?: string;
          refresh_token?: string;
        };
        if (
          ctx.path !== "/oauth2/token" ||
          body?.grant_type !== "refresh_token"
        )
          return;
        // Refresh tokens are stored as the unsalted SHA-256 (base64url) hash.
        const row = await ctx.context.adapter.findOne<Json>({
          model: "oauthRefreshToken",
          where: [
            {
              field: "token",
              value: createHash("sha256")
                .update(body.refresh_token ?? "")
                .digest("base64url"),
            },
          ],
        });
        audit.before.push({
          presentedRowRevoked: Boolean(row?.revoked),
          rotationWindowOpen:
            row?.rotationReplayExpiresAt instanceof Date &&
            row.rotationReplayExpiresAt.getTime() >= Date.now(),
          userId: row?.userId,
          clientId: row?.clientId,
          referenceId: row?.referenceId,
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/oauth2/token") {
          rec.afterToken.push({
            path: ctx.path,
            returned: ctx.context.returned,
          });
          audit.after.push({ returned: ctx.context.returned as Json });
        }
      }),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: RESOURCE,
        scopes: ["openid", "offline_access", "mcp:tools"],
        accessTokenExpiresIn: 600,
        postLogin: {
          page: "/select-workspace",
          shouldRedirect: (context) => {
            rec.shouldRedirect.push(context as unknown as Json);
            return !selected.has(context.session.id);
          },
          consentReferenceId: (context) => {
            rec.consentReferenceId.push(context as unknown as Json);
            return `ws-${context.session.id}`;
          },
        },
        customAccessTokenClaims: (info) => {
          rec.claims.push(info as unknown as Json);
          return { referenceId: info.referenceId ?? null };
        },
      }),
      cimd({
        metadataProfile: "mcp-2026-07-28",
        fetchClientMetadataResource: async (input) => {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          if (url.href === CLIENT_ID)
            return new Response(JSON.stringify(cimdDocument), {
              headers: {
                "content-type": "application/json",
                "cache-control": "max-age=3600",
              },
            });
          return new Response("not found", { status: 404 });
        },
      }),
    ],
  });

const auth = makeCharacterizationAuth(db);

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("origin", ORIGIN);
  if (cookie) headers.set("cookie", cookie);
  return auth.handler(new Request(`${ORIGIN}${path}`, { ...rest, headers }));
};

const postJson = (path: string, body: unknown, cookie?: string) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cookie,
  });

const postForm = (path: string, form: Record<string, string>) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function signIn(email: string) {
  const up = await postJson(`${BASE_PATH}/sign-up/email`, {
    email,
    name: "Characterization",
    password: "correct horse battery staple",
  });
  expect(up.status).toBe(200);
  const cookie = cookieFrom(up);
  expect(cookie).toContain("session_token");
  return cookie;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

const jwtPayload = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

type FlowStep = { step: string; location: string };
type Flow = {
  steps: FlowStep[];
  code?: string;
  error?: string;
  errorDescription?: string;
  verifier: string;
  finalUrl: URL;
};

/**
 * Drives authorize -> post-login selection -> consent -> redirect_uri the
 * way a browser would, following the signed `oauth_query` between pages.
 */
async function authorizeFlow(
  cookie: string,
  opts: { resource?: string | null; markSelected?: boolean } = {},
): Promise<Flow> {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (opts.resource !== null) params.set("resource", opts.resource ?? RESOURCE);
  const steps: FlowStep[] = [];
  let res = await call(`${BASE_PATH}/oauth2/authorize?${params}`, { cookie });
  for (let i = 0; i < 8; i++) {
    const location =
      res.headers.get("location") ??
      (
        (await res
          .clone()
          .json()
          .catch(() => ({}))) as { url?: string }
      ).url ??
      "";
    const url = new URL(location, ORIGIN);
    const base = `${url.origin}${url.pathname}`;
    if (base === REDIRECT_URI || location.startsWith(REDIRECT_URI)) {
      steps.push({ step: "redirect_uri", location });
      return {
        steps,
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription:
          url.searchParams.get("error_description") ?? undefined,
        verifier,
        finalUrl: url,
      };
    }
    steps.push({ step: url.pathname, location });
    const oauthQuery = url.search.slice(1);
    if (url.pathname === "/select-workspace") {
      if (opts.markSelected !== false) {
        const sessionId = (rec.shouldRedirect.at(-1)!.session as { id: string })
          .id;
        selected.add(sessionId);
      }
      res = await postJson(
        `${BASE_PATH}/oauth2/continue`,
        { postLogin: true, oauth_query: oauthQuery },
        cookie,
      );
    } else if (url.pathname === "/consent") {
      res = await postJson(
        `${BASE_PATH}/oauth2/consent`,
        { accept: true, oauth_query: oauthQuery },
        cookie,
      );
    } else {
      throw new Error(`unexpected step ${location}`);
    }
  }
  throw new Error(`flow did not finish: ${JSON.stringify(steps)}`);
}

const exchangeCode = (flow: Flow, resource: string | null = RESOURCE) =>
  postForm(`${BASE_PATH}/oauth2/token`, {
    grant_type: "authorization_code",
    code: flow.code!,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: flow.verifier,
    ...(resource ? { resource } : {}),
  });

const refresh = (refreshToken: string, resource?: string) =>
  postForm(`${BASE_PATH}/oauth2/token`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...(resource ? { resource } : {}),
  });

describe("Better Auth 1.7.10 MCP/OAuth characterization", () => {
  let cookie: string;
  let sessionId: string;

  beforeAll(async () => {
    // Derived from the merged schema, so it also documents which tables
    // WP-M1 adds.
    const context = await auth.$context;
    for (const table of Object.values(context.tables))
      db[table.modelName] ??= [];
    modelNames.push(...Object.keys(db).sort());
    cookie = await signIn("char-1@example.test");
    const session = (await (
      await call(`${BASE_PATH}/get-session`, { cookie })
    ).json()) as { session: { id: string } };
    sessionId = session.session.id;
  });

  it("jwt() with disableSettingJwtHeader leaves session responses without set-auth-jwt, but exposes GET /token unless the path is disabled", async () => {
    const res = await call(`${BASE_PATH}/get-session`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-jwt")).toBeNull();
    // Observed: jwt() registers GET /token (session -> JWT). WP-M1 must keep it
    // closed with `disabledPaths: ["/token"]`.
    const open = await call(`${BASE_PATH}/token`, { cookie });
    expect(open.status).toBe(200);
    expect(((await open.json()) as Json).token).toBeTruthy();

    const closedDb: Record<string, Json[]> = {};
    for (const name of Object.keys(db)) closedDb[name] = [];
    const closed = makeCharacterizationAuth(closedDb, {
      disabledPaths: ["/token"],
    });
    const signUp = await closed.handler(
      new Request(`${ORIGIN}${BASE_PATH}/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          email: "char-closed@example.test",
          name: "Closed",
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const blocked = await closed.handler(
      new Request(`${ORIGIN}${BASE_PATH}/token`, {
        headers: { cookie: cookieFrom(signUp), origin: ORIGIN },
      }),
    );
    expect(blocked.status).toBe(404);
    // The JWKS endpoint stays public; resource servers verify against it.
    const jwks = await closed.handler(
      new Request(`${ORIGIN}${BASE_PATH}/jwks`),
    );
    expect(jwks.status).toBe(200);
  });

  it("publishes discovery with S256, CIMD support and iss in authorization responses", async () => {
    const res = await call(
      `/.well-known/oauth-authorization-server${BASE_PATH}`,
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Json;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.issuer).toBe(`${ORIGIN}${BASE_PATH}`);
    const prm = await call("/.well-known/oauth-protected-resource");
    expect(prm.status).toBe(200);
    expect(((await prm.json()) as Json).resource).toBe(RESOURCE);
  });

  it("shouldRedirect receives headers, user, session (with id), scopes and isContinuation but no client_id", async () => {
    rec.shouldRedirect.length = 0;
    rec.consentReferenceId.length = 0;
    selected.clear();
    const flow = await authorizeFlow(cookie);
    expect(flow.code).toBeTruthy();
    expect(flow.finalUrl.searchParams.get("iss")).toBe(`${ORIGIN}${BASE_PATH}`);

    const [first, second] = rec.shouldRedirect;
    expect(first).toBeDefined();
    expect(Object.keys(first!).sort()).toEqual(
      ["headers", "isContinuation", "scopes", "session", "user"].sort(),
    );
    expect(first!.headers).toBeInstanceOf(Headers);
    expect((first!.session as { id: string }).id).toBe(sessionId);
    expect((first!.user as { email: string }).email).toBe(
      "char-1@example.test",
    );
    expect(first!.scopes).toEqual(SCOPES.split(" "));
    expect(first!.isContinuation).toBe(false);
    // No client id anywhere in the arguments (the user and session objects do
    // not carry one either).
    expect(JSON.stringify([first!.scopes, first!.session])).not.toContain(
      CLIENT_ID,
    );
    // The continuation call after the selection page.
    expect(second!.isContinuation).toBe(true);
    expect((second!.session as { id: string }).id).toBe(sessionId);

    expect(flow.steps.map((s) => s.step)).toEqual([
      "/select-workspace",
      "/consent",
      "redirect_uri",
    ]);

    // consentReferenceId is asked on the authorize pass after the selection,
    // again by the consent endpoint (to store the consent) and once more by
    // the final authorize pass, always with the same session.
    expect(rec.consentReferenceId).toHaveLength(3);
    expect(
      new Set(
        rec.consentReferenceId.map((c) => (c.session as { id: string }).id),
      ),
    ).toEqual(new Set([sessionId]));
  });

  it("signs the oauth_query with an exp of codeExpiresIn (default 600 s) and rejects an altered or expired query", async () => {
    selected.clear();
    const { challenge } = pkce();
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const before = Math.floor(Date.now() / 1000);
    const res = await call(`${BASE_PATH}/oauth2/authorize?${params}`, {
      cookie,
    });
    const location = new URL(res.headers.get("location")!, ORIGIN);
    expect(location.pathname).toBe("/select-workspace");
    const exp = Number(location.searchParams.get("exp"));
    expect(exp - before).toBeGreaterThanOrEqual(599);
    expect(exp - before).toBeLessThanOrEqual(601);
    expect(location.searchParams.get("sig")).toBeTruthy();
    expect(location.searchParams.get("ba_iat")).toBeTruthy();
    expect(location.searchParams.getAll("ba_param").length).toBeGreaterThan(5);

    const tampered = new URLSearchParams(location.search.slice(1));
    tampered.set("state", "other");
    const bad = await postJson(
      `${BASE_PATH}/oauth2/continue`,
      { postLogin: true, oauth_query: tampered.toString() },
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Json).error).toBe("invalid_signature");

    // An expired exp cannot be re-signed without the secret, so it fails the
    // same check.
    const expired = new URLSearchParams(location.search.slice(1));
    expired.set("exp", String(before - 5));
    const expiredRes = await postJson(
      `${BASE_PATH}/oauth2/continue`,
      { postLogin: true, oauth_query: expired.toString() },
      cookie,
    );
    expect(expiredRes.status).toBe(400);
    // No distinct "expired" code: Orbit has to detect expiry itself.
    expect(((await expiredRes.json()) as Json).error).toBe("invalid_signature");
  });

  it("consentReferenceId receives user, session (with id) and scopes, and its result reaches customAccessTokenClaims as referenceId on the code and refresh grants", async () => {
    rec.consentReferenceId.length = 0;
    rec.claims.length = 0;
    selected.clear();
    const flow = await authorizeFlow(cookie);
    expect(flow.code).toBeTruthy();

    // The consent for this session reference already exists from the first
    // flow, so only the authorize pass asks (no consent endpoint call).
    expect(rec.consentReferenceId).toHaveLength(1);
    expect(flow.steps.map((step) => step.step)).toEqual([
      "/select-workspace",
      "redirect_uri",
    ]);
    const ref = rec.consentReferenceId[0]!;
    expect(Object.keys(ref).sort()).toEqual(["scopes", "session", "user"]);
    expect((ref.session as { id: string }).id).toBe(sessionId);
    expect(ref.scopes).toEqual(SCOPES.split(" "));

    const tokenRes = await exchangeCode(flow);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(600);
    const access = jwtPayload(tokens.access_token);
    // openid adds the userinfo endpoint as a second audience.
    expect(access.aud).toEqual([
      RESOURCE,
      `${ORIGIN}${BASE_PATH}/oauth2/userinfo`,
    ]);
    expect(access.iss).toBe(`${ORIGIN}${BASE_PATH}`);
    expect(access.referenceId).toBe(`ws-${sessionId}`);

    const codeClaims = rec.claims.at(-1)!;
    expect(codeClaims.referenceId).toBe(`ws-${sessionId}`);
    expect(Object.keys(codeClaims).sort()).toEqual(
      ["metadata", "referenceId", "resources", "scopes", "user"].sort(),
    );
    expect(codeClaims.resources).toEqual([RESOURCE]);

    rec.claims.length = 0;
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect(jwtPayload(next.access_token).referenceId).toBe(`ws-${sessionId}`);
    expect(jwtPayload(next.access_token).aud).toContain(RESOURCE);
    // consentReferenceId is not asked again on refresh; the stored value is.
    expect(rec.claims).toHaveLength(1);
    expect(rec.claims[0]!.referenceId).toBe(`ws-${sessionId}`);
  });

  it("authorize and token without a resource parameter still succeed but issue an opaque access token with no MCP audience", async () => {
    selected.clear();
    const flow = await authorizeFlow(cookie, { resource: null });
    // No invalid_target: the server does not require `resource`.
    expect(flow.error).toBeUndefined();
    expect(flow.code).toBeTruthy();
    rec.claims.length = 0;
    const res = await exchangeCode(flow, null);
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
    };
    // Opaque (not a three-segment JWT), so requireMcpAuth would reject it, and
    // customAccessTokenClaims is not called for it.
    expect(tokens.access_token.split(".")).toHaveLength(1);
    expect(rec.claims).toHaveLength(0);
    expect(tokens.refresh_token).toBeTruthy();
    // The id_token is a JWT whose audience is the client, never the resource.
    expect(jwtPayload(tokens.id_token!).aud).toBe(CLIENT_ID);
    const refreshed = await refresh(tokens.refresh_token!);
    expect(refreshed.status).toBe(200);
    expect(
      ((await refreshed.json()) as { access_token: string }).access_token.split(
        ".",
      ),
    ).toHaveLength(1);
  });

  it("binds the code to the authorize-time resource and rejects a different or unknown resource at the token and refresh endpoints", async () => {
    selected.clear();
    const flow = await authorizeFlow(cookie);
    // A code obtained for the MCP resource yields the same audience when the
    // token request omits `resource`.
    const noResource = await exchangeCode(flow, null);
    expect(noResource.status).toBe(200);
    const issued = (await noResource.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(jwtPayload(issued.access_token).aud).toContain(RESOURCE);
    const wrongRefresh = await refresh(
      issued.refresh_token,
      "https://evil.test/mcp",
    );
    expect(wrongRefresh.status).toBe(400);
    expect(((await wrongRefresh.json()) as Json).error).toBe("invalid_target");

    selected.clear();
    const second = await authorizeFlow(cookie);
    const wrongCode = await exchangeCode(second, "https://evil.test/mcp");
    expect(wrongCode.status).toBe(400);
    expect(((await wrongCode.json()) as Json).error).toBe("invalid_target");

    // An unknown resource is refused at authorize time, redirected to the
    // client with invalid_target.
    selected.clear();
    const unknown = await authorizeFlow(cookie, {
      resource: "https://evil.test/mcp",
    });
    expect(unknown.error).toBe("invalid_target");
    expect(unknown.code).toBeUndefined();
  });

  it("replay of a rotated refresh token after the reuse interval fails with invalid_grant, deletes every token of the client and user, and is visible only to global before/after hooks", async () => {
    selected.clear();
    const flow = await authorizeFlow(cookie);
    const first = (await (await exchangeCode(flow)).json()) as {
      refresh_token: string;
    };
    const rotated = await refresh(first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as { refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Stored hashed: the row holds the SHA-256 (base64url) of the token.
    const hashed = createHash("sha256")
      .update(first.refresh_token)
      .digest("base64url");
    expect(db.oauthRefreshToken!.some((r) => r.token === hashed)).toBe(true);
    expect(
      db.oauthRefreshToken!.some((r) => r.token === first.refresh_token),
    ).toBe(false);

    // Within the 30 s reuse interval (mcp() default) the old token returns a
    // replay of the rotated response instead of failing.
    audit.before.length = 0;
    const within = await refresh(first.refresh_token);
    expect(within.status).toBe(200);
    expect(audit.before.at(-1)).toMatchObject({
      presentedRowRevoked: true,
      rotationWindowOpen: true,
    });

    // Move the replay window into the past instead of sleeping 30 s. The
    // adapter swaps the table array on deletes, so re-read it each time.
    const userId = db.oauthRefreshToken![0]!.userId;
    expect(db.oauthRefreshToken!.length).toBeGreaterThanOrEqual(2);
    expect(db.oauthAccessToken!.length).toBeGreaterThanOrEqual(1);
    for (const row of db.oauthRefreshToken!)
      if (row.rotationReplayExpiresAt)
        row.rotationReplayExpiresAt = new Date(Date.now() - 1000);

    audit.before.length = 0;
    audit.after.length = 0;
    const replay = await refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as Json;
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBe("invalid refresh token");

    // Everything the client holds for this user is gone, not only the family
    // of the replayed token (other sessions and workspaces included), and the
    // access tokens linked to those refresh tokens went with it.
    expect(
      db.oauthRefreshToken!.filter(
        (r) => r.clientId === CLIENT_ID && r.userId === userId,
      ),
    ).toHaveLength(0);
    expect(db.oauthAccessToken!).toHaveLength(0);
    const newest = await refresh(second.refresh_token);
    expect(newest.status).toBe(400);
    expect(((await newest.json()) as Json).error).toBe("invalid_grant");

    // Audit seam: the provider has no replay hook or distinct error code (an
    // expired token and a client mismatch answer with the same description).
    // A global `before` hook can classify the attempt from the stored row
    // before the provider deletes it; the `after` hook sees the APIError.
    expect(audit.before[0]).toMatchObject({
      presentedRowRevoked: true,
      rotationWindowOpen: false,
      userId,
      clientId: CLIENT_ID,
      referenceId: `ws-${sessionId}`,
    });
    const returned = audit.after[0]!.returned as unknown as {
      statusCode: number;
      body: Json;
    };
    expect(returned.statusCode).toBe(400);
    expect(returned.body).toEqual({
      error: "invalid_grant",
      error_description: "invalid refresh token",
    });
  });
});
