import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { buildServer } from "../src/server.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import { makeAuth } from "../src/auth.ts";
import { createPackageProject } from "./support/package-project.ts";
import {
  createFlowDriver,
  cimdFetchFor,
  metadata,
} from "./mcp-oauth-flow-helpers.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "MCP 2.0 HTTP/OAuth end-to-end (no paid calls)",
  () => {
    let api: Awaited<ReturnType<typeof buildServer>>;
    let gateway: Awaited<ReturnType<typeof buildMcpServer>>;
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let cookie = "",
      userId = "",
      token = "";
    const client = `https://client.test/mcp2-${randomUUID()}.json`;
    const cimdFetch = cimdFetchFor({ [client]: metadata(client) });
    const saved: Record<string, string | undefined> = {};
    const flags = {
      ORBIT_MCP_OAUTH: "true",
      ORBIT_MCP_GATEWAY: "true",
      ORBIT_MCP_TASKS: "true",
      ORBIT_MCP_PROPOSALS: "true",
      ORBIT_MCP_CIMD_HOSTS: "client.test",
    };
    const driver = createFlowDriver({
      app: () => api,
      config: () => loadConfig(),
      cookie: () => cookie,
      defaultClientId: client,
      selection: () => ({
        workspaceId: project.owner.workspaceId,
        projectIds: [project.owner.projectId],
      }),
    });
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      gateway.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "tools/call"
            ? { "mcp-name": String(params.name) }
            : method === "resources/read"
              ? { "mcp-name": String(params.uri) }
              : {}),
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "mcp2-test",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
      });
    beforeAll(async () => {
      for (const [key, value] of Object.entries(flags)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      api = await buildServer(undefined, { cimdFetch });
      await api.listen({ port: 0, host: "127.0.0.1" });
      const jwksUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`;
      gateway = await buildMcpServer({
        cimdFetch,
        jwksUrl,
        taskSubscriptions: { lifetimeMs: 100, pollMs: 20 },
      });
      project = await createPackageProject({ name: "Synthetic HTTP MCP 2" });
      const password = randomBytes(24).toString("base64url"),
        email = `${randomUUID()}@example.invalid`;
      const auth = makeAuth({ cimdFetch });
      userId = (
        await auth.api.signUpEmail({
          body: { email, password, name: "Synthetic MCP owner" },
        })
      ).user.id;
      await authDb.workspaceMember.create({
        data: { workspaceId: project.owner.workspaceId, userId, role: "owner" },
      });
      const login = await driver.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers["set-cookie"];
      cookie = (Array.isArray(cookies) ? cookies : [cookies!])
        .map((c) => c.split(";")[0])
        .join("; ");
      const flow = await driver.connect();
      const exchanged = await driver.exchange(flow);
      expect(exchanged.statusCode).toBe(200);
      token = exchanged.json().access_token;
    }, 120000);
    afterAll(async () => {
      await gateway?.close();
      await api?.close();
      await project?.cleanup();
      if (userId) await authDb.user.delete({ where: { id: userId } });
      await authDb.oauthClient.deleteMany({ where: { clientId: client } });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDatabase();
    });
    it("keeps old tools, lists new capabilities, creates through real OAuth and reads durable task state after the gateway restarts", async () => {
      const list = await rpc("tools/list");
      expect(list.statusCode).toBe(200);
      const names = list.json().result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "orbit_profile",
          "orbit_projects",
          "search",
          "fetch",
          "orbit_action_status",
          "orbit_create_task",
          "orbit_get_task",
          "orbit_get_task_result",
          "orbit_cancel_task",
          "knowledge_add_document",
          "marketing_prepare_package",
        ]),
      );
      const sources = await rpc("tools/call", {
        name: "knowledge_sources",
        arguments: { projectId: project.owner.projectId },
      });
      expect(sources.json().result.isError, sources.body).not.toBe(true);
      expect(
        sources.json().result.structuredContent.result.items.length,
      ).toBeGreaterThan(0);
      const created = await rpc("tools/call", {
        name: "orbit_create_task",
        arguments: {
          projectId: project.owner.projectId,
          description: "Prepare a synthetic marketing review",
          modules: ["marketing"],
          idempotencyKey: randomUUID(),
        },
      });
      const result = created.json().result;
      expect(result.isError).not.toBe(true);
      const made = result.structuredContent;
      expect(made.taskId).toMatch(/^[a-f0-9-]{36}$/);
      await gateway.close();
      gateway = await buildMcpServer({
        cimdFetch,
        taskSubscriptions: { lifetimeMs: 100, pollMs: 20 },
        jwksUrl: `http://127.0.0.1:${(api.server.address() as { port: number }).port}/api/auth/jwks`,
      });
      const read = await rpc("tools/call", {
        name: "orbit_get_task",
        arguments: { projectId: project.owner.projectId, taskId: made.taskId },
      });
      expect(read.json().result.structuredContent.task.status).toBe(
        "awaiting_approval",
      );
      const resource = await rpc("resources/read", {
        uri: `orbit://tasks/${project.owner.projectId}/${made.taskId}`,
      });
      expect(resource.statusCode, resource.body).toBe(200);
      expect(JSON.parse(resource.json().result.contents[0].text).taskId).toBe(
        made.taskId,
      );
      const stream = await rpc("subscriptions/listen", {
        notifications: {
          resourceSubscriptions: [
            `orbit://tasks/${project.owner.projectId}/${made.taskId}`,
          ],
        },
      });
      expect(stream.statusCode).toBe(200);
      expect(stream.headers["content-type"]).toContain("text/event-stream");
      expect(stream.body).toContain("notifications/subscriptions/acknowledged");
      const web = await driver.inject({
        url: `/api/projects/${project.owner.projectId}/assistant-tasks`,
      });
      expect(web.statusCode).toBe(200);
      expect(web.json().items[0].taskId).toBe(made.taskId);
      const inbox = await driver.inject({
        url: `/api/projects/${project.owner.projectId}/action-requests`,
      });
      expect(
        inbox.json().items.find((r: any) => r.id === made.actionRequestId)
          .summary.task.description,
      ).toContain("synthetic");
    });
  },
);
