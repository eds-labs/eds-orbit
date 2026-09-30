import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import { generateProjectImage } from "../src/modules/image-generation.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const IMAGE_MODEL = "gpt-image-2.5-flare";
const MAX_COST = 5000;

describe.skipIf(!enabled)("Image generation telemetry", () => {
  let scope: Scope;
  let png: Buffer;
  beforeAll(async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    png = rendered.bytes;
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic image telemetry",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Image telemetry",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Image project" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    const now = new Date().toISOString();
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await create(tx, scope, "policies", {
        mode: "observe",
        channels: ["x-test"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: new Date(Date.now() - 3600000).toISOString(),
        endAt: new Date(Date.now() + 86400000).toISOString(),
        maxPerDay: 0,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 100000,
        monthlyBudgetMicros: 100000,
        perRunBudgetMicros: 10000,
        approvedPaidTests: true,
        active: true,
      });
      await saveOpenAiConfiguration(tx, scope, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-model", IMAGE_MODEL],
        rateCard: {
          "synthetic-model": {
            inputMicrosPerMillion: 1000,
            outputMicrosPerMillion: 1000,
            verifiedAt: now,
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
          maxCostMicrosPerImage: MAX_COST,
          pricingVerifiedAt: now,
        },
      });
      // Stored directly: the official-link fact checks of saveMarketingProfile are out of scope here.
      const profile = marketingProfile.parse({
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
            url: "https://example.invalid",
            factId: randomUUID(),
          },
        ],
        visualIdentity: {
          primaryColor: "#112233",
          secondaryColor: "#334455",
          accentColor: "#55AAFF",
          backgroundColor: "#F0F4F8",
          surfaceColor: "#FFFFFF",
          textColor: "#101820",
          headingFont: "Inter",
          bodyFont: "Arial",
          designRules: ["Use clean geometric forms."],
        },
        assetPolicy: "approved_only",
      });
      await tx.projectMarketingProfile.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          version: 1,
          data: profile,
        },
      });
    });
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: scope.workspaceId } });
    await authDb.user.delete({ where: { id: scope.userId } });
    await closeDatabase();
  });

  const request = (requestId: string) => ({
    requestId,
    name: "Synthetic artwork",
    prompt: "A calm geometric abstract artwork with soft gradients.",
    size: "1024x1024" as const,
    quality: "low" as const,
    background: "opaque" as const,
    validUses: ["social" as const],
    confirmPromptMayBeSentToOpenAI: true as const,
    confirmMaximumCostMicros: MAX_COST,
    saveToDrive: false,
  });
  const traced = (requestId: string) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const runs = await tx.agentRun.findMany({
        where: { subjectType: "asset_request", subjectId: requestId },
      });
      return {
        runs,
        spans: await tx.agentSpan.findMany({
          where: { runId: { in: runs.map((r) => r.id) } },
        }),
        reservations: await tx.budgetReservation.findMany({
          where: { key: `${scope.projectId}:image:${requestId}` },
        }),
      };
    });

  it("records a succeeded image span with unknown cost and attributes the reservation", async () => {
    const requestId = randomUUID();
    const provider = async () => ({
      bytes: png,
      model: IMAGE_MODEL,
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      usage: null,
    });
    await generateProjectImage(scope, request(requestId), provider as never);
    const { runs, spans, reservations } = await traced(requestId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(
      expect.objectContaining({
        kind: "image",
        taskClass: "image_generation",
        status: "succeeded",
      }),
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toEqual(
      expect.objectContaining({
        agentRunId: runs[0]!.id,
        taskClass: "image_generation",
        model: IMAGE_MODEL,
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual(
      expect.objectContaining({
        type: "image",
        name: "images.generate",
        model: IMAGE_MODEL,
        status: "succeeded",
        costMicros: null,
        budgetReservationId: reservations[0]!.id,
      }),
    );
  });

  it("records an unknown image span and a failed run when the provider throws", async () => {
    const requestId = randomUUID();
    const provider = async () => {
      throw new Error("provider said: secret prompt text");
    };
    await expect(
      generateProjectImage(scope, request(requestId), provider as never),
    ).rejects.toThrow();
    const { runs, spans, reservations } = await traced(requestId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.agentRunId).toBe(runs[0]!.id);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual(
      expect.objectContaining({
        type: "image",
        name: "images.generate",
        model: IMAGE_MODEL,
        status: "unknown",
        errorCode: "IMAGE_PROVIDER_ERROR",
        costMicros: null,
        budgetReservationId: reservations[0]!.id,
      }),
    );
    expect(JSON.stringify(spans, (_k, v) => (typeof v === "bigint" ? `${v}` : v))).not.toContain(
      "secret prompt text",
    );
  });
});
