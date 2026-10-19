import { createHash, randomBytes } from "node:crypto";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";

// Shared drivers for the MCP OAuth integration tests (Track M, WP-M1): build
// the app with the flags set, serve CIMD client documents in-process, and walk
// the browser flow (authorize -> /connect selection -> consent -> code ->
// token -> refresh) through the real Fastify app. Test support only.

export const origin = process.env.APP_ORIGIN!;
export const ISSUER = `${origin}/api/auth`;
export const REDIRECT_URI = "https://client.test/cb";
export const SCOPES =
  "openid email profile offline_access orbit:read orbit:propose";
export const FORM = { "content-type": "application/x-www-form-urlencoded" };

export type Json = Record<string, any>;
type App = Awaited<ReturnType<typeof buildServer>>;

const FLAG_KEYS = [
  "ORBIT_MCP_OAUTH",
  "ORBIT_MCP_DCR",
  "ORBIT_MCP_CIMD_HOSTS",
] as const;

/** A CIMD client document (RFC draft: the client id is its metadata URL). */
export const metadata = (clientId: string, extra: Json = {}) => ({
  client_id: clientId,
  client_name: `Synthetic ${new URL(clientId).pathname}`,
  client_uri: "https://client.test",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: SCOPES,
  ...extra,
});

/** A fetch that serves the given client documents and nothing else. */
export const cimdFetchFor = (documents: Record<string, Json>) =>
  (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const document = documents[url];
    return document
      ? new Response(JSON.stringify(document), {
          headers: {
            "content-type": "application/json",
            "cache-control": "max-age=3600",
          },
        })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;

/** Builds the app (and Better Auth) with the given flags, then restores the env. */
export async function withFlags(
  flags: Partial<Record<(typeof FLAG_KEYS)[number], string>>,
  cimdFetch: typeof fetch,
) {
  const saved = Object.fromEntries(FLAG_KEYS.map((k) => [k, process.env[k]]));
  for (const k of FLAG_KEYS) delete process.env[k];
  Object.assign(process.env, flags);
  try {
    return {
      app: await buildServer(undefined, { cimdFetch }),
      auth: makeAuth({ cimdFetch }),
      config: loadConfig(),
    };
  } finally {
    for (const k of FLAG_KEYS)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

/** A fresh documentation address per request: no request shares a rate-limit bucket. */
export const clientIp = () =>
  `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

export const jwtPayload = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

export const queryOf = (url: URL) => url.search.slice(1);

export type Flow = { steps: string[]; final: URL; verifier: string };

/**
 * Drives the browser flow as whoever `cookie()` names. Everything is read
 * lazily, so a test can swap the session (or the app) between calls.
 */
export function createFlowDriver(ctx: {
  app: () => App;
  config: () => ReturnType<typeof loadConfig>;
  cookie: () => string;
  /** What /connect selects unless a test overrides it. */
  selection: () => { workspaceId: string; projectIds: string[] };
  defaultClientId: string;
}) {
  const inject = (opts: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
    session?: boolean;
    noOrigin?: boolean;
  }) =>
    ctx.app().inject({
      method: opts.method ?? "GET",
      url: opts.url,
      headers: {
        [CLIENT_IP_HEADER]: clientIp(),
        ...(opts.method && opts.method !== "GET" && !opts.noOrigin
          ? { origin }
          : {}),
        ...(opts.session === false ? {} : { cookie: ctx.cookie() }),
        ...opts.headers,
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
    });

  /** GET /oauth2/authorize; returns where Better Auth sends the browser. */
  async function authorize(overrides: Record<string, string | null> = {}) {
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams();
    const values: Record<string, string | null> = {
      client_id: ctx.defaultClientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: ctx.config().MCP_RESOURCE,
      ...overrides,
    };
    for (const [k, v] of Object.entries(values))
      if (v !== null) params.set(k, v);
    const response = await inject({
      url: `/api/auth/oauth2/authorize?${params}`,
    });
    const location = response.headers.location as string | undefined;
    return {
      response,
      verifier,
      location: location ? new URL(location, origin) : undefined,
    };
  }

  async function select(oauthQuery: string, body: Json = {}) {
    return inject({
      method: "POST",
      url: "/api/mcp-connect/selection",
      payload: { oauthQuery, ...ctx.selection(), ...body },
    });
  }

  async function consent(oauthQuery: string, body: Json = {}) {
    return inject({
      method: "POST",
      url: "/api/mcp-connect/consent",
      payload: { oauthQuery, accept: true, scopes: SCOPES.split(" "), ...body },
    });
  }

  /** Drives the whole browser flow up to the client's redirect_uri. */
  async function connect(
    options: {
      clientId?: string;
      selection?: Json;
      consent?: Json;
      scope?: string;
    } = {},
  ): Promise<Flow> {
    const { location, verifier } = await authorize({
      client_id: options.clientId ?? ctx.defaultClientId,
      ...(options.scope ? { scope: options.scope } : {}),
    });
    if (location?.pathname !== "/connect")
      throw new Error(`authorize did not reach /connect: ${location}`);
    const steps = ["select"];
    const request = await inject({
      url: `/api/mcp-connect/request?${queryOf(location)}`,
    });
    if (request.statusCode !== 200)
      throw new Error(`connect request ${request.statusCode}: ${request.body}`);
    const selected = await select(queryOf(location), options.selection);
    if (selected.statusCode !== 200)
      throw new Error(`selection ${selected.statusCode}: ${selected.body}`);
    let next = new URL(selected.json().next, origin);
    if (next.pathname === "/connect") {
      steps.push("consent");
      const consented = await consent(queryOf(next), options.consent);
      if (consented.statusCode !== 200)
        throw new Error(`consent ${consented.statusCode}: ${consented.body}`);
      next = new URL(consented.json().redirect);
    }
    steps.push("redirect_uri");
    return { steps, final: next, verifier };
  }

  const exchange = (flow: Flow, extra: Record<string, string> = {}) =>
    inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      session: false,
      noOrigin: true,
      headers: FORM,
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: flow.final.searchParams.get("code")!,
        redirect_uri: REDIRECT_URI,
        client_id: ctx.defaultClientId,
        code_verifier: flow.verifier,
        resource: ctx.config().MCP_RESOURCE,
        ...extra,
      }).toString(),
    });

  const refresh = (refreshToken: string, clientId = ctx.defaultClientId) =>
    inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      session: false,
      noOrigin: true,
      headers: FORM,
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });

  return { inject, authorize, select, consent, connect, exchange, refresh };
}
