import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { createPackageProject, IMAGE_MODEL } from "./support/package-project.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { authorizeMcpCall, visibleMcpTools } from "../src/platform/mcp/visibility.ts";
import { registeredToolOwner } from "../src/platform/modules/contributions.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  createConnection,
  grantConnection,
} from "../src/platform/administration/connections.ts";
import { saveAiProfile } from "../src/platform/administration/ai-profiles.ts";
import { create, data, entity } from "../src/shared.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";

// Project administration over MCP (docs/MCP_PROJECT_ADMINISTRATION.md),
// end to end on a project set up like FamilyPlan: a Marketing profile, no
// policy, no own AI key or Postiz connection, and the organization's
// central Postiz, Matomo and OpenAI connections. An owner's client reads
// the configuration, proposes channel, policy and model changes, the owner
// approves them in Orbit, and the readiness shows what is fixed. Nothing
// changes before approval, nothing publishes, and no read returns a key.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_MCP_PROJECT_ADMINISTRATION: "true",
  ORBIT_MCP_PROJECT_CONFIGURATION: "true",
  ORBIT_MCP_PROPOSALS: "true",
  ORBIT_MCP_TASKS: "false",
  ORBIT_CONNECTIONS: "true",
  ORBIT_CONNECTIONS_CUTOVER: "postiz,matomo",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const FACEBOOK = "cmufs9sra0001qm87aaxugx2k";
const INSTAGRAM = "cmufsb4kx0003qm87rrudkj65";
const SIBLING = "chan-sibling";
const CHANNELS = [
  { id: FACEBOOK, name: "FamilyPlan Facebook", identifier: "facebook", disabled: false },
  { id: INSTAGRAM, name: "FamilyPlan Instagram", identifier: "instagram", disabled: false },
  { id: SIBLING, name: "Sibling X", identifier: "x", disabled: false },
];
const SECRETS = {
  postiz: `postiz-${randomBytes(12).toString("hex")}`,
  matomo: `matomo-${randomBytes(12).toString("hex")}`,
  openai: `sk-synthetic-${randomBytes(16).toString("hex")}`,
};
const rate = () => ({
  inputMicrosPerMillion: 1000,
  outputMicrosPerMillion: 1000,
  verifiedAt: new Date().toISOString(),
});

describe.skipIf(!enabled)("Project administration over MCP", () => {
  let family: Awaited<ReturnType<typeof createPackageProject>>;
  let other: Awaited<ReturnType<typeof createPackageProject>>;
  let owner: McpPrincipal, editor: McpPrincipal, otherOwner: McpPrincipal;
  let postizId: string, matomoId: string, siblingProjectId: string;
  const outputs: string[] = [];

  async function principal(scope: Scope, scopes = ["orbit:read", "orbit:propose"]) {
    const g = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://administration.test/${randomUUID()}.json`,
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
  async function call(by: McpPrincipal, name: string, args: object = {}, projectId = family.owner.projectId): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(by, name, projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, registeredToolOwner(name)!),
        runId: "synthetic-administration",
        conversationId: "synthetic-administration",
        callIndex: 0,
        channel: { kind: "mcp", clientId: by.clientId, grantId: by.grantId, requestId: randomUUID() },
      },
      args,
    );
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    outputs.push(JSON.stringify(result.output));
    return result.output;
  }
  const read = async (name: string, by = owner) => (await call(by, name)).result;
  const decide = (id: string, decision: "approve" | "reject" = "approve", project = family) =>
    scoped(project.owner.workspaceId, project.owner.projectId, async (tx) => {
      const row = await entity(tx, project.owner, "action_requests", id);
      return decideActionRequest(tx, project.owner, id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision,
      });
    });
  const request = (id: string) =>
    scoped(family.owner.workspaceId, family.owner.projectId, (tx) =>
      entity(tx, family.owner, "action_requests", id),
    );
  const blockers = async () =>
    (await read("project_readiness_get")).blockers.map((b: { code: string }) => b.code);
  const policy = {
    mode: "assisted",
    channels: [FACEBOOK, INSTAGRAM],
    contentTypes: ["social"],
    allowedOrigins: ["https://example.invalid"],
    startAt: new Date(Date.now() - 3600000).toISOString(),
    endAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    maxPerDay: 2,
    minIntervalMinutes: 60,
    dailyBudgetMicros: 1_000_000,
    monthlyBudgetMicros: 10_000_000,
    perRunBudgetMicros: 500_000,
    approvedPaidTests: true,
  };

  beforeAll(async () => {
    family = await createPackageProject({ name: "Synthetic FamilyPlan administration" });
    other = await createPackageProject({ name: "Synthetic other tenant administration" });
    const s = family.owner;
    const actor = { userId: s.userId, role: "owner" as const, workspaceId: s.workspaceId };
    // Like FamilyPlan: no policy, no own AI settings, no own Postiz connection.
    await scoped(s.workspaceId, s.projectId, async (tx) => {
      await tx.entity.deleteMany({
        where: { projectId: s.projectId, kind: { in: ["policies", "connectors", "openai_configuration"] } },
      });
      // A source synced now, so internal drafting has current knowledge.
      const source = await entity(tx, s, "sources", family.sourceId);
      await tx.entity.update({
        where: { id: source.id },
        data: { data: { ...data(source), lastSuccessfulSyncAt: new Date().toISOString() } },
      });
    });
    // The organization's central connections and AI profile.
    const postiz = await createConnection(actor, {
      provider: "postiz",
      label: "Organization Postiz",
      config: { baseUrl: "https://postiz.example.invalid/api/public/v1" },
      secret: SECRETS.postiz,
    });
    postizId = postiz.id;
    await authDb.connection.update({
      where: { id: postizId },
      data: { status: "read_verified", health: { at: new Date().toISOString(), ok: true, channels: CHANNELS } },
    });
    // Another project of the organization already holds one channel.
    siblingProjectId = (
      await authDb.project.create({ data: { workspaceId: s.workspaceId, name: "Synthetic sibling" } })
    ).id;
    await authDb.connectionGrant.create({
      data: {
        connectionId: postizId,
        workspaceId: s.workspaceId,
        projectId: siblingProjectId,
        settings: { channels: [SIBLING] },
        createdBy: s.userId,
      },
    });
    const matomo = await createConnection(actor, {
      provider: "matomo",
      label: "Organization Matomo",
      config: { baseUrl: "https://matomo.example.invalid" },
      secret: SECRETS.matomo,
    });
    matomoId = matomo.id;
    await grantConnection(actor, matomoId, { projectId: s.projectId });
    const openai = await createConnection(actor, {
      provider: "openai",
      label: "Organization OpenAI",
      config: {},
      secret: SECRETS.openai,
    });
    await grantConnection(actor, openai.id, {
      projectId: s.projectId,
      purposes: ["text", "image"],
      monthlyBudgetMicros: 5_000_000,
    });
    await saveAiProfile(s.userId, { scope: "workspace", workspaceId: s.workspaceId }, {
      verifiedModels: ["synthetic-model", "synthetic-quality", "text-embedding-3-small", IMAGE_MODEL],
      rateCard: {
        "synthetic-model": rate(),
        "synthetic-quality": rate(),
        "text-embedding-3-small": rate(),
      },
      modelRoutes: {
        fast: "synthetic-model",
        standard: "synthetic-model",
        quality: "synthetic-model",
        escalation: "synthetic-model",
      },
    });
    owner = await principal(family.owner);
    editor = await principal(family.editor);
    otherOwner = await principal(other.owner);
  });
  afterAll(async () => {
    await authDb.aiProfile.deleteMany({ where: { workspaceId: family?.owner.workspaceId } });
    await authDb.connection.deleteMany({ where: { workspaceId: family?.owner.workspaceId } });
    await family?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("reads configuration, policy, AI models, integrations and readiness without secrets", async () => {
    const configuration = await read("project_configuration_get");
    expect(configuration.sections.marketing.version).toBe(1);
    const p = await read("marketing_policy_get");
    expect(p).toMatchObject({ version: 0, policy: null, active: false, approvalMode: null });
    // Channels come only from assignments, and none is assigned yet.
    expect(p.options.channels).toEqual([]);
    const ai = await read("ai_models_get");
    // The organization's granted key and profile serve the project.
    expect(ai.project).toEqual({ configured: false });
    expect(ai.effective.keySources.openai).toBe("connection");
    expect(ai.checks.textModelVerified).toBe(true);
    expect(ai.global.grantedKeys.openaiText).toMatchObject({ label: "Organization OpenAI" });
    const integrations = await read("integrations_get");
    expect(integrations.postiz).toEqual([]);
    expect(integrations.grantedConnections).toEqual([
      expect.objectContaining({ connectionId: matomoId, provider: "matomo", attached: false }),
    ]);
    const options = integrations.organizationChannels.find((o: any) => o.connectionId === postizId);
    expect(options.channels.map((c: any) => [c.id, c.holder])).toEqual([
      [FACEBOOK, "free"],
      [INSTAGRAM, "free"],
      [SIBLING, "other_project"],
    ]);
    expect(integrations.drive).toMatchObject({ connected: false });
    const codes = await blockers();
    expect(codes).toEqual(
      expect.arrayContaining([
        "OWNER_POLICY_REQUIRED",
        "POSTIZ_CHANNELS_NOT_ASSIGNED",
        "LIVE_RAG_EVAL_REQUIRED",
        "DRIVE_NOT_CONNECTED",
        "MATOMO_READ_VERIFICATION_REQUIRED",
        "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
      ]),
    );
    // Central keys count: the model blocker is gone without an own key.
    expect(codes).not.toContain("VERIFIED_OPENAI_MODELS_REQUIRED");
    const readiness = await read("project_readiness_get");
    expect(readiness.blockers.find((b: any) => b.code === "POSTIZ_CHANNELS_NOT_ASSIGNED")).toMatchObject({
      resolution: "mcp",
      automatable: true,
      tools: expect.arrayContaining(["integrations_configure"]),
      check: "failing",
      affects: expect.arrayContaining(["postiz_draft"]),
    });
    expect(readiness.blockers.find((b: any) => b.code === "PUBLISHER_WRITE_VERIFICATION_REQUIRED")).toMatchObject({
      resolution: "orbit",
      automatable: false,
    });
    const all = outputs.join("\n");
    for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/encrypted(Api)?Key|encryptedCredential|ciphertext/);
  });

  it("assigns the organization's Facebook and Instagram channels only after approval", async () => {
    const proposal = await call(owner, "integrations_configure", {
      action: "postiz_claim_channels",
      connectionId: postizId,
      channelIds: [FACEBOOK, INSTAGRAM],
      idempotencyKey: randomUUID(),
    });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    // The approval shows exactly what changes.
    expect(data(await request(proposal.actionRequestId)).payload.approvalContext).toEqual({
      changes: [{ setting: `connection.${postizId}.channels`, from: [], to: [FACEBOOK, INSTAGRAM].sort() }],
    });
    expect((await read("integrations_get")).postiz).toEqual([]);
    await decide(proposal.actionRequestId);
    const postiz = (await read("integrations_get")).postiz;
    expect(postiz).toHaveLength(1);
    expect(postiz[0].centralConnectionId).toBe(postizId);
    expect(postiz[0].channels.filter((c: any) => c.assigned).map((c: any) => c.id).sort()).toEqual(
      [FACEBOOK, INSTAGRAM].sort(),
    );
    expect(await blockers()).not.toContain("POSTIZ_CHANNELS_NOT_ASSIGNED");
    // A bound connection's channels are the organization's to assign.
    await expect(
      call(owner, "integrations_configure", {
        action: "postiz_assign_channels",
        connectorId: postiz[0].connectorId,
        expectedVersion: postiz[0].version,
        channelIds: [FACEBOOK],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "USE_POSTIZ_CLAIM_CHANNELS" });
    // Another project's channel is never taken.
    await expect(
      call(owner, "integrations_configure", {
        action: "postiz_claim_channels",
        connectionId: postizId,
        channelIds: [SIBLING],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_ASSIGNED_ELSEWHERE" });
    const sibling = await authDb.connectionGrant.findFirst({
      where: { projectId: siblingProjectId, revokedAt: null },
    });
    expect(sibling!.settings).toEqual({ channels: [SIBLING] });
  });

  it("sets a human_each policy after approval; refuses autopilot, foreign channels and stale versions", async () => {
    await expect(
      call(owner, "marketing_policy_update", {
        expectedVersion: 0,
        changes: { ...policy, mode: "autopilot" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ["changes", "mode"] })] });
    await expect(
      call(owner, "marketing_policy_update", {
        expectedVersion: 0,
        changes: { ...policy, channels: [FACEBOOK, SIBLING] },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "POSTIZ_CHANNEL_NOT_ASSIGNED" });
    const key = randomUUID();
    const proposal = await call(owner, "marketing_policy_update", {
      expectedVersion: 0,
      changes: policy,
      idempotencyKey: key,
    });
    expect(proposal.status).toBe("pending");
    expect((await read("marketing_policy_get")).policy).toBeNull();
    const changes = data(await request(proposal.actionRequestId)).payload.approvalContext.changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        { setting: "mode", from: null, to: "assisted" },
        { setting: "monthlyBudgetMicros", from: null, to: 10_000_000 },
      ]),
    );
    // A competing proposal against the same version loses at approval.
    const competing = await call(owner, "marketing_policy_update", {
      expectedVersion: 0,
      changes: { ...policy, maxPerDay: 1 },
      idempotencyKey: randomUUID(),
    });
    await decide(proposal.actionRequestId);
    await expect(decide(competing.actionRequestId)).rejects.toMatchObject({
      code: "POLICY_VERSION_CONFLICT",
    });
    const saved = await read("marketing_policy_get");
    expect(saved).toMatchObject({ active: true, approvalMode: "human_each", version: 1 });
    expect(saved.policy).toMatchObject({ mode: "assisted", channels: [FACEBOOK, INSTAGRAM], maxPerDay: 2 });
    // The retry returns the executed request and changes nothing again.
    const replay = await call(owner, "marketing_policy_update", {
      expectedVersion: 0,
      changes: policy,
      idempotencyKey: key,
    });
    expect(replay).toMatchObject({ actionRequestId: proposal.actionRequestId, deduplicated: true, status: "consumed" });
    expect((await read("marketing_policy_get")).version).toBe(1);
    // A rejected change has no effect; an old version is refused at once.
    const rejected = await call(owner, "marketing_policy_update", {
      expectedVersion: 1,
      changes: { maxPerDay: 3 },
      idempotencyKey: randomUUID(),
    });
    await decide(rejected.actionRequestId, "reject");
    expect((await read("marketing_policy_get")).policy.maxPerDay).toBe(2);
    await expect(
      call(owner, "marketing_policy_update", {
        expectedVersion: 0,
        changes: { maxPerDay: 3 },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });
    // The Marketing profile stayed untouched.
    expect((await read("project_configuration_get")).sections.marketing.version).toBe(1);
  });

  it("selects verified, priced models only and never needs a key over MCP", async () => {
    await expect(
      call(owner, "ai_models_update", {
        expectedVersion: 0,
        changes: { verifiedModels: ["synthetic-model", "made-up-model"] },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_VERIFIED:made-up-model" });
    const proposal = await call(owner, "ai_models_update", {
      expectedVersion: 0,
      changes: {
        modelRoutes: {
          fast: "synthetic-model",
          standard: "synthetic-model",
          quality: "synthetic-quality",
          escalation: "synthetic-quality",
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: 40_000,
          pricingVerifiedAt: new Date().toISOString(),
        },
      },
      idempotencyKey: randomUUID(),
    });
    expect((await read("ai_models_get")).project).toEqual({ configured: false });
    await decide(proposal.actionRequestId);
    const ai = await read("ai_models_get");
    expect(ai.project.configured).toBe(true);
    expect(ai.effective.modelRoutes.quality).toBe("synthetic-quality");
    // The organization's key still serves the project.
    expect(ai.effective.keySources.openai).toBe("connection");
    expect(ai.checks).toMatchObject({
      textModelVerified: true,
      imagePricingCurrent: true,
      imageModelVerified: true,
    });
    expect(await blockers()).not.toContain("VERIFIED_OPENAI_MODELS_REQUIRED");
    await expect(
      call(owner, "ai_models_update", {
        expectedVersion: 0,
        changes: { defaultProvider: "openai", fallback: { onProviderBudgetStop: "openai" } },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "AI_CONFIGURATION_VERSION_CONFLICT" });
  });

  it("adds a globally verified model with its global price to a project's own selection", async () => {
    const saved = {
      models: process.env.OPENAI_VERIFIED_MODELS,
      rates: process.env.OPENAI_RATE_CARD_JSON,
    };
    const price = { inputMicrosPerMillion: 20000, outputMicrosPerMillion: 0, verifiedAt: new Date().toISOString() };
    process.env.OPENAI_VERIFIED_MODELS = "text-embedding-3-large";
    process.env.OPENAI_RATE_CARD_JSON = JSON.stringify({ "text-embedding-3-large": price });
    try {
      const ai = await read("ai_models_get");
      expect(ai.candidates).toContainEqual(
        expect.objectContaining({ model: "text-embedding-3-large", source: "global", price: "current", verified: false }),
      );
      const proposal = await call(owner, "ai_models_update", {
        expectedVersion: ai.version,
        changes: { verifiedModels: [...ai.effective.verifiedModels, "text-embedding-3-large"] },
        idempotencyKey: randomUUID(),
      });
      await decide(proposal.actionRequestId);
      const after = await read("ai_models_get");
      expect(after.effective.verifiedModels).toContain("text-embedding-3-large");
      expect(after.effective.prices["text-embedding-3-large"]).toBe("current");
    } finally {
      for (const [key, value] of [
        ["OPENAI_VERIFIED_MODELS", saved.models],
        ["OPENAI_RATE_CARD_JSON", saved.rates],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });

  it("attaches the granted Matomo connection with its site and reports verification failures", async () => {
    const proposal = await call(owner, "integrations_configure", {
      action: "attach_connection",
      connectionId: matomoId,
      siteId: "7",
      idempotencyKey: randomUUID(),
    });
    await decide(proposal.actionRequestId);
    const matomo = (await read("integrations_get")).matomo;
    expect(matomo).toEqual([
      expect.objectContaining({ centralConnectionId: matomoId, siteId: "7", status: "configured" }),
    ]);
    // Still unverified: the read check has to pass first.
    expect(await blockers()).toContain("MATOMO_READ_VERIFICATION_REQUIRED");
    // Drive is not connected: a concrete cause, nothing changed.
    const verify = await call(owner, "integration_verify", { target: "drive", connectorId: null });
    expect(verify).toMatchObject({ target: "drive", ok: false });
    expect(verify.code).toMatch(/^GOOGLE_DRIVE_/);
  });

  it("runs the RAG evaluation steps as owner proposals and opens the gate only after a passed evaluation", async () => {
    const before = await read("knowledge_evaluation_get");
    expect(before.liveEvaluation.valid).toBe(false);
    expect(before.liveEvaluation.reasons).toContain("LIVE_INDEX_EVALUATION_REQUIRED");
    expect((await read("project_readiness_get")).blockers.find((b: any) => b.code === "LIVE_RAG_EVAL_REQUIRED").details.reasons).toEqual(
      before.liveEvaluation.reasons,
    );
    // An index without a passed live evaluation cannot be activated.
    await expect(
      call(owner, "knowledge_evaluate", { step: "activate", indexId: before.activeIndex.id, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "INDEX_NOT_EVALUATED" });
    const begin = await call(owner, "knowledge_evaluate", { step: "begin_index", idempotencyKey: randomUUID() });
    await decide(begin.actionRequestId);
    const after = await read("knowledge_evaluation_get");
    const building = after.generations.find((g: any) => g.state === "building");
    expect(building).toBeTruthy();
    // Too few cases are refused before anything is paid.
    await expect(
      call(owner, "knowledge_evaluate", {
        step: "evaluate",
        indexId: building.id,
        datasetVersion: "familyplan-v1",
        confirmQueriesMayBeSentToOpenAI: true,
        cases: Array.from({ length: 60 }, (_, i) => ({
          id: `c${i}`,
          query: `question ${i}`,
          expectedChunkIds: [],
          forbiddenChunkIds: ["x"],
        })),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_CASE_COVERAGE_REQUIRED" });
    expect(await blockers()).toContain("LIVE_RAG_EVAL_REQUIRED");
  });

  it("drafts internally while publishing stays blocked", async () => {
    const s = family.owner;
    const draft = await scoped(s.workspaceId, s.projectId, (tx) =>
      create(tx, s, "content", {
        title: "Synthetic FamilyPlan post",
        body: "Plan the week together.",
        channel: FACEBOOK,
        type: "social",
        status: "draft",
        origin: "human_authored",
        synthetic: false,
      }),
    );
    expect(draft.id).toBeTruthy();
    const readiness = await read("project_readiness_get");
    expect(readiness.actions.text_draft.state).toBe("ready");
    expect(readiness.actions.postiz_live.state).not.toBe("ready");
    expect(readiness.actions.postiz_schedule.state).not.toBe("ready");
    expect(readiness.actions.postiz_live.blockers).toEqual(
      expect.arrayContaining(["PUBLISHER_WRITE_VERIFICATION_REQUIRED", "EXTERNAL_WRITES_DISABLED"]),
    );
    // Assisted: every post still needs the owner's package approval.
    expect((await read("marketing_policy_get")).approvalMode).toBe("human_each");
  });

  it("keeps tenants apart and changes to owners", async () => {
    await expect(authorizeMcpCall(otherOwner, "marketing_policy_get", family.owner.projectId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // The other tenant sees its own state, never FamilyPlan's connections.
    const theirs = await call(otherOwner, "integrations_get", {}, other.owner.projectId);
    expect(JSON.stringify(theirs)).not.toContain(postizId);
    await expect(
      call(
        otherOwner,
        "integrations_configure",
        { action: "postiz_claim_channels", connectionId: postizId, channelIds: [FACEBOOK], idempotencyKey: randomUUID() },
        other.owner.projectId,
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    await expect(
      call(
        otherOwner,
        "integrations_configure",
        { action: "attach_connection", connectionId: matomoId, idempotencyKey: randomUUID() },
        other.owner.projectId,
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_GRANTED" });
    // A project on autopilot changes over MCP only by moving to assisted.
    const theirPolicy = (await call(otherOwner, "marketing_policy_get", {}, other.owner.projectId)).result;
    expect(theirPolicy.approvalMode).toBe("automatic");
    await expect(
      call(
        otherOwner,
        "marketing_policy_update",
        { expectedVersion: theirPolicy.version, changes: { maxPerDay: 2 }, idempotencyKey: randomUUID() },
        other.owner.projectId,
      ),
    ).rejects.toMatchObject({ code: "MCP_AUTOPILOT_NOT_ALLOWED" });
    // An editor reads but proposes nothing; a read-only token lists no proposal tool.
    expect((await read("marketing_policy_get", editor)).approvalMode).toBe("human_each");
    for (const name of ["marketing_policy_update", "ai_models_update", "integrations_configure", "knowledge_evaluate", "integration_verify"])
      await expect(authorizeMcpCall(editor, name, family.owner.projectId)).rejects.toMatchObject({
        code: "MCP_TOOL_NOT_ALLOWED",
      });
    const reader = await principal(family.owner, ["orbit:read"]);
    const names = (await visibleMcpTools(reader, family.owner.projectId)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["marketing_policy_get", "ai_models_get", "project_readiness_get"]));
    expect(names).not.toContain("marketing_policy_update");
  });

  it("lists none of the tools while the feature is off", async () => {
    process.env.ORBIT_MCP_PROJECT_ADMINISTRATION = "false";
    try {
      const names = (await visibleMcpTools(owner, family.owner.projectId)).map((t) => t.name);
      for (const name of [
        "marketing_policy_get",
        "marketing_policy_update",
        "ai_models_get",
        "ai_models_update",
        "integrations_get",
        "integrations_configure",
        "integration_verify",
        "knowledge_evaluation_get",
        "knowledge_evaluate",
        "project_readiness_get",
      ])
        expect(names).not.toContain(name);
    } finally {
      process.env.ORBIT_MCP_PROJECT_ADMINISTRATION = "true";
    }
  });
});
