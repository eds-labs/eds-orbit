import { z } from "zod";
import { authDb, type Prisma } from "../../../../../packages/db/src/index.ts";
import { priceCatalog } from "../../../../../packages/ai/src/index.ts";
import { DomainError } from "../shared.ts";
import { mergeCatalog } from "../ai/catalog.ts";
import { systemAudit } from "./audit.ts";

// "Modelle & Preise" of the system (administrators) and of an organization
// (its owners), plans/ai-central-management.md phase A: Orbit's catalog
// with each model's override. A price is entered in a form, never as JSON;
// saving one dates it now. Resetting deletes the override.

type Target = { scope: "system" } | { scope: "workspace"; workspaceId: string };

const where = (t: Target) =>
  t.scope === "system"
    ? { scope: "system", workspaceId: null }
    : { scope: "workspace", workspaceId: t.workspaceId };

const micros = z.number().int().min(0).max(1_000_000_000);
export const modelPriceInput = z
  .object({
    active: z.boolean().optional(),
    inputMicrosPerMillion: micros.optional(),
    outputMicrosPerMillion: micros.optional(),
    cachedInputMicrosPerMillion: micros.optional(),
    perImageMicros: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

/** The catalog as the target sees it: the system's view, or the organization's. */
export async function listModelPrices(target: Target) {
  const rows = await authDb.aiModelPrice.findMany({
    where:
      target.scope === "system"
        ? { scope: "system" }
        : { OR: [{ scope: "system" }, { scope: "workspace", workspaceId: target.workspaceId }] },
  });
  const own = new Set(
    rows.filter((r) => r.scope === target.scope).map((r) => r.modelId),
  );
  return {
    scope: target.scope,
    models: mergeCatalog(rows).map((m) => ({ ...m, overridden: own.has(m.id) })),
  };
}

/** Saves the target's override of one catalog model and audits it. */
export async function setModelPrice(
  actorId: string,
  target: Target,
  modelId: string,
  raw: unknown,
) {
  const entry = priceCatalog[modelId];
  if (!entry) throw new DomainError("MODEL_NOT_IN_CATALOG", 404);
  const input = modelPriceInput.parse(raw);
  const priceGiven =
    input.inputMicrosPerMillion !== undefined ||
    input.outputMicrosPerMillion !== undefined ||
    input.cachedInputMicrosPerMillion !== undefined;
  if (priceGiven && !entry.rate) throw new DomainError("MODEL_HAS_NO_TOKEN_PRICE", 400);
  if (input.perImageMicros !== undefined && entry.purpose !== "image")
    throw new DomainError("MODEL_HAS_NO_IMAGE_PRICE", 400);
  return authDb.$transaction(async (tx) => {
    const current = await tx.aiModelPrice.findFirst({
      where: { ...where(target), modelId },
    });
    const base = (current?.rate as Record<string, number> | null) ?? entry.rate ?? {};
    const rate = priceGiven
      ? {
          ...base,
          ...(input.inputMicrosPerMillion !== undefined
            ? { inputMicrosPerMillion: input.inputMicrosPerMillion }
            : {}),
          ...(input.outputMicrosPerMillion !== undefined
            ? { outputMicrosPerMillion: input.outputMicrosPerMillion }
            : {}),
          ...(input.cachedInputMicrosPerMillion !== undefined
            ? { cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion }
            : {}),
        }
      : undefined;
    const now = new Date();
    const data = {
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(rate ? { rate: rate as Prisma.InputJsonValue } : {}),
      ...(input.perImageMicros !== undefined ? { perImageMicros: input.perImageMicros } : {}),
      // A price entered now is dated now (D-3).
      ...(priceGiven || input.perImageMicros !== undefined ? { verifiedAt: now } : {}),
      updatedBy: actorId,
      updatedAt: now,
    };
    const saved = current
      ? await tx.aiModelPrice.update({
          where: { id: current.id },
          data: { ...data, version: { increment: 1 } },
        })
      : await tx.aiModelPrice.create({
          data: { ...where(target), modelId, ...data },
        });
    await systemAudit(
      {
        actorId,
        action: "ai_model_price.updated",
        targetType: "ai_model_price",
        targetId: saved.id,
        workspaceId: saved.workspaceId,
        metadata: {
          scope: target.scope,
          modelId,
          version: saved.version,
          fields: Object.keys(input),
        },
      },
      tx,
    );
    return { modelId, version: saved.version };
  });
}

/** Removes the target's override; the model falls back to the catalog. */
export async function resetModelPrice(actorId: string, target: Target, modelId: string) {
  if (!priceCatalog[modelId]) throw new DomainError("MODEL_NOT_IN_CATALOG", 404);
  return authDb.$transaction(async (tx) => {
    const current = await tx.aiModelPrice.findFirst({
      where: { ...where(target), modelId },
    });
    if (!current) return { modelId, reset: false };
    await tx.aiModelPrice.delete({ where: { id: current.id } });
    await systemAudit(
      {
        actorId,
        action: "ai_model_price.reset",
        targetType: "ai_model_price",
        targetId: current.id,
        workspaceId: current.workspaceId,
        metadata: { scope: target.scope, modelId },
      },
      tx,
    );
    return { modelId, reset: true };
  });
}
