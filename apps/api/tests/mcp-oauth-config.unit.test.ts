import { afterEach, describe, expect, it } from "vitest";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { APIError } from "better-auth/api";
import { makeAuth } from "../src/platform/tenancy/auth.ts";
import {
  MCP_SCOPES,
  ORBIT_WORKSPACE_CLAIM,
  isCimdHostAllowed,
  mcpAuthDeps,
  mcpAuthPluginOptions,
  oauthApi,
} from "../src/platform/mcp-auth/plugins.ts";
import { authRequestHeaders } from "../src/platform/mcp-auth/http.ts";
import {
  loadConfig,
  normalizeMcpResource,
} from "../../../packages/config/src/index.ts";

const ENV_KEYS = [
  "ORBIT_MCP_OAUTH",
  "ORBIT_MCP_DCR",
  "MCP_RESOURCE",
  "ORBIT_MCP_CIMD_HOSTS",
  "APP_ORIGIN",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

const RESOURCE = "https://orbit.example/mcp";
type Plugin = {
  id: string;
  options?: Record<string, any>;
};
const pluginsOf = (auth: ReturnType<typeof makeAuth>) =>
  (auth.options.plugins ?? []) as unknown as Plugin[];

describe("MCP OAuth configuration", () => {
  it("flag off: makeAuth registers no plugins", () => {
    setEnv({ ORBIT_MCP_OAUTH: "false" });
    expect(makeAuth().options.plugins ?? []).toHaveLength(0);
    setEnv({});
    expect(makeAuth().options.plugins ?? []).toHaveLength(0);
  });

  it("the session token endpoint stays disabled in every mode", () => {
    setEnv({});
    expect(makeAuth().options.disabledPaths).toEqual(["/token"]);
    setEnv({ ORBIT_MCP_OAUTH: "true", MCP_RESOURCE: RESOURCE });
    expect(makeAuth().options.disabledPaths).toEqual(["/token"]);
  });

  it("flag on: jwt, oauth provider and cimd are registered with the pinned options", () => {
    setEnv({ ORBIT_MCP_OAUTH: "true", MCP_RESOURCE: RESOURCE });
    const auth = makeAuth();
    const plugins = pluginsOf(auth);
    expect(plugins.map((p) => p.id)).toEqual(["jwt", "oauth-provider", "cimd"]);

    expect(plugins[0]!.options).toMatchObject({
      disableSettingJwtHeader: true,
    });
    const mcpOptions = plugins[1]!.options!;
    expect(mcpOptions).toMatchObject({
      accessTokenExpiresIn: 600,
      refreshTokenReuseInterval: 30,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      loginPage: "/connect/login",
      consentPage: "/connect",
      grantTypes: ["authorization_code", "refresh_token"],
    });
    expect(mcpOptions.postLogin.page).toBe("/connect");
    expect(mcpOptions.scopes).toEqual([...MCP_SCOPES]);

    const options = mcpAuthPluginOptions(loadConfig(), {
      fetchClientMetadataResource,
      consentReference: async () => undefined,
      shouldRedirect: async () => false,
    });
    expect(options.mcp).toMatchObject({
      resource: RESOURCE,
      accessTokenExpiresIn: 600,
      refreshTokenReuseInterval: 30,
      scopes: MCP_SCOPES,
      resources: [{ identifier: RESOURCE, allowedScopes: MCP_SCOPES }],
      allowDynamicClientRegistration: false,
      loginPage: "/connect/login",
      consentPage: "/connect",
    });
    expect(options.mcp.postLogin?.page).toBe("/connect");
    expect(options.jwt.disableSettingJwtHeader).toBe(true);
    expect(options.cimd.metadataProfile).toBe("mcp-2026-07-28");
  });

  it("ORBIT_MCP_DCR=true opens dynamic registration, otherwise it stays closed", () => {
    const deps = {
      fetchClientMetadataResource,
      consentReference: async () => undefined,
      shouldRedirect: async () => false,
    };
    setEnv({ ORBIT_MCP_DCR: "true", MCP_RESOURCE: RESOURCE });
    expect(mcpAuthPluginOptions(loadConfig(), deps).mcp).toMatchObject({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: "infer",
    });
    setEnv({ MCP_RESOURCE: RESOURCE });
    const closed = mcpAuthPluginOptions(loadConfig(), deps).mcp;
    expect(closed.allowDynamicClientRegistration).toBe(false);
    expect(closed.allowUnauthenticatedClientRegistration).toBe(false);
  });

  it("production uses fetchClientMetadataResource from @better-auth/cimd/node", () => {
    expect(mcpAuthDeps().fetchClientMetadataResource).toBe(
      fetchClientMetadataResource,
    );
    // The test seam replaces only the transport.
    const seam = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(mcpAuthDeps({ cimdFetch: seam }).fetchClientMetadataResource).toBe(
      seam,
    );
  });

  it("customAccessTokenClaims carries the workspace claim from referenceId only", async () => {
    setEnv({ MCP_RESOURCE: RESOURCE });
    const { mcp } = mcpAuthPluginOptions(loadConfig(), {
      fetchClientMetadataResource,
      consentReference: async () => undefined,
      shouldRedirect: async () => false,
    });
    const claims = mcp.customAccessTokenClaims!;
    const base = { scopes: [] as string[], user: null };
    expect(ORBIT_WORKSPACE_CLAIM).toBe("orbit_workspace_id");
    expect(await claims({ ...base, referenceId: "ws-1" })).toEqual({
      [ORBIT_WORKSPACE_CLAIM]: "ws-1",
    });
    expect(await claims({ ...base, referenceId: "" })).toEqual({});
    expect(await claims({ ...base })).toEqual({});
  });

  it("the default post-login hooks fail closed until a workspace is selected", async () => {
    setEnv({ ORBIT_MCP_OAUTH: "true", MCP_RESOURCE: RESOURCE });
    const postLogin = pluginsOf(makeAuth())[1]!.options!.postLogin;
    const ctx = { session: { id: "s1" }, user: { id: "u1" }, scopes: [] };
    await expect(postLogin.shouldRedirect(ctx)).resolves.toBe(true);
    const error = await postLogin
      .consentReferenceId(ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).statusCode).toBe(400);
    expect((error as APIError).body).toMatchObject({
      error: "set_workspace",
      error_description: "select a workspace first",
    });
  });

  it("oauthApi refuses to hand out the provider API when the flag is off", () => {
    setEnv({});
    expect(() => oauthApi(makeAuth())).toThrow(/ORBIT_MCP_OAUTH/);
    setEnv({ ORBIT_MCP_OAUTH: "true", MCP_RESOURCE: RESOURCE });
    expect(oauthApi(makeAuth())).toBeTruthy();
  });
});

describe("MCP_RESOURCE validation", () => {
  const parse = (values: Record<string, string>) => {
    setEnv(values);
    return loadConfig();
  };

  it("defaults to APP_ORIGIN + /mcp", () => {
    expect(parse({ APP_ORIGIN: "https://orbit.example" }).MCP_RESOURCE).toBe(
      "https://orbit.example/mcp",
    );
    expect(parse({}).MCP_RESOURCE).toBe("http://localhost:4310/mcp");
  });

  it("accepts https and loopback http", () => {
    for (const value of [
      "https://orbit.example/mcp",
      "http://localhost:4310/mcp",
      "http://127.0.0.1:4310/mcp",
      "http://[::1]:4310/mcp",
    ])
      expect(parse({ MCP_RESOURCE: value }).MCP_RESOURCE).toBe(value);
  });

  it("rejects a query, a fragment, credentials and non-loopback http", () => {
    for (const value of [
      "https://orbit.example/mcp?x=1",
      "https://orbit.example/mcp?",
      "https://orbit.example/mcp#frag",
      "https://orbit.example/mcp#",
      "https://user:pw@orbit.example/mcp",
      "http://orbit.example/mcp",
      "ftp://orbit.example/mcp",
      "not a url",
    ])
      expect(() => parse({ MCP_RESOURCE: value }), value).toThrow();
  });

  it("is normalized at load: scheme and host lower-cased, default port and trailing slash dropped (WP-M5)", () => {
    for (const [value, expected] of [
      ["HTTPS://Orbit.Example/mcp", "https://orbit.example/mcp"],
      ["https://orbit.example/mcp/", "https://orbit.example/mcp"],
      ["https://orbit.example:443/mcp", "https://orbit.example/mcp"],
      ["https://ORBIT.example:443/Mcp/", "https://orbit.example/Mcp"],
      ["http://LOCALHOST:80/mcp/", "http://localhost/mcp"],
      ["http://localhost:4310/mcp", "http://localhost:4310/mcp"],
      // The bare origin keeps its one slash.
      ["https://orbit.example", "https://orbit.example/"],
      ["https://orbit.example/", "https://orbit.example/"],
    ])
      expect(parse({ MCP_RESOURCE: value }).MCP_RESOURCE, value).toBe(expected);
    expect(
      parse({ APP_ORIGIN: "https://Orbit.Example:443/" }).MCP_RESOURCE,
    ).toBe("https://orbit.example/mcp");
    for (const [value, expected] of [
      ["https://orbit.example/mcp/", "https://orbit.example/mcp"],
      ["not a url", "not a url"],
    ])
      expect(normalizeMcpResource(value)).toBe(expected);
  });

  it("the provider is configured with the normalized resource (advertised and aud)", () => {
    setEnv({
      ORBIT_MCP_OAUTH: "true",
      MCP_RESOURCE: "HTTPS://Orbit.Example:443/mcp/",
    });
    const options = mcpAuthPluginOptions(loadConfig(), {
      fetchClientMetadataResource,
      consentReference: async () => undefined,
      shouldRedirect: async () => false,
    });
    expect(options.mcp.resource).toBe(RESOURCE);
    expect(options.mcp.resources).toEqual([
      { identifier: RESOURCE, allowedScopes: [...MCP_SCOPES] },
    ]);
  });

  it("a non-loopback http APP_ORIGIN only fails the derived default when the flag is on", () => {
    expect(() => parse({ APP_ORIGIN: "http://staging.example" })).not.toThrow();
    expect(() =>
      parse({ APP_ORIGIN: "http://staging.example", ORBIT_MCP_OAUTH: "true" }),
    ).toThrow();
  });
});

describe("CIMD host allow list", () => {
  it("allows an exact host or a subdomain, nothing else", () => {
    const hosts = ["chatgpt.com", "claude.ai"];
    expect(isCimdHostAllowed("https://chatgpt.com/c.json", hosts)).toBe(true);
    expect(isCimdHostAllowed("https://www.chatgpt.com/c.json", hosts)).toBe(
      true,
    );
    expect(isCimdHostAllowed("https://claude.ai/oauth/c.json", hosts)).toBe(
      true,
    );
    expect(isCimdHostAllowed("https://evilchatgpt.com/c.json", hosts)).toBe(
      false,
    );
    expect(
      isCimdHostAllowed("https://chatgpt.com.evil.test/c.json", hosts),
    ).toBe(false);
    expect(isCimdHostAllowed("not a url", hosts)).toBe(false);
    expect(isCimdHostAllowed("https://chatgpt.com/c.json", [])).toBe(false);
  });
});

describe("authRequestHeaders", () => {
  const request = (headers: Record<string, string>) =>
    ({
      headers,
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    }) as never;

  it("flag off: the proxy-only header never reaches Better Auth, every other header is unchanged", () => {
    const incoming = {
      "x-orbit-sec-fetch-mode": "navigate",
      "sec-fetch-mode": "cors",
      cookie: "orbit.session=abc",
      origin: "https://orbit.example",
      "content-type": "application/json",
    };
    const headers = authRequestHeaders(
      { ORBIT_MCP_OAUTH: "false", ORBIT_MCP_DCR: "false" },
      request(incoming),
    );
    expect(headers.has("x-orbit-sec-fetch-mode")).toBe(false);
    // The proxied mode is not applied either: Better Auth sees what it saw before.
    expect(Object.fromEntries(headers.entries())).toEqual({
      "sec-fetch-mode": "cors",
      cookie: "orbit.session=abc",
      origin: "https://orbit.example",
      "content-type": "application/json",
    });
  });

  it("flag off: a request without the header is unchanged", () => {
    const headers = authRequestHeaders(
      { ORBIT_MCP_OAUTH: "false", ORBIT_MCP_DCR: "false" },
      request({ cookie: "a=b" }),
    );
    expect(Object.fromEntries(headers.entries())).toEqual({ cookie: "a=b" });
  });
});
