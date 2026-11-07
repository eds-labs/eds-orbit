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
import { registeredActionType, registeredTools } from "../src/platform/modules/contributions.ts";
import { decideActionRequest, listActionRequests } from "../src/modules/action-requests.ts";
import { data, entity } from "../src/shared.ts";
import { availableTools } from "../src/modules/agents/tools/registry.ts";
import { createPost, getPost } from "../src/modules/social/posts/posts.ts";
import { schedulePost } from "../src/modules/social/posts/approval.ts";
import { createSocialProject } from "./support/social-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const ENV = { ORBIT_SOCIAL: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true", ORBIT_MCP_TASKS: "true" };
const READS = ["social_accounts", "social_calendar", "social_drive_files", "social_media_list", "social_post_get", "social_post_status", "social_validate"];
// The check and the Drive list (for importing) need social.compose.
const VIEWER_READS = READS.filter((n) => n !== "social_validate" && n !== "social_drive_files");
const DRAFTS = ["social_cancel", "social_draft_create", "social_draft_update"];
const PUBLISHING = ["social_publish_now", "social_schedule"];
const PROPOSALS = [...DRAFTS, ...PUBLISHING].sort();
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

  it("registers the draft and cancel proposals as owner-decided, internal and mandatable", () => {
    const tools = registeredTools().filter((t) => t.namespace === "social" && t.risk === "P_proposal");
    expect(ours(tools.map((t) => t.name))).toEqual(expect.arrayContaining(DRAFTS));
    for (const name of DRAFTS) {
      const type = registeredActionType(`social.mcp.${name}`)!;
      expect(type.riskClass, name).toBe("W0");
      expect(type.deciderRole, name).toBe("owner");
      expect(type.policyRequired, name).toBe(false);
      expect(type.mandate, name).toEqual(expect.objectContaining({ maxCostMicrosPerAction: 0 }));
    }
  });

  it("registers scheduling and publishing as owner-decided, public and never mandatable", () => {
    for (const name of PUBLISHING) {
      const type = registeredActionType(`social.mcp.${name}`)!;
      expect(type.riskClass, name).toBe("W2");
      expect(type.deciderRole, name).toBe("owner");
      expect(type.mandate, name).toBeUndefined();
    }
  });

  it("offers the reads to viewers except the check, and nothing without the module", () => {
    const names = (role: Scope["role"]) =>
      ours(availableTools(registeredTools(), role, ["social"]).filter((t) => t.risk === "R0_read").map((t) => t.name));
    expect(names("editor")).toEqual(READS);
    expect(names("viewer")).toEqual(VIEWER_READS);
    const proposals = (role: Scope["role"]) =>
      ours(availableTools(registeredTools(), role, ["social", "mcp_tasks"]).filter((t) => t.risk === "P_proposal").map((t) => t.name));
    expect(proposals("editor")).toEqual(PROPOSALS);
    expect(proposals("viewer")).toEqual([]);
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
  const decide = (who: Scope, id: string) =>
    p.run(async (tx) => {
      const row = await entity(tx, who, "action_requests", id);
      return decideActionRequest(tx, who, id, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
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
    expect(await names(principal)).toEqual([...READS, ...PROPOSALS].sort());
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:propose"]))).toEqual([]);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:social"]))).toEqual(READS);
    const discovery = ours(
      (await visibleMcpToolsForDiscovery(await grantFor(owner(), ["orbit:read"]), owner().projectId)).map((t) => t.name),
    );
    // Discovery assumes the content scope and orbit:write (not orbit:propose),
    // so a client can ask for the scopes the library writes declare.
    expect(discovery).toEqual([...READS, "social_media_import", "social_media_upload"].sort());
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

  it("proposes a draft that the owner approves once, created as an MCP post", async () => {
    const editor = await grantFor(p.editor, ALL);
    const args = { idempotencyKey: "draft-1", title: "Launch", baseText: "We launch today.", baseMedia: [], variants: [{ accountId: x }, { accountId: telegram, text: "Telegram text" }] };
    const before = await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId } }));
    const proposal = await op("social_draft_create", args, editor);
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true, deduplicated: false });
    expect(await op("social_draft_create", args, editor)).toMatchObject({ actionRequestId: proposal.actionRequestId, deduplicated: true });
    expect(await code("social_draft_create", { ...args, baseText: "Other" }, editor)).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId } }))).toBe(before);
    // The owner sees the exact texts per account, with handles.
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === proposal.actionRequestId);
    expect(listed).toMatchObject({
      actionType: "social.mcp.social_draft_create",
      summary: {
        operation: {
          kind: "social_draft",
          change: "create",
          title: "Launch",
          variants: [
            { accountId: x, platform: "x", handle: "@x_orbit", body: "We launch today.", images: 0 },
            { accountId: telegram, platform: "telegram", handle: "@telegram_orbit", body: "Telegram text", images: 0 },
          ],
        },
      },
    });
    await expect(decide(p.editor, proposal.actionRequestId)).rejects.toThrow();
    await decide(owner(), proposal.actionRequestId);
    const created = await p.run((tx) => tx.socialPost.findMany({ where: { projectId: owner().projectId, title: "Launch" } }));
    expect(created.map((c) => [c.origin, c.createdBy, c.status])).toEqual([["mcp", p.editor.userId, "draft"]]);
    const row = await p.run((tx) => entity(tx, owner(), "action_requests", proposal.actionRequestId));
    expect(data(row)).toMatchObject({ status: "consumed", executionResult: { postId: created[0]!.id, version: expect.any(Number) } });
    await decide(owner(), proposal.actionRequestId).catch(() => undefined);
    expect(await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId, title: "Launch" } }))).toBe(1);
  });

  it("refuses a stale draft update before asking, and at approval when the post changed", async () => {
    const post = await p.run((tx) => createPost(tx, owner(), { baseText: "Old", baseMedia: [], variants: [{ accountId: x }] }));
    const change = { postId: post.id, baseText: "New", baseMedia: [], variants: [{ accountId: x }] };
    expect(await code("social_draft_update", { ...change, version: post.version + 1, idempotencyKey: "stale" })).toBe("SOCIAL_VERSION_CONFLICT");
    const proposal = await op("social_draft_update", { ...change, version: post.version, idempotencyKey: "update-1" });
    await p.run((tx) => tx.socialPost.update({ where: { id: post.id }, data: { version: { increment: 1 } } }));
    await expect(decide(owner(), proposal.actionRequestId)).rejects.toThrow("SOCIAL_VERSION_CONFLICT");
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).baseText).toBe("Old");
    await p.run((tx) => tx.socialPost.update({ where: { id: post.id }, data: { title: "Kept title" } }));
    const fresh = await p.run((tx) => getPost(tx, owner(), post.id));
    const ok = await op("social_draft_update", { ...change, version: fresh.version, idempotencyKey: "update-2" });
    // The approval names the title the post keeps, not "Untitled".
    const okListed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === ok.actionRequestId);
    expect(okListed?.summary).toMatchObject({ operation: { title: "Kept title" } });
    await decide(owner(), ok.actionRequestId);
    const after = await p.run((tx) => getPost(tx, owner(), post.id));
    // Without a title the update keeps the one the post has.
    expect([after.baseText, after.title]).toEqual(["New", "Kept title"]);
  });

  it("warns on the approval that a content change ends a planned post's approval", async () => {
    const post = await p.run((tx) => createPost(tx, owner(), { baseText: "Planned text", baseMedia: [], variants: [{ accountId: telegram }] }));
    const scheduled = await p.run((tx) =>
      schedulePost(tx, owner(), post.id, { version: post.version, at: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
    );
    const proposal = await op("social_draft_update", {
      postId: post.id,
      version: scheduled.version,
      title: "Planned",
      baseText: "Changed text",
      baseMedia: [],
      variants: [{ accountId: telegram }],
      idempotencyKey: "update-planned",
    });
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === proposal.actionRequestId);
    expect(listed?.summary).toMatchObject({
      operation: {
        kind: "social_draft",
        change: "update",
        current: { status: "scheduled", local: scheduled.schedule.local, timeZone: scheduled.schedule.timeZone, approvalEnds: true },
      },
    });
    const draft = await p.run((tx) => createPost(tx, owner(), { baseText: "Only a draft", baseMedia: [], variants: [{ accountId: telegram }] }));
    const plain = await op("social_draft_update", { postId: draft.id, version: draft.version, baseText: "Still a draft", baseMedia: [], variants: [{ accountId: telegram }], idempotencyKey: "update-draft" });
    const plainListed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === plain.actionRequestId);
    expect(plainListed?.summary).toMatchObject({ operation: { current: { status: "draft", approvalEnds: false } } });
  });

  it("cancels a planned post after the owner's approval", async () => {
    const post = await p.run((tx) => createPost(tx, owner(), { baseText: "Planned", baseMedia: [], variants: [{ accountId: telegram }] }));
    const scheduled = await p.run((tx) =>
      schedulePost(tx, owner(), post.id, { version: post.version, at: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
    );
    expect(scheduled.status).toBe("scheduled");
    const proposal = await op("social_cancel", { postId: post.id, version: scheduled.version, idempotencyKey: "cancel-1" });
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === proposal.actionRequestId);
    expect(listed?.summary).toMatchObject({ operation: { kind: "social_cancel", postId: post.id, status: "scheduled" } });
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).status).toBe("scheduled");
    await decide(owner(), proposal.actionRequestId);
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).status).toBe("draft");
    expect(await code("social_cancel", { postId: post.id, version: scheduled.version, idempotencyKey: "cancel-2" })).toBe("SOCIAL_VERSION_CONFLICT");
  });

  it("schedules after the owner approves an editor's proposal, without a second request", async () => {
    const editor = await grantFor(p.editor, ALL);
    const post = await p.run((tx) => createPost(tx, p.editor, { baseText: "Planned by MCP", baseMedia: [], variants: [{ accountId: telegram }] }));
    const local = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) + "T10:00";
    const proposal = await op("social_schedule", { postId: post.id, version: post.version, local, timeZone: "Europe/Berlin", idempotencyKey: "schedule-1" }, editor);
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === proposal.actionRequestId);
    expect(listed?.summary).toMatchObject({
      operation: { kind: "social_post", mode: "at", local, timeZone: "Europe/Berlin", variants: [{ accountId: telegram, handle: "@telegram_orbit", body: "Planned by MCP", media: [] }] },
    });
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).status).toBe("draft");
    await decide(owner(), proposal.actionRequestId);
    const after = await p.run((tx) => getPost(tx, owner(), post.id));
    expect(after).toMatchObject({ status: "scheduled", schedule: { mode: "at", local, timeZone: "Europe/Berlin" } });
    expect(after.approval).toMatchObject({ state: "approved", requestId: proposal.actionRequestId, approvedBy: owner().userId });
    const native = await p.run((tx) =>
      tx.entity.count({ where: { projectId: owner().projectId, kind: "action_requests", data: { path: ["actionType"], equals: "social.post.schedule" } } }),
    );
    expect(native).toBe(0);
    // The audit names the deciding owner, not only the proposing editor.
    const audits = await p.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: owner().projectId, action: "social.post.approved", resourceId: post.id } }),
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ channel: "mcp_request", requestId: proposal.actionRequestId, approvedBy: owner().userId }),
    ]);
  });

  it("refuses the approval when the post changed after the proposal", async () => {
    const post = await p.run((tx) => createPost(tx, owner(), { baseText: "Before", baseMedia: [], variants: [{ accountId: telegram }] }));
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const proposal = await op("social_schedule", { postId: post.id, version: post.version, at, idempotencyKey: "schedule-stale" });
    // The text changes in Orbit meanwhile (the version stays the proposal's
    // only when the change is undone, so compare the content itself).
    await p.run((tx) => tx.socialPostVariant.updateMany({ where: { postId: post.id }, data: { body: "After" } }));
    await expect(decide(owner(), proposal.actionRequestId)).rejects.toThrow("SOCIAL_APPROVAL_STALE");
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).status).toBe("draft");
  });

  it("publishes now after approval and refuses invalid or too early proposals before asking", async () => {
    const post = await p.run((tx) => createPost(tx, owner(), { baseText: "Right away", baseMedia: [], variants: [{ accountId: telegram }] }));
    const now = await op("social_publish_now", { postId: post.id, version: post.version, idempotencyKey: "now-1" });
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === now.actionRequestId);
    expect(listed?.summary).toMatchObject({ operation: { kind: "social_post", mode: "now", at: null } });
    await decide(owner(), now.actionRequestId);
    expect((await p.run((tx) => getPost(tx, owner(), post.id))).status).toMatch(/approved|publishing|published/);
    const requests = () => p.run((tx) => tx.entity.count({ where: { projectId: owner().projectId, kind: "action_requests" } }));
    const before = await requests();
    const long = await p.run((tx) => createPost(tx, owner(), { baseText: "x".repeat(300), baseMedia: [], variants: [{ accountId: x }] }));
    expect(await code("social_publish_now", { postId: long.id, version: long.version, idempotencyKey: "now-invalid" })).toBe("SOCIAL_VALIDATION_FAILED");
    const soon = await p.run((tx) => createPost(tx, owner(), { baseText: "Soon", baseMedia: [], variants: [{ accountId: telegram }] }));
    expect(
      await code("social_schedule", { postId: soon.id, version: soon.version, at: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "soon" }),
    ).toBe("SOCIAL_SCHEDULE_TOO_SOON");
    expect(await code("social_schedule", { postId: soon.id, version: soon.version, idempotencyKey: "no-time" })).toBe("SOCIAL_SCHEDULE_INVALID");
    expect(await requests()).toBe(before);
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
