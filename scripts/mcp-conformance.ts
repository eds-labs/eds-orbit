/**
 * Conformance checks for the Orbit MCP gateway (Track M, WP-M5, D-M5-10):
 * raw JSON-RPC over fetch for the protocol revisions 2026-07-28 and
 * 2025-11-25, the error paths, the health check and the Protected Resource
 * Metadata. Used by scripts/mcp-smoke.ts against a deployed gateway and by
 * apps/api/tests/mcp-conformance.integration.test.ts against an in-process
 * one. No dependency beyond Node's fetch.
 *
 * The bearer token goes to the MCP endpoint only (never to the PRM or health
 * URLs), only over HTTPS or to a loopback host, and never into a result:
 * details are built from status codes and response fields, and every detail
 * is passed through a redaction of the token before it is returned.
 */

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
/** The protocol revisions every run checks, newest first. */
export const CONFORMANCE_REVISIONS = [MODERN, LEGACY] as const;
type Revision = (typeof CONFORMANCE_REVISIONS)[number];

const META = "io.modelcontextprotocol/";
const PRM_PATH = "/.well-known/oauth-protected-resource";
const SERVER_NAME = "orbit-mcp-gateway";
const CLIENT_INFO = { name: "orbit-conformance", version: "1" };
const UNKNOWN_TOOL = "orbit_conformance_unknown_tool";
const SEARCH_QUERY = "orbit conformance smoke";
/** Sent as an invalid credential; it is not a token. */
const INVALID_TOKEN = "orbit-conformance-invalid-token";
const REQUIRED_TOOLS = ["orbit_projects", "search", "fetch"];

export type ConformanceOptions = {
  /** The MCP endpoint, for example `${APP_ORIGIN}/mcp`. */
  url: string;
  /** An access token for the MCP resource; without it the authenticated checks are skipped. */
  token?: string;
  /** The origin serving the Protected Resource Metadata (the web origin); skipped when absent. */
  webUrl?: string;
  /** The resource identifier the PRM and the 401 challenge must name; default `url`. */
  resource?: string;
  /** The gateway's health URL; skipped when absent. */
  healthUrl?: string;
  /** "enabled" (default) checks a serving gateway; "disabled" checks the health-only mode (D-M5-1). */
  mode?: "enabled" | "disabled";
  /** false skips `search` (it may spend a query embedding per project). Default true. */
  search?: boolean;
  /** Per-request timeout in milliseconds. Default 15 s. */
  timeoutMs?: number;
  /** Test seam: the fetch to use. */
  fetch?: typeof fetch;
};

export type CheckStatus = "pass" | "fail" | "skip";
export type CheckResult = { name: string; status: CheckStatus; detail: string };

type Json = Record<string, any>;
type Answer = { status: number; headers: Headers; body: Json | null };
type Check = { name: string; skip?: string; run: () => Promise<string> };

class CheckFailure extends Error {}
function expectThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hosts a token may be sent to over plain HTTP. */
function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/** A JSON body, or the last `data:` frame of a request-scoped event stream. */
async function readAnswer(response: Response): Promise<Answer> {
  const text = await response.text();
  let body: Json | null = null;
  try {
    if (
      (response.headers.get("content-type") ?? "").startsWith(
        "text/event-stream",
      )
    ) {
      const frames = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
      const last = frames.at(-1);
      body = isRecord(last) ? last : null;
    } else if (text) {
      const parsed = JSON.parse(text) as unknown;
      body = isRecord(parsed) ? parsed : null;
    }
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

/** "HTTP 401", plus the JSON-RPC or tool error code when there is one. */
function describe(answer: Answer) {
  const rpc = answer.body?.error?.code;
  const tool = answer.body?.result?.isError
    ? answer.body.result.structuredContent?.code
    : undefined;
  return [
    `HTTP ${answer.status}`,
    ...(rpc !== undefined ? [`rpc error ${String(rpc)}`] : []),
    ...(tool !== undefined ? [`tool error ${String(tool)}`] : []),
  ].join(", ");
}

/** The JSON-RPC result of a successful call. */
function resultOf(answer: Answer): Json {
  expectThat(
    answer.status === 200 && isRecord(answer.body?.result),
    describe(answer),
  );
  return answer.body!.result as Json;
}

/** A tool call's structured content; an isError result fails the check. */
function toolContent(answer: Answer): Json {
  const result = resultOf(answer);
  expectThat(!result.isError, describe(answer));
  expectThat(isRecord(result.structuredContent), "no structured content");
  return result.structuredContent as Json;
}

/** Runs the checks for `options`; one result per check, in a stable order. */
export async function runConformance(
  options: ConformanceOptions,
): Promise<CheckResult[]> {
  const endpoint = new URL(options.url);
  const token = options.token || undefined;
  if (token && endpoint.protocol !== "https:" && !isLoopback(endpoint.hostname))
    throw new Error(
      "Refusing to send the token over plain http to a non-loopback host; use an https URL",
    );
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const resource = new URL(options.resource ?? options.url);
  const resourcePath = resource.pathname.replace(/\/$/, "");
  const prmPaths = [PRM_PATH, `${PRM_PATH}${resourcePath}`];
  const challengeUrl = `${resource.origin}${PRM_PATH}${resourcePath}`;
  const mode = options.mode ?? "enabled";
  let nextId = 1;

  const redact = (text: string) => {
    let out = text.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]");
    if (token) out = out.split(token).join("[redacted]");
    return out;
  };

  const get = async (url: string | URL, accept = "application/json") =>
    readAnswer(
      await doFetch(url, {
        method: "GET",
        headers: { accept },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );

  /** POSTs `body` to the endpoint with the revision's headers. */
  const post = async (
    revision: Revision,
    method: string | null,
    body: unknown,
    credential: string | null,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(revision === LEGACY && method === "initialize"
        ? {}
        : { "mcp-protocol-version": revision }),
      ...(revision === MODERN && method ? { "mcp-method": method } : {}),
      ...extra,
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    };
    return readAnswer(
      await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
  };

  /** One JSON-RPC request in the revision's shape (2026-07-28 carries the _meta envelope). */
  const rpc = (
    revision: Revision,
    method: string,
    params: Json,
    credential: string | null = token ?? null,
  ) => {
    const toolName =
      method === "tools/call" && typeof params.name === "string"
        ? params.name
        : undefined;
    const message = {
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params:
        revision === MODERN
          ? {
              ...params,
              _meta: {
                [`${META}protocolVersion`]: MODERN,
                [`${META}clientInfo`]: CLIENT_INFO,
                [`${META}clientCapabilities`]: {},
              },
            }
          : params,
    };
    return post(
      revision,
      method,
      message,
      credential,
      revision === MODERN && toolName ? { "mcp-name": toolName } : {},
    );
  };
  const callTool = (revision: Revision, name: string, args: Json) =>
    rpc(revision, "tools/call", { name, arguments: args });

  const healthCheck = (expected: string): Check => ({
    name: "healthz",
    ...(options.healthUrl ? {} : { skip: "no health URL" }),
    run: async () => {
      const answer = await get(options.healthUrl!);
      expectThat(
        answer.status === 200 && answer.body?.status === expected,
        `${describe(answer)}, status ${String(answer.body?.status)}`,
      );
      return `status ${expected}`;
    },
  });

  const prmChecks = (serving: boolean): Check[] =>
    prmPaths.map((path) => ({
      name: `prm ${path}`,
      ...(options.webUrl ? {} : { skip: "no web URL" }),
      run: async () => {
        const answer = await get(new URL(path, options.webUrl));
        if (!serving) {
          expectThat(answer.status === 404, describe(answer));
          return "HTTP 404";
        }
        const body = answer.body;
        expectThat(answer.status === 200 && body, describe(answer));
        expectThat(
          body.resource === resource.href ||
            body.resource === `${resource.origin}${resourcePath}`,
          `resource ${String(body.resource)}`,
        );
        const servers = body.authorization_servers;
        expectThat(
          Array.isArray(servers) &&
            servers.length > 0 &&
            servers.every((s: unknown) => typeof s === "string"),
          "no authorization_servers",
        );
        expectThat(
          Array.isArray(body.scopes_supported) &&
            body.scopes_supported.includes("orbit:read"),
          "orbit:read not in scopes_supported",
        );
        expectThat(
          Array.isArray(body.bearer_methods_supported) &&
            body.bearer_methods_supported.includes("header"),
          "header not in bearer_methods_supported",
        );
        return `resource ok, authorization server ${servers.join(" ")}`;
      },
    }));

  const challengeCheck = (name: string, credential: string | null): Check => ({
    name,
    run: async () => {
      const answer = await rpc(MODERN, "tools/list", {}, credential);
      expectThat(answer.status === 401, describe(answer));
      const header = answer.headers.get("www-authenticate") ?? "";
      const named = /resource_metadata="([^"]+)"/.exec(header)?.[1];
      expectThat(
        header.startsWith("Bearer ") && named,
        "no Bearer resource_metadata challenge",
      );
      expectThat(named === challengeUrl, `resource_metadata ${named}`);
      expectThat(
        answer.body?.error?.code === -32000,
        `rpc error ${String(answer.body?.error?.code)}`,
      );
      return `challenge names ${named}`;
    },
  });

  const methodCheck = (status: number): Check => ({
    name: `GET is ${status}`,
    run: async () => {
      const answer = await get(endpoint, "text/event-stream");
      expectThat(answer.status === status, describe(answer));
      if (status === 405)
        expectThat(
          (answer.headers.get("allow") ?? "").includes("POST"),
          "no Allow: POST",
        );
      return `HTTP ${status}`;
    },
  });

  const needsToken = token ? {} : { skip: "no token" };

  const revisionChecks = (revision: Revision): Check[] => [
    {
      name: `${revision} discovery`,
      ...needsToken,
      run: async () => {
        if (revision === MODERN) {
          const answer = await rpc(MODERN, "server/discover", {});
          const result = resultOf(answer);
          expectThat(
            Array.isArray(result.supportedVersions) &&
              result.supportedVersions.includes(MODERN),
            `supportedVersions ${JSON.stringify(result.supportedVersions)}`,
          );
          const name = result._meta?.[`${META}serverInfo`]?.name;
          expectThat(name === SERVER_NAME, `server ${String(name)}`);
          expectThat(
            !answer.headers.has("mcp-session-id"),
            "unexpected mcp-session-id",
          );
          return `server/discover: ${SERVER_NAME}, supports ${MODERN}`;
        }
        const answer = await rpc(LEGACY, "initialize", {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        const result = resultOf(answer);
        expectThat(
          result.protocolVersion === LEGACY,
          `protocolVersion ${String(result.protocolVersion)}`,
        );
        expectThat(
          result.serverInfo?.name === SERVER_NAME,
          `server ${String(result.serverInfo?.name)}`,
        );
        expectThat(
          !answer.headers.has("mcp-session-id"),
          "unexpected mcp-session-id (the gateway is stateless)",
        );
        return `initialize: ${SERVER_NAME}, ${LEGACY}, no session`;
      },
    },
    {
      name: `${revision} tools/list`,
      ...needsToken,
      run: async () => {
        const result = resultOf(await rpc(revision, "tools/list", {}));
        const tools = result.tools;
        expectThat(Array.isArray(tools), "no tools array");
        expectThat(
          tools.every(
            (t: unknown) =>
              isRecord(t) &&
              typeof t.name === "string" &&
              isRecord(t.inputSchema),
          ),
          "a tool without name or inputSchema",
        );
        const names = tools.map((t: Json) => t.name as string);
        const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n));
        expectThat(missing.length === 0, `missing ${missing.join(", ")}`);
        return `${tools.length} tools`;
      },
    },
    {
      name: `${revision} tools/call orbit_projects`,
      ...needsToken,
      run: async () => {
        const content = toolContent(
          await callTool(revision, "orbit_projects", {}),
        );
        expectThat(
          typeof content.workspace?.id === "string" &&
            Array.isArray(content.projects),
          "no workspace or projects",
        );
        return `${content.projects.length} project(s)`;
      },
    },
    {
      name: `${revision} tools/call search`,
      ...(options.search === false ? { skip: "search disabled" } : needsToken),
      run: async () => {
        const content = toolContent(
          await callTool(revision, "search", { query: SEARCH_QUERY }),
        );
        const results = content.results;
        expectThat(Array.isArray(results), "no results array");
        expectThat(
          results.every(
            (r: unknown) =>
              isRecord(r) &&
              typeof r.id === "string" &&
              typeof r.title === "string" &&
              typeof r.url === "string",
          ),
          "a result without id, title or url",
        );
        return `${results.length} result(s)`;
      },
    },
    {
      name: `${revision} unknown tool`,
      ...needsToken,
      run: async () => {
        const answer = await callTool(revision, UNKNOWN_TOOL, {});
        expectThat(
          answer.status === 200 && answer.body?.error?.code === -32602,
          describe(answer),
        );
        return "rpc error -32602";
      },
    },
  ];

  const checks: Check[] =
    mode === "disabled"
      ? [
          healthCheck("disabled"),
          ...prmChecks(false),
          {
            name: "POST is 404",
            run: async () => {
              const answer = await rpc(MODERN, "tools/list", {}, null);
              expectThat(answer.status === 404, describe(answer));
              return "HTTP 404";
            },
          },
          methodCheck(404),
        ]
      : [
          healthCheck("ok"),
          ...prmChecks(true),
          challengeCheck("401 challenge without a token", null),
          challengeCheck("401 challenge with an invalid token", INVALID_TOKEN),
          methodCheck(405),
          {
            name: "batch is refused",
            ...needsToken,
            run: async () => {
              const message = (id: number) => ({
                jsonrpc: "2.0",
                id,
                method: "tools/list",
                params: {},
              });
              const answer = await post(
                MODERN,
                null,
                [message(nextId++), message(nextId++)],
                token ?? null,
              );
              expectThat(
                answer.status === 400 && answer.body?.error?.code === -32600,
                describe(answer),
              );
              return "HTTP 400, rpc error -32600";
            },
          },
          ...CONFORMANCE_REVISIONS.flatMap(revisionChecks),
        ];

  const results: CheckResult[] = [];
  for (const check of checks) {
    if (check.skip) {
      results.push({ name: check.name, status: "skip", detail: check.skip });
      continue;
    }
    try {
      const detail = await check.run();
      results.push({
        name: check.name,
        status: "pass",
        detail: redact(detail),
      });
    } catch (error) {
      const detail =
        error instanceof CheckFailure
          ? error.message
          : `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? ""}`;
      results.push({
        name: check.name,
        status: "fail",
        detail: redact(detail),
      });
    }
  }
  return results;
}

/** True unless a check failed (skipped checks do not fail a run). */
export const conformancePassed = (results: readonly CheckResult[]) =>
  results.every((r) => r.status !== "fail");

/** One line per check: `PASS name - detail`. */
export const formatResults = (results: readonly CheckResult[]) =>
  results
    .map(
      (r) =>
        `${r.status.toUpperCase()} ${r.name}${r.detail ? ` - ${r.detail}` : ""}`,
    )
    .join("\n");
