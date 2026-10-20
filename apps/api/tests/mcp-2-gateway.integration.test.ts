import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createSign,
} from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  authDb,
  scoped,
  closeDatabase,
} from "../../../packages/db/src/index.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { SCOPES } from "./mcp-oauth-flow-helpers.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { buildServer } from "../src/server.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import { makeAuth } from "../src/auth.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
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
    const supportScopes = `${SCOPES} orbit:support`;
    const resource = `${process.env.APP_ORIGIN}/mcp-upgrade-${randomUUID()}`;
    const clientKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const clientJwk = {
      ...clientKeys.publicKey.export({ format: "jwk" }),
      kid: "synthetic-cimd-rsa",
      alg: "RS256",
      use: "sig",
    };
    const clientAssertion = () => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${encode({ alg: "RS256", kid: clientJwk.kid })}.${encode({ iss: client, sub: client, aud: `${loadConfig().APP_ORIGIN}/api/auth`, iat: now, exp: now + 60, jti: randomUUID() })}`;
      return {
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: `${input}.${createSign("RSA-SHA256").update(input).sign(clientKeys.privateKey).toString("base64url")}`,
      };
    };
    const cimdFetch = cimdFetchFor({
      [client]: metadata(client, {
        scope: supportScopes,
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        jwks: { keys: [clientJwk] },
      }),
    });
    const saved: Record<string, string | undefined> = {};
    const flags = {
      ORBIT_MCP_OAUTH: "true",
      ORBIT_MCP_GATEWAY: "true",
      ORBIT_MCP_TASKS: "true",
      ORBIT_MCP_PROPOSALS: "true",
      ORBIT_SUPPORT: "true",
      ORBIT_MODULES: "true",
      ORBIT_MCP_CIMD_HOSTS: "client.test",
      MCP_RESOURCE: resource,
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
      // Existing installations retain the first resource policy across deploys.
      // Use a unique resource so this upgrade fixture never alters other tests.
      await authDb.oauthResource.create({
        data: {
          id: randomUUID(),
          identifier: resource,
          name: "Legacy MCP resource",
          allowedScopes: SCOPES.split(" "),
          accessTokenTtl: 91,
          refreshTokenTtl: 3600,
          disabled: true,
          customClaims: { upgradeSentinel: "preserved" },
        },
      });
      await makeAuth({ cimdFetch }).$context;
      const bootstrapped = await authDb.oauthResource.findUniqueOrThrow({
        where: { identifier: resource },
      });
      expect(bootstrapped.disabled).toBe(true);
      expect(bootstrapped.accessTokenTtl).toBe(91);
      expect(bootstrapped.refreshTokenTtl).toBe(3600);
      expect(bootstrapped.customClaims).toEqual({
        upgradeSentinel: "preserved",
      });
      await authDb.oauthResource.update({
        where: { identifier: resource },
        data: { disabled: false },
      });
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
      const flow = await driver.connect({
        scope: supportScopes,
        consent: { scopes: supportScopes.split(" ") },
      });
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
      await authDb.oauthResource.deleteMany({
        where: { identifier: resource },
      });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDatabase();
    });
    it("reconciles legacy resource scopes on startup without replacing other policy", async () => {
      const stored = await authDb.oauthResource.findUniqueOrThrow({
        where: { identifier: resource },
      });
      expect(stored.allowedScopes).toEqual([...MCP_SCOPES]);
      expect(stored.accessTokenTtl).toBe(91);
      expect(stored.refreshTokenTtl).toBe(3600);
      expect(stored.customClaims).toEqual({ upgradeSentinel: "preserved" });
      const profile = (
        await rpc("tools/call", { name: "orbit_profile", arguments: {} })
      ).json().result.structuredContent;
      expect(profile.grantedScopes).toContain("orbit:support");
      expect(profile.effectiveScopes).toContain("orbit:support");
    });
    it("keeps old tools, lists new capabilities, creates through real OAuth and reads durable task state after the gateway restarts", async () => {
      const profile = (
        await rpc("tools/call", { name: "orbit_profile", arguments: {} })
      ).json().result.structuredContent;
      expect(profile.effectiveScopes).toContain("orbit:support");
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
    it("exposes Support schemas over real OAuth and sends no reply until the exact native web approval", async () => {
      const made = await scoped(
        project.owner.workspaceId,
        project.owner.projectId,
        async (tx) => {
          await tx.projectModule.create({
            data: {
              workspaceId: project.owner.workspaceId,
              projectId: project.owner.projectId,
              moduleId: "support",
              moduleVersion: "1.0.0",
              enabled: true,
            },
          });
          const inbox = await createMailInbox(tx, project.owner, {
            name: "Synthetic OAuth Support",
            channels: ["email"],
            emailAddress: "http-support@example.invalid",
            rules: { autoAck: false },
          });
          return createTicket(tx, project.owner, {
            inboxId: inbox.inbox.id,
            channel: "email",
            inbound: {
              externalId: randomUUID(),
              contact: { email: "http-customer@example.invalid" },
              subject: "HTTP Support question",
              bodyText: "Please help with the report.",
              attachments: [],
            },
          });
        },
      );
      const definitions = (await rpc("tools/list")).json().result.tools;
      for (const name of [
        "support_list_tickets",
        "support_get_ticket",
        "support_list_messages",
        "support_reply_ticket",
        "support_add_internal_note",
        "support_update_ticket",
        "support_list_categories",
        "support_list_tags",
        "support_create_category",
        "support_update_category",
        "support_delete_category",
        "support_create_tag",
        "support_update_tag",
        "support_delete_tag",
      ]) {
        const def = definitions.find((t: any) => t.name === name);
        expect(def, name).toBeDefined();
        expect(def.inputSchema.additionalProperties).toBe(false);
        expect(def.outputSchema.additionalProperties).toBe(false);
        expect(def._meta.securitySchemes[0].scopes).toContain("orbit:support");
        if (name === "support_reply_ticket") {
          expect(def.annotations.destructiveHint).toBe(true);
          expect(def.annotations.openWorldHint).toBe(true);
          expect(def.description).toContain(
            "owner has enabled direct MCP replies",
          );
          expect(def.description).toContain("for the ticket inbox");
        }
        expect(def.annotations.readOnlyHint).toBe(
          ![
            "support_reply_ticket",
            "support_add_internal_note",
            "support_update_ticket",
            "support_create_category",
            "support_update_category",
            "support_delete_category",
            "support_create_tag",
            "support_update_tag",
            "support_delete_tag",
          ].includes(name),
        );
      }
      const call = async (name: string, args: any) => {
        const res = await rpc("tools/call", {
          name,
          arguments: { projectId: project.owner.projectId, ...args },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().result.isError, res.body).not.toBe(true);
        return res.json().result.structuredContent;
      };
      expect((await call("support_list_categories", {})).result.items).toEqual(
        [],
      );
      expect((await call("support_list_tags", {})).result.items).toEqual([]);
      const taxonomyProposal = await call("support_create_category", {
        key: "http_category",
        label: "HTTP category",
        idempotencyKey: randomUUID(),
      });
      expect(taxonomyProposal).toMatchObject({
        status: "pending",
        requiresApproval: true,
      });
      expect((await call("support_list_categories", {})).result.items).toEqual(
        [],
      );
      expect(
        (await call("support_list_tickets", { q: "HTTP Support question" }))
          .result.items[0].id,
      ).toBe(made.ticketId);
      expect(
        (await call("support_get_ticket", { ticketId: made.ticketId })).result
          .ticket.id,
      ).toBe(made.ticketId);
      expect(
        (
          await call("support_list_messages", { ticketId: made.ticketId })
        ).result.items.some((m: any) => m.bodyText?.includes("Please help")),
      ).toBe(true);
      const key = randomUUID();
      const request = await call("support_reply_ticket", {
        ticketId: made.ticketId,
        message: "Your report is being reviewed.",
        idempotencyKey: key,
      });
      expect(
        (
          await call("orbit_get_action_result", {
            actionRequestId: request.actionRequestId,
          })
        ).result,
      ).toBeNull();
      // MCP bearer credentials must not authorize the cookie-only native REST
      // reply endpoint, which would otherwise skip this proposal's approval.
      const bypass = await api.inject({
        method: "POST",
        url: `/api/projects/${project.owner.projectId}/support/tickets/${made.ticketId}/replies`,
        headers: {
          authorization: `Bearer ${token}`,
          origin: loadConfig().APP_ORIGIN,
        },
        payload: { bodyText: "Attempted direct reply" },
      });
      expect([401, 403]).toContain(bypass.statusCode);
      expect(
        await scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
          tx.supportMessage.count({
            where: { ticketId: made.ticketId, kind: "agent_reply" },
          }),
        ),
      ).toBe(0);
      const list = await driver.inject({
        url: `/api/projects/${project.owner.projectId}/action-requests`,
      });
      const pending = list
        .json()
        .items.find((r: any) => r.id === request.actionRequestId);
      expect(pending.summary.operation).toMatchObject({
        ticketId: made.ticketId,
        bodyText: "Your report is being reviewed.",
        approvalContext: { recipient: "http-customer@example.invalid" },
      });
      const approved = await driver.inject({
        method: "POST",
        url: `/api/projects/${project.owner.projectId}/action-requests/${request.actionRequestId}/decide`,
        payload: {
          version: pending.version,
          packageHash: pending.packageHash,
          decision: "approve",
        },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      const receipt = await call("orbit_get_action_result", {
        actionRequestId: request.actionRequestId,
      });
      expect(receipt).toMatchObject({
        status: "consumed",
        result: { ticketId: made.ticketId, kind: "agent_reply" },
      });
      const retry = await call("support_reply_ticket", {
        ticketId: made.ticketId,
        message: "Your report is being reviewed.",
        idempotencyKey: key,
      });
      expect(retry).toMatchObject({
        actionRequestId: request.actionRequestId,
        deduplicated: true,
      });
      const missingProject = await rpc("tools/call", {
        name: "support_get_ticket",
        arguments: { ticketId: made.ticketId },
      });
      expect(
        missingProject.json().error ?? missingProject.json().result.isError,
      ).toBeTruthy();
      const invalid = await rpc("tools/call", {
        name: "support_reply_ticket",
        arguments: {
          projectId: project.owner.projectId,
          ticketId: made.ticketId,
          message: "No unknown fields",
          idempotencyKey: randomUUID(),
          autoApprove: true,
        },
      });
      expect(
        invalid.json().error ?? invalid.json().result.isError,
      ).toBeTruthy();
      // A token with only the old scopes must not gain the new content surface.
      const minimal = await driver.connect({
        consent: { scopes: SCOPES.split(" ") },
      });
      const reduced = await driver.exchange(minimal);
      expect(reduced.statusCode).toBe(200);
      const originalToken = token;
      token = reduced.json().access_token;
      try {
        // Descriptions must remain discoverable so the client can request
        // Support; execution still requires a correctly scoped token.
        expect(
          (await rpc("tools/list")).json().result.tools.map((t: any) => t.name),
        ).toContain("support_get_ticket");
      } finally {
        token = originalToken;
      }
    });
    it("reads Support through a signed RS256 client exchange and refresh", async () => {
      const flow = await driver.connect({
        scope: supportScopes,
        consent: { scopes: supportScopes.split(" ") },
      });
      const issued = await driver.exchange(flow, clientAssertion());
      expect(issued.statusCode, issued.body).toBe(200);
      const refreshed = await driver.inject({
        method: "POST",
        url: "/api/auth/oauth2/token",
        session: false,
        noOrigin: true,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.json().refresh_token,
          client_id: client,
          ...clientAssertion(),
        }).toString(),
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      token = refreshed.json().access_token;
      const tickets = await rpc("tools/call", {
        name: "support_list_tickets",
        arguments: { projectId: project.owner.projectId },
      });
      expect(tickets.statusCode, tickets.body).toBe(200);
      expect(tickets.json().result.isError, tickets.body).not.toBe(true);
    });
    it("can read Support after revoking and granting the exact ChatGPT scopes again", async () => {
      const chatgptScopes =
        "openid email offline_access orbit:propose orbit:read orbit:support";
      for (let attempt = 0; attempt < 3; attempt++) {
        const active = await authDb.mcpGrant.findFirstOrThrow({
          where: {
            userId,
            clientId: client,
            workspaceId: project.owner.workspaceId,
            status: "active",
          },
        });
        const revoked = await driver.inject({
          method: "DELETE",
          url: `/api/mcp-grants/${active.id}`,
        });
        expect(revoked.statusCode, revoked.body).toBe(204);
        const unauthenticated = await rpc("tools/list");
        expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);
        // Distinguish the intentionally conservative same-second replay boundary.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const flow = await driver.connect({
          scope: chatgptScopes,
          consent: { scopes: chatgptScopes.split(" ") },
        });
        expect(flow.steps).toContain("consent");
        const exchange = await driver.exchange(flow);
        expect(exchange.statusCode, exchange.body).toBe(200);
        const issued = exchange.json();
        token = issued.access_token;
        const refresh = await driver.refresh(issued.refresh_token);
        expect(refresh.statusCode, refresh.body).toBe(200);
        for (const candidate of [
          issued.access_token,
          refresh.json().access_token,
        ]) {
          token = candidate;
          const result = await rpc("tools/call", {
            name: "orbit_profile",
            arguments: {},
          });
          expect(result.statusCode, result.body).toBe(200);
          expect(
            result.json().result.structuredContent.effectiveScopes,
          ).toContain("orbit:support");
          const tickets = await rpc("tools/call", {
            name: "support_list_tickets",
            arguments: { projectId: project.owner.projectId },
          });
          expect(tickets.statusCode, tickets.body).toBe(200);
          expect(tickets.json().result.isError, tickets.body).not.toBe(true);
        }
      }
    });
    it("discovers Support schemas with an older token and challenges content calls without granting access", async () => {
      const minimal = await driver.connect({
        scope: SCOPES,
        consent: { scopes: SCOPES.split(" ") },
      });
      const old = await driver.exchange(minimal);
      expect(old.statusCode).toBe(200);
      const upgraded = await driver.connect({
        scope: supportScopes,
        consent: { scopes: supportScopes.split(" ") },
      });
      const fresh = await driver.exchange(upgraded);
      expect(fresh.statusCode).toBe(200);
      token = old.json().access_token;
      const profile = (
        await rpc("tools/call", { name: "orbit_profile", arguments: {} })
      ).json().result.structuredContent;
      expect(profile.effectiveScopes).not.toContain("orbit:support");
      expect(profile.grantedScopes).toContain("orbit:support");
      const list = await rpc("tools/list");
      expect(list.statusCode).toBe(200);
      const definition = list
        .json()
        .result.tools.find((t: any) => t.name === "support_list_tickets");
      expect(definition._meta.securitySchemes[0].scopes).toContain(
        "orbit:support",
      );
      expect(definition.securitySchemes).toEqual(
        definition._meta.securitySchemes,
      );
      expect(list.body).not.toContain("HTTP Support question");
      // A narrower token never gains the stored consent's content access.
      const refused = await rpc("tools/call", {
        name: "support_list_tickets",
        arguments: { projectId: project.owner.projectId },
      });
      expect(refused.json().result.isError).toBe(true);
      expect(refused.json().result.structuredContent.code).toBe(
        "INSUFFICIENT_SCOPE",
      );
      const challenge = refused.json().result._meta["mcp/www_authenticate"][0];
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain("orbit:support");
      expect(challenge).toContain("offline_access");
      expect(challenge).toContain("resource_metadata=");
      // Follow the scope declaration and challenge as a real client would.
      // Identity/refresh scopes survive step-up; consent never authorizes the
      // old narrow token to read content.
      const challengedScopes = /scope="([^"]+)"/.exec(challenge)![1]!;
      const stepUp = await driver.connect({
        scope: challengedScopes,
        consent: { scopes: challengedScopes.split(" ") },
      });
      const stepUpToken = await driver.exchange(stepUp);
      expect(stepUpToken.statusCode, stepUpToken.body).toBe(200);
      expect(stepUpToken.json().refresh_token).toEqual(expect.any(String));
      const narrowToken = token;
      for (const issued of [
        stepUpToken,
        await driver.refresh(stepUpToken.json().refresh_token),
      ]) {
        expect(issued.statusCode, issued.body).toBe(200);
        token = issued.json().access_token;
        const read = await rpc("tools/call", {
          name: "support_list_tickets",
          arguments: { projectId: project.owner.projectId },
        });
        expect(read.json().result.isError, read.body).not.toBe(true);
        const items = read.json().result.structuredContent.result.items;
        expect(items).toHaveLength(1);
        expect(items[0].subject).toMatch(/Support question$/);
        expect(items[0].untrusted).toBe(true);
      }
      token = narrowToken;
      expect(refused.body).not.toContain("HTTP Support question");
      const foreign = await rpc("tools/call", {
        name: "support_list_tickets",
        arguments: { projectId: randomUUID() },
      });
      expect(foreign.json().result.structuredContent.code).toBe("NOT_FOUND");
      expect(
        foreign.json().result._meta?.["mcp/www_authenticate"],
      ).toBeUndefined();
      // ChatGPT's 2025 protocol path must discover and step up identically.
      for (const method of ["tools/list", "tools/call"]) {
        const legacy = await gateway.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          payload: {
            jsonrpc: "2.0",
            id: 42,
            method,
            params:
              method === "tools/list"
                ? {}
                : {
                    name: "support_list_tickets",
                    arguments: { projectId: project.owner.projectId },
                  },
          },
        });
        expect(legacy.statusCode, legacy.body).toBe(200);
        const frame = legacy.body
          .split("\n")
          .find((line) => line.startsWith("data: "));
        const body = frame ? JSON.parse(frame.slice(6)) : legacy.json();
        if (method === "tools/list") {
          expect(body.result.tools.map((t: any) => t.name)).toContain(
            "support_list_tickets",
          );
          const support = body.result.tools.find(
            (t: any) => t.name === "support_list_tickets",
          );
          expect(support.securitySchemes).toEqual(
            support._meta.securitySchemes,
          );
        } else
          expect(body.result._meta["mcp/www_authenticate"][0]).toContain(
            "orbit:support",
          );
      }
      process.env.ORBIT_MCP_TASKS = "false";
      try {
        expect((await rpc("tools/list")).statusCode).toBe(200);
      } finally {
        process.env.ORBIT_MCP_TASKS = "true";
      }
      process.env.ORBIT_SUPPORT = "false";
      try {
        expect((await rpc("tools/list")).statusCode).toBe(200);
      } finally {
        process.env.ORBIT_SUPPORT = "true";
      }
      const activeGrant = {
        clientId: client,
        userId,
        workspaceId: project.owner.workspaceId,
        status: "active",
      };
      await authDb.mcpGrant.updateMany({
        where: activeGrant,
        data: { scopes: SCOPES.split(" ") },
      });
      try {
        const unconsented = (await rpc("tools/list")).json().result.tools;
        expect(unconsented.map((t: any) => t.name)).toContain(
          "support_list_tickets",
        );
        const denied = await rpc("tools/call", {
          name: "support_list_tickets",
          arguments: { projectId: project.owner.projectId },
        });
        expect(denied.json().result.structuredContent.code).toBe(
          "INSUFFICIENT_SCOPE",
        );
        expect(denied.body).not.toContain("HTTP Support question");
      } finally {
        await authDb.mcpGrant.updateMany({
          where: activeGrant,
          data: { scopes: supportScopes.split(" ") },
        });
      }
      await authDb.mcpGrant.updateMany({
        where: activeGrant,
        data: { modules: ["knowledge"] },
      });
      try {
        expect((await rpc("tools/list")).statusCode).toBe(200);
      } finally {
        await authDb.mcpGrant.updateMany({
          where: activeGrant,
          data: { modules: [] },
        });
      }
      await scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
        tx.projectModule.updateMany({
          where: { projectId: project.owner.projectId, moduleId: "support" },
          data: { enabled: false },
        }),
      );
      try {
        expect((await rpc("tools/list")).statusCode).toBe(200);
      } finally {
        await scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
          tx.projectModule.updateMany({
            where: { projectId: project.owner.projectId, moduleId: "support" },
            data: { enabled: true },
          }),
        );
      }
      token = fresh.json().access_token;
      expect(
        (await rpc("tools/list")).json().result.tools.map((t: any) => t.name),
      ).toContain("support_list_tickets");
    });
  },
);
