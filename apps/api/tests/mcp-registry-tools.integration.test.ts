import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  projectStatusOutput,
  readTools,
} from "../src/modules/marketing/tools/read-tools.ts";
import { readinessActions } from "../src/modules/marketing/readiness/action-readiness.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import {
  supportInsights,
  supportInsightsOutput,
} from "../src/modules/support/tools.ts";
import { buildMcpServer } from "../src/platform/mcp/server.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  metadata,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M3, Task 4: the first registry tools exposed to MCP clients,
// `marketing_project_status` and `support_insights`, through the gateway with
// real WP-M1 tokens. Both opt in with `exposure.mcp` and a strict output
// schema; the assistant's output is unchanged.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const HOUR = 3600000;
// Customer text that must never reach an MCP result (Q-12a).
const SECRET_SUBJECT = "Quorvanth refund secret subject";

const names = ["alpha", "beta", "viewer", "all"] as const;
type Name = (typeof names)[number];
const CLIENT = Object.fromEntries(
  names.map((n) => [n, `https://client.test/registry-tools-${n}.json`]),
) as Record<Name, string>;
const cimdFetch = cimdFetchFor(
  Object.fromEntries(Object.values(CLIENT).map((id) => [id, metadata(id)])),
);

const FLAGS = {
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MCP_GATEWAY: "true",
  ORBIT_MCP_CIMD_HOSTS: "client.test",
} as const;

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(values);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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

const projectNames = ["Alpha", "Beta", "Gamma", "Delta"] as const;
type ProjectName = (typeof projectNames)[number];

/** Every JSON-schema object is closed or a typed map; every array is bounded. */
function assertClosedAndBounded(schema: Json, path = "$"): void {
  if (schema.type === "object") {
    expect(
      schema.additionalProperties === false ||
        typeof schema.additionalProperties === "object" ||
        schema.patternProperties !== undefined,
      `${path} is open`,
    ).toBe(true);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      assertClosedAndBounded(child as Json, `${path}.${key}`);
    if (typeof schema.additionalProperties === "object")
      assertClosedAndBounded(schema.additionalProperties, `${path}{}`);
  }
  if (schema.type === "array") {
    expect(typeof schema.maxItems, `${path} is unbounded`).toBe("number");
    assertClosedAndBounded(schema.items, `${path}[]`);
  }
  for (const alternative of schema.anyOf ?? [])
    assertClosedAndBounded(alternative, path);
}

describe.skipIf(!enabled)(
  "MCP registry tools: project status and support",
  () => {
    let api: Awaited<ReturnType<typeof buildServer>>;
    let gateway: FastifyInstance;
    let auth: ReturnType<typeof makeAuth>;
    let appConfig: ReturnType<typeof loadConfig>;
    let jwksUrl = "";
    let cookie = "";
    let selection: { workspaceId: string; projectIds: string[] } = {
      workspaceId: "",
      projectIds: [],
    };
    const ids = {} as Record<"owner" | "editor", string>;
    const users: string[] = [];
    let workspaceId = "";
    const project = {} as Record<ProjectName, string>;
    const tokens = {} as Record<Name, string>;
    let draftId = "";
    let approvalContentId = "";

    const driver = createFlowDriver({
      app: () => api,
      config: () => appConfig,
      cookie: () => cookie,
      selection: () => selection,
      defaultClientId: CLIENT.alpha,
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
                name: "registry-tools-test",
                version: "1",
              },
              [`${META}clientCapabilities`]: {},
            },
          },
        }),
      });
    }
    const list = async (who: Name) =>
      rpcBody(await rpc("tools/list", {}, tokens[who])).result.tools as Json[];
    const listed = async (who: Name) => (await list(who)).map((t) => t.name);
    async function call(name: string, args: Json, who: Name = "alpha") {
      const response = await rpc(
        "tools/call",
        { name, arguments: args },
        tokens[who],
      );
      expect(response.statusCode).toBe(200);
      return rpcBody(response);
    }
    const ownerScope = (name: ProjectName): Scope => ({
      workspaceId,
      projectId: project[name],
      userId: ids.owner,
      role: "owner",
    });
    const inProject = <T>(
      name: ProjectName,
      work: Parameters<typeof scoped<T>>[2],
    ) => scoped(workspaceId, project[name], work);
    const grantFor = (name: Name) =>
      authDb.mcpGrant.findFirstOrThrow({
        where: { userId: ids.editor, clientId: CLIENT[name] },
      });

    beforeAll(async () => {
      process.env.ORBIT_SUPPORT = "true";
      await withEnv(FLAGS, async () => {
        appConfig = loadConfig();
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
      const emails = {} as Record<"owner" | "editor", string>;
      for (const who of ["owner", "editor"] as const) {
        emails[who] = `${randomUUID()}@example.invalid`;
        const created = await auth.api.signUpEmail({
          body: {
            email: emails[who],
            name: `Synthetic registry ${who}`,
            password,
          },
        });
        ids[who] = created.user.id;
        users.push(created.user.id);
      }
      const workspace = await authDb.workspace.create({
        data: {
          name: "Synthetic registry tools workspace",
          members: {
            create: [
              { userId: ids.owner, role: "owner" },
              { userId: ids.editor, role: "editor" },
            ],
          },
          projects: {
            create: projectNames.map((name) => ({
              name,
              ...(name === "Delta"
                ? {}
                : {
                    members: {
                      create: [
                        {
                          userId: ids.editor,
                          role: name === "Gamma" ? "viewer" : "editor",
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

      // Alpha: a complete marketing project and an enabled support module.
      const alpha = ownerScope("Alpha");
      await inProject("Alpha", async (tx) => {
        await create(tx, alpha, "policies", {
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
        await create(tx, alpha, "connectors", {
          provider: "postiz",
          status: "read_verified",
          channels: [
            {
              id: "x-test",
              name: "Registry X",
              identifier: "x",
              disabled: false,
            },
          ],
          assignedIntegrationIds: ["x-test"],
        });
        approvalContentId = randomUUID();
        await create(tx, alpha, "approvals", {
          contentId: approvalContentId,
          status: "pending",
        });
        draftId = (
          await create(tx, alpha, "content", {
            title: "Registry draft title",
            status: "draft",
          })
        ).id;
        await tx.projectMarketingProfile.create({
          data: {
            workspaceId,
            projectId: project.Alpha,
            version: 3,
            data: marketingProfile.parse({
              productName: "Synthetic brand",
              contentLanguage: "en",
              internalLanguage: "de",
              audience: "Product teams",
              positioning: "Evidence-led publishing",
              productStrategy: "Explain the product",
              presaleStrategy: "Use verified facts only",
              voice: ["Clear"],
              guardrails: ["No unsupported claims"],
              primaryCtas: ["Learn more"],
              channelPriority: ["x"],
              notificationPreference: "none",
              officialLinks: [
                {
                  label: "Website",
                  url: "https://example.invalid/",
                  factId: randomUUID(),
                },
              ],
              assetPolicy: "approved_only",
            }),
          },
        });
      });
      // Support: Alpha and Gamma enable it, Beta does not. Alpha has three open
      // tickets (one assigned, one high priority and categorised) and one closed.
      for (const name of ["Alpha", "Gamma"] as const)
        await inProject(name, (tx) =>
          tx.projectModule.create({
            data: {
              workspaceId,
              projectId: project[name],
              moduleId: "support",
              enabled: true,
              moduleVersion: "1.0.0",
            },
          }),
        );
      await inProject("Alpha", async (tx) => {
        const inbox = (
          await createMailInbox(tx, alpha, {
            name: "Registry mail",
            channels: ["email"],
            emailAddress: "registry@example.invalid",
          })
        ).inbox.id;
        const make = async (fields: Record<string, unknown>) => {
          const ticket = await createTicket(tx, alpha, {
            inboxId: inbox,
            channel: "email",
            now: new Date(),
            inbound: {
              externalId: null,
              contact: { email: `${randomUUID()}@example.org` },
              subject: SECRET_SUBJECT,
              bodyText: `${SECRET_SUBJECT} body`,
              attachments: [],
            },
          });
          await tx.supportTicket.update({
            where: { id: ticket.ticketId },
            data: fields,
          });
        };
        await make({});
        await make({ assigneeUserId: ids.editor, status: "open" });
        await make({ priority: "high", category: "deposits" });
        await make({ status: "closed" });
      });

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

      tokens.alpha = await tokenFor("alpha", [project.Alpha]);
      tokens.beta = await tokenFor("beta", [project.Beta]);
      tokens.viewer = await tokenFor("viewer", [project.Gamma]);
      tokens.all = await tokenFor("all", [
        project.Alpha,
        project.Beta,
        project.Gamma,
      ]);
    }, 180_000);

    afterAll(async () => {
      delete process.env.ORBIT_SUPPORT;
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

    describe("listing", () => {
      it("lists project status for every member and support insights where the module is on", async () => {
        const wanted = ["marketing_project_status", "support_insights"];
        // Alpha and Gamma have support on; the viewer role may read both.
        expect(await listed("alpha")).toEqual([
          "fetch",
          "marketing_project_status",
          "orbit_action_status",
          "orbit_profile",
          "orbit_projects",
          "search",
          "support_insights",
        ]);
        expect(await listed("viewer")).toEqual(expect.arrayContaining(wanted));
        // Beta has no support row: only the project status.
        expect(await listed("beta")).toEqual([
          "fetch",
          "marketing_project_status",
          "orbit_action_status",
          "orbit_profile",
          "orbit_projects",
          "search",
        ]);
        // A grant over several projects lists what any of them allows.
        expect(await listed("all")).toEqual(expect.arrayContaining(wanted));
      });

      it("hides support while ORBIT_SUPPORT is off for the installation", async () => {
        await withEnv({ ORBIT_SUPPORT: undefined }, async () => {
          expect(await listed("alpha")).not.toContain("support_insights");
          expect(await listed("alpha")).toContain("marketing_project_status");
          const refused = await call("support_insights", {});
          expect(refused.error).toMatchObject({ code: -32602 });
        });
      });

      it("follows the grant's module restriction", async () => {
        const grant = await grantFor("alpha");
        try {
          await authDb.mcpGrant.update({
            where: { id: grant.id },
            data: { modules: ["support"] },
          });
          const support = await listed("alpha");
          expect(support).toContain("support_insights");
          expect(support).not.toContain("marketing_project_status");
          await authDb.mcpGrant.update({
            where: { id: grant.id },
            data: { modules: ["marketing"] },
          });
          const marketing = await listed("alpha");
          expect(marketing).toContain("marketing_project_status");
          expect(marketing).not.toContain("support_insights");
        } finally {
          await authDb.mcpGrant.update({
            where: { id: grant.id },
            data: { modules: grant.modules },
          });
        }
      });

      it("pins closed, bounded output schemas and read-only annotations", async () => {
        const tools = await list("alpha");
        for (const name of ["marketing_project_status", "support_insights"]) {
          const tool = tools.find((t) => t.name === name)!;
          expect(tool.annotations).toMatchObject({
            readOnlyHint: true,
            openWorldHint: false,
          });
          expect(tool._meta.securitySchemes).toEqual([
            { type: "oauth2", scopes: ["orbit:read"] },
          ]);
          expect(tool.outputSchema.type).toBe("object");
          expect(tool.outputSchema.additionalProperties).toBe(false);
          assertClosedAndBounded(tool.outputSchema);
        }
        const status = tools.find(
          (t) => t.name === "marketing_project_status",
        )!;
        expect(status.outputSchema.required).toEqual(
          expect.arrayContaining([
            "project",
            "now",
            "marketingProfile",
            "availableChannels",
            "policy",
            "approvals",
            "drafts",
            "readiness",
          ]),
        );
        // One granted project: projectId optional, nothing else to pass.
        expect(status.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: { projectId: { type: "string", format: "uuid" } },
        });
        expect(Object.keys(status.inputSchema.properties)).toEqual([
          "projectId",
        ]);
      });
    });

    describe("marketing_project_status", () => {
      it("returns the full status in a schema-valid result", async () => {
        const body = await call("marketing_project_status", {});
        const result = body.result;
        expect(result.isError).toBeFalsy();
        const status = projectStatusOutput.parse(result.structuredContent);
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
        expect(result.structuredContent).not.toHaveProperty("cards");
        expect(status.project).toEqual({
          id: project.Alpha,
          name: "Alpha",
          timezone: "UTC",
          language: "en",
          mode: "observe",
          paused: false,
        });
        expect(Date.parse(status.now)).toBeGreaterThan(Date.now() - 60_000);
        expect(status.marketingProfile).toEqual({
          version: 3,
          language: "en",
          primaryCtas: ["Learn more"],
          officialLinks: [
            {
              label: "Website",
              url: "https://example.invalid/",
              factId: expect.any(String),
            },
          ],
        });
        expect(status.availableChannels).toEqual([
          { id: "x-test", name: "Registry X", provider: "x" },
        ]);
        expect(status.policy).toMatchObject({
          version: 1,
          channels: ["x-test"],
          contentTypes: ["social"],
          modelBudget: {
            currency: "USD",
            approvedPaidTests: true,
            mandateActiveNow: true,
            dailyLimitMicros: 100000,
            monthlyLimitMicros: 100000,
            perRunLimitMicros: 10000,
          },
        });
        expect(status.approvals).toEqual([
          {
            id: expect.any(String),
            contentId: approvalContentId,
            status: "pending",
          },
        ]);
        expect(status.drafts).toEqual([
          { id: draftId, title: "Registry draft title", status: "draft" },
        ]);
        // No knowledge source yet: nothing to test with.
        expect(status.readiness.state).toBe("not_configured");
        expect(status.readiness.blockers).toEqual(
          expect.arrayContaining(["PUBLISHER_WRITE_VERIFICATION_REQUIRED"]),
        );
        expect(Object.keys(status.readiness.actions).sort()).toEqual(
          [...readinessActions].sort(),
        );
        // No credentials or internals ride along (no extra keys survive).
        expect(Object.keys(result.structuredContent).sort()).toEqual(
          [
            "approvals",
            "availableChannels",
            "drafts",
            "marketingProfile",
            "now",
            "policy",
            "project",
            "readiness",
          ].sort(),
        );
      });

      it("equals what the assistant gets, minus the time and the cards", async () => {
        const tool = readTools.find((t) => t.name === "project_status")!;
        expect(tool.exposure).toEqual({ assistant: true, mcp: true });
        const { output, cards } = await tool.execute(
          {
            scope: {
              ...ownerScope("Alpha"),
              userId: ids.editor,
              role: "editor",
            },
            runId: randomUUID(),
            conversationId: "assistant-parity",
            callIndex: 1,
          },
          {},
        );
        // The assistant still gets its link cards.
        expect(cards.map((card) => card.kind)).toEqual(["link", "link"]);
        const mcp = (await call("marketing_project_status", {})).result
          .structuredContent;
        const { now: assistantNow, ...assistant } = output as Json;
        const { now: mcpNow, ...over } = mcp;
        expect(over).toEqual(assistant);
        expect(Date.parse(mcpNow) - Date.parse(assistantNow)).toBeLessThan(
          30_000,
        );
      });

      it("answers a project without marketing data with empty parts", async () => {
        const result = (
          await call(
            "marketing_project_status",
            { projectId: project.Gamma },
            "viewer",
          )
        ).result;
        expect(result.isError).toBeFalsy();
        const status = projectStatusOutput.parse(result.structuredContent);
        expect(status).toMatchObject({
          project: { id: project.Gamma, name: "Gamma" },
          marketingProfile: null,
          policy: null,
          availableChannels: [],
          approvals: [],
          drafts: [],
        });
        expect(status.readiness.state).toBe("not_configured");
      });

      it("never answers for a project outside the grant", async () => {
        for (const projectId of [project.Delta, project.Beta, randomUUID()]) {
          const result = (
            await call("marketing_project_status", { projectId }, "alpha")
          ).result;
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({
            code: "NOT_FOUND",
            message: "NOT FOUND",
            retryable: false,
          });
        }
      });

      it("rejects arguments the tool does not take", async () => {
        const result = (await call("marketing_project_status", { extra: 1 }))
          .result;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Invalid arguments for tool/);
      });

      it("writes the audit record of the project call", async () => {
        await call("marketing_project_status", {});
        const rows = await inProject("Alpha", (tx) =>
          tx.auditEvent.findMany({
            where: { projectId: project.Alpha, action: "mcp.tool_call" },
          }),
        );
        expect(
          rows.some(
            (row) => (row.metadata as Json).tool === "marketing_project_status",
          ),
        ).toBe(true);
      });
    });

    describe("support_insights", () => {
      it("returns counts only", async () => {
        const result = (await call("support_insights", {})).result;
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text as string;
        expect(JSON.parse(text)).toEqual(result.structuredContent);
        expect(result.structuredContent).toEqual({
          available: true,
          open: 3,
          unassigned: 2,
          atRisk: 0,
          breached: 0,
          byStatus: { new: 2, open: 1 },
          byPriority: { normal: 2, high: 1 },
          byCategory: { none: 2, deposits: 1 },
        });
        supportInsightsOutput.parse(result.structuredContent);
        // Nothing of a ticket reaches the client.
        expect(text).not.toContain(SECRET_SUBJECT);
        expect(text).not.toContain("example.org");
      });

      it("chooses the project of a multi-project grant and refuses one without the module", async () => {
        const fine = (
          await call("support_insights", { projectId: project.Gamma }, "all")
        ).result;
        expect(fine.structuredContent).toMatchObject({
          available: true,
          open: 0,
          byStatus: {},
          byPriority: {},
          byCategory: {},
        });
        // Listed for Alpha, but Beta has support off.
        const refused = (
          await call("support_insights", { projectId: project.Beta }, "all")
        ).result;
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toEqual({
          code: "MCP_TOOL_NOT_ALLOWED",
          message: "MCP TOOL NOT ALLOWED",
          retryable: false,
        });
        const outside = (
          await call("support_insights", { projectId: project.Delta }, "all")
        ).result;
        expect(outside.structuredContent).toMatchObject({ code: "NOT_FOUND" });
      });

      it("keeps the project's gate: the tool itself answers available:false without the module", async () => {
        // The gateway hides the tool; the tool's own gate still holds.
        const output = await supportInsights.execute(
          {
            scope: { ...ownerScope("Beta"), role: "editor" },
            runId: randomUUID(),
            conversationId: "assistant-parity",
            callIndex: 1,
          },
          {},
        );
        expect(output).toEqual({ output: { available: false }, cards: [] });
        expect(supportInsightsOutput.parse(output.output)).toEqual({
          available: false,
        });
      });

      it("accepts exactly the two documented shapes", () => {
        const counts = {
          available: true,
          open: 1,
          unassigned: 0,
          atRisk: 0,
          breached: 0,
          byStatus: { new: 1 },
          byPriority: { normal: 1 },
          byCategory: { none: 1 },
        };
        expect(supportInsightsOutput.safeParse(counts).success).toBe(true);
        expect(
          supportInsightsOutput.safeParse({ available: false }).success,
        ).toBe(true);
        // Extra keys, a missing count, a counted "unavailable", a bad key.
        expect(
          supportInsightsOutput.safeParse({ ...counts, subject: "x" }).success,
        ).toBe(false);
        expect(
          supportInsightsOutput.safeParse({ available: true, open: 1 }).success,
        ).toBe(false);
        expect(
          supportInsightsOutput.safeParse({ ...counts, available: false })
            .success,
        ).toBe(false);
        expect(
          supportInsightsOutput.safeParse({
            ...counts,
            byCategory: { "Refund Jane Doe": 1 },
          }).success,
        ).toBe(false);
        expect(
          supportInsightsOutput.safeParse({
            ...counts,
            byStatus: { resolved: 1 },
          }).success,
        ).toBe(false);
      });
    });

    describe("registration", () => {
      it("opts both tools in without parameters that a second parse could change", () => {
        expect(supportInsights.exposure).toEqual({
          assistant: true,
          mcp: true,
        });
        for (const tool of [
          supportInsights,
          readTools.find((t) => t.name === "project_status")!,
        ]) {
          // The SDK parses the arguments, then the adapter parses them again:
          // no parameters means nothing a transform or default could change.
          expect(Object.keys(tool.parameters.shape)).toEqual([]);
          expect(tool.parameters.parse({})).toEqual({});
          expect(tool.parameters.safeParse({ a: 1 }).success).toBe(false);
        }
      });

      it("leaves the other marketing read tools unexposed", () => {
        for (const tool of readTools.filter((t) => t.name !== "project_status"))
          expect(tool.exposure?.mcp).not.toBe(true);
      });
    });
  },
);
