import { describe, expect, it } from "vitest";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

// Characterization tests for @modelcontextprotocol/server 2.3.1 (Track M,
// WP-M2 Task 0). They drive the SDK in-process with Web `Request` objects
// against `handler.fetch(request, { authInfo })` (no network, no Orbit DB) and
// pin the behaviour the MCP gateway design relies on. If an SDK upgrade breaks
// one of these tests, re-read the gateway design (D-M2-7, Task 3) before
// touching the assertion. Findings: docs/superpowers/plans/
// 2026-10-18-track-m-wp-m2-gateway.md ("Task 0 findings").

const META = "io.modelcontextprotocol/";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

type Json = Record<string, any>;

const auth = (clientId: string, extra: Partial<AuthInfo> = {}): AuthInfo => ({
  token: `token-${clientId}`,
  clientId,
  scopes: ["orbit:read"],
  ...extra,
});

/** A 2026-07-28 request: standard headers plus the per-request `_meta` envelope. */
function modernRequest(
  method: string,
  params: Json = {},
  init: { id?: number; headers?: Record<string, string> } = {},
): Request {
  return new Request("http://gateway.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      ...init.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: init.id ?? 1,
      method,
      params: {
        ...params,
        _meta: {
          [`${META}protocolVersion`]: MODERN,
          [`${META}clientInfo`]: { name: "characterization", version: "1" },
          [`${META}clientCapabilities`]: {},
        },
      },
    }),
  });
}

/** A 2025-era request (no envelope). Notifications pass `id: null`. */
function legacyRequest(
  method: string,
  params: Json = {},
  init: { id?: number | null; headers?: Record<string, string> } = {},
): Request {
  const id = init.id === undefined ? 1 : init.id;
  return new Request("http://gateway.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...init.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      method,
      params,
    }),
  });
}

const legacyInitialize = (protocolVersion = LEGACY) =>
  legacyRequest("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "characterization", version: "1" },
  });

const rawPost = (body: string, headers: Record<string, string>) =>
  new Request("http://gateway.test/mcp", { method: "POST", headers, body });

/** Reads a JSON body or the single `data:` frame of a request-scoped SSE body. */
async function body(response: Response): Promise<Json> {
  const text = await response.text();
  if (text === "") return {};
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Json);
    expect(frames).toHaveLength(1);
    return frames[0]!;
  }
  return JSON.parse(text) as Json;
}

/** A fixture server with one tool per behaviour under test. */
function fixtureServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer({ name: "orbit-fixture", version: "9.9.9" });
  const principal = ctx.authInfo?.clientId;
  if (principal === "factory-throws") throw new Error("factory-secret-detail");
  // Per-principal surface: the factory sees `authInfo`, so the tool list can
  // be built per request (the gateway's permission intersection).
  if (principal === "alice") {
    server.registerTool(
      "only_alice",
      { inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "alice" }] }),
    );
  }
  if (principal === "bob") {
    server.registerTool(
      "only_bob",
      { inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "bob" }] }),
    );
  }
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes a short message.",
      inputSchema: z.object({ msg: z.string().max(5) }).strict(),
      outputSchema: z.object({ msg: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { "orbit/risk": "R0_read" },
    },
    async ({ msg }, handlerCtx) => ({
      structuredContent: { msg },
      content: [{ type: "text", text: JSON.stringify({ msg }) }],
      // Per-request state reaches handlers via `ctx.http.authInfo`.
      _meta: { seenClient: handlerCtx.http?.authInfo?.clientId ?? null },
    }),
  );
  server.registerTool(
    "context_probe",
    { inputSchema: z.object({}) },
    async (_args, handlerCtx) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            httpKeys: Object.keys(handlerCtx.http ?? {}).sort(),
            client: handlerCtx.http?.authInfo?.clientId ?? null,
            scopes: handlerCtx.http?.authInfo?.scopes ?? null,
            sessionId: handlerCtx.sessionId ?? null,
            hasRequest: handlerCtx.http?.req !== undefined,
          }),
        },
      ],
    }),
  );
  server.registerTool(
    "json_schema_tool",
    {
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { q: { type: "string", maxLength: 3 } },
        required: ["q"],
        additionalProperties: false,
      }),
      outputSchema: fromJsonSchema({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      }),
    },
    async () => ({
      structuredContent: { ok: true },
      content: [{ type: "text", text: '{"ok":true}' }],
    }),
  );
  server.registerTool(
    "constraints",
    {
      inputSchema: z.object({
        kind: z.enum(["a", "b"]),
        literal: z.literal("x"),
        digits: z.string().regex(/^[0-9]+$/),
        count: z.number().int().max(3),
      }),
    },
    async () => ({ content: [] }),
  );
  server.registerTool("throws_error", { inputSchema: z.object({}) }, async () => {
    throw new Error("thrown-secret-detail");
  });
  server.registerTool("throws_string", { inputSchema: z.object({}) }, async () => {
    throw "thrown-string-detail";
  });
  server.registerTool(
    "throws_protocol_error",
    { inputSchema: z.object({}) },
    async () => {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "protocol-detail");
    },
  );
  server.registerTool("returns_error", { inputSchema: z.object({}) }, async () => ({
    isError: true,
    content: [{ type: "text", text: "refused: not allowed" }],
  }));
  const outputSchema = z.object({ n: z.number() });
  server.registerTool(
    "bad_output",
    { inputSchema: z.object({}), outputSchema },
    async () => ({ structuredContent: { n: "x" as unknown as number }, content: [] }),
  );
  server.registerTool(
    "missing_output",
    { inputSchema: z.object({}), outputSchema },
    async () => ({ content: [{ type: "text", text: "{}" }] }),
  );
  server.registerTool(
    "extra_output",
    { inputSchema: z.object({}), outputSchema },
    async () => ({
      structuredContent: { n: 1, extra: "not-in-schema" },
      content: [{ type: "text", text: "{}" }],
    }),
  );
  server.registerTool(
    "error_with_output_schema",
    { inputSchema: z.object({}), outputSchema },
    async () => ({ isError: true, content: [{ type: "text", text: "refused" }] }),
  );
  server.registerTool("huge", { inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "x".repeat(200_000) }],
  }));
  return server;
}

type LegacyOption = "stateless" | "reject" | undefined;

function makeHandler(
  legacy: LegacyOption,
  extra: { maxRequestBodySize?: number } = {},
) {
  const errors: Error[] = [];
  const contexts: McpRequestContext[] = [];
  const handler = createMcpHandler(
    (ctx) => {
      contexts.push(ctx);
      return fixtureServer(ctx);
    },
    {
      ...(legacy === undefined ? {} : { legacy }),
      ...extra,
      onerror: (error) => errors.push(error),
    },
  );
  return { handler, errors, contexts };
}

const toolText = (result: Json): string => result.content?.[0]?.text ?? "";

describe("createMcpHandler: factory context and per-request state", () => {
  it("calls the factory once per request with era, authInfo and the Request", async () => {
    const { handler, contexts } = makeHandler("reject");
    const alice = auth("alice");
    await handler.fetch(modernRequest("tools/list"), { authInfo: alice });
    await handler.fetch(modernRequest("tools/list"), { authInfo: alice });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.era).toBe("modern");
    expect(contexts[0]!.authInfo).toBe(alice);
    expect(contexts[0]!.requestInfo).toBeInstanceOf(Request);
    await handler.close();
  });

  it("builds a different tool list per principal and refuses tools not built for the caller", async () => {
    const { handler } = makeHandler("reject");
    const names = async (clientId: string) =>
      (
        (await body(
          await handler.fetch(modernRequest("tools/list"), {
            authInfo: auth(clientId),
          }),
        )) as Json
      ).result.tools.map((tool: Json) => tool.name as string);
    const aliceTools = await names("alice");
    const bobTools = await names("bob");
    expect(aliceTools).toContain("only_alice");
    expect(aliceTools).not.toContain("only_bob");
    expect(bobTools).toContain("only_bob");
    expect(bobTools).not.toContain("only_alice");

    // Calling a tool that was not built for this principal is an unknown tool,
    // a JSON-RPC error (not an isError result) that names only the tool name.
    const call = await handler.fetch(
      modernRequest("tools/call", { name: "only_alice", arguments: {} }),
      { authInfo: auth("bob") },
    );
    expect(await body(call)).toMatchObject({
      error: { code: -32602, message: "Tool only_alice not found" },
    });
    await handler.close();
  });

  it("hands authInfo to tool handlers as ctx.http.authInfo (modern and legacy)", async () => {
    for (const request of [
      modernRequest("tools/call", { name: "context_probe", arguments: {} }),
      legacyRequest(
        "tools/call",
        { name: "context_probe", arguments: {} },
        { headers: { "mcp-protocol-version": LEGACY } },
      ),
    ]) {
      const { handler } = makeHandler(undefined);
      const response = await handler.fetch(request, {
        authInfo: auth("alice", { scopes: ["orbit:read", "orbit:propose"] }),
      });
      const probe = JSON.parse(toolText((await body(response)).result));
      expect(probe).toMatchObject({
        client: "alice",
        scopes: ["orbit:read", "orbit:propose"],
        hasRequest: true,
        sessionId: null,
      });
      expect(probe.httpKeys).toContain("authInfo");
      await handler.close();
    }
  });

  it("is pass-through only: no authInfo option means none, whatever the headers say", async () => {
    const { handler, contexts } = makeHandler("reject");
    const response = await handler.fetch(
      modernRequest(
        "tools/call",
        { name: "context_probe", arguments: {} },
        { headers: { authorization: "Bearer looks-valid" } },
      ),
    );
    const probe = JSON.parse(toolText((await body(response)).result));
    expect(probe.client).toBeNull();
    expect(probe.httpKeys).not.toContain("authInfo");
    expect(contexts[0]!.authInfo).toBeUndefined();
    await handler.close();
  });

  it("performs no token checks: an expired authInfo is still served", async () => {
    const { handler } = makeHandler("reject");
    const response = await handler.fetch(modernRequest("tools/list"), {
      authInfo: auth("alice", { expiresAt: 1 }),
    });
    expect(response.status).toBe(200);
    expect((await body(response)).result.tools.length).toBeGreaterThan(0);
    await handler.close();
  });

  it("answers a throwing factory with a generic 500 and reports the real error only to onerror", async () => {
    const { handler, errors } = makeHandler("reject");
    const response = await handler.fetch(modernRequest("tools/list"), {
      authInfo: auth("factory-throws"),
    });
    expect(response.status).toBe(500);
    const payload = await body(response);
    expect(payload.error).toMatchObject({
      code: -32603,
      message: "Internal server error",
    });
    expect(JSON.stringify(payload)).not.toContain("factory-secret-detail");
    expect(errors.map((error) => error.message)).toContain(
      "factory-secret-detail",
    );
    await handler.close();
  });
});

describe("createMcpHandler: the `legacy` option", () => {
  it("rejects a function value (there is no handler-valued option)", () => {
    expect(() =>
      createMcpHandler(() => new McpServer({ name: "x", version: "1" }), {
        legacy: (() => undefined) as never,
      }),
    ).toThrow(TypeError);
  });

  for (const legacy of [undefined, "stateless"] as const) {
    describe(`legacy: ${legacy ?? "(default)"}`, () => {
      it("serves a 2025-11-25 initialize statelessly over request-scoped SSE, without a session id", async () => {
        const { handler, contexts } = makeHandler(legacy);
        const response = await handler.fetch(legacyInitialize(), {
          authInfo: auth("alice"),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(
          /^text\/event-stream/,
        );
        expect(response.headers.get("mcp-session-id")).toBeNull();
        const payload = await body(response);
        expect(payload.result).toMatchObject({
          protocolVersion: LEGACY,
          serverInfo: { name: "orbit-fixture", version: "9.9.9" },
          capabilities: { tools: { listChanged: true } },
        });
        expect(contexts.at(-1)!.era).toBe("legacy");
        expect(contexts.at(-1)!.authInfo?.clientId).toBe("alice");
        await handler.close();
      });

      it("echoes any older SDK-supported revision (there is no way to pin legacy to 2025-11-25 only) and answers unknown ones with 2025-11-25", async () => {
        const { handler } = makeHandler(legacy);
        const negotiated = async (requested: string) =>
          (
            await body(
              await handler.fetch(legacyInitialize(requested), {
                authInfo: auth("alice"),
              }),
            )
          ).result.protocolVersion;
        expect(await negotiated("2099-01-01")).toBe(LEGACY);
        expect(await negotiated("2025-06-18")).toBe("2025-06-18");
        expect(await negotiated("2024-11-05")).toBe("2024-11-05");
        await handler.close();
      });

      it("serves tools/list and tools/call with no initialize and no session, per principal", async () => {
        const { handler } = makeHandler(legacy);
        const headers = { "mcp-protocol-version": LEGACY };
        const list = await body(
          await handler.fetch(legacyRequest("tools/list", {}, { headers }), {
            authInfo: auth("bob"),
          }),
        );
        const names = list.result.tools.map((tool: Json) => tool.name);
        expect(names).toContain("only_bob");
        expect(names).not.toContain("only_alice");

        const call = await body(
          await handler.fetch(
            legacyRequest(
              "tools/call",
              { name: "echo", arguments: { msg: "hi" } },
              { id: 7, headers },
            ),
            { authInfo: auth("bob") },
          ),
        );
        expect(call).toMatchObject({
          id: 7,
          result: {
            structuredContent: { msg: "hi" },
            content: [{ type: "text", text: '{"msg":"hi"}' }],
          },
        });
        // The legacy era has no `resultType` marker.
        expect(call.result.resultType).toBeUndefined();
        await handler.close();
      });

      it("acknowledges a legacy notification with 202 (nothing to persist)", async () => {
        const { handler } = makeHandler(legacy);
        const response = await handler.fetch(
          legacyRequest("notifications/initialized", {}, { id: null }),
          { authInfo: auth("alice") },
        );
        expect(response.status).toBe(202);
        await handler.close();
      });

      it("needs no session store: GET (event stream) and DELETE are 405", async () => {
        const { handler } = makeHandler(legacy);
        const get = await handler.fetch(
          new Request("http://gateway.test/mcp", {
            method: "GET",
            headers: { accept: "text/event-stream" },
          }),
          { authInfo: auth("alice") },
        );
        const del = await handler.fetch(
          new Request("http://gateway.test/mcp", { method: "DELETE" }),
          { authInfo: auth("alice") },
        );
        for (const response of [get, del]) {
          expect(response.status).toBe(405);
          expect((await body(response)).error).toMatchObject({
            code: -32000,
            message: "Method not allowed.",
          });
        }
        await handler.close();
      });

      it("requires Accept: application/json, text/event-stream on legacy POSTs (406 otherwise)", async () => {
        const { handler } = makeHandler(legacy);
        const response = await handler.fetch(
          rawPost(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            { "content-type": "application/json" },
          ),
          { authInfo: auth("alice") },
        );
        expect(response.status).toBe(406);
        await handler.close();
      });
    });
  }

  describe("legacy: reject", () => {
    it("answers a 2025-11-25 initialize with the unsupported-version error naming only 2026-07-28", async () => {
      const { handler, errors, contexts } = makeHandler("reject");
      const response = await handler.fetch(legacyInitialize(), {
        authInfo: auth("alice"),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await body(response)).toMatchObject({
        id: 1,
        error: {
          code: -32022,
          message: `Unsupported protocol version: ${LEGACY}`,
          data: { supported: [MODERN], requested: LEGACY },
        },
      });
      // No factory call and no server instance for rejected legacy traffic.
      expect(contexts).toHaveLength(0);
      expect(errors[0]?.message).toContain("modern-only endpoint");
      await handler.close();
    });

    it("rejects legacy tools/list and ping the same way, and acknowledges legacy notifications with 202", async () => {
      const { handler } = makeHandler("reject");
      for (const request of [
        legacyRequest(
          "tools/list",
          {},
          { headers: { "mcp-protocol-version": LEGACY } },
        ),
        legacyRequest("ping"),
      ]) {
        const response = await handler.fetch(request, {
          authInfo: auth("alice"),
        });
        expect(response.status).toBe(400);
        expect((await body(response)).error.code).toBe(-32022);
      }
      const notification = await handler.fetch(
        legacyRequest("notifications/initialized", {}, { id: null }),
        { authInfo: auth("alice") },
      );
      expect(notification.status).toBe(202);
      await handler.close();
    });

    it("rejects GET and DELETE with 405, like the stateless modes", async () => {
      const { handler } = makeHandler("reject");
      const get = await handler.fetch(
        new Request("http://gateway.test/mcp", {
          method: "GET",
          headers: { accept: "text/event-stream" },
        }),
        { authInfo: auth("alice") },
      );
      const del = await handler.fetch(
        new Request("http://gateway.test/mcp", { method: "DELETE" }),
        { authInfo: auth("alice") },
      );
      expect(get.status).toBe(405);
      expect(del.status).toBe(405);
      await handler.close();
    });
  });

  for (const legacy of [undefined, "stateless", "reject"] as const) {
    it(`serves 2026-07-28 identically with legacy: ${legacy ?? "(default)"}`, async () => {
      const { handler } = makeHandler(legacy);
      const response = await handler.fetch(
        modernRequest("tools/call", {
          name: "echo",
          arguments: { msg: "hi" },
        }),
        { authInfo: auth("alice") },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(
        /^application\/json/,
      );
      expect((await body(response)).result).toMatchObject({
        structuredContent: { msg: "hi" },
        resultType: "complete",
      });
      await handler.close();
    });
  }
});

describe("registerTool shapes and results (2026-07-28)", () => {
  it("lists JSON Schema 2020-12 input/output schemas plus annotations, _meta, title and description", async () => {
    const { handler } = makeHandler("reject");
    const list = await body(
      await handler.fetch(modernRequest("tools/list"), {
        authInfo: auth("alice"),
      }),
    );
    const echo = list.result.tools.find((tool: Json) => tool.name === "echo");
    expect(echo).toMatchObject({
      name: "echo",
      title: "Echo",
      description: "Echoes a short message.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { "orbit/risk": "R0_read" },
      inputSchema: {
        type: "object",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: { msg: { type: "string", maxLength: 5 } },
        required: ["msg"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
    });
    await handler.close();
  });

  it("accepts plain JSON Schema through fromJsonSchema for input and output", async () => {
    const { handler } = makeHandler("reject");
    const ok = await body(
      await handler.fetch(
        modernRequest("tools/call", {
          name: "json_schema_tool",
          arguments: { q: "ab" },
        }),
        { authInfo: auth("alice") },
      ),
    );
    expect(ok.result).toMatchObject({ structuredContent: { ok: true } });
    const bad = await body(
      await handler.fetch(
        modernRequest("tools/call", {
          name: "json_schema_tool",
          arguments: { q: "way-too-long" },
        }),
        { authInfo: auth("alice") },
      ),
    );
    expect(bad.result.isError).toBe(true);
    // JSON Schema validation names the JSON pointer, never the value.
    expect(toolText(bad.result)).toContain("data/q must NOT have more than 3");
    expect(toolText(bad.result)).not.toContain("way-too-long");
    await handler.close();
  });

  it("returns structuredContent + content + the result _meta the handler set, plus serverInfo and resultType", async () => {
    const { handler } = makeHandler("reject");
    const result = (
      await body(
        await handler.fetch(
          modernRequest("tools/call", {
            name: "echo",
            arguments: { msg: "hi" },
          }),
          { authInfo: auth("alice") },
        ),
      )
    ).result;
    expect(result).toEqual({
      structuredContent: { msg: "hi" },
      content: [{ type: "text", text: '{"msg":"hi"}' }],
      resultType: "complete",
      _meta: {
        seenClient: "alice",
        [`${META}serverInfo`]: { name: "orbit-fixture", version: "9.9.9" },
      },
    });
    await handler.close();
  });

  it("does not cap result size: a 200 KB result is returned whole (the gateway must enforce its own 64 KB cap)", async () => {
    const { handler } = makeHandler("reject");
    const response = await handler.fetch(
      modernRequest("tools/call", { name: "huge", arguments: {} }),
      { authInfo: auth("alice") },
    );
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(200_000);
    await handler.close();
  });
});

describe("errors: thrown vs returned, invalid params, output validation", () => {
  const call = async (name: string, args: Json) => {
    const { handler, errors } = makeHandler("reject");
    const response = await handler.fetch(
      modernRequest("tools/call", { name, arguments: args }),
      { authInfo: auth("alice") },
    );
    const payload = await body(response);
    await handler.close();
    return { response, payload, errors };
  };

  it("turns a thrown Error into an isError result that carries the error MESSAGE to the client and never reaches onerror", async () => {
    const { response, payload, errors } = await call("throws_error", {});
    expect(response.status).toBe(200);
    expect(payload.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "thrown-secret-detail" }],
    });
    expect(errors).toHaveLength(0);
  });

  it("does the same for a thrown string and a thrown ProtocolError (no JSON-RPC error, message passes through)", async () => {
    const str = await call("throws_string", {});
    expect(str.payload.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "thrown-string-detail" }],
    });
    const protocol = await call("throws_protocol_error", {});
    expect(protocol.payload.error).toBeUndefined();
    expect(protocol.payload.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "protocol-detail" }],
    });
  });

  it("passes a returned isError result through unchanged (also when an outputSchema is declared)", async () => {
    const plain = await call("returns_error", {});
    expect(plain.payload.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "refused: not allowed" }],
    });
    const withSchema = await call("error_with_output_schema", {});
    expect(withSchema.payload.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "refused" }],
    });
  });

  it("reports invalid params as an isError RESULT (not a JSON-RPC error) naming paths and rules, never the argument values", async () => {
    const { payload } = await call("constraints", {
      kind: "SECRET-KIND",
      literal: "SECRET-LITERAL",
      digits: "SECRET-DIGITS",
      count: 987654321,
    });
    expect(payload.error).toBeUndefined();
    expect(payload.result.isError).toBe(true);
    const text = toolText(payload.result);
    expect(text).toMatch(/^Input validation error: Invalid arguments for tool constraints: /);
    for (const path of ["kind:", "literal:", "digits:", "count:"]) {
      expect(text).toContain(path);
    }
    for (const value of ["SECRET-KIND", "SECRET-LITERAL", "SECRET-DIGITS", "987654321"]) {
      expect(text).not.toContain(value);
    }
  });

  it("echoes unrecognized key NAMES of a strict schema (names, not values); a non-strict schema silently drops them", async () => {
    const strict = await call("echo", { msg: "hi", "client-chosen-key": "VALUE-NOT-ECHOED" });
    const text = toolText(strict.payload.result);
    expect(strict.payload.result.isError).toBe(true);
    expect(text).toContain('Unrecognized key: "client-chosen-key"');
    expect(text).not.toContain("VALUE-NOT-ECHOED");

    // `constraints` uses a default (strip) object: the extra key is dropped
    // before the handler runs, so rejecting unknown fields needs `.strict()`.
    const lenient = await call("constraints", {
      kind: "a",
      literal: "x",
      digits: "1",
      count: 1,
      surprise: "dropped",
    });
    expect(lenient.payload.result.isError).toBeUndefined();
  });

  it("returns an unknown tool as a JSON-RPC -32602 error, not an isError result", async () => {
    const { payload } = await call("does_not_exist", {});
    expect(payload).toMatchObject({
      error: { code: -32602, message: "Tool does_not_exist not found" },
    });
    expect(payload.result).toBeUndefined();
  });

  it("validates structuredContent against the outputSchema: wrong type and missing content become isError results", async () => {
    const wrong = await call("bad_output", {});
    expect(wrong.payload.result.isError).toBe(true);
    expect(toolText(wrong.payload.result)).toMatch(
      /^Output validation error: Invalid structured content for tool bad_output: n: /,
    );
    const missing = await call("missing_output", {});
    expect(missing.payload.result.isError).toBe(true);
    expect(toolText(missing.payload.result)).toContain(
      "has an output schema but no structured content was provided",
    );
  });

  it("does NOT strip or reject extra keys in structuredContent: the gateway must return its own parsed output", async () => {
    const { payload } = await call("extra_output", {});
    expect(payload.result.isError).toBeUndefined();
    expect(payload.result.structuredContent).toEqual({
      n: 1,
      extra: "not-in-schema",
    });
  });
});

describe("transport behaviour", () => {
  it("answers modern requests as plain JSON and needs no Accept header", async () => {
    const { handler } = makeHandler("reject");
    const response = await handler.fetch(modernRequest("tools/list"), {
      authInfo: auth("alice"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await handler.close();
  });

  it("supports server/discover and answers 404 -32601 for removed or unregistered methods (ping, resources, prompts)", async () => {
    const { handler } = makeHandler("reject");
    const discover = await body(
      await handler.fetch(modernRequest("server/discover"), {
        authInfo: auth("alice"),
      }),
    );
    expect(discover.result).toMatchObject({
      supportedVersions: [MODERN],
      capabilities: { tools: { listChanged: true } },
    });
    for (const method of ["ping", "resources/list", "prompts/list"]) {
      const response = await handler.fetch(modernRequest(method), {
        authInfo: auth("alice"),
      });
      expect(response.status).toBe(404);
      expect((await body(response)).error.code).toBe(-32601);
    }
    await handler.close();
  });

  it("acknowledges a modern notification with 202", async () => {
    const { handler } = makeHandler("reject");
    const response = await handler.fetch(
      rawPost(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: 1,
            _meta: { [`${META}protocolVersion`]: MODERN },
          },
        }),
        {
          "content-type": "application/json",
          "mcp-protocol-version": MODERN,
          "mcp-method": "notifications/cancelled",
        },
      ),
      { authInfo: auth("alice") },
    );
    expect(response.status).toBe(202);
    await handler.close();
  });

  it("rejects a modern request naming an unserved revision with -32022 and the served list", async () => {
    const { handler } = makeHandler("reject");
    const request = rawPost(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [`${META}protocolVersion`]: "2027-01-01",
            [`${META}clientInfo`]: { name: "x", version: "1" },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
      {
        "content-type": "application/json",
        "mcp-protocol-version": "2027-01-01",
        "mcp-method": "tools/list",
      },
    );
    const response = await handler.fetch(request, { authInfo: auth("alice") });
    expect(response.status).toBe(400);
    expect((await body(response)).error).toMatchObject({
      code: -32022,
      data: { supported: [MODERN], requested: "2027-01-01" },
    });
    await handler.close();
  });

  it("enforces the standard headers: a missing Mcp-Method header is a -32020 400", async () => {
    const { handler } = makeHandler("reject");
    const request = rawPost(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [`${META}protocolVersion`]: MODERN,
            [`${META}clientInfo`]: { name: "x", version: "1" },
            [`${META}clientCapabilities`]: {},
          },
        },
      }),
      { "content-type": "application/json", "mcp-protocol-version": MODERN },
    );
    const response = await handler.fetch(request, { authInfo: auth("alice") });
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe(-32020);
    await handler.close();
  });

  it("answers a non-JSON content type with 415 and an oversized body with 413 before any factory call", async () => {
    const { handler, contexts } = makeHandler("reject", {
      maxRequestBodySize: 600,
    });
    const wrongType = await handler.fetch(
      rawPost("{}", { "content-type": "text/plain" }),
      { authInfo: auth("alice") },
    );
    expect(wrongType.status).toBe(415);
    const tooLarge = await handler.fetch(
      modernRequest("tools/call", {
        name: "echo",
        arguments: { pad: "x".repeat(2000) },
      }),
      { authInfo: auth("alice") },
    );
    expect(tooLarge.status).toBe(413);
    expect((await body(tooLarge)).error.message).toContain("600 bytes");
    expect(contexts).toHaveLength(0);
    await handler.close();
  });

  it("answers GET, DELETE and PUT with 405 even for a modern revision header", async () => {
    const { handler } = makeHandler("reject");
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await handler.fetch(
        new Request("http://gateway.test/mcp", {
          method,
          headers: { "mcp-protocol-version": MODERN },
        }),
        { authInfo: auth("alice") },
      );
      expect(response.status).toBe(405);
    }
    await handler.close();
  });

  it("performs no Origin or Host validation itself (the gateway must add its own)", async () => {
    const { handler } = makeHandler("reject");
    const response = await handler.fetch(
      modernRequest("tools/list", {}, {
        headers: { origin: "https://evil.example", host: "evil.example" },
      }),
      { authInfo: auth("alice") },
    );
    expect(response.status).toBe(200);
    await handler.close();
  });

  it("refuses new requests after close()", async () => {
    const { handler } = makeHandler("reject");
    await handler.close();
    await expect(
      handler.fetch(modernRequest("tools/list"), { authInfo: auth("alice") }),
    ).rejects.toThrow("closed");
  });
});
