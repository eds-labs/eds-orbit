import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  environmentRuntimeConfig,
  rateCardSchema,
  type OpenAiRuntimeConfig,
} from "../../../../packages/ai/src/index.ts";
import { loadConfig, modelRoutes } from "../../../../packages/config/src/index.ts";
import { create, data, decrypt, encrypt, update, DomainError } from "../shared.ts";

const key = z.string().trim().min(20).max(1000);
export const openAiConfigurationInput = z
  .object({
    apiKey: key.optional(),
    verifiedModels: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
    rateCard: rateCardSchema,
    modelRoutes: z.object({
      fast: z.string().trim().min(1).max(120),
      standard: z.string().trim().min(1).max(120),
      quality: z.string().trim().min(1).max(120),
      escalation: z.string().trim().min(1).max(120),
    }).strict().default(modelRoutes),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.verifiedModels).size !== value.verifiedModels.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_MODEL" });
    if (!Object.keys(value.rateCard).length)
      context.addIssue({ code: "custom", message: "RATE_CARD_REQUIRED" });
    if (Object.keys(value.rateCard).length > 20)
      context.addIssue({ code: "custom", message: "RATE_CARD_LIMIT" });
    // Escalation remains deliberately unavailable until its model is explicitly verified.
    // `route` enforces that runtime capability gate when an escalation is requested.
    if ([value.modelRoutes.fast, value.modelRoutes.standard, value.modelRoutes.quality].some((model) => !value.verifiedModels.includes(model)))
      context.addIssue({ code: "custom", message: "ROUTED_MODEL_NOT_VERIFIED" });
  });

type StoredConfiguration = z.infer<typeof openAiConfigurationInput> & {
  encryptedApiKey: string;
  updatedBy: string;
  updatedAt: string;
};

function stored(row: { data: unknown }) {
  const value = data(row);
  return {
    encryptedApiKey: z.string().parse(value.encryptedApiKey),
    verifiedModels: z.array(z.string()).parse(value.verifiedModels),
    rateCard: rateCardSchema.parse(value.rateCard),
    modelRoutes: z.object({ fast: z.string(), standard: z.string(), quality: z.string(), escalation: z.string() }).parse(value.modelRoutes ?? modelRoutes),
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
      configured: Boolean(fallback.apiKey),
      source: fallback.apiKey ? "environment" : "none",
      verifiedModels: fallback.verifiedModels,
      rateCard: fallback.rateCard,
      modelRoutes,
    };
  const value = stored(row);
  return {
    configured: true,
    source: "orbit",
    verifiedModels: value.verifiedModels,
    rateCard: value.rateCard,
    modelRoutes: value.modelRoutes,
    updatedAt: value.updatedAt,
    version: row.version,
  };
}

export async function runtimeOpenAiConfiguration(
  tx: DbTx,
  scope: Scope,
): Promise<OpenAiRuntimeConfig> {
  const row = await tx.entity.findFirst({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: "openai_configuration" },
  });
  if (!row) return environmentRuntimeConfig();
  const value = stored(row);
  return {
    apiKey: decrypt(value.encryptedApiKey, loadConfig().CREDENTIAL_KEY),
    verifiedModels: value.verifiedModels,
    rateCard: value.rateCard,
    modelRoutes: value.modelRoutes,
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
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: "openai_configuration" },
  });
  if (!current && !input.apiKey)
    throw new DomainError("OPENAI_API_KEY_REQUIRED");
  const next = {
    encryptedApiKey: input.apiKey
      ? encrypt(input.apiKey, loadConfig().CREDENTIAL_KEY)
      : stored(current!).encryptedApiKey,
    verifiedModels: input.verifiedModels,
    rateCard: input.rateCard,
    updatedBy: scope.userId,
    updatedAt: new Date().toISOString(),
  };
  const row = current
    ? await update(tx, scope, current, next)
    : await create(tx, scope, "openai_configuration", next);
  return publicOpenAiConfiguration(row);
}
