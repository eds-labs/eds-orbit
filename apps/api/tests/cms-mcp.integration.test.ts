import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { authorizeMcpCall, visibleMcpTools, visibleMcpToolsForDiscovery } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { MCP_RESOURCE_SCOPES } from "../src/platform/mcp/server.ts";
import { MCP_SCOPES } from "../src/platform/mcp-auth/plugins.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { registeredActionType, registeredTools } from "../src/platform/modules/contributions.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { data, entity } from "../src/shared.ts";
import { createSite } from "../src/modules/cms/sites/sites.ts";
import { textToDoc } from "../src/modules/cms/tools.ts";
import { createIssuesProject } from "./support/issues-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const ENV = { ORBIT_CMS: "true", ORBIT_MODULES: "true", ORBIT_MCP_PROPOSALS: "true" };
const READS = ["cms_entries", "cms_entry_get", "cms_media", "cms_publication_status", "cms_sites"];
const WRITES = ["cms_draft_create", "cms_draft_update", "cms_media_import"];
const ALL = ["orbit:read", "orbit:propose", "orbit:write", "orbit:cms"];
const ours = (names: string[]) => names.filter((n) => n.startsWith("cms_")).sort();

/**
 * The content module's MCP and assistant tools (ADR 0029 §6, CH1.16):
 * reads, internal draft writes and a publication proposal that becomes the
 * module's own approval request; all need `orbit:cms`.
 */
describe("content tool contracts (CH1.16)", () => {
  it("registers every tool with the content scope; publication types accept MCP proposals", () => {
    process.env.ORBIT_CMS = "true";
    const tools = registeredTools().filter((t) => t.namespace === "cms");
    expect(ours(tools.filter((t) => t.risk === "R0_read").map((t) => t.name))).toEqual(READS);
    expect(ours(tools.filter((t) => t.risk === "W0_internal").map((t) => t.name))).toEqual(WRITES);
    expect(ours(tools.filter((t) => t.risk === "P_proposal").map((t) => t.name))).toEqual(["cms_publish_propose"]);
    for (const tool of tools) {
      expect(tool.mcpScopes, tool.name).toEqual(["orbit:cms"]);
      expect(tool.feature, tool.name).toBe("cms");
    }
    for (const type of ["cms.entry.publish", "cms.entry.unpublish"]) {
      const def = registeredActionType(type)!;
      expect(def).toMatchObject({ mcpProposable: true, apiProposable: true, mcpScopes: ["orbit:cms"], riskClass: "W2" });
      expect(def.mandate).toBeUndefined();
    }
    expect(MCP_SCOPES).toContain("orbit:cms");
    expect(MCP_RESOURCE_SCOPES).toContain("orbit:cms");
    delete process.env.ORBIT_CMS;
  });

  it("turns plain text into orbit-doc", () => {
    expect(textToDoc("## Titel\n\nErster Absatz\nmit Zeile.\n\n- eins\n- zwei")).toEqual({
      schema: "orbit-doc",
      version: 1,
      blocks: [
        { type: "heading", level: 2, content: [{ text: "Titel" }] },
        { type: "paragraph", content: [{ text: "Erster Absatz mit Zeile." }] },
        {
          type: "list",
          ordered: false,
          items: [[{ type: "paragraph", content: [{ text: "eins" }] }], [{ type: "paragraph", content: [{ text: "zwei" }] }]],
        },
      ],
    });
  });
});

describe.skipIf(!enabled)("content MCP tools (SQL)", () => {
  let p: Awaited<ReturnType<typeof createIssuesProject>>;
  let principal: McpPrincipal;
  let siteId = "";
  const previous: Record<string, string | undefined> = {};
  const owner = () => p.owner;
  const context = (scope: Scope, who: McpPrincipal) => ({
    scope: moduleScope(scope, "cms"),
    runId: "synthetic-cms-mcp",
    conversationId: "synthetic-cms-mcp",
    callIndex: 0,
    channel: { kind: "mcp" as const, clientId: who.clientId, grantId: who.grantId, requestId: "synthetic-cms-mcp" },
  });
  async function op(name: string, args: unknown, who = principal): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(who, name, owner().projectId);
    const result = await tool.execute(context(scope, who), args);
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return (result.output as { result?: unknown; schemaVersion?: number }).schemaVersion ? (result.output as { result: unknown }).result : result.output;
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
        clientId: `https://client.test/cms-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes,
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return { workspaceId: scope.workspaceId, userId: scope.userId, clientId: grant.clientId, grantId: grant.id, projectIds: [scope.projectId], scopes: new Set(grant.scopes), modules: [] };
  }

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    p = await createIssuesProject({ name: "Synthetic cms MCP", modules: ["cms"] });
    principal = await grantFor(owner(), ALL);
    siteId = (
      await p.run((tx) => createSite(tx, owner(), { name: "Familie", baseUrl: "https://familie.example.invalid", locales: ["de"], defaultLocale: "de" }))
    ).site.id;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await p?.cleanup();
    await closeDatabase();
  });

  it("lists tools by scope set; discovery asks for orbit:cms", async () => {
    expect(await names(principal)).toEqual([...READS, ...WRITES, "cms_publish_propose"].sort());
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:propose", "orbit:write"]))).toEqual([]);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:cms"]))).toEqual(READS);
    const discovery = ours((await visibleMcpToolsForDiscovery(await grantFor(owner(), ["orbit:read"]), owner().projectId)).map((t) => t.name));
    expect(discovery).toEqual([...READS, ...WRITES].sort());
    const viewer = await names(await grantFor(p.viewer, ALL));
    expect(viewer).toEqual(READS);
  });

  it("creates and edits drafts idempotently; a proposal becomes the content approval", async () => {
    const created = await op("cms_draft_create", {
      locale: "de",
      title: "Von einem Agenten",
      siteIds: [siteId],
      text: "## Worum es geht\n\nEin kurzer Text.",
      idempotencyKey: "agent-draft-0001",
    });
    expect(created).toMatchObject({ draftVersion: 1, deduplicated: false });
    expect(
      await op("cms_draft_create", { locale: "de", title: "Von einem Agenten", siteIds: [siteId], text: "## Worum es geht\n\nEin kurzer Text.", idempotencyKey: "agent-draft-0001" }),
    ).toEqual({ ...created, deduplicated: true });
    expect(await code("cms_draft_create", { locale: "de", title: "Anders", idempotencyKey: "agent-draft-0001" })).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await code("cms_draft_create", { locale: "de", title: "Beides", text: "a", body: textToDoc("b"), idempotencyKey: "agent-draft-0002" })).toBe("CMS_BODY_AMBIGUOUS");

    const updated = await op("cms_draft_update", { entryId: created.entryId, version: 1, excerpt: "Kurz." });
    expect(updated).toMatchObject({ entryId: created.entryId, draftVersion: 2 });
    expect(await code("cms_draft_update", { entryId: created.entryId, version: 1, excerpt: "Alt." })).toBe("CMS_DRAFT_STALE");

    const read = await op("cms_entry_get", { entryId: created.entryId });
    expect(read).toMatchObject({ entry: { origin: "mcp", status: "draft" }, draft: { excerpt: "Kurz.", version: 2 }, preflight: { ok: true, issues: [] }, urls: [] });
    expect(read.draft.body.blocks[0]).toMatchObject({ type: "heading", level: 2 });

    const proposed = await op("cms_publish_propose", { entryId: created.entryId, draftVersion: 2 });
    expect(proposed).toMatchObject({ status: "pending_approval", deduplicated: false });
    expect(await op("cms_publish_propose", { entryId: created.entryId, draftVersion: 2 })).toMatchObject({ actionRequestId: proposed.actionRequestId, deduplicated: true });
    expect(await code("cms_publish_propose", { entryId: created.entryId, draftVersion: 2, changeNote: "anders" })).toBe("CMS_REQUEST_PENDING");
    const request = await p.run((tx) => entity(tx, owner(), "action_requests", proposed.actionRequestId));
    expect(data(request)).toMatchObject({ actionType: "cms.entry.publish", status: "pending", requestedBy: { kind: "mcp", clientId: principal.clientId } });

    const decider = moduleScope(owner(), "cms");
    await p.run(async (tx) => {
      const row = await entity(tx, decider, "action_requests", proposed.actionRequestId);
      return decideActionRequest(tx, decider, proposed.actionRequestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" });
    });
    const status = await op("cms_publication_status", { entryIds: [created.entryId, randomUUID()] });
    expect(status.items).toMatchObject([{ entryId: created.entryId, status: "published", liveRevision: 1, urls: [{ siteId }] }]);
    expect(status.missing).toHaveLength(1);
    expect((await op("cms_entries", { status: "published" })).items.map((i: { id: string }) => i.id)).toContain(created.entryId);
    expect((await op("cms_sites", {})).items).toMatchObject([{ siteId, name: "Familie" }]);
  });

  it("a viewer's grant cannot write or propose", async () => {
    const viewer = await grantFor(p.viewer, ALL);
    expect(await code("cms_draft_create", { locale: "de", title: "Nein", idempotencyKey: "viewer-0001" }, viewer)).not.toBe("resolved");
  });
});
