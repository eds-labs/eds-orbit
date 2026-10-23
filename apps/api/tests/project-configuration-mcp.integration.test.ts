import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { marketingProfile } from "../../../packages/schemas/src/index.ts";
import { createPackageProject } from "./support/package-project.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { authorizeMcpCall, visibleMcpTools } from "../src/platform/mcp/visibility.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { assertCampaignContext } from "../src/modules/marketing/brand/marketing-profile.ts";
import { create, data, entity } from "../src/shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";

// Project configuration over MCP (plans/project-configuration-mcp.md): an
// owner reads the configuration with orbit:read and proposes partial
// changes with orbit:propose; nothing changes before the owner approves in
// Orbit, an approved change is a new profile version that sends dependent
// drafts to review, and the presale strategy is required only where presale
// campaigns are enabled.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const GET = "project_configuration_get";
const UPDATE = "project_configuration_update";

describe.skipIf(!enabled)("Project configuration over MCP", () => {
  let legacy: Awaited<ReturnType<typeof createPackageProject>>;
  let fresh: Awaited<ReturnType<typeof createPackageProject>>;
  let owner: McpPrincipal, freshOwner: McpPrincipal, editor: McpPrincipal;
  let linkFactId: string;
  const saved: Record<string, string | undefined> = {};
  const flags = {
    ORBIT_MCP_PROJECT_CONFIGURATION: "true",
    ORBIT_MCP_PROPOSALS: "true",
    ORBIT_MCP_TASKS: "false",
  };

  async function principal(scope: Scope, scopes = ["orbit:read", "orbit:propose"]) {
    const g = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://configuration.test/${randomUUID()}.json`,
        projectIds: [scope.projectId],
        modules: [],
        scopes,
        status: "active",
        activatedAt: new Date(),
      },
    });
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      clientId: g.clientId,
      grantId: g.id,
      projectIds: [scope.projectId],
      modules: [],
      scopes: new Set(scopes),
    } as McpPrincipal;
  }
  async function call(by: McpPrincipal, name: string, projectId: string, args: object = {}): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(by, name, projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "platform"),
        runId: "synthetic-configuration",
        conversationId: "synthetic-configuration",
        callIndex: 0,
        channel: { kind: "mcp", clientId: by.clientId, grantId: by.grantId, requestId: randomUUID() },
      },
      args,
    );
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result.output;
  }
  const read = async (by = owner, project = legacy) =>
    (await call(by, GET, project.owner.projectId)).result;
  const propose = (changes: object, expectedVersion: number, by = owner, project = legacy, idempotencyKey = randomUUID()) =>
    call(by, UPDATE, project.owner.projectId, { expectedVersion, changes, idempotencyKey });
  const decide = (project: typeof legacy, id: string, decision: "approve" | "reject" = "approve") =>
    scoped(project.owner.workspaceId, project.owner.projectId, async (tx) => {
      const row = await entity(tx, project.owner, "action_requests", id);
      return decideActionRequest(tx, project.owner, id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision,
      });
    });
  const profileOf = (project: typeof legacy) =>
    scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
      tx.projectMarketingProfile.findFirst({ where: { projectId: project.owner.projectId } }),
    );

  beforeAll(async () => {
    for (const [k, v] of Object.entries(flags)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    legacy = await createPackageProject({ name: "Synthetic legacy configuration" });
    fresh = await createPackageProject({ name: "Synthetic fresh configuration" });
    // A project like FamilyPlan: no Marketing profile yet and no policy.
    linkFactId = await scoped(fresh.owner.workspaceId, fresh.owner.projectId, async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: fresh.owner.projectId },
      });
      await tx.projectMarketingProfile.delete({ where: { id: profile.id } });
      await tx.entity.deleteMany({ where: { projectId: fresh.owner.projectId, kind: "policies" } });
      return (profile.data as { officialLinks: Array<{ factId: string }> }).officialLinks[0]!.factId;
    });
    owner = await principal(legacy.owner);
    freshOwner = await principal(fresh.owner);
    editor = await principal(legacy.editor);
  });
  afterAll(async () => {
    await legacy?.cleanup();
    await fresh?.cleanup();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await closeDatabase();
  });

  it("reads the whole configuration with its version and field requirements, no secrets", async () => {
    const config = await read();
    expect(config.version).toBe(1);
    expect(Object.keys(config.sections)).toEqual(["project", "marketing"]);
    const marketing = config.sections.marketing;
    expect(marketing.values).toMatchObject({ audience: "Product teams", presaleStrategy: "No presale" });
    // A profile from before campaign types keeps presale (uLiquid's case).
    expect(marketing.notes.campaignTypes).toEqual(["product", "presale"]);
    expect(marketing.fields.presaleStrategy).toEqual({ requirement: "required", editable: true });
    expect(marketing.fields.brandTerms.requirement).toBe("optional");
    expect(config.sections.project.values).toMatchObject({ name: "Synthetic legacy configuration" });
    expect(config.sections.project.editable).toBe(false);
    expect(JSON.stringify(config)).not.toContain("synthetic-no-provider-call-key");
  });

  it("changes only the proposed field, and only after the owner approves", async () => {
    const proposal = await propose({ marketing: { audience: "Families with shared calendars" } }, 1);
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true, deduplicated: false });
    // Without approval nothing changed.
    expect((await profileOf(legacy))!.version).toBe(1);
    expect((await read()).sections.marketing.values.audience).toBe("Product teams");
    await decide(legacy, proposal.actionRequestId);
    const after = await read();
    expect(after.version).toBe(2);
    expect(after.sections.marketing.values).toMatchObject({
      audience: "Families with shared calendars",
      // Everything else, the presale strategy included, is kept.
      positioning: "Test only",
      presaleStrategy: "No presale",
      productName: "Synthetic Orbit",
    });
    const history = await scoped(legacy.owner.workspaceId, legacy.owner.projectId, (tx) =>
      tx.projectMarketingProfileVersion.findMany({ where: { projectId: legacy.owner.projectId } }),
    );
    expect(history.map((h) => h.version)).toEqual([2]);
  });

  it("leaves a rejected proposal without effect", async () => {
    const proposal = await propose({ marketing: { positioning: "Rejected" } }, 2);
    await decide(legacy, proposal.actionRequestId, "reject");
    expect((await read()).sections.marketing.values.positioning).toBe("Test only");
    expect((await read()).version).toBe(2);
  });

  it("refuses a stale expectedVersion, at proposal and at approval", async () => {
    await expect(propose({ marketing: { audience: "Old" } }, 1)).rejects.toMatchObject({
      code: "CONFIGURATION_VERSION_CONFLICT",
    });
    const first = await propose({ marketing: { positioning: "First" } }, 2);
    const second = await propose({ marketing: { positioning: "Second" } }, 2);
    await decide(legacy, first.actionRequestId);
    await expect(decide(legacy, second.actionRequestId)).rejects.toMatchObject({
      code: "CONFIGURATION_VERSION_CONFLICT",
    });
    expect((await read()).sections.marketing.values.positioning).toBe("First");
  });

  it("does not repeat a change for a repeated idempotency key", async () => {
    const version = (await read()).version;
    const key = randomUUID();
    const once = await propose({ marketing: { positioning: "Once" } }, version, owner, legacy, key);
    const again = await propose({ marketing: { positioning: "Once" } }, version, owner, legacy, key);
    expect(again).toMatchObject({ actionRequestId: once.actionRequestId, deduplicated: true });
    await decide(legacy, once.actionRequestId);
    const replay = await propose({ marketing: { positioning: "Once" } }, version, owner, legacy, key);
    expect(replay).toMatchObject({ actionRequestId: once.actionRequestId, deduplicated: true, status: "consumed" });
    expect((await read()).version).toBe(version + 1);
    await expect(
      propose({ marketing: { positioning: "Other" } }, version, owner, legacy, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("sends drafts of the previous profile version back to review", async () => {
    const version = (await read()).version;
    const draft = await scoped(legacy.owner.workspaceId, legacy.owner.projectId, (tx) =>
      create(tx, legacy.owner, "content", {
        title: "Synthetic draft",
        body: "Synthetic body",
        status: "draft",
        profileVersion: version,
      }),
    );
    const proposal = await propose({ marketing: { guardrails: ["No unsupported claims", "No prices"] } }, version);
    await decide(legacy, proposal.actionRequestId);
    const after = await scoped(legacy.owner.workspaceId, legacy.owner.projectId, (tx) =>
      tx.entity.findUniqueOrThrow({ where: { id: draft.id } }),
    );
    expect(after.data).toMatchObject({
      status: "needs_review",
      profileInvalidatedFrom: version,
      profileInvalidatedTo: version + 1,
    });
  });

  it("keeps projects apart and changes to owners", async () => {
    await expect(authorizeMcpCall(owner, GET, fresh.owner.projectId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // An editor reads, but cannot propose a configuration change.
    expect((await read(editor)).version).toBeGreaterThan(0);
    await expect(authorizeMcpCall(editor, UPDATE, legacy.owner.projectId)).rejects.toMatchObject({
      code: "MCP_TOOL_NOT_ALLOWED",
    });
    // A read-only token sees no update tool.
    const reader = await principal(legacy.owner, ["orbit:read"]);
    await expect(authorizeMcpCall(reader, UPDATE, legacy.owner.projectId)).rejects.toBeTruthy();
  });

  it("sets up a product-only profile without any presale strategy (FamilyPlan's case)", async () => {
    const before = await read(freshOwner, fresh);
    expect(before.version).toBe(0);
    const profile = {
      productName: "Synthetic family planner",
      contentLanguage: "en",
      internalLanguage: "de",
      campaignTypes: ["product"],
      audience: "Families",
      positioning: "Shared planning",
      productStrategy: "Show everyday use",
      voice: ["warm"],
      guardrails: ["No unsupported claims"],
      primaryCtas: ["Learn more."],
      channelPriority: ["x"],
      notificationPreference: "none",
      officialLinks: [{ label: "Official", url: "https://example.invalid", factId: linkFactId }],
      assetPolicy: "approved_only",
    };
    // Enabling presale without its strategy names the missing field.
    await expect(
      propose({ marketing: { ...profile, campaignTypes: ["product", "presale"] } }, 0, freshOwner, fresh),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ["presaleStrategy"] })] });
    const proposal = await propose({ marketing: profile }, 0, freshOwner, fresh);
    // No Marketing policy is needed for a configuration change.
    expect(proposal.status).toBe("pending");
    await decide(fresh, proposal.actionRequestId);
    const after = await read(freshOwner, fresh);
    expect(after.version).toBe(1);
    expect(after.sections.marketing.fields.presaleStrategy.requirement).toBe("not_used");
    expect(after.sections.marketing.values.presaleStrategy).toBeUndefined();
    // Presale campaigns stay unavailable for this project.
    await expect(
      scoped(fresh.owner.workspaceId, fresh.owner.projectId, (tx) =>
        assertCampaignContext(tx, fresh.owner, {
          profileVersion: 1,
          campaignType: "presale",
          targetAction: "Learn more.",
          language: "en",
          targetUrl: "https://example.invalid",
        }),
      ),
    ).rejects.toMatchObject({ code: "CAMPAIGN_TYPE_NOT_ENABLED" });
  });

  it("keeps a stored profile valid under the new rules (uLiquid's case)", () => {
    const stored = {
      productName: "Legacy",
      contentLanguage: "en",
      internalLanguage: "de",
      audience: "a",
      positioning: "b",
      productStrategy: "c",
      presaleStrategy: "d",
      voice: ["v"],
      guardrails: ["g"],
      primaryCtas: ["c"],
      channelPriority: ["x"],
      notificationPreference: "none",
      officialLinks: [{ label: "L", url: "https://example.invalid", factId: randomUUID() }],
      assetPolicy: "approved_only",
    };
    expect(marketingProfile.parse(stored)).toMatchObject({ presaleStrategy: "d" });
    const { presaleStrategy: _drop, ...productOnly } = stored;
    expect(marketingProfile.safeParse(productOnly).success).toBe(true);
    expect(marketingProfile.safeParse({ ...productOnly, campaignTypes: ["presale"] }).success).toBe(false);
  });

  it("lists neither tool while the feature is off", async () => {
    process.env.ORBIT_MCP_PROJECT_CONFIGURATION = "false";
    try {
      const names = (await visibleMcpTools(owner, legacy.owner.projectId)).map((t) => t.name);
      expect(names).not.toContain(GET);
      expect(names).not.toContain(UPDATE);
    } finally {
      process.env.ORBIT_MCP_PROJECT_CONFIGURATION = "true";
    }
  });
});
