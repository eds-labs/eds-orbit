import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, type McpOptions } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import {
  normalizeMcpResource,
  type Config,
} from "../../../../../packages/config/src/index.ts";

// Orbit as OAuth 2.1 authorization server for MCP clients (Track M, WP-M1).
// This file wires Better Auth's plugins (options, CIMD host policy, client
// change detection) and holds the global hooks that enforce grants on the
// OAuth endpoints (`resource` on authorize, refresh only with an active grant,
// selection activation on consent, hand-off of denials, issued codes and
// refresh replays); the grant bookkeeping itself lives in grants.ts. It holds
// no business logic of the product modules.
// Everything here is registered only behind ORBIT_MCP_OAUTH (see tenancy/auth.ts).

/** `orbit:read` and `orbit:propose` only narrow what the user may do in the UI. */
export const MCP_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "orbit:read",
  "orbit:propose",
] as const;

/** Access-token claim naming the workspace the user granted (consent referenceId). */
export const ORBIT_WORKSPACE_CLAIM = "orbit_workspace_id";

/**
 * Consent reference used while the session's selection is still pending. No
 * consent is ever stored under it, so Better Auth always shows the consent
 * page instead of issuing a code for a grant that is not active.
 */
export const PENDING_REFERENCE_PREFIX = "pending:";

type PostLoginArgs = { session: { id: string }; user: { id: string } };

/**
 * Authorization parameters the provider never rewrites while it handles one
 * authorization request. The signature, its expiry and issue time, the
 * post-login marker and the signed-parameter list change with every re-sign;
 * `scope`, `claims`, `prompt` and `max_age` are narrowed or removed by the
 * consent and sign-in passes.
 */
const REQUEST_BINDING_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "resource",
] as const;

/**
 * Fingerprint of one authorization request (WP-M5): SHA-256 (base64url) over
 * the stable authorization parameters of a signed OAuth query or of the
 * provider's request state. A selection stores it and only serves the request
 * it was made for, so a selection made under one authorization (its PKCE
 * challenge and state) is never consumed by another one of the same session
 * and client. Holds no token material.
 */
export function authorizationRequestHash(query: string | URLSearchParams) {
  const params = new URLSearchParams(query);
  const stable = REQUEST_BINDING_PARAMS.map((name) => [
    name,
    params.getAll(name),
  ]);
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("base64url");
}

/** The transport type the CIMD plugin accepts; the standard `fetch` satisfies it. */
export type MetadataResourceFetch = Parameters<
  typeof cimd
>[0]["fetchClientMetadataResource"];

/**
 * What Orbit does when a Client ID Metadata Document client appears or
 * changes (implemented in grants.ts). Better Auth calls these on a best-effort
 * basis: a failure is logged and never fails the OAuth request.
 */
export type McpClientDeps = {
  /** A client was stored for the first time. */
  onClientCreated: (args: { clientId: string }) => Promise<void>;
  /**
   * A known client was reconciled with its document; `changed` names the
   * security-relevant fields that differ (see `changedClientFields`).
   */
  onClientRefreshed: (args: {
    clientId: string;
    changed: string[];
  }) => Promise<void>;
};

export type McpAuthDeps = {
  /** Transport for Client ID Metadata Documents (resolve-once DNS, no redirects). */
  fetchClientMetadataResource: MetadataResourceFetch;
  /** Audit and revocation for discovered clients; absent in bare setups. */
  clientEvents?: McpClientDeps;
  /** Workspace the session selected for the consent being given (Task 4). */
  consentReference: (args: PostLoginArgs) => Promise<string | undefined>;
  /** Whether the user still has to pick a workspace on /connect (Task 4). */
  shouldRedirect: (args: PostLoginArgs) => Promise<boolean>;
};

/**
 * Fail-closed defaults until the workspace selection exists (Task 4): every
 * authorization is sent to /connect and no consent can be recorded.
 */
export function mcpAuthDeps(options: { cimdFetch?: typeof fetch } = {}) {
  return {
    fetchClientMetadataResource:
      options.cimdFetch ?? fetchClientMetadataResource,
    shouldRedirect: async () => true,
    consentReference: async () => {
      throw new APIError("BAD_REQUEST", {
        error: "set_workspace",
        error_description: "select a workspace first",
      });
    },
  } satisfies McpAuthDeps;
}

/** `ORBIT_MCP_CIMD_HOSTS` as a lower-cased list without empty entries. */
export function cimdHosts(value: string) {
  return value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** A metadata document may only come from an allowed host or one of its subdomains. */
export function isCimdHostAllowed(clientIdUrl: string, hosts: string[]) {
  let hostname: string;
  try {
    hostname = new URL(clientIdUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

/** The stored client fields a metadata refresh can change. */
type ClientRecord = {
  name?: string | null;
  uri?: string | null;
  redirectUris?: string[] | null;
  postLogoutRedirectUris?: string[] | null;
  jwksUri?: string | null;
  jwks?: string | null;
  tokenEndpointAuthMethod?: string | null;
  grantTypes?: string[] | null;
  scopes?: string[] | null;
};

/** Stable text of a JSON value, so key order never counts as a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function canonicalDocument(value: string | null | undefined) {
  if (!value) return "";
  try {
    return canonicalJson(JSON.parse(value));
  } catch {
    return value;
  }
}

const sortedSet = (value: string[] | null | undefined) =>
  JSON.stringify([...new Set(value ?? [])].sort());

/** Metadata names (RFC 7591) of the client fields that differ; names only, never values. */
export function changedClientFields(
  previous: ClientRecord,
  current: ClientRecord,
): string[] {
  const fields: [string, (c: ClientRecord) => string][] = [
    ["client_name", (c) => c.name ?? ""],
    ["client_uri", (c) => c.uri ?? ""],
    ["redirect_uris", (c) => sortedSet(c.redirectUris)],
    ["post_logout_redirect_uris", (c) => sortedSet(c.postLogoutRedirectUris)],
    ["jwks_uri", (c) => c.jwksUri ?? ""],
    ["jwks", (c) => canonicalDocument(c.jwks)],
    ["token_endpoint_auth_method", (c) => c.tokenEndpointAuthMethod ?? ""],
    ["grant_types", (c) => sortedSet(c.grantTypes)],
    ["scope", (c) => sortedSet(c.scopes)],
  ];
  return fields
    .filter(([, read]) => read(previous) !== read(current))
    .map(([name]) => name);
}

export function mcpAuthPluginOptions(config: Config, deps: McpAuthDeps) {
  const hosts = cimdHosts(config.ORBIT_MCP_CIMD_HOSTS);
  const dcr = config.ORBIT_MCP_DCR === "true";
  const scopes = [...MCP_SCOPES];
  const mcpOptions = {
    resource: config.MCP_RESOURCE,
    scopes,
    resources: [
      { identifier: config.MCP_RESOURCE, allowedScopes: [...MCP_SCOPES] },
    ],
    // Authorization code with PKCE plus refresh; no client credentials.
    grantTypes: ["authorization_code", "refresh_token"],
    accessTokenExpiresIn: 600,
    refreshTokenReuseInterval: 30,
    loginPage: "/connect/login",
    consentPage: "/connect",
    postLogin: {
      page: "/connect",
      shouldRedirect: ({ session, user }) =>
        deps.shouldRedirect({ session, user }),
      consentReferenceId: ({ session, user }) =>
        deps.consentReference({ session, user }),
    },
    customAccessTokenClaims: ({ referenceId }) =>
      typeof referenceId === "string" &&
      referenceId !== "" &&
      !referenceId.startsWith(PENDING_REFERENCE_PREFIX)
        ? { [ORBIT_WORKSPACE_CLAIM]: referenceId }
        : {},
    allowDynamicClientRegistration: dcr,
    allowUnauthenticatedClientRegistration: dcr,
    ...(dcr
      ? { clientRegistrationDefaultApplicationType: "infer" as const }
      : {}),
  } satisfies McpOptions;
  return {
    // The session JWT stays out of session responses; /token is disabled in auth.ts.
    jwt: { disableSettingJwtHeader: true } as const,
    mcp: mcpOptions,
    cimd: {
      metadataProfile: "mcp-2026-07-28" as const,
      fetchClientMetadataResource: deps.fetchClientMetadataResource,
      isMetadataDocumentUrlAllowed: (clientIdUrl: string) =>
        isCimdHostAllowed(clientIdUrl, hosts),
      ...(deps.clientEvents
        ? {
            onClientCreated: async ({
              client,
            }: {
              client: ClientRecord & { clientId: string };
            }) =>
              deps.clientEvents!.onClientCreated({ clientId: client.clientId }),
            onClientRefreshed: async ({
              client,
              previousClient,
            }: {
              client: ClientRecord & { clientId: string };
              previousClient: ClientRecord;
            }) =>
              deps.clientEvents!.onClientRefreshed({
                clientId: client.clientId,
                changed: changedClientFields(previousClient, client),
              }),
          }
        : {}),
    },
  };
}

export function mcpAuthPlugins(config: Config, deps: McpAuthDeps) {
  const options = mcpAuthPluginOptions(config, deps);
  return [jwt(options.jwt), mcp(options.mcp), cimd(options.cimd)] as const;
}

/** Grant bookkeeping the global hooks hand off to (implemented in grants.ts). */
export type McpHookDeps = {
  /**
   * The user accepted the consent page (before the provider stores consent
   * and issues the code): the session's selection must become active here.
   */
  onConsentAccepted: (args: {
    userId: string;
    sessionId: string;
    clientId: string;
    scopes: string[];
    /** `authorizationRequestHash` of the signed query being consented to. */
    requestHash: string;
  }) => Promise<void>;
  /** The user denied; the client comes from the provider's request state. */
  onConsentDenied: (args: {
    userId: string;
    sessionId: string;
  }) => Promise<void>;
  /**
   * An authorization code was issued for this session's authorization.
   * Returns false unless the selection is active; the hook then withholds the
   * code from the client.
   */
  onCodeIssued: (args: { sessionId: string }) => Promise<boolean>;
  /**
   * Whether a refresh token may still be exchanged: an active grant exists for
   * (user, client, workspace the token was issued for), and none of that
   * reference was revoked after the token was issued.
   */
  refreshAllowed: (args: {
    userId: string;
    clientId: string;
    referenceId?: string;
    issuedAt: Date;
  }) => Promise<boolean>;
  /**
   * The token endpoint minted tokens for (user, client, reference). Returns
   * false, after deleting the stored tokens of that reference, unless an
   * active grant backs them and no grant of that reference was revoked since
   * `checkedAt` (when this token request started); the hook then answers
   * `invalid_grant`.
   */
  onTokensIssued: (args: {
    userId: string;
    clientId: string;
    referenceId?: string;
    checkedAt: Date;
  }) => Promise<boolean>;
  /** A rotated refresh token was replayed after the reuse window. */
  onRefreshReplay: (args: {
    userId: string;
    clientId: string;
    referenceId?: string;
    error: string;
  }) => Promise<void>;
};

/**
 * Endpoints whose answer can carry an authorization code to the client. The
 * provider's internal authorize passes (marked by `authorizeSettings`) run
 * inside continue and consent, whose hooks see their code; only a top-level
 * authorize counts on its own (an unconsumed selection with stored consent).
 * A sign-in that resumes an authorization never issues a code here: its new
 * session has no selection yet.
 */
function mayIssueCode(ctx: { path: string; authorizeSettings?: unknown }) {
  if (ctx.path === "/oauth2/authorize")
    return ctx.authorizeSettings === undefined;
  return ctx.path === "/oauth2/continue" || ctx.path === "/oauth2/consent";
}

type Returned = {
  statusCode?: unknown;
  body?: { error?: unknown };
  redirect?: unknown;
  url?: unknown;
};

/** The OAuth error code of a failed endpoint result, if it failed. */
function oauthError(returned: unknown) {
  const r = returned as Returned | undefined;
  return typeof r?.statusCode === "number" &&
    r.statusCode >= 400 &&
    typeof r.body?.error === "string"
    ? r.body.error
    : undefined;
}

/** Whether the endpoint answered with a thrown redirect (3xx APIError). */
function isRedirectError(returned: unknown) {
  const r = returned as Returned | undefined;
  return (
    typeof r?.statusCode === "number" &&
    r.statusCode >= 300 &&
    r.statusCode < 400
  );
}

/** Where the endpoint sends the browser: a JSON redirect or a Location header. */
function redirectTarget(returned: unknown, headers: Headers | undefined) {
  const r = returned as Returned | undefined;
  if (r?.redirect === true && typeof r.url === "string") return r.url;
  return headers?.get("location") ?? undefined;
}

/** Whether the redirect hands an authorization code to the client (absolute URL with `code`). */
function carriesCode(target: string | undefined) {
  if (!target) return false;
  try {
    return new URL(target).searchParams.has("code");
  } catch {
    return false;
  }
}

/** Tokens are stored as their unsalted SHA-256 (base64url). */
const storedTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("base64url");

/** The JSON payload of a JWT, unverified (only for tokens this process just minted). */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as unknown;
    return claims && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type TokenOwner = { userId: string; clientId: string; referenceId?: string };

/**
 * Who a successful token answer was minted for: the stored refresh token's
 * row, else the claims of the JWT access token, else the stored opaque access
 * token's row. Undefined when it cannot be told (the hook then refuses).
 */
async function tokenOwner(
  adapter: {
    findOne: <T>(args: {
      model: string;
      where: { field: string; value: string }[];
    }) => Promise<T | null>;
  },
  body: { access_token?: unknown; refresh_token?: unknown },
  workspaceClaim: string,
): Promise<TokenOwner | undefined> {
  type Row = { userId?: string; clientId: string; referenceId?: string | null };
  const fromRow = (row: Row | null) =>
    row?.userId
      ? {
          userId: row.userId,
          clientId: row.clientId,
          ...(row.referenceId ? { referenceId: row.referenceId } : {}),
        }
      : undefined;
  if (typeof body.refresh_token === "string")
    return fromRow(
      await adapter.findOne<Row>({
        model: "oauthRefreshToken",
        where: [{ field: "token", value: storedTokenHash(body.refresh_token) }],
      }),
    );
  if (typeof body.access_token !== "string") return undefined;
  const claims = jwtClaims(body.access_token);
  if (claims) {
    const reference = claims[workspaceClaim];
    return typeof claims.sub === "string" && typeof claims.azp === "string"
      ? {
          userId: claims.sub,
          clientId: claims.azp,
          ...(typeof reference === "string" ? { referenceId: reference } : {}),
        }
      : undefined;
  }
  return fromRow(
    await adapter.findOne<Row>({
      model: "oauthAccessToken",
      where: [{ field: "token", value: storedTokenHash(body.access_token) }],
    }),
  );
}

/**
 * The canonical MCP resource for a requested one, when it names the same
 * resource (compared normalized, WP-M5); undefined for anything else,
 * including repeated or missing values.
 */
function canonicalResource(requested: unknown, resource: string) {
  return typeof requested === "string" &&
    normalizeMcpResource(requested) === resource
    ? resource
    : undefined;
}

/**
 * Global Better Auth hooks of the OAuth server, registered only while
 * ORBIT_MCP_OAUTH is on:
 * - before `/oauth2/authorize`: `resource` must name MCP_RESOURCE, compared
 *   normalized; another spelling is rewritten to the canonical one, so the
 *   code, the stored consent and the token audience always carry it (the
 *   library would otherwise issue an opaque token without audience);
 * - before `/oauth2/token`: rewrites a `resource` naming MCP_RESOURCE in
 *   another spelling to the canonical one; on refresh, refuses a token
 *   without an active grant (`invalid_grant`, nothing rotated) and remembers
 *   who owns a presented, already rotated refresh token, because the library
 *   deletes the family on replay;
 * - before `/oauth2/consent` (accepted): activates the session's selection
 *   made for this authorization request;
 * - after `/oauth2/token`: tokens minted for a reference without an active
 *   grant are deleted and the answer becomes `invalid_grant` (narrows the
 *   windows between a revocation and a code exchange or refresh rotation that
 *   had already passed their checks);
 * - after: hands denials, issued codes and refresh replays to `deps`.
 */
export function mcpAuthHooks(config: Config, deps: McpHookDeps) {
  const presentedRefresh = new WeakMap<
    Request,
    { userId: string; clientId: string; referenceId?: string }
  >();
  // When each token request started: a revocation after this moment may have
  // raced the code or refresh token the request presented.
  const tokenRequestStarted = new WeakMap<Request, Date>();
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/oauth2/authorize") {
        // A top-level POST reads its parameters from the form body; the
        // provider's internal passes (after selection, consent or sign-in)
        // re-dispatch the verified signed query as `ctx.query`.
        const internal =
          (ctx as { authorizeSettings?: unknown }).authorizeSettings !==
          undefined;
        const fromBody = ctx.method === "POST" && !internal;
        const params = (fromBody ? ctx.body : ctx.query) as
          Record<string, unknown> | undefined;
        const resource = canonicalResource(
          params?.resource,
          config.MCP_RESOURCE,
        );
        if (!resource)
          throw new APIError("BAD_REQUEST", {
            error: "invalid_target",
            error_description: "resource must be the Orbit MCP resource",
          });
        if (params!.resource === resource) return;
        return {
          context: {
            [fromBody ? "body" : "query"]: { ...params, resource },
          },
        };
      }
      if (ctx.path === "/oauth2/consent") {
        // Activate before the provider stores consent and issues the code, so
        // consent is only ever stored for an active grant. A request the
        // provider will reject (bad signature, a scope not requested) is left
        // to it and activates nothing; scopes are parsed exactly as the
        // provider parses them (no filtering of empty tokens).
        const body = ctx.body as {
          accept?: unknown;
          oauth_query?: unknown;
          scope?: unknown;
          claims?: unknown;
        };
        if (body?.accept !== true) return;
        // Orbit's consent page never narrows claims; refusing them keeps
        // every stored consent tied to an activation.
        if (body.claims !== undefined)
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "claims are not supported",
          });
        if (
          typeof body.oauth_query !== "string" ||
          (body.scope !== undefined && typeof body.scope !== "string") ||
          !(await verifyOAuthQueryParams(body.oauth_query, ctx.context.secret))
        )
          return;
        const query = new URLSearchParams(body.oauth_query);
        const clientId = query.get("client_id");
        const requested = query.get("scope")?.split(" ") ?? [];
        const accepted =
          typeof body.scope === "string" ? body.scope.split(" ") : requested;
        if (!clientId || accepted.some((scope) => !requested.includes(scope)))
          return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return;
        await deps.onConsentAccepted({
          userId: session.user.id,
          sessionId: session.session.id,
          clientId,
          scopes: accepted.filter(Boolean),
          requestHash: authorizationRequestHash(query),
        });
        return;
      }
      if (ctx.path !== "/oauth2/token") return;
      if (ctx.request) tokenRequestStarted.set(ctx.request, new Date());
      const body = ctx.body as {
        grant_type?: unknown;
        refresh_token?: unknown;
        resource?: unknown;
      };
      // The library compares the resource exactly against the one bound at
      // authorize (always the canonical spelling, see above).
      const resource = canonicalResource(body?.resource, config.MCP_RESOURCE);
      const rewrite =
        resource && body.resource !== resource
          ? { context: { body: { ...body, resource } } }
          : undefined;
      if (
        body?.grant_type !== "refresh_token" ||
        typeof body.refresh_token !== "string"
      )
        return rewrite;
      const row = await ctx.context.adapter.findOne<{
        userId: string;
        clientId: string;
        referenceId?: string | null;
        createdAt: Date;
        revoked?: Date | null;
      }>({
        model: "oauthRefreshToken",
        where: [
          {
            field: "token",
            value: storedTokenHash(body.refresh_token),
          },
        ],
      });
      if (!row) return rewrite;
      // Nothing is rotated for a token whose grant is gone: this also closes
      // the race with a revocation that deleted the tokens after this
      // request found its row, and keeps a token issued before a revocation
      // from working again after a later grant for the same reference.
      if (
        !(await deps.refreshAllowed({
          userId: row.userId,
          clientId: row.clientId,
          ...(row.referenceId ? { referenceId: row.referenceId } : {}),
          issuedAt: new Date(row.createdAt),
        }))
      )
        throw new APIError("BAD_REQUEST", {
          error: "invalid_grant",
          error_description:
            "the grant behind this refresh token is not active",
        });
      if (row.revoked && ctx.request)
        presentedRefresh.set(ctx.request, {
          userId: row.userId,
          clientId: row.clientId,
          ...(row.referenceId ? { referenceId: row.referenceId } : {}),
        });
      return rewrite;
    }),
    after: createAuthMiddleware(async (ctx) => {
      const returned = ctx.context.returned;
      if (ctx.path === "/oauth2/token") {
        const presented = ctx.request
          ? presentedRefresh.get(ctx.request)
          : undefined;
        const error = oauthError(returned);
        if (presented && error === "invalid_grant")
          await deps.onRefreshReplay({ ...presented, error });
        const body = returned as
          { access_token?: unknown; refresh_token?: unknown } | undefined;
        if (error || typeof body?.access_token !== "string") return;
        // A revocation can commit after this request passed its checks (the
        // code was consumed, or the refresh check ran) and before the library
        // stored the new tokens, which its cleanup then missed. Checked again
        // now that they exist; refused tokens are deleted and never answered.
        const owner = await tokenOwner(
          ctx.context.adapter,
          body,
          ORBIT_WORKSPACE_CLAIM,
        );
        // Without a request (direct server calls, which Orbit makes none of)
        // only the active grant is checked.
        const checkedAt =
          (ctx.request && tokenRequestStarted.get(ctx.request)) || new Date();
        if (owner && (await deps.onTokensIssued({ ...owner, checkedAt })))
          return;
        throw new APIError("BAD_REQUEST", {
          error: "invalid_grant",
          error_description:
            "the grant behind this authorization is not active",
        });
      }
      if (!mayIssueCode(ctx) || oauthError(returned)) return;
      const target = redirectTarget(returned, ctx.context.responseHeaders);
      const consentAnswered = ctx.path === "/oauth2/consent";
      const denied =
        consentAnswered && (ctx.body as { accept?: unknown })?.accept !== true;
      if (!denied && !carriesCode(target)) return;
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const sessionId = session.session.id;
      if (denied)
        return deps.onConsentDenied({ userId: session.user.id, sessionId });
      if (await deps.onCodeIssued({ sessionId })) return;
      // Refused: the code must not reach the client. A thrown redirect keeps
      // its 302 status and Location when a hook only throws, so drop the
      // Location and answer with a plain 400 Response instead.
      ctx.context.responseHeaders?.delete("location");
      const refusal = {
        error: "consent_required",
        error_description: "the selection is not an active grant",
      };
      if (isRedirectError(returned))
        return new Response(JSON.stringify(refusal), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      throw new APIError("BAD_REQUEST", refusal);
    }),
  };
}

export type McpAuthPlugins = ReturnType<typeof mcpAuthPlugins>;
type McpAuth = ReturnType<typeof betterAuth<{ plugins: [...McpAuthPlugins] }>>;

/**
 * The only place that narrows the conditional plugin list: callers get the
 * typed provider API, or an error when ORBIT_MCP_OAUTH is off.
 */
export function oauthApi(auth: {
  options: { plugins?: readonly { id: string }[] };
  api: unknown;
}): McpAuth["api"] {
  const registered = (auth.options.plugins ?? []).some(
    (plugin) => plugin.id === "oauth-provider",
  );
  if (!registered)
    throw new Error(
      "The OAuth provider is not registered: ORBIT_MCP_OAUTH is off",
    );
  return auth.api as McpAuth["api"];
}
