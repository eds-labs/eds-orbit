import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, type McpOptions } from "@better-auth/mcp";
import type { Config } from "../../../../../packages/config/src/index.ts";

// Orbit as OAuth 2.1 authorization server for MCP clients (Track M, WP-M1).
// This file only wires Better Auth's plugins; it holds no business logic.
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

type PostLoginArgs = { session: { id: string }; user: { id: string } };

/** The transport type the CIMD plugin accepts; the standard `fetch` satisfies it. */
export type MetadataResourceFetch = Parameters<
  typeof cimd
>[0]["fetchClientMetadataResource"];

export type McpAuthDeps = {
  /** Transport for Client ID Metadata Documents (resolve-once DNS, no redirects). */
  fetchClientMetadataResource: MetadataResourceFetch;
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
      typeof referenceId === "string" && referenceId !== ""
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
    },
  };
}

export function mcpAuthPlugins(config: Config, deps: McpAuthDeps) {
  const options = mcpAuthPluginOptions(config, deps);
  return [jwt(options.jwt), mcp(options.mcp), cimd(options.cimd)] as const;
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
