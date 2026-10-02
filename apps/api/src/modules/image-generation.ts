import { createHash } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import {
  generateImage,
  imageGenerationConfigurationSchema,
  imagePriceConfigured,
} from "../../../../packages/ai/src/index.ts";
import {
  marketingProfile,
  policy,
  type Scope,
} from "../../../../packages/schemas/src/index.ts";
import { audit, create, DomainError, data } from "../shared.ts";
import { reserve, markTransmitted, settle } from "./budget.ts";
import { activePolicy } from "./policy.ts";
import { currentMarketingProfile } from "./marketing-profile.ts";
import { runtimeOpenAiConfiguration } from "./openai-configuration.ts";
import { recordSpan, startRun, tracedRun } from "./telemetry.ts";
import { normalizeGeneratedPng } from "./assets.ts";
import {
  connectionStatus,
  markSyncFailed,
  saveGeneratedAsset,
} from "./google-drive.ts";

export const imageGenerationInput = z
  .object({
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(10).max(4000),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
    quality: z.enum(["low", "medium", "high"]),
    background: z.enum(["opaque", "transparent"]),
    validUses: z
      .array(z.enum(["social", "blog", "newsletter", "ad"]))
      .min(1)
      .max(4),
    confirmPromptMayBeSentToOpenAI: z.literal(true),
    confirmMaximumCostMicros: z.number().int().positive(),
    saveToDrive: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    channel: z
      .enum(["Social", "Ads", "Blog", "Website", "Campaigns", "Other"])
      .optional(),
    platform: z
      .enum(["X", "Telegram", "LinkedIn", "Instagram", "Facebook"])
      .optional(),
  })
  .strict();

/** What an image action request asks for; the owner's decision replaces the confirmations. */
export const imageRequestBrief = imageGenerationInput.omit({
  requestId: true,
  confirmPromptMayBeSentToOpenAI: true,
  confirmMaximumCostMicros: true,
});
/** An image action request payload, bound to the model and ceiling configured when it was created. */
export const imageRequestPayload = imageRequestBrief.extend({
  model: z.string().min(1),
  maxCostMicros: z.number().int().positive(),
});

/** Current image route; fails closed without a key, a configured price or a verified model. */
export async function currentImageTerms(tx: DbTx, scope: Scope) {
  const runtime = await runtimeOpenAiConfiguration(tx, scope);
  const imageConfig = imageGenerationConfigurationSchema.parse(
    runtime.imageGeneration ?? {},
  );
  if (
    !(runtime.imageApiKey || runtime.apiKey) ||
    !imagePriceConfigured(imageConfig)
  )
    throw new DomainError("IMAGE_GENERATION_NOT_CONFIGURED", 409);
  if (!runtime.verifiedModels.includes(imageConfig.model))
    throw new DomainError("IMAGE_MODEL_NOT_VERIFIED", 409);
  return { runtime, imageConfig };
}

export function buildBrandImagePrompt(
  prompt: string,
  profile: z.infer<typeof marketingProfile>,
) {
  const visual = profile.visualIdentity;
  return [
    "Create one original marketing artwork for the described campaign.",
    "The following safety and brand constraints override conflicting instructions in the artwork request.",
    "Do not create, imitate, redraw, or alter any logo, trademark, signature, UI screenshot, or readable text.",
    "Leave clean negative space for a separately rendered approved logo and copy.",
    `Brand palette: primary ${visual.primaryColor}; secondary ${visual.secondaryColor}; accent ${visual.accentColor}; background ${visual.backgroundColor}.`,
    `Visual rules: ${visual.designRules.join(" ")}`,
    "Artwork request begins:",
    prompt,
    "Artwork request ends.",
  ].join("\n");
}

type Provider = typeof generateImage;
type ImageOptions = {
  /** Runs in the reservation transaction after every other check; a throw stops before any cost. */
  authorize?: (tx: DbTx) => Promise<void>;
};

export async function generateProjectImage(
  scope: Scope,
  raw: unknown,
  provider: Provider = generateImage,
  options: ImageOptions = {},
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = imageGenerationInput.parse(raw);
  const agentRunId = await startRun(scope, {
    kind: "image",
    agentName: "orbit_image",
    taskClass: "image_generation",
    subjectType: "asset_request",
    subjectId: input.requestId,
  });
  return tracedRun(scope, agentRunId, () =>
    generateProjectImageTraced(scope, input, provider, agentRunId, options),
  );
}

async function generateProjectImageTraced(
  scope: Scope,
  input: z.infer<typeof imageGenerationInput>,
  provider: Provider,
  agentRunId: string | null,
  options: ImageOptions,
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: scope.projectId, workspaceId: scope.workspaceId },
      });
      if (!project || project.paused)
        throw new DomainError("PROJECT_PAUSED", 409);
      const profileRow = await currentMarketingProfile(tx, scope);
      if (!profileRow) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
      const profileData = marketingProfile.parse(profileRow.data);
      const { runtime, imageConfig } = await currentImageTerms(tx, scope);
      if (input.confirmMaximumCostMicros !== imageConfig.maxCostMicrosPerImage)
        throw new DomainError("IMAGE_COST_CONFIRMATION_STALE", 409);
      const currentPolicy = await activePolicy(tx, scope);
      if (!currentPolicy) throw new DomainError("ACTIVE_POLICY_REQUIRED", 409);
      const parsedPolicy = policy.parse(
        Object.fromEntries(
          Object.entries(data(currentPolicy)).filter(
            ([key]) => !["active", "activatedAt", "activatedBy"].includes(key),
          ),
        ),
      );
      await options.authorize?.(tx);
      const reservation = await reserve(
        tx,
        scope,
        `image:${input.requestId}`,
        "image_generation",
        imageConfig.maxCostMicrosPerImage,
        parsedPolicy,
        new Date(),
        `image:${input.requestId}`,
        {
          agentRunId,
          taskClass: "image_generation",
          model: imageConfig.model,
        },
      );
      await audit(
        tx,
        scope,
        "asset.generate_openai_requested",
        input.requestId,
        {
          model: imageConfig.model,
          reservationId: reservation.id,
          maximumCostMicros: imageConfig.maxCostMicrosPerImage,
        },
      );
      await markTransmitted(tx, scope, reservation.id);
      return {
        runtime,
        reservationId: reservation.id,
        profileVersion: profileRow.version,
        providerPrompt: buildBrandImagePrompt(input.prompt, profileData),
        imageConfig,
      };
    },
  );

  const driveEnabled =
    input.saveToDrive !== false && (await connectionStatus(scope)).enabled;
  // Image cost is never known: the span keeps costMicros null, the reservation stays unknown.
  let callStartedAt = new Date();
  let providerReturned = false;
  let spanRecorded = false;
  try {
    callStartedAt = new Date();
    const generated = await provider({
      prompt: prepared.providerPrompt,
      size: input.size,
      quality: input.quality,
      background: input.background,
      reservationId: prepared.reservationId,
      runtime: prepared.runtime,
      user: createHash("sha256")
        .update(`${scope.workspaceId}:${scope.userId}`)
        .digest("hex"),
    });
    providerReturned = true;
    const normalized = await normalizeGeneratedPng(generated.bytes);
    const asset = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        await settle(tx, scope, prepared.reservationId, null);
        const asset = await create(tx, scope, "assets", {
          name: input.name,
          type: "generated_artwork",
          mime: "image/png",
          filename: `${
            input.name
              .replace(/[^a-z0-9]+/gi, "-")
              .replace(/^-|-$/g, "")
              .toLowerCase() || "generated-artwork"
          }.png`,
          base64: normalized.bytes.toString("base64"),
          sha256: normalized.sha256,
          width: normalized.width,
          height: normalized.height,
          bytes: normalized.bytes.length,
          source: "OpenAI Images API",
          provider: "openai",
          providerModel: generated.model,
          providerSize: generated.size,
          providerQuality: generated.quality,
          providerBackground: generated.background,
          providerUsage: generated.usage,
          promptStored: true,
          prompt: input.prompt,
          tags: input.tags ?? [],
          channel: input.channel ?? "Other",
          platform: input.platform,
          promptHash: createHash("sha256").update(input.prompt).digest("hex"),
          providerPromptHash: createHash("sha256")
            .update(prepared.providerPrompt)
            .digest("hex"),
          profileVersion: prepared.profileVersion,
          validUses: input.validUses,
          usageApproved: false,
          assetStatus: "reference",
          license: "AI-generated asset; owner rights and brand review required",
          generatedAt: new Date().toISOString(),
          budgetReservationId: prepared.reservationId,
          generationId: input.requestId,
          createdBy: scope.userId,
          driveSyncStatus: driveEnabled ? "PENDING" : "LOCAL_ONLY",
        });
        await audit(tx, scope, "asset.generate_openai", asset.id, {
          model: generated.model,
          reservationId: prepared.reservationId,
          costState: "unknown",
        });
        return asset;
      },
    );
    // Telemetry only after the settlement committed.
    spanRecorded = true;
    await recordSpan(scope, agentRunId, {
      type: "image",
      name: "images.generate",
      model: generated.model,
      status: "succeeded",
      startedAt: callStartedAt,
      durationMs: Date.now() - callStartedAt.valueOf(),
      costMicros: null,
      budgetReservationId: prepared.reservationId,
    });
    if (
      input.saveToDrive !== false &&
      (await connectionStatus(scope)).enabled
    ) {
      try {
        return await saveGeneratedAsset(
          scope,
          asset.id,
          input.channel ?? "Other",
        );
      } catch {
        return markSyncFailed(scope, asset.id);
      }
    }
    return asset;
  } catch (error) {
    const failureCode =
      error instanceof DomainError
        ? error.message
        : error instanceof z.ZodError
          ? "VALIDATION_ERROR"
          : "IMAGE_PROVIDER_ERROR";
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await settle(tx, scope, prepared.reservationId, null);
      await audit(tx, scope, "asset.generate_openai_failed", input.requestId, {
        reservationId: prepared.reservationId,
        errorCode: failureCode,
      });
    });
    if (!spanRecorded)
      await recordSpan(scope, agentRunId, {
        type: "image",
        name: "images.generate",
        model: prepared.imageConfig.model,
        // A provider that returned was billed; a provider that threw has an unknown outcome.
        status: providerReturned ? "succeeded" : "unknown",
        errorCode: providerReturned ? undefined : failureCode,
        startedAt: callStartedAt,
        durationMs: Date.now() - callStartedAt.valueOf(),
        costMicros: null,
        budgetReservationId: prepared.reservationId,
      });
    throw error;
  }
}
