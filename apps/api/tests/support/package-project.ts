import { randomUUID } from "node:crypto";
import { authDb, scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { ingest, setFact } from "../../../../packages/knowledge/src/index.ts";
import { create } from "../../src/shared.ts";
import { saveOpenAiConfiguration } from "../../src/modules/openai-configuration.ts";

export const X = "x-int";
export const TELEGRAM = "tg-int";
export const LINKEDIN = "li-int";
export const OFFICIAL_URL = "https://example.invalid";
export const IMAGE_MODEL = "gpt-image-2.5-flare";
export const IMAGE_MAX = 50_000;

/**
 * A synthetic project ready for content packages: an autopilot policy for X
 * and Telegram (LinkedIn assigned but not allowed), a marketing profile with a
 * verified official link, one usable and one expired fact, an active index and
 * priced synthetic text, embedding and image models. No real credential.
 */
export async function createPackageProject() {
  const users: string[] = [];
  const syntheticUser = async () => {
    const row = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic package user",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(row.id);
    return row.id;
  };
  const ownerId = await syntheticUser();
  const workspace = await authDb.workspace.create({
    data: {
      name: "Content packages",
      members: { create: { userId: ownerId, role: "owner" } },
    },
  });
  const project = await authDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Content package project",
      timezone: "Europe/Berlin",
    },
  });
  const owner: Scope = {
    workspaceId: workspace.id,
    projectId: project.id,
    userId: ownerId,
    role: "owner",
  };
  // Same shape as the add-member action: workspace viewer plus a project role.
  const projectMember = async (role: Scope["role"]): Promise<Scope> => {
    const userId = await syntheticUser();
    await authDb.workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId, role: "viewer" },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        userId,
        role,
      },
    });
    return { ...owner, userId, role };
  };
  const editor = await projectMember("editor");
  const viewer = await projectMember("viewer");
  let sourceId = "";
  let betaFactId = "";
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const now = Date.now();
  const past = new Date(now - 3600000).toISOString();
  const future = new Date(now + 30 * 86400000).toISOString();
  await run(async (tx) => {
    await create(tx, owner, "policies", {
      mode: "autopilot",
      channels: [X, TELEGRAM],
      contentTypes: ["social"],
      allowedOrigins: [OFFICIAL_URL],
      startAt: past,
      endAt: future,
      maxPerDay: 1,
      minIntervalMinutes: 1,
      dailyBudgetMicros: 10_000_000,
      monthlyBudgetMicros: 100_000_000,
      perRunBudgetMicros: 5_000_000,
      approvedPaidTests: true,
      active: true,
    });
    await create(tx, owner, "connectors", {
      provider: "postiz",
      status: "read_verified",
      channels: [
        { id: X, name: "Synthetic X", identifier: "x", disabled: false },
        {
          id: TELEGRAM,
          name: "Synthetic Telegram",
          identifier: "telegram",
          disabled: false,
        },
        {
          id: "li-int",
          name: "Synthetic LinkedIn",
          identifier: "linkedin",
          disabled: false,
        },
      ],
      assignedIntegrationIds: [X, TELEGRAM, "li-int"],
      postingTimes: { [X]: "17:00" },
    });
    const source = await create(tx, owner, "sources", {
      name: "Synthetic product source",
      status: "active",
      publicUse: true,
      modelUse: true,
      authority: "official",
      generation: 1,
      maxAgeHours: 168,
    });
    sourceId = source.id;
    const link = await create(tx, owner, "facts", {
      key: "official.link",
      value: OFFICIAL_URL,
      valueType: "url",
      language: "en",
      sourceId,
      validFrom: past,
      validUntil: future,
      status: "verified",
      publicUse: true,
      modelUse: true,
    });
    const beta = await setFact(tx, owner, {
      key: "beta.access",
      value: "open for product teams",
      valueType: "text",
      language: "en",
      sourceId,
      validFrom: past,
      validUntil: future,
      status: "verified",
      publicUse: true,
      modelUse: true,
    });
    betaFactId = beta.id;
    await setFact(tx, owner, {
      key: "launch.deadline",
      value: "expired fixture",
      valueType: "text",
      language: "en",
      sourceId,
      validFrom: new Date(now - 48 * 3600000).toISOString(),
      validUntil: past,
      status: "verified",
      publicUse: true,
      modelUse: true,
    });
    await ingest(tx, owner, {
      sourceId,
      externalId: "synthetic-beta-access",
      title: "Synthetic beta access",
      text: "Beta access is open for product teams.",
      mimeType: "text/plain",
      language: "en",
      validFrom: past,
      validUntil: future,
      embeddings: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
    });
    await tx.projectMarketingProfile.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        version: 1,
        data: {
          productName: "Synthetic Orbit",
          contentLanguage: "en",
          internalLanguage: "de",
          audience: "Product teams",
          positioning: "Test only",
          productStrategy: "Test only",
          presaleStrategy: "No presale",
          voice: ["clear"],
          guardrails: ["No unsupported claims"],
          primaryCtas: ["Learn more."],
          channelPriority: [X],
          notificationPreference: "none",
          officialLinks: [
            { label: "Official", url: OFFICIAL_URL, factId: link.id },
          ],
          assetPolicy: "approved_only",
        },
      },
    });
    const rate = {
      inputMicrosPerMillion: 1000,
      outputMicrosPerMillion: 1000,
      verifiedAt: new Date().toISOString(),
    };
    await saveOpenAiConfiguration(tx, owner, {
      apiKey: "synthetic-no-provider-call-key",
      verifiedModels: [
        "synthetic-model",
        "text-embedding-3-small",
        IMAGE_MODEL,
      ],
      rateCard: { "synthetic-model": rate, "text-embedding-3-small": rate },
      modelRoutes: {
        fast: "synthetic-model",
        standard: "synthetic-model",
        quality: "synthetic-model",
        escalation: "synthetic-model",
      },
      imageGeneration: {
        model: IMAGE_MODEL,
        maxCostMicrosPerImage: IMAGE_MAX,
        pricingVerifiedAt: new Date().toISOString(),
      },
    });
  });
  return {
    owner,
    editor,
    viewer,
    sourceId,
    betaFactId,
    async cleanup() {
      await authDb.workspace.delete({ where: { id: owner.workspaceId } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
    },
  };
}
