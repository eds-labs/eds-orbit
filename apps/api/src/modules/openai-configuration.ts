import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  environmentRuntimeConfig,
  imageGenerationConfigurationSchema,
  rateCardSchema,
  type OpenAiRuntimeConfig,
} from "../../../../packages/ai/src/index.ts";
import {
  loadConfig,
  modelRoutes,
} from "../../../../packages/config/src/index.ts";
import {
  create,
  data,
  decrypt,
  encrypt,
  update,
  DomainError,
} from "../shared.ts";

const key = z.string().trim().min(20).max(1000);
export const openAiConfigurationInput = z
  .object({
    apiKey: key.optional(),
    imageApiKey: key.optional(),
    verifiedModels: z.array(z.string().trim().min(1).max(120)).max(20),
    rateCard: rateCardSchema,
    modelRoutes: z
      .object({
        fast: z.string().trim().min(1).max(120),
        standard: z.string().trim().min(1).max(120),
        quality: z.string().trim().min(1).max(120),
        escalation: z.string().trim().min(1).max(120),
      })
      .strict()
      .default(modelRoutes),
    imageGeneration: imageGenerationConfigurationSchema.default({
      model: "gpt-image-2.5-flare",
      maxCostMicrosPerImage: 0,
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.verifiedModels).size !== value.verifiedModels.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_MODEL" });
    if (Object.keys(value.rateCard).length > 20)
      context.addIssue({ code: "custom", message: "RATE_CARD_LIMIT" });
    // Escalation remains deliberately unavailable until its model is explicitly verified.
    // `route` enforces that runtime capability gate when an escalation is requested.
    if (
      value.verifiedModels.length &&
      [
        value.modelRoutes.fast,
        value.modelRoutes.standard,
        value.modelRoutes.quality,
      ].some((model) => !value.verifiedModels.includes(model))
    )
      context.addIssue({
        code: "custom",
        message: "ROUTED_MODEL_NOT_VERIFIED",
      });
    if (
      value.imageGeneration.maxCostMicrosPerImage > 0 &&
      !value.verifiedModels.includes(value.imageGeneration.model)
    )
      context.addIssue({ code: "custom", message: "IMAGE_MODEL_NOT_VERIFIED" });
  });

type StoredConfiguration = Omit<
  z.infer<typeof openAiConfigurationInput>,
  "apiKey" | "imageApiKey"
> & {
  encryptedApiKey?: string;
  encryptedImageApiKey?: string;
  updatedBy: string;
  updatedAt: string;
};

function stored(row: { data: unknown }) {
  const value = data(row);
  return {
    encryptedApiKey: z.string().optional().parse(value.encryptedApiKey),
    encryptedImageApiKey: z
      .string()
      .optional()
      .parse(value.encryptedImageApiKey),
    verifiedModels: z.array(z.string()).parse(value.verifiedModels),
    rateCard: rateCardSchema.parse(value.rateCard),
    modelRoutes: z
      .object({
        fast: z.string(),
        standard: z.string(),
        quality: z.string(),
        escalation: z.string(),
      })
      .parse(value.modelRoutes ?? modelRoutes),
    imageGeneration: imageGenerationConfigurationSchema.parse(
      value.imageGeneration ?? {},
    ),
    updatedBy: z.string().parse(value.updatedBy),
    updatedAt: z.iso.datetime().parse(value.updatedAt),
  } satisfies StoredConfiguration;
}

export function publicOpenAiConfiguration(
  row: { data: unknown; version?: number } | null,
  fallback = environmentRuntimeConfig(),
) {
  if (!row)
    return {
      configured: Boolean(fallback.apiKey || fallback.imageApiKey),
      source: fallback.apiKey || fallback.imageApiKey ? "environment" : "none",
      textKeyConfigured: Boolean(fallback.apiKey),
      imageKeyConfigured: Boolean(fallback.imageApiKey || fallback.apiKey),
      dedicatedImageKeyConfigured: Boolean(fallback.imageApiKey),
      verifiedModels: fallback.verifiedModels,
      rateCard: fallback.rateCard,
      modelRoutes,
      imageGeneration:
        fallback.imageGeneration ??
        imageGenerationConfigurationSchema.parse({}),
    };
  const value = stored(row);
  return {
    configured: true,
    source: "orbit",
    textKeyConfigured: Boolean(value.encryptedApiKey),
    imageKeyConfigured: Boolean(
      value.encryptedImageApiKey || value.encryptedApiKey,
    ),
    dedicatedImageKeyConfigured: Boolean(value.encryptedImageApiKey),
    verifiedModels: value.verifiedModels,
    rateCard: value.rateCard,
    modelRoutes: value.modelRoutes,
    imageGeneration: value.imageGeneration,
    updatedAt: value.updatedAt,
    version: row.version,
  };
}

export async function runtimeOpenAiConfiguration(
  tx: DbTx,
  scope: Scope,
): Promise<OpenAiRuntimeConfig> {
  const row = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
  });
  if (!row) return environmentRuntimeConfig();
  const value = stored(row);
  return {
    apiKey: value.encryptedApiKey
      ? decrypt(value.encryptedApiKey, loadConfig().CREDENTIAL_KEY)
      : undefined,
    imageApiKey: value.encryptedImageApiKey
      ? decrypt(value.encryptedImageApiKey, loadConfig().CREDENTIAL_KEY)
      : undefined,
    verifiedModels: value.verifiedModels,
    rateCard: value.rateCard,
    modelRoutes: value.modelRoutes,
    imageGeneration: value.imageGeneration,
  };
}

export async function saveOpenAiConfiguration(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = openAiConfigurationInput.parse(raw);
  const current = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
  });
  if (!current && !input.apiKey && !input.imageApiKey)
    throw new DomainError("OPENAI_API_KEY_REQUIRED");
  const currentValue = current ? stored(current) : null;
  const next = {
    encryptedApiKey: input.apiKey
      ? encrypt(input.apiKey, loadConfig().CREDENTIAL_KEY)
      : currentValue?.encryptedApiKey,
    encryptedImageApiKey: input.imageApiKey
      ? encrypt(input.imageApiKey, loadConfig().CREDENTIAL_KEY)
      : currentValue?.encryptedImageApiKey,
    verifiedModels: input.verifiedModels,
    rateCard: input.rateCard,
    modelRoutes: input.modelRoutes,
    imageGeneration: input.imageGeneration,
    updatedBy: scope.userId,
    updatedAt: new Date().toISOString(),
  };
  const row = current
    ? await update(tx, scope, current, next)
    : await create(tx, scope, "openai_configuration", next);
  return publicOpenAiConfiguration(row);
}
