import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { authorizeMcpCall, visibleMcpTools, visibleMcpToolsForDiscovery } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { MCP_RESOURCE_SCOPES } from "../src/platform/mcp/server.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { registeredTools } from "../src/platform/modules/contributions.ts";
import { availableTools } from "../src/modules/agents/tools/registry.ts";
import { createPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const ENV = { ORBIT_SOCIAL: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true", ORBIT_MCP_TASKS: "true" };
const READS = ["social_accounts", "social_calendar", "social_post_get", "social_post_status", "social_validate"];
const VIEWER_READS = READS.filter((n) => n !== "social_validate");
const ALL = ["orbit:read", "orbit:propose", "orbit:social"];
const ours = (names: string[]) => names.filter((n) => n.startsWith("social_")).sort();

/**
 * The social module's MCP and assistant tools (ADR 0020 §6.5, S7): reads
 * of accounts, calendar and posts, a check without saving, and proposals an
 * owner approves in Orbit. Every tool needs the module, the member's
 * permission and, over MCP, the explicit scope orbit:social.
 */
describe("social tool contracts (S7)", () => {
  beforeAll(() => {
    process.env.ORBIT_SOCIAL = "true";
  });
  afterAll(() => {
    delete process.env.ORBIT_SOCIAL;
  });

  it("registers the reads with the social scope and feature", () => {
    const tools = registeredTools().filter((t) => t.namespace === "social");
    expect(ours(tools.filter((t) => t.risk === "R0_read").map((t) => t.name))).toEqual(READS);
    for (const tool of tools) {
      expect(tool.mcpScopes).toEqual(["orbit:social"]);
      expect(tool.feature).toBe("social");
      expect(tool.outputSchema).toBeDefined();
    }
    expect(MCP_SCOPES).toContain("orbit:social");
    expect(MCP_RESOURCE_SCOPES).toContain("orbit:social");
  });

  it("offers the reads to viewers except the check, and nothing without the module", () => {
    const names = (role: Scope["role"]) =>
      ours(availableTools(registeredTools(), role, ["social"]).filter((t) => t.risk === "R0_read").map((t) => t.name));
    expect(names("editor")).toEqual(READS);
    expect(names("viewer")).toEqual(VIEWER_READS);
    expect(ours(availableTools(registeredTools(), "owner", []).map((t) => t.name))).toEqual([]);
  });
});

describe.skipIf(!enabled)("social MCP tools (SQL, no provider call)", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let principal: McpPrincipal;
  let x = "";
  let telegram = "";
  const previous: Record<string, string | undefined> = {};
  const owner = () => p.owner;
  const context = (scope: Scope, who: McpPrincipal) => ({
    scope: moduleScope(scope, "social"),
    runId: "synthetic-social-mcp",
    conversationId: "synthetic-social-mcp",
    callIndex: 0,
    channel: { kind: "mcp" as const, clientId: who.clientId, grantId: who.grantId, requestId: "synthetic-social-mcp" },
  });
  async function op(name: string, args: unknown, who = principal): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(who, name, owner().projectId);
    const result = await tool.execute(context(scope, who), args);
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result.output;
  }
  const code = (name: string, args: unknown, who = principal) =>
    op(name, args, who).then(
      () => "resolved",
      (e: { code?: string; message: string }) => e.code ?? e.message,
    );
  const names = async (who: McpPrincipal) => ours((await visibleMcpTools(who, owner().projectId)).map((t) => t.name));
  async function grantFor(scope: Scope, scopes: string[]): Promise<McpPrincipal> {
    const grant = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://client.test/social-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes,
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      clientId: grant.clientId,
      grantId: grant.id,
      projectIds: [scope.projectId],
      scopes: new Set(grant.scopes),
      modules: [],
    };
  }
  const account = (tx: DbTx, platform: string, project = p) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_orbit`,
        displayName: `Orbit ${platform}`,
        capability: "write_verified",
        createdBy: project.owner.userId,
      },
    });
  const timed = async (text: string, at: string, accounts: string[]) => {
    const post = await p.run((tx) =>
      createPost(tx, owner(), { baseText: text, baseMedia: [], variants: accounts.map((accountId) => ({ accountId })) }),
    );
    await p.run((tx) =>
      tx.socialPost.update({ where: { id: post.id }, data: { scheduleMode: "at", scheduledAt: new Date(at), scheduleLocal: at.slice(0, 16) } }),
    );
    return post.id;
  };

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    p = await createSocialProject({ name: "Synthetic social MCP" });
    other = await createSocialProject({ name: "Synthetic social MCP B" });
    x = (await p.run((tx) => account(tx, "x"))).id;
    telegram = (await p.run((tx) => account(tx, "telegram"))).id;
    principal = await grantFor(owner(), ALL);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("lists the reads by scope set and asks for orbit:social at discovery", async () => {
    expect(await names(principal)).toEqual(expect.arrayContaining(READS));
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:propose"]))).toEqual([]);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:social"]))).toEqual(READS);
    const discovery = ours(
      (await visibleMcpToolsForDiscovery(await grantFor(owner(), ["orbit:read"]), owner().projectId)).map((t) => t.name),
    );
    expect(discovery).toEqual(READS);
    expect(await names(await grantFor(p.viewer, ALL))).toEqual(VIEWER_READS);
  });

  it("hides every tool while the module is off", async () => {
    await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "social" }, data: { enabled: false } }));
    try {
      expect(await names(principal)).toEqual([]);
    } finally {
      await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "social" }, data: { enabled: true } }));
    }
  });

  it("reads the accounts without secrets, with their text limit", async () => {
    const out = await op("social_accounts", {});
    expect(out.result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: x, platform: "x", handle: "@x_orbit", status: "active", capability: "write_verified", textLimit: 280 }),
        expect.objectContaining({ accountId: telegram, platform: "telegram", textLimit: 4096 }),
      ]),
    );
    expect(JSON.stringify(out)).not.toMatch(/connectionId|token/i);
  });

  it("reads the calendar of at most 31 days, filtered, with a truncation marker", async () => {
    const a = await timed("December launch", "2026-12-10T09:00:00Z", [x, telegram]);
    const b = await timed("Telegram only", "2026-12-12T09:00:00Z", [telegram]);
    const out = await op("social_calendar", { from: "2026-12-01T00:00:00Z", to: "2026-12-31T00:00:00Z" });
    expect(out.result.items.map((i: { postId: string }) => i.postId)).toEqual([a, b]);
    expect(out.result.items[0]).toMatchObject({ excerpt: "December launch", status: "draft", accounts: [expect.anything(), expect.anything()] });
    expect(out.result.truncated).toBe(false);
    const filtered = await op("social_calendar", { from: "2026-12-01T00:00:00Z", to: "2026-12-31T00:00:00Z", platforms: ["x"] });
    expect(filtered.result.items.map((i: { postId: string }) => i.postId)).toEqual([a]);
    expect(await code("social_calendar", { from: "2026-12-01T00:00:00Z", to: "2027-01-02T00:00:00Z" })).toBe("SOCIAL_RANGE_TOO_LARGE");
  });

  it("reads one post and the status of several, never another project's", async () => {
    const id = await timed("Read me back", "2026-12-15T09:00:00Z", [x]);
    const post = await op("social_post_get", { postId: id });
    expect(post.result).toMatchObject({
      postId: id,
      status: "draft",
      version: expect.any(Number),
      variants: [expect.objectContaining({ accountId: x, platform: "x", body: "Read me back", issues: expect.any(Array) })],
      publications: [],
    });
    const foreignAccount = (await other.run((tx) => account(tx, "x", other))).id;
    const foreign = await other.run((tx) =>
      createPost(tx, other.owner, { baseText: "Not yours", baseMedia: [], variants: [{ accountId: foreignAccount }] }),
    );
    expect(await code("social_post_get", { postId: foreign.id })).toBe("NOT_FOUND");
    const status = await op("social_post_status", { postIds: [id, foreign.id] });
    expect(status.result).toEqual({ items: [{ postId: id, status: "draft", publications: [] }], missing: [foreign.id] });
  });

  it("checks a draft without saving it", async () => {
    const before = await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId } }));
    const out = await op("social_validate", { baseText: "x".repeat(300), baseMedia: [], variants: [{ accountId: x }, { accountId: telegram }] });
    const issues = Object.fromEntries(out.result.variants.map((v: { accountId: string; issues: Array<{ code: string }> }) => [v.accountId, v.issues.map((i) => i.code)]));
    expect(issues[x]).toContain("SOCIAL_TEXT_TOO_LONG");
    expect(issues[telegram]).not.toContain("SOCIAL_TEXT_TOO_LONG");
    expect(await code("social_validate", { baseText: "Hi", baseMedia: [], variants: [{ accountId: randomUUID() }] })).toBe("NOT_FOUND");
    expect(await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId } }))).toBe(before);
  });
});
