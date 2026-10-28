import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { generateImage } from "../../../packages/ai/src/index.ts";
import { sha256Hex } from "../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { runCreativePreview } from "../src/modules/marketing/creative/preview.ts";
import { PREVIEW_ACTION } from "../src/modules/marketing/creative/mcp-tools.ts";
import { authorizeMcpCall } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { delegatedExecution } from "../src/platform/tasks/delegation.ts";
import {
  grantAgentMandate,
  mandatableTypes,
  readAgentMandates,
  revokeAgentMandate,
} from "../src/platform/governance/agent-mandates.ts";
import { resolveAuthorization } from "../src/platform/governance/authorization.ts";
import { MANDATABLE_RISK_CLASSES } from "../src/platform/governance/action-requests.ts";
import {
  registeredActionTypes,
  registeredTools,
} from "../src/platform/modules/contributions.ts";
import { saveSpendPolicy } from "../src/platform/ai/spend-policy.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { create, data, entity } from "../src/shared.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
} from "./support/package-project.ts";

// Agent mandates (ADR 0019) with the creative preview as the pilot: with an
// owner's mandate a proposal from a covered channel runs without another
// approval, within the mandate's and the spending authority's limits;
// without one, or outside it, the request waits for the owner as before.
// Nothing here is published. Image generation is a synthetic provider.

vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImage: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImageWithReferences: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const CREATE = "marketing_creative_preview_create";
const STATUS = "marketing_creative_preview_status";
const RESULT = "marketing_creative_preview_result";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps and throws for a calm room.",
  cta: "Shop the collection",
};

describe.skipIf(!enabled)("Agent mandates", () => {
  type Project = Awaited<ReturnType<typeof createPackageProject>>;
  let p: Project;
  let owner: McpPrincipal, editor: McpPrincipal;
  let artPng: Buffer;
  let photo = "";
  const saved: Record<string, string | undefined> = {};
  const flags = {
    ORBIT_CREATIVE_STUDIO: "true",
    ORBIT_MCP_PROPOSALS: "true",
    ORBIT_MCP_TASKS: "false",
    ORBIT_AGENT_MANDATES: "true",
  };
  const image = vi.mocked(generateImage);
  const runIn = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(p.owner.workspaceId, p.owner.projectId, work);

  async function principal(scope: Scope) {
    const scopes = ["orbit:read", "orbit:propose"];
    const g = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://mandate.test/${randomUUID()}.json`,
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
  /** An MCP call through the gateway's authorization, as a real client makes it. */
  async function call(by: McpPrincipal, name: string, args: object = {}) {
    const { tool, scope } = await authorizeMcpCall(by, name, p.owner.projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "marketing"),
        runId: "synthetic-mandate",
        conversationId: "synthetic-mandate",
        callIndex: 0,
        channel: {
          kind: "mcp",
          clientId: by.clientId,
          grantId: by.grantId,
          requestId: randomUUID(),
        },
      },
      args,
    );
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result as { output: any; images?: any[] };
  }
  /** The same tool from the in-app assistant (no gateway channel). */
  async function assistant(scope: Scope, args: object) {
    const tool = registeredTools().find((t) => t.name === CREATE)!;
    return (await tool.execute(
      {
        scope: moduleScope(scope, "marketing"),
        runId: randomUUID(),
        conversationId: randomUUID(),
        callIndex: 0,
      },
      args,
    )) as { output: any };
  }
  const request = (extra: object = {}) => ({
    channel: "instagram",
    title: "Autumn evenings",
    postText: "Evenings feel softer in warm light. Find lamps and throws.",
    copy: COPY,
    template: "lifestyle",
    art: "generate",
    artDirection: { motif: "A reading lamp glowing over a wool throw" },
    maxBudgetMicros: 1_000_000,
    idempotencyKey: randomUUID(),
    ...extra,
  });
  const free = (extra: object = {}) =>
    request({
      art: "asset",
      artAssetId: photo,
      artDirection: undefined,
      ...extra,
    });
  const grant = (input: object = {}, now?: Date) =>
    runIn((tx) =>
      grantAgentMandate(
        tx,
        p.owner,
        {
          actionType: PREVIEW_ACTION,
          assistant: true,
          mcp: true,
          maxCostMicrosPerAction: 1_000_000,
          maxActionsPerDay: 20,
          days: 30,
          ...input,
        },
        now,
      ),
    );
  const requestRow = (id: string) =>
    runIn((tx) => entity(tx, p.owner, "action_requests", id));
  const reasons = async (id: string) =>
    runIn(async (tx) => {
      const row = await entity(tx, p.owner, "action_requests", id);
      const auth = await resolveAuthorization(tx, p.owner, row);
      return auth.mode === "approval_required" ? auth.reasons : [];
    });
  const counts = () =>
    runIn(async (tx) =>
      Object.fromEntries(
        await Promise.all(
          ["publications", "postiz_drafts", "content", "missions"].map(
            async (kind) => [
              kind,
              await tx.entity.count({
                where: { projectId: p.owner.projectId, kind },
              }),
            ],
          ),
        ),
      ),
    );
  const previewOf = async (actionRequestId: string) =>
    (await call(owner, STATUS, { actionRequestId })).output.result;
  const imageConfig = (maxCostMicrosPerImage: number) =>
    runIn((tx) =>
      saveOpenAiConfiguration(tx, p.owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-model", "text-embedding-3-small", IMAGE_MODEL],
        rateCard: {
          "synthetic-model": {
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
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage,
          pricingVerifiedAt: new Date().toISOString(),
        },
      }),
    );
  /** Revokes the type's mandate in force, if any. */
  async function revokeAll() {
    const view = await runIn((tx) => readAgentMandates(tx, p.owner));
    const m = view.items.find((i) => i.actionType === PREVIEW_ACTION)?.mandate;
    if (m && !m.revokedAt)
      await runIn((tx) =>
        revokeAgentMandate(tx, p.owner, m.id, { version: m.version }),
      );
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(flags)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    p = await createPackageProject({ name: "Synthetic mandate project" });
    const lumora = await demoBrand("lumora");
    artPng = (await fixtureArt("good", "lumora")).bytes;
    const addAsset = (type: string, bytes: Buffer) =>
      runIn(async (tx) => {
        const row = await create(tx, p.owner, "assets", {
          name: `Synthetic ${type}`,
          type,
          mime: "image/png",
          base64: bytes.toString("base64"),
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
          source: "Synthetic fixture",
          license: "Synthetic rights fixture",
          validUses: ["brand", "social"],
          usageApproved: true,
          assetStatus: "approved",
          providerUse: false,
          driveSyncStatus: "LOCAL_ONLY",
        });
        return row.id;
      });
    const logo = await addAsset("logo", lumora.logos[0]!.bytes);
    photo = await addAsset("photo", artPng);
    await runIn((tx) =>
      tx.projectMarketingProfile.updateMany({
        where: { projectId: p.owner.projectId },
        data: {
          data: lumoraProfile({ logoAssetId: logo }) as any,
          version: { increment: 1 },
        },
      }),
    );
    owner = await principal(p.owner);
    editor = await principal(p.editor);
    image.mockImplementation((async (
      req: Parameters<typeof generateImage>[0],
    ) => ({
      bytes: artPng,
      model: IMAGE_MODEL,
      size: req.size,
      quality: req.quality,
      background: req.background,
      usage: null,
    })) as never);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await p?.cleanup();
    await closeDatabase();
  });

  it("marks only internal types mandatable, never publishing or direct external effects", () => {
    // Marking a type is a reviewed decision of its own (ADR 0019 §2): this
    // list changes only with that review.
    expect(mandatableTypes().map((t) => t.actionType).sort()).toEqual(
      [
        PREVIEW_ACTION,
        "knowledge.mcp.knowledge_propose_fact",
        "marketing.mcp.marketing_create_campaign",
        "marketing.mcp.marketing_update_campaign",
        "support.mcp.support_add_note",
        "support.mcp.support_prepare_reply",
        "work.mcp.work_propose_comment",
        "work.mcp.work_propose_initiative",
        "work.mcp.work_propose_task_update",
        "work.mcp.work_propose_tasks",
      ].sort(),
    );
    for (const [actionType, type] of registeredActionTypes()) {
      if (!type.mandate) continue;
      expect(MANDATABLE_RISK_CLASSES, actionType).toContain(type.riskClass);
    }
    for (const never of [
      "content.schedule",
      "image.generate",
      "assignment.confirm",
      "platform.task.start",
      "support.mcp.support_send_reply",
      "platform.mcp.ai_spend_policy_update",
    ])
      expect(registeredActionTypes().get(never)?.mandate, never).toBeUndefined();
    // Tools with a direct external effect are never mandatable.
    for (const tool of registeredTools().filter((t) => t.mcpDirectEffect))
      expect(
        registeredActionTypes().get(`${tool.namespace}.mcp.${tool.name}`)
          ?.mandate,
        tool.name,
      ).toBeUndefined();
  });

  it("B: without a mandate a preview waits for the owner as before", async () => {
    const proposed = (await call(owner, CREATE, request())).output;
    expect(proposed).toMatchObject({ status: "pending", requiresApproval: true });
    expect(proposed.approvedBy).toBeUndefined();
    expect(await reasons(proposed.actionRequestId)).toEqual(["NO_AGENT_MANDATE"]);
  });

  it("grants only within the type's limits, owners only, and refuses other types", async () => {
    await expect(
      runIn((tx) =>
        grantAgentMandate(tx, p.editor, {
          actionType: PREVIEW_ACTION,
          assistant: true,
          mcp: false,
          maxCostMicrosPerAction: 0,
          maxActionsPerDay: 1,
          days: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    await expect(grant({ actionType: "content.schedule" })).rejects.toMatchObject(
      { code: "ACTION_TYPE_NOT_MANDATABLE" },
    );
    await expect(
      grant({ maxCostMicrosPerAction: 2_000_001 }),
    ).rejects.toMatchObject({ code: "AGENT_MANDATE_COST_TOO_HIGH" });
    await expect(grant({ days: 91 })).rejects.toBeTruthy();
    await expect(grant({ options: { art: ["paint"] } })).rejects.toMatchObject({
      code: "AGENT_MANDATE_INVALID",
    });
    await expect(grant({ assistant: false, mcp: false })).rejects.toMatchObject({
      code: "AGENT_MANDATE_NO_CHANNEL",
    });
  });

  it("A/G: a real MCP client gets a finished internal preview under the mandate, without a decision and without publishing", async () => {
    const before = await counts();
    await grant();
    const args = request();
    const proposed = (await call(owner, CREATE, args)).output;
    expect(proposed).toMatchObject({
      status: "consumed",
      requiresApproval: false,
      approvedBy: "mandate",
      deduplicated: false,
    });
    const row = await requestRow(proposed.actionRequestId);
    expect(data(row)).toMatchObject({
      status: "consumed",
      decision: { channel: "mandate", decision: "approve", userId: p.owner.userId },
      authorization: { mode: "auto_within_policy" },
    });
    const events = await runIn((tx) =>
      tx.auditEvent.findMany({
        where: { projectId: p.owner.projectId, resourceId: row.id },
        orderBy: { createdAt: "asc" },
      }),
    );
    const auto = events.find((e) => e.action === "action_request.auto_approved");
    expect(auto?.metadata).toMatchObject({
      actionType: PREVIEW_ACTION,
      requesterKind: "mcp",
      clientId: owner.clientId,
      grantId: owner.grantId,
    });
    // The payload never reaches the audit trail.
    expect(JSON.stringify(auto?.metadata)).not.toContain(args.postText);
    // A retry with the same key returns the same request, never a second run.
    expect((await call(owner, CREATE, args)).output).toMatchObject({
      actionRequestId: proposed.actionRequestId,
      deduplicated: true,
    });

    const status = await previewOf(proposed.actionRequestId);
    expect(status).toMatchObject({ status: "queued" });
    image.mockClear();
    await runCreativePreview(p.owner, status.previewId);
    expect(image).toHaveBeenCalledTimes(1);
    const result = await call(owner, RESULT, { previewId: status.previewId });
    expect(result.output.result).toMatchObject({
      status: "completed",
      published: false,
      postText: args.postText,
      image: { format: "feed_portrait", width: 1080, height: 1350 },
      approval: {
        generation: "approved",
        generationApprovedBy: "agent_mandate",
        publishing: "not_requested",
      },
      qa: { scope: "technical" },
      cost: { settledMicros: IMAGE_MAX },
      // F: no rights consent in this mandate, so the art waits for the owner.
      rights: { status: "awaiting_owner_rights_decision" },
    });
    expect(result.output.result.rights.explanation).toMatch(/usage rights/);
    expect(result.images).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });

  it("covers the assistant with the same decision, and never delegated orders or other members", async () => {
    await grant({ assistant: false, mcp: true });
    const inApp = (await assistant(p.owner, free())).output;
    expect(inApp).toMatchObject({ status: "pending" });
    expect(await reasons(inApp.actionRequestId)).toEqual(["CHANNEL_NOT_COVERED"]);

    await grant({ assistant: true, mcp: false });
    expect((await assistant(p.owner, free())).output).toMatchObject({
      status: "consumed",
      approvedBy: "mandate",
    });
    const viaMcp = (await call(owner, CREATE, free())).output;
    expect(viaMcp.status).toBe("pending");
    expect(await reasons(viaMcp.actionRequestId)).toEqual(["CHANNEL_NOT_COVERED"]);

    await grant();
    // A delegated work order carries an MCP channel and its task: not covered.
    const delegated = await delegatedExecution.run(
      {
        userId: owner.userId,
        clientId: owner.clientId,
        grantId: owner.grantId,
        taskId: randomUUID(),
      } as any,
      () => call(owner, CREATE, free()),
    );
    expect(delegated.output.status).toBe("pending");
    expect(await reasons(delegated.output.actionRequestId)).toEqual([
      "DELEGATED_TASK_NOT_COVERED",
    ]);
    // A specialist's task (an assignment run) is not the owner's assistant.
    const tool = registeredTools().find((t) => t.name === CREATE)!;
    const specialist = (await tool.execute(
      {
        scope: moduleScope(p.owner, "marketing"),
        runId: randomUUID(),
        conversationId: randomUUID(),
        callIndex: 0,
        agentTask: { taskId: randomUUID(), runId: randomUUID() },
      },
      free(),
    )) as { output: any };
    expect(specialist.output.status).toBe("pending");
    // An editor is not a covered member (and the mandate stays the owner's).
    const byEditor = (await call(editor, CREATE, free())).output;
    expect(byEditor.status).toBe("pending");
    expect(await reasons(byEditor.actionRequestId)).toEqual([
      "REQUESTER_NOT_COVERED",
    ]);
    // A named client list leaves out every other client.
    await grant({ mcpClientIds: ["https://other.example.invalid/client.json"] });
    const other = (await call(owner, CREATE, free())).output;
    expect(await reasons(other.actionRequestId)).toEqual(["MCP_CLIENT_NOT_COVERED"]);
  });

  it("refuses requests outside the mandate's terms", async () => {
    await grant({ options: { art: ["none", "asset"] } });
    const art = (await call(owner, CREATE, request())).output;
    expect(art.status).toBe("pending");
    expect(await reasons(art.actionRequestId)).toEqual(["ART_MODE_NOT_COVERED"]);

    await grant({ maxCostMicrosPerAction: IMAGE_MAX - 1 });
    const costly = (await call(owner, CREATE, request())).output;
    expect(await reasons(costly.actionRequestId)).toEqual(
      expect.arrayContaining(["COST_OVER_MANDATE"]),
    );
  });

  it("D: counts the day's mandate approvals one after the other, also in parallel", async () => {
    await grant({ maxActionsPerDay: 2 });
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => call(owner, CREATE, free())),
    );
    const statuses = results.map((r) => r.output.status).sort();
    expect(statuses).toEqual(["consumed", "consumed", "pending", "pending"]);
    const waiting = results.find((r) => r.output.status === "pending")!;
    expect(await reasons(waiting.output.actionRequestId)).toEqual([
      "AGENT_MANDATE_DAILY_LIMIT",
    ]);
  });

  it("D: the spending authority still decides at payment; a mandate never raises a budget", async () => {
    await grant();
    // A platform record whose day is smaller than one image (fallback mode
    // reads it first): the reservation refuses, nothing is sent.
    const now = new Date();
    await runIn((tx) =>
      saveSpendPolicy(tx, p.owner, {
        profile: "custom",
        startAt: new Date(now.getTime() - 3600000).toISOString(),
        endAt: new Date(now.getTime() + 86400000).toISOString(),
        approvedPaidUse: true,
        dailyBudgetMicros: IMAGE_MAX - 1,
        monthlyBudgetMicros: 10_000_000,
        perRunBudgetMicros: IMAGE_MAX,
      }),
    );
    try {
      const proposed = (await call(owner, CREATE, request())).output;
      expect(proposed.approvedBy).toBe("mandate");
      const status = await previewOf(proposed.actionRequestId);
      image.mockClear();
      await runCreativePreview(p.owner, status.previewId);
      expect(image).not.toHaveBeenCalled();
      expect(await previewOf(proposed.actionRequestId)).toMatchObject({
        status: "blocked",
        errorCode: "BUDGET_EXCEEDED",
      });
      // Without paid use allowed, a paid preview is not covered at all.
      await runIn((tx) => saveSpendPolicy(tx, p.owner, { profile: "off" }));
      const off = (await call(owner, CREATE, request())).output;
      expect(off.status).toBe("pending");
      expect(await reasons(off.actionRequestId)).toEqual([
        "SPEND_AUTHORITY_INACTIVE",
      ]);
    } finally {
      await runIn((tx) =>
        tx.entity.updateMany({
          where: { projectId: p.owner.projectId, kind: "ai_spend_policies" },
          data: { data: { active: false } },
        }),
      );
    }
  });

  it("E: a revoked or expired mandate authorizes nothing new, and approved work stops before payment", async () => {
    const m = await grant();
    const proposed = (await call(owner, CREATE, request())).output;
    expect(proposed.approvedBy).toBe("mandate");
    const status = await previewOf(proposed.actionRequestId);
    await runIn((tx) =>
      revokeAgentMandate(tx, p.owner, m.id, { version: m.version }),
    );
    image.mockClear();
    await runCreativePreview(p.owner, status.previewId);
    expect(image).not.toHaveBeenCalled();
    expect(await previewOf(proposed.actionRequestId)).toMatchObject({
      status: "blocked",
      errorCode: "AGENT_MANDATE_ENDED",
      costMicros: 0,
    });
    const after = (await call(owner, CREATE, free())).output;
    expect(after.status).toBe("pending");
    expect(await reasons(after.actionRequestId)).toEqual(["NO_AGENT_MANDATE"]);
    // Revoking again returns the revoked record.
    await expect(
      runIn((tx) => revokeAgentMandate(tx, p.owner, m.id, { version: m.version })),
    ).resolves.toBeTruthy();

    // Granted 31 days ago for 30 days: ended.
    await grant({}, new Date(Date.now() - 31 * 86400000));
    const expired = (await call(owner, CREATE, free())).output;
    expect(expired.status).toBe("pending");
    expect(await reasons(expired.actionRequestId)).toEqual(["AGENT_MANDATE_ENDED"]);
    await revokeAll();
  });

  it("E: switching mandates off makes them inert", async () => {
    await grant();
    process.env.ORBIT_AGENT_MANDATES = "false";
    try {
      const off = (await call(owner, CREATE, free())).output;
      expect(off.status).toBe("pending");
      expect(await reasons(off.actionRequestId)).toEqual([
        "AGENT_MANDATES_DISABLED",
      ]);
      await expect(grant()).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      process.env.ORBIT_AGENT_MANDATES = "true";
    }
    await revokeAll();
  });

  it("F: the mandate's rights consent approves new art only for the image terms it was given for", async () => {
    await grant({ generatedImageRights: true });
    const proposed = (await call(owner, CREATE, request())).output;
    const status = await previewOf(proposed.actionRequestId);
    await runCreativePreview(p.owner, status.previewId);
    const r = (await call(owner, RESULT, { previewId: status.previewId })).output
      .result;
    expect(r.rights).toMatchObject({
      status: "approved_components",
      pendingAssetIds: [],
    });
    const art = await runIn((tx) => entity(tx, p.owner, "assets", r.artAssetId));
    expect(data(art)).toMatchObject({
      usageApproved: true,
      assetStatus: "approved",
      approvedBy: p.owner.userId,
      rightsSource: {
        kind: "agent_mandate",
        model: IMAGE_MODEL,
        maxCostMicrosPerImage: IMAGE_MAX,
      },
    });
    // The rendition stays an internal reference: never a post's image.
    const rendition = await runIn((tx) =>
      entity(tx, p.owner, "assets", r.image.assetId),
    );
    expect(data(rendition)).toMatchObject({
      usageApproved: false,
      assetStatus: "reference",
    });

    // A changed image ceiling voids the consent: the art waits again,
    // and the technical QA result is the same either way.
    await imageConfig(IMAGE_MAX + 1);
    try {
      const again = (await call(owner, CREATE, request())).output;
      expect(again.approvedBy).toBe("mandate");
      const s2 = await previewOf(again.actionRequestId);
      await runCreativePreview(p.owner, s2.previewId);
      const r2 = (await call(owner, RESULT, { previewId: s2.previewId })).output
        .result;
      expect(r2.rights.status).toBe("awaiting_owner_rights_decision");
      expect(r2.qa.verdict).toBe(r.qa.verdict);
    } finally {
      await imageConfig(IMAGE_MAX);
      await revokeAll();
    }
  });

  it("H: a person's approval still works for requests a mandate does not cover", async () => {
    const proposed = (await call(owner, CREATE, free())).output;
    expect(proposed.status).toBe("pending");
    const row = await requestRow(proposed.actionRequestId);
    await runIn((tx) =>
      decideActionRequest(tx, p.owner, row.id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
      }),
    );
    expect(data(await requestRow(row.id))).toMatchObject({
      status: "consumed",
      decision: { channel: "web" },
    });
    expect(data(await requestRow(row.id)).authorization).toBeUndefined();
  });
});
