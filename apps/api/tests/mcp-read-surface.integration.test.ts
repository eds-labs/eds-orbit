import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The paid query embedding never reaches a provider: a fixed vector with a
// known cost, counted per call.
const embedding = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => {
    embedding.calls++;
    return {
      vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 10,
        outputTokens: 0,
        costMicros: 7,
      },
    };
  }),
}));

import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
  type Prisma,
} from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { EMBEDDING_PROFILE } from "../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { ingest, setFact } from "../src/platform/knowledge/engine.ts";
import {
  nativeTools,
  type NativeTool,
} from "../src/platform/mcp/native-tools.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  origin,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M3, Task 3: the native MCP tools `search`, `fetch` and
// `orbit_profile` through the gateway with real WP-M1 tokens. Everything a
// client gets is what `retrieve(forModel: true, purpose: "public")` without
// a consumer could return, in a project the grant, the membership, the
// knowledge module and the role all allow.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const HOUR = 3600000;
// Every document carries this word, every fact key this prefix.
const TOKEN = "quorvanthmcp";
const FACT_PREFIX = "mcpsurfacefix";

const names = ["one", "beta", "two", "all", "charlie"] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/read-surface-${n}.json`]),
) as Record<Name, string>;
const cimdFetch = cimdFetchFor(
  Object.fromEntries(Object.values(CLIENT).map((id) => [id, metadata(id)])),
);

const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;

async function withFlags<T>(run: () => Promise<T>): Promise<T> {
  const keys = Object.keys(FLAGS) as (keyof typeof FLAGS)[];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, FLAGS);
  try {
    return await run();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

const rpcBody = (response: { body: string }): Json =>
  response.body === "" ? {} : (JSON.parse(response.body) as Json);

const projectNames = [
  "Alpha",
  "Beta",
  "Charlie",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
] as const;
type ProjectName = (typeof projectNames)[number];

describe.skipIf(!enabled)(
  "MCP read surface: search, fetch, orbit_profile",
  () => {
    let api: Awaited<ReturnType<typeof buildServer>>;
    let gateway: FastifyInstance;
    let auth: ReturnType<typeof makeAuth>;
    let config: ReturnType<typeof loadConfig>;
    let jwksUrl = "";
    let cookie = "";
    let selection: { workspaceId: string; projectIds: string[] } = {
      workspaceId: "",
      projectIds: [],
    };
    const ids = {} as Record<"owner" | "editor", string>;
    const emails = {} as Record<"owner" | "editor", string>;
    const users: string[] = [];
    let workspaceId = "";
    const project = {} as Record<ProjectName, string>;
    const tokens = {} as Record<Name, string>;
    // Fixture ids: chunks and facts by label.
    const chunks = new Map<string, { chunkId: string; versionId: string }>();
    const facts = new Map<string, string>();
    const sources = new Map<string, string>();
    const appOrigin = () => new URL(loadConfig().APP_ORIGIN).origin;

    const driver = createFlowDriver({
      app: () => api,
      config: () => config,
      cookie: () => cookie,
      selection: () => selection,
      defaultClientId: CLIENT.one,
    });

    async function tokenFor(name: Name, projectIds: string[]) {
      selection = { workspaceId, projectIds };
      const flow = await driver.connect({ clientId: CLIENT[name] });
      const response = await driver.exchange(flow, { client_id: CLIENT[name] });
      expect(response.statusCode).toBe(200);
      return (response.json() as Json).access_token as string;
    }

    function rpc(method: string, params: Json, token: string) {
      return gateway.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": MODERN,
          "mcp-method": method,
          ...(method === "tools/call"
            ? { "mcp-name": String(params.name) }
            : {}),
          authorization: `Bearer ${token}`,
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              [`${META}protocolVersion`]: MODERN,
              [`${META}clientInfo`]: {
                name: "read-surface-test",
                version: "1",
              },
              [`${META}clientCapabilities`]: {},
            },
          },
        }),
      });
    }
    /** A tools/call; returns the JSON-RPC result. */
    async function call(name: string, args: Json, who: Name = "one") {
      const response = await rpc(
        "tools/call",
        { name, arguments: args },
        tokens[who],
      );
      expect(response.statusCode).toBe(200);
      return rpcBody(response).result as Json;
    }
    const search = (args: Json, who: Name = "one") => call("search", args, who);
    const fetchItem = (id: string, who: Name = "one") =>
      call("fetch", { id }, who);
    const ownerScope = (name: ProjectName): Scope => ({
      workspaceId,
      projectId: project[name],
      userId: ids.owner,
      role: "owner",
    });
    const run = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
      scoped(s.workspaceId, s.projectId, work);
    const chunkId = (name: ProjectName, label: string) =>
      `p:${project[name]}:chunk:${chunks.get(label)!.chunkId}`;
    const factId = (name: ProjectName, label: string) =>
      `p:${project[name]}:fact:${facts.get(label)!}`;
    const resultIds = (result: Json) =>
      (result.structuredContent.results as Json[]).map((r) => r.id as string);
    const projectsIn = (result: Json) =>
      new Set(resultIds(result).map((id) => id.split(":")[1]));
    const reservations = (name: ProjectName) =>
      scoped(workspaceId, project[name], (tx) =>
        tx.budgetReservation.findMany({
          where: { workspaceId, projectId: project[name] },
          orderBy: { createdAt: "asc" },
        }),
      );
    const runsIn = (name: ProjectName, kind = "mcp") =>
      scoped(workspaceId, project[name], (tx) =>
        tx.agentRun.findMany({
          where: { workspaceId, projectId: project[name], kind },
          include: { spans: true },
          orderBy: { startedAt: "asc" },
        }),
      );
    const auditRows = (name: ProjectName) =>
      scoped(workspaceId, project[name], (tx) =>
        tx.auditEvent.findMany({
          where: {
            workspaceId,
            projectId: project[name],
            action: "mcp.tool_call",
          },
          orderBy: { createdAt: "asc" },
        }),
      );
    const grantFor = (name: Name) =>
      authDb.mcpGrant.findFirstOrThrow({
        where: { userId: ids.editor, clientId: CLIENT[name] },
      });
    const callEvents = async (name: Name) => {
      const grant = await grantFor(name);
      return authDb.mcpGrantEvent.findMany({
        where: { grantId: grant.id, action: "mcp.call" },
        orderBy: { createdAt: "asc" },
      });
    };

    async function source(name: ProjectName, overrides: Json = {}) {
      const s = ownerScope(name);
      return run(
        s,
        async (tx) =>
          (
            await tx.entity.create({
              data: {
                workspaceId,
                projectId: s.projectId,
                kind: "sources",
                data: {
                  name: "Synthetic MCP surface source",
                  type: "file",
                  status: "active",
                  generation: 1,
                  publicUse: true,
                  modelUse: true,
                  authority: "official",
                  maxAgeHours: 168,
                  allowedOrigins: [],
                  allowedPaths: [],
                  ...overrides,
                },
              },
            })
          ).id,
      );
    }
    async function document(
      name: ProjectName,
      sourceId: string,
      title: string,
      overrides: Json = {},
    ) {
      const s = ownerScope(name);
      const result = await run(s, (tx) =>
        ingest(tx, s, {
          sourceId,
          externalId: randomUUID(),
          title,
          text: `Orbit ${TOKEN} passage for ${title} ${randomUUID()}.`,
          mimeType: "text/plain",
          language: "en",
          validFrom: new Date(Date.now() - 2 * HOUR).toISOString(),
          ...overrides,
        }),
      );
      const chunk = await run(s, (tx) =>
        tx.knowledgeChunk.findFirstOrThrow({
          where: { documentVersionId: result.versionId },
          orderBy: { position: "asc" },
        }),
      );
      return { chunkId: chunk.id, versionId: result.versionId };
    }
    async function fact(name: ProjectName, sourceId: string, key: string) {
      const s = ownerScope(name);
      return run(
        s,
        async (tx) =>
          (
            await setFact(tx, s, {
              key: `${FACT_PREFIX}.${key}`,
              value: `value of ${key}`,
              valueType: "text",
              language: "en",
              sourceId,
              validFrom: new Date(Date.now() - HOUR).toISOString(),
              status: "verified",
              publicUse: true,
              modelUse: true,
            } as Parameters<typeof setFact>[2])
          ).id,
      );
    }

    beforeAll(async () => {
      await withFlags(async () => {
        config = loadConfig();
        api = await buildServer(undefined, { cimdFetch });
        auth = makeAuth({ cimdFetch });
        await api.listen({ port: 0, host: "127.0.0.1" });
        jwksUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`;
        gateway = await buildMcpServer({ cimdFetch, jwksUrl });
      });
      await authDb.oauthClient.deleteMany({
        where: { clientId: { in: Object.values(CLIENT) } },
      });

      const password = randomBytes(24).toString("base64url");
      for (const who of ["owner", "editor"] as const) {
        emails[who] = `${randomUUID()}@example.invalid`;
        const created = await auth.api.signUpEmail({
          body: {
            email: emails[who],
            name: `Synthetic surface ${who}`,
            password,
          },
        });
        ids[who] = created.user.id;
        users.push(created.user.id);
      }
      const workspace = await authDb.workspace.create({
        data: {
          name: "Synthetic read surface workspace",
          members: {
            create: [
              { userId: ids.owner, role: "owner" },
              { userId: ids.editor, role: "editor" },
            ],
          },
          projects: {
            create: projectNames.map((name) => ({
              name,
              ...(name === "India"
                ? {}
                : {
                    members: {
                      create: [
                        {
                          userId: ids.editor,
                          // A viewer may read knowledge too.
                          role: name === "Beta" ? "viewer" : "editor",
                        },
                      ],
                    },
                  }),
            })),
          },
        },
        include: { projects: true },
      });
      workspaceId = workspace.id;
      for (const row of workspace.projects)
        project[row.name as ProjectName] = row.id;

      // Alpha: eligible passages (one with a canonical URL), a fact, and a
      // passage from a source models may not use. It has a spend mandate and a
      // priced embedding model, so its searches take the paid path.
      const alpha = await source("Alpha");
      sources.set("alpha", alpha);
      chunks.set(
        "alpha cited",
        await document("Alpha", alpha, "Alpha cited guide", {
          canonicalUrl: "https://docs.example.com/alpha?utm_source=x#part",
        }),
      );
      chunks.set("alpha plain", await document("Alpha", alpha, "Alpha plain"));
      chunks.set(
        "alpha modelUse false",
        await document(
          "Alpha",
          await source("Alpha", { modelUse: false }),
          "Alpha internal only",
        ),
      );
      facts.set("alpha fact", await fact("Alpha", alpha, "alpha"));
      await run(ownerScope("Alpha"), async (tx) => {
        const scope = ownerScope("Alpha");
        await create(tx, scope, "policies", {
          mode: "observe",
          channels: ["x-test"],
          contentTypes: ["social"],
          allowedOrigins: ["https://example.invalid"],
          startAt: new Date(Date.now() - HOUR).toISOString(),
          endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
          maxPerDay: 0,
          minIntervalMinutes: 1,
          dailyBudgetMicros: 100000,
          monthlyBudgetMicros: 100000,
          perRunBudgetMicros: 10000,
          approvedPaidTests: true,
          active: true,
        });
        await saveOpenAiConfiguration(tx, scope, {
          apiKey: "synthetic-no-provider-call-key",
          verifiedModels: ["synthetic-model", "text-embedding-3-small"],
          rateCard: {
            "synthetic-model": {
              inputMicrosPerMillion: 1000,
              outputMicrosPerMillion: 1000,
              verifiedAt: new Date().toISOString(),
            },
            "text-embedding-3-small": {
              inputMicrosPerMillion: 1000,
              outputMicrosPerMillion: 1000,
              verifiedAt: new Date().toISOString(),
            },
          },
          modelRoutes: {
            fast: "synthetic-model",
            standard: "synthetic-model",
            quality: "synthetic-model",
            escalation: "synthetic-model",
          },
        });
      });
      // One eligible passage in every other project (no mandate: lexical).
      for (const name of [
        "Beta",
        "Charlie",
        "Echo",
        "Foxtrot",
        "Golf",
        "Hotel",
        "India",
      ] as const)
        chunks.set(
          name.toLowerCase(),
          await document(name, await source(name), `${name} guide`),
        );
      // Charlie's only index is retired: it cannot be searched at all (the
      // baseline index is created lazily only for a project without any).
      await run(ownerScope("Charlie"), (tx) =>
        tx.knowledgeIndex.create({
          data: {
            workspaceId,
            projectId: project.Charlie,
            generation: 1,
            profile: EMBEDDING_PROFILE,
            model: "text-embedding-3-small",
            dimensions: 1536,
            state: "retired",
            manifest: [],
            manifestHash: "synthetic-retired",
          },
        }),
      );

      const signIn = await driver.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email: emails.editor, password },
      });
      expect(signIn.statusCode).toBe(200);
      const set = signIn.headers["set-cookie"];
      cookie = (Array.isArray(set) ? set : [set!])
        .map((v) => v.split(";")[0])
        .join("; ");

      tokens.one = await tokenFor("one", [project.Alpha]);
      tokens.beta = await tokenFor("beta", [project.Beta]);
      tokens.two = await tokenFor("two", [project.Alpha, project.Beta]);
      tokens.all = await tokenFor(
        "all",
        (["Golf", "Foxtrot", "Echo", "Charlie", "Beta", "Alpha"] as const).map(
          (name) => project[name],
        ),
      );
      tokens.charlie = await tokenFor("charlie", [project.Charlie]);
    }, 180_000);

    afterAll(async () => {
      await gateway?.close();
      await api?.close();
      if (workspaceId)
        await authDb.workspace.delete({ where: { id: workspaceId } });
      await authDb.mcpGrantEvent.deleteMany({
        where: { userId: { in: users } },
      });
      await authDb.oauthClient.deleteMany({
        where: { clientId: { in: Object.values(CLIENT) } },
      });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
      await closeDatabase();
    });

    describe("tool definitions", () => {
      it("lists the native tools with pinned schemas, annotations and _meta", async () => {
        const tools = rpcBody(await rpc("tools/list", {}, tokens.one)).result
          .tools as Json[];
        // Plus marketing's project status, the first registry tool (Task 4).
        expect(tools.map((tool) => tool.name)).toEqual([
          "fetch",
          "marketing_project_status",
          "orbit_action_status",
          "orbit_profile",
          "orbit_projects",
          "search",
        ]);
        const pinned = (name: string) => {
          const tool = tools.find((t) => t.name === name)!;
          return {
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            _meta: tool._meta,
          };
        };
        expect(pinned("search")).toMatchInlineSnapshot(`
        {
          "_meta": {
            "securitySchemes": [
              {
                "scopes": [
                  "orbit:read",
                ],
                "type": "oauth2",
              },
            ],
          },
          "annotations": {
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "inputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "projectId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string",
              },
              "query": {
                "maxLength": 2000,
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "query",
            ],
            "type": "object",
          },
          "outputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "results": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                    },
                    "title": {
                      "type": "string",
                    },
                    "url": {
                      "minLength": 1,
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "title",
                    "url",
                  ],
                  "type": "object",
                },
                "maxItems": 30,
                "type": "array",
              },
            },
            "required": [
              "results",
            ],
            "type": "object",
          },
        }
      `);
        expect(pinned("fetch")).toMatchInlineSnapshot(`
        {
          "_meta": {
            "securitySchemes": [
              {
                "scopes": [
                  "orbit:read",
                ],
                "type": "oauth2",
              },
            ],
          },
          "annotations": {
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "inputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "id": {
                "maxLength": 200,
                "type": "string",
              },
            },
            "required": [
              "id",
            ],
            "type": "object",
          },
          "outputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
              },
              "metadata": {
                "additionalProperties": false,
                "properties": {
                  "documentVersionId": {
                    "type": "string",
                  },
                  "fetchedAt": {
                    "type": "string",
                  },
                  "kind": {
                    "enum": [
                      "chunk",
                      "fact",
                    ],
                    "type": "string",
                  },
                  "projectId": {
                    "type": "string",
                  },
                  "sourceId": {
                    "type": "string",
                  },
                  "truncated": {
                    "type": "boolean",
                  },
                },
                "required": [
                  "projectId",
                  "kind",
                  "sourceId",
                ],
                "type": "object",
              },
              "text": {
                "type": "string",
              },
              "title": {
                "type": "string",
              },
              "url": {
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "id",
              "title",
              "text",
              "url",
              "metadata",
            ],
            "type": "object",
          },
        }
      `);
        expect(pinned("orbit_profile")).toMatchInlineSnapshot(`
        {
          "_meta": {
            "openai/profile": true,
            "securitySchemes": [
              {
                "scopes": [
                  "orbit:read",
                ],
                "type": "oauth2",
              },
            ],
          },
          "annotations": {
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "inputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {},
            "type": "object",
          },
          "outputSchema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
              },
            },
            "required": [
              "id",
            ],
            "type": "object",
          },
        }
      `);
      });

      it("a native tool's _meta cannot replace securitySchemes", async () => {
        const sneaky: NativeTool = {
          name: "fixture_meta",
          description: "Fixture",
          risk: "R0_read",
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({}).strict(),
          meta: {
            securitySchemes: [{ type: "noauth" }],
            "fixture/flag": true,
          },
          run: async () => ({}),
        };
        (nativeTools as NativeTool[]).push(sneaky);
        try {
          const tools = rpcBody(await rpc("tools/list", {}, tokens.one)).result
            .tools as Json[];
          expect(tools.find((t) => t.name === "fixture_meta")!._meta).toEqual({
            "fixture/flag": true,
            securitySchemes: [{ type: "oauth2", scopes: ["orbit:read"] }],
          });
        } finally {
          (nativeTools as NativeTool[]).pop();
        }
      });
    });

    describe("orbit_profile", () => {
      it("returns the opaque user id and no e-mail", async () => {
        const result = await call("orbit_profile", {});
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ id: ids.editor });
        expect(JSON.parse(result.content[0].text)).toEqual({ id: ids.editor });
        expect(JSON.stringify(result)).not.toContain(emails.editor);
        expect(JSON.stringify(result)).not.toContain("@");
      });
    });

    describe("search", () => {
      it("search falls back to lexical without spending", async () => {
        const calls = embedding.calls;
        const result = await search({ query: TOKEN }, "beta");
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
          results: [
            {
              id: chunkId("Beta", "beta"),
              title: "Beta guide",
              url: `${appOrigin()}/p/${project.Beta}/knowledge/library`,
            },
          ],
        });
        // The JSON text copy carries the same value.
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
        expect(embedding.calls).toBe(calls);
        expect(await reservations("Beta")).toHaveLength(0);
        // A single-project call is audited in its project, with its run.
        const rows = await auditRows("Beta");
        expect(rows.at(-1)!.metadata).toMatchObject({
          tool: "search",
          outcome: "ok",
        });
        const runs = await runsIn("Beta");
        expect(runs.at(-1)).toMatchObject({
          taskClass: "search",
          status: "succeeded",
        });
      });

      it("paid search is attributed to the mcp run", async () => {
        const calls = embedding.calls;
        const before = (await reservations("Alpha")).length;
        // A fact is relevant when the query names a part of its key.
        const result = await search({ query: `${TOKEN} alpha` });
        expect(result.isError).toBeFalsy();
        expect(embedding.calls).toBe(calls + 1);

        const added = (await reservations("Alpha")).slice(before);
        expect(added).toHaveLength(1);
        const grant = await grantFor("one");
        const runs = (await runsIn("Alpha")).filter(
          (r) => r.taskClass === "search",
        );
        const mcpRun = runs.at(-1)!;
        expect(mcpRun.status).toBe("succeeded");
        expect(added[0]).toMatchObject({
          category: "query_embedding",
          state: "settled",
          agentRunId: mcpRun.id,
          taskClass: "search",
        });
        expect(added[0]!.key).toMatch(
          new RegExp(
            // grant, request id, per-call id, project (D-M3-2, fix round 1)
            `^${project.Alpha}:query:mcp:${grant.id}:[0-9a-f-]{36}:[0-9a-f-]{36}:${project.Alpha}$`,
          ),
        );
        // Another call gets other keys.
        expect((await search({ query: `${TOKEN} alpha` })).isError).toBeFalsy();
        const keys = (await reservations("Alpha"))
          .slice(before)
          .map((row) => row.key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        // The embedding span hangs on the call's run; no retrieval run opened.
        expect(mcpRun.spans.map((span) => span.type).sort()).toEqual([
          "embedding",
          "tool_call",
        ]);
        expect(
          (await runsIn("Alpha", "retrieval")).filter(
            (r) => r.startedAt >= mcpRun.startedAt,
          ),
        ).toHaveLength(0);

        // Ids, titles and urls (D-M3-6, D-M3-7).
        const results = result.structuredContent.results as Json[];
        expect(results).toEqual(
          expect.arrayContaining([
            {
              id: chunkId("Alpha", "alpha cited"),
              title: "Alpha cited guide",
              url: "https://docs.example.com/alpha",
            },
            {
              id: chunkId("Alpha", "alpha plain"),
              title: "Alpha plain",
              url: `${appOrigin()}/p/${project.Alpha}/knowledge/library`,
            },
            {
              id: factId("Alpha", "alpha fact"),
              title: `${FACT_PREFIX}.alpha`,
              url: `${appOrigin()}/p/${project.Alpha}/knowledge/facts`,
            },
          ]),
        );
      });

      it("modelUse=false content is absent end-to-end", async () => {
        const hidden = chunkId("Alpha", "alpha modelUse false");
        for (const who of ["one", "two", "all"] as const) {
          const result = await search({ query: TOKEN }, who);
          expect(resultIds(result)).not.toContain(hidden);
          expect(JSON.stringify(result)).not.toContain("Alpha internal only");
        }
        const fetched = await fetchItem(hidden);
        expect(fetched.isError).toBe(true);
        expect(fetched.structuredContent.code).toBe("NOT_FOUND");
      });

      it("covers at most five projects by name and skips one without an active index", async () => {
        const result = await search({ query: TOKEN }, "all");
        expect(result.isError).toBeFalsy();
        // Alpha, Beta, Charlie, Echo, Foxtrot by name; Golf is the sixth and
        // Charlie cannot be searched.
        expect(projectsIn(result)).toEqual(
          new Set([project.Alpha, project.Beta, project.Echo, project.Foxtrot]),
        );
        expect(resultIds(result).length).toBeLessThanOrEqual(30);
      });

      it("a multi-project call is project-less; paid embeddings get their own retrieval run", async () => {
        const auditBefore = (await auditRows("Alpha")).length;
        const eventsBefore = (await callEvents("two")).length;
        const before = (await reservations("Alpha")).length;
        const result = await search({ query: TOKEN }, "two");
        expect(result.isError).toBeFalsy();
        expect(projectsIn(result)).toEqual(
          new Set([project.Alpha, project.Beta]),
        );
        expect(await auditRows("Alpha")).toHaveLength(auditBefore);
        const events = (await callEvents("two")).slice(eventsBefore);
        expect(events).toHaveLength(1);
        expect(events[0]!.detail).toMatchObject({
          tool: "search",
          outcome: "ok",
        });
        const added = (await reservations("Alpha")).slice(before);
        expect(added).toHaveLength(1);
        const retrievalRuns = await runsIn("Alpha", "retrieval");
        expect(retrievalRuns.map((r) => r.id)).toContain(added[0]!.agentRunId);
        const grant = await grantFor("two");
        expect(added[0]!.key).toMatch(
          new RegExp(`^${project.Alpha}:query:mcp:${grant.id}:`),
        );
      });

      it.each([
        [
          "an expired mandate",
          { endAt: new Date(Date.now() - 60000).toISOString() },
        ],
        [
          "a mandate that has not started",
          { startAt: new Date(Date.now() + HOUR).toISOString() },
        ],
        ["a mandate without approved paid tests", { approvedPaidTests: false }],
        ["a paused project", null],
      ])(
        "%s searches lexically and opens no retrieval run or reservation",
        async (_name, change) => {
          const alpha = ownerScope("Alpha");
          const policyRow = await run(alpha, (tx) =>
            tx.entity.findFirstOrThrow({
              where: {
                workspaceId,
                projectId: project.Alpha,
                kind: "policies",
              },
            }),
          );
          const setPolicy = (data: object) =>
            run(alpha, (tx) =>
              tx.entity.update({
                where: { id: policyRow.id },
                data: { data: data as Prisma.InputJsonObject },
              }),
            );
          const setPaused = (paused: boolean) =>
            run(alpha, (tx) =>
              tx.project.update({
                where: { id: project.Alpha },
                data: { paused },
              }),
            );
          const calls = embedding.calls;
          const reservationsBefore = (await reservations("Alpha")).length;
          const runsBefore = (await runsIn("Alpha", "retrieval")).length;
          if (change)
            await setPolicy({ ...(policyRow.data as object), ...change });
          else await setPaused(true);
          try {
            const result = await search({ query: TOKEN }, "two");
            expect(result.isError).toBeFalsy();
            // Alpha is still searched, lexically.
            expect(projectsIn(result)).toEqual(
              new Set([project.Alpha, project.Beta]),
            );
            expect(resultIds(result)).toContain(
              chunkId("Alpha", "alpha plain"),
            );
          } finally {
            await setPolicy(policyRow.data as object);
            await setPaused(false);
          }
          expect(embedding.calls).toBe(calls);
          expect(await reservations("Alpha")).toHaveLength(reservationsBefore);
          expect(await runsIn("Alpha", "retrieval")).toHaveLength(runsBefore);
        },
      );

      it("a single project without an active index is an empty list", async () => {
        const result = await search({ query: TOKEN }, "charlie");
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ results: [] });
        const named = await search(
          { query: TOKEN, projectId: project.Charlie },
          "all",
        );
        expect(named.structuredContent).toEqual({ results: [] });
      });

      it("projectId narrows the search to that project", async () => {
        const result = await search(
          { query: TOKEN, projectId: project.Echo },
          "all",
        );
        expect(projectsIn(result)).toEqual(new Set([project.Echo]));
        // Golf is outside the first five, but may be named.
        const golf = await search(
          { query: TOKEN, projectId: project.Golf },
          "all",
        );
        expect(resultIds(golf)).toEqual([chunkId("Golf", "golf")]);
      });

      it("projectId outside the grant answers NOT_FOUND", async () => {
        for (const projectId of [
          project.Beta,
          project.Hotel,
          project.India,
          randomUUID(),
        ]) {
          const result = await search({ query: TOKEN, projectId });
          expect(result.isError).toBe(true);
          expect(result.structuredContent.code).toBe("NOT_FOUND");
        }
      });

      it("empty search is an empty list", async () => {
        const result = await search({ query: "nothingmatchesthisxq" }, "two");
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ results: [] });
        expect(JSON.parse(result.content[0].text)).toEqual({ results: [] });
      });

      it("refuses an empty or oversized query", async () => {
        for (const query of ["", "   ", "x".repeat(2001)]) {
          const response = await rpc(
            "tools/call",
            { name: "search", arguments: { query } },
            tokens.one,
          );
          const result = rpcBody(response).result;
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toMatch(/Invalid arguments for tool/);
        }
      });
    });

    describe("fetch", () => {
      it("returns a passage's version text with its url and metadata", async () => {
        const result = await fetchItem(chunkId("Alpha", "alpha cited"));
        expect(result.isError).toBeFalsy();
        const value = result.structuredContent;
        expect(value).toEqual({
          id: chunkId("Alpha", "alpha cited"),
          title: "Alpha cited guide",
          text: expect.stringContaining(TOKEN),
          url: "https://docs.example.com/alpha",
          metadata: {
            projectId: project.Alpha,
            kind: "chunk",
            sourceId: sources.get("alpha"),
            documentVersionId: chunks.get("alpha cited")!.versionId,
            fetchedAt: expect.any(String),
            truncated: false,
          },
        });
        expect(JSON.parse(result.content[0].text)).toEqual(value);
        // A project call: audited in its project.
        expect((await auditRows("Alpha")).at(-1)!.metadata).toMatchObject({
          tool: "fetch",
          outcome: "ok",
        });
        const plain = await fetchItem(chunkId("Alpha", "alpha plain"));
        expect(plain.structuredContent.url).toBe(
          `${appOrigin()}/p/${project.Alpha}/knowledge/library`,
        );
      });

      it("returns a fact as key: value with the facts link", async () => {
        const result = await fetchItem(factId("Alpha", "alpha fact"));
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
          id: factId("Alpha", "alpha fact"),
          title: `${FACT_PREFIX}.alpha`,
          text: `${FACT_PREFIX}.alpha: value of alpha`,
          url: `${appOrigin()}/p/${project.Alpha}/knowledge/facts`,
          metadata: {
            projectId: project.Alpha,
            kind: "fact",
            sourceId: sources.get("alpha"),
          },
        });
      });

      it("fetch ids cannot cross projects", async () => {
        const notFound = async (id: string, who: Name = "one") => {
          const result = await fetchItem(id, who);
          expect(result.isError).toBe(true);
          return result.structuredContent;
        };
        const reference = await notFound(
          `p:${project.Alpha}:chunk:${randomUUID()}`,
        );
        expect(reference).toEqual({
          code: "NOT_FOUND",
          message: "NOT FOUND",
          retryable: false,
        });
        const hotel = chunks.get("hotel")!.chunkId;
        const beta = chunks.get("beta")!.chunkId;
        const cases: [string, Name][] = [
          // Projects the grant does not hold, member or not.
          [`p:${project.Hotel}:chunk:${hotel}`, "one"],
          [`p:${project.India}:chunk:${chunks.get("india")!.chunkId}`, "one"],
          [`p:${project.Beta}:chunk:${beta}`, "one"],
          // Another project's chunk or fact under a granted project's id.
          [`p:${project.Alpha}:chunk:${beta}`, "two"],
          [`p:${project.Beta}:fact:${facts.get("alpha fact")}`, "two"],
          [`p:${project.Alpha}:chunk:${hotel}`, "one"],
          // A fact id as a chunk and the other way round.
          [
            `p:${project.Alpha}:fact:${chunks.get("alpha plain")!.chunkId}`,
            "one",
          ],
          [`p:${project.Alpha}:chunk:${facts.get("alpha fact")}`, "one"],
          // Malformed ids.
          ["", "one"],
          ["x", "one"],
          [`p:${project.Alpha}:chunk:not-a-uuid`, "one"],
          [`p:${project.Alpha}:doc:${beta}`, "one"],
          [`p:${project.Alpha}:chunk:${beta}:extra`, "one"],
          [`p:not-a-uuid:chunk:${beta}`, "one"],
          [`p:${project.Alpha.toUpperCase()}:chunk:${beta}`, "one"],
          [`${project.Alpha}:chunk:${beta}`, "one"],
        ];
        for (const [id, who] of cases)
          expect(await notFound(id, who)).toEqual(reference);
        // A project outside the grant gets no audit row (and no run) in it.
        expect(await auditRows("Hotel")).toHaveLength(0);
        expect(await runsIn("Hotel")).toHaveLength(0);
      });

      it("refuses an id longer than 200 characters", async () => {
        const response = await rpc(
          "tools/call",
          { name: "fetch", arguments: { id: "p".repeat(201) } },
          tokens.one,
        );
        const result = rpcBody(response).result;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Invalid arguments for tool/);
      });
    });

    describe("knowledge module and role", () => {
      it("a grant restricted to other modules searches nothing and fetches nothing", async () => {
        const grant = await grantFor("two");
        await authDb.mcpGrant.update({
          where: { id: grant.id },
          data: { modules: ["marketing"] },
        });
        try {
          expect(
            (await search({ query: TOKEN }, "two")).structuredContent,
          ).toEqual({ results: [] });
          const fetched = await fetchItem(
            chunkId("Alpha", "alpha plain"),
            "two",
          );
          expect(fetched.structuredContent.code).toBe("NOT_FOUND");
          const named = await search(
            { query: TOKEN, projectId: project.Alpha },
            "two",
          );
          expect(named.structuredContent).toEqual({ results: [] });
        } finally {
          await authDb.mcpGrant.update({
            where: { id: grant.id },
            data: { modules: [] },
          });
        }
        expect(projectsIn(await search({ query: TOKEN }, "two")).size).toBe(2);
      });

      const NOT_FOUND_BODY = {
        code: "NOT_FOUND",
        message: "NOT FOUND",
        retryable: false,
      };
      /**
       * Beta's knowledge is hidden: a search skips it (empty when it is the
       * only project); naming it as projectId is an empty list, as for any
       * granted project whose knowledge the member cannot read
       * (knowledgeScope returns null; 404 stays for projects outside the
       * grant); a fetch answers the identical NOT_FOUND.
       */
      async function expectBetaHidden() {
        expect(projectsIn(await search({ query: TOKEN }, "two"))).toEqual(
          new Set([project.Alpha]),
        );
        expect(
          (await search({ query: TOKEN }, "beta")).structuredContent,
        ).toEqual({ results: [] });
        expect(
          (await search({ query: TOKEN, projectId: project.Beta }, "two"))
            .structuredContent,
        ).toEqual({ results: [] });
        for (const who of ["two", "beta"] as const) {
          const fetched = await fetchItem(chunkId("Beta", "beta"), who);
          expect(fetched.isError).toBe(true);
          expect(fetched.structuredContent).toEqual(NOT_FOUND_BODY);
        }
      }
      async function expectBetaVisible() {
        expect(projectsIn(await search({ query: TOKEN }, "two"))).toEqual(
          new Set([project.Alpha, project.Beta]),
        );
        expect(
          (await fetchItem(chunkId("Beta", "beta"), "beta")).isError,
        ).toBeFalsy();
      }
      /** Sets an env flag for `run`, then restores it. */
      async function withEnvFlag(key: string, run: () => Promise<void>) {
        const saved = process.env[key];
        process.env[key] = "true";
        try {
          await run();
        } finally {
          if (saved === undefined) delete process.env[key];
          else process.env[key] = saved;
        }
      }

      it("a module role knowledge = none hides the project's knowledge", async () => {
        await expectBetaVisible();
        await withEnvFlag("ORBIT_MODULE_ROLES", async () => {
          await authDb.projectMemberModuleRole.create({
            data: {
              workspaceId,
              projectId: project.Beta,
              userId: ids.editor,
              moduleId: "knowledge",
              role: "none",
            },
          });
          try {
            await expectBetaHidden();
          } finally {
            await authDb.projectMemberModuleRole.deleteMany({
              where: { projectId: project.Beta, userId: ids.editor },
            });
          }
          await expectBetaVisible();
        });
      });

      it("the knowledge module disabled for the project hides its knowledge", async () => {
        await withEnvFlag("ORBIT_MODULES", async () => {
          await expectBetaVisible();
          await scoped(workspaceId, project.Beta, (tx) =>
            tx.projectModule.create({
              data: {
                workspaceId,
                projectId: project.Beta,
                moduleId: "knowledge",
                enabled: false,
                moduleVersion: "1.0.0",
                changedBy: ids.owner,
              },
            }),
          );
          try {
            await expectBetaHidden();
          } finally {
            await scoped(workspaceId, project.Beta, (tx) =>
              // The app never deletes activation rows; switch it back on.
              tx.projectModule.updateMany({
                where: { workspaceId, projectId: project.Beta },
                data: { enabled: true },
              }),
            );
          }
          await expectBetaVisible();
        });
      });
    });

    describe("JSON-RPC batches", () => {
      it("refuses every batch before the SDK, also an all-legacy one with search calls", async () => {
        const before = {
          embeds: embedding.calls,
          reservations: (await reservations("Alpha")).length,
          audit: (await auditRows("Alpha")).length,
          runs: (await runsIn("Alpha")).length,
          events: (await callEvents("one")).length,
        };
        const message = (id: number) => ({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "search", arguments: { query: TOKEN } },
        });
        const batches = [[message(1), message(2)], [message(3)]];
        for (const version of ["2025-03-26", "2025-11-25", MODERN, null])
          for (const batch of batches) {
            const response = await gateway.inject({
              method: "POST",
              url: "/mcp",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(version ? { "mcp-protocol-version": version } : {}),
                authorization: `Bearer ${tokens.one}`,
              },
              payload: JSON.stringify(batch),
            });
            expect(response.statusCode).toBe(400);
            expect(rpcBody(response)).toEqual({
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message: "Batch requests are not supported",
              },
              id: null,
            });
          }
        // Nothing ran: no embedding, reservation, audit row, run or log.
        expect(embedding.calls).toBe(before.embeds);
        expect(await reservations("Alpha")).toHaveLength(before.reservations);
        expect(await auditRows("Alpha")).toHaveLength(before.audit);
        expect(await runsIn("Alpha")).toHaveLength(before.runs);
        expect(await callEvents("one")).toHaveLength(before.events);
      });

      it("still needs a valid token first", async () => {
        const response = await gateway.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          payload: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
        });
        expect(response.statusCode).toBe(401);
      });
    });
  },
);
