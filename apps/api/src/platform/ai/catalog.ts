import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  priceCatalog,
  priceNeedsReview,
  rateSchema,
  type CatalogEntry,
  type OpenAiRuntimeConfig,
  type Rate,
} from "../../../../../packages/ai/src/index.ts";

// The central AI price catalog (plans/ai-central-management.md, phase A):
// Orbit's dated catalog in code, overridden per model by the system's and
// then the organization's `AiModelPrice` rows. With ORBIT_AI_CATALOG on, a
// project's runtime prices and verifies every active catalog model; the
// project's own rate card and verified list still win and stay as they are.

export const aiCatalogEnabled = () => process.env.ORBIT_AI_CATALOG === "true";
/**
 * Organization standard models and project presets (phase B). They choose
 * models from the catalog, so they apply only while the catalog is on too.
 */
export const aiDefaultsEnabled = () =>
  process.env.ORBIT_AI_DEFAULTS === "true" && aiCatalogEnabled();

type Override = {
  scope: string;
  modelId: string;
  active: boolean;
  rate: unknown;
  perImageMicros: number | null;
  verifiedAt: Date | null;
};

export type CatalogModel = CatalogEntry & {
  id: string;
  active: boolean;
  /** Where the price comes from: Orbit's catalog, the system or the organization. */
  priceSource: "orbit" | "system" | "organization";
  needsReview: boolean;
};

const overrideRate = (value: unknown): Omit<Rate, "verifiedAt"> | undefined => {
  const parsed = rateSchema
    .omit({ verifiedAt: true })
    .safeParse(value ?? undefined);
  return parsed.success ? parsed.data : undefined;
};

/**
 * The catalog with the given overrides applied, system rows before the
 * organization's: one entry per catalog model.
 */
export function mergeCatalog(overrides: Override[], now = Date.now()): CatalogModel[] {
  return Object.entries(priceCatalog).map(([id, entry]) => {
    let model: CatalogModel = {
      ...entry,
      id,
      active: true,
      priceSource: "orbit",
      needsReview: false,
    };
    for (const scope of ["system", "workspace"] as const) {
      const row = overrides.find((o) => o.scope === scope && o.modelId === id);
      if (!row) continue;
      const rate = overrideRate(row.rate);
      const priced = Boolean(rate) || row.perImageMicros !== null;
      model = {
        ...model,
        active: row.active,
        ...(rate ? { rate } : {}),
        ...(row.perImageMicros !== null ? { perImageMicros: row.perImageMicros } : {}),
        ...(priced && row.verifiedAt
          ? {
              verifiedAt: row.verifiedAt.toISOString(),
              priceSource: scope === "system" ? "system" : "organization",
            }
          : {}),
      };
    }
    return { ...model, needsReview: priceNeedsReview(model.verifiedAt, now) };
  });
}

/** The project's catalog: overrides of the system and its organization (RLS). */
export async function projectCatalog(tx: DbTx, scope: Scope) {
  const rows = await tx.aiModelPrice.findMany({
    where: {
      OR: [{ scope: "system" }, { scope: "workspace", workspaceId: scope.workspaceId }],
    },
  });
  return mergeCatalog(rows);
}

/**
 * The runtime with the catalog applied: every active text or embedding
 * model is verified and priced from the catalog unless the project's (or
 * its profiles') own configuration names it; active image models are
 * verified, and their booked amount is offered to the image settings.
 */
export function withCatalog(
  runtime: OpenAiRuntimeConfig,
  catalog: CatalogModel[],
): OpenAiRuntimeConfig {
  const active = catalog.filter((m) => m.active);
  const rates: Record<string, Rate> = {};
  for (const m of active)
    if (m.rate) rates[m.id] = { ...m.rate, verifiedAt: m.verifiedAt };
  const verified = new Set([...(runtime.verifiedModels ?? []), ...active.map((m) => m.id)]);
  return {
    ...runtime,
    verifiedModels: [...verified],
    rateCard: { ...rates, ...(runtime.rateCard ?? {}) },
  };
}

/** The booked amount per image of an active catalog image model, or null. */
export function catalogImagePrice(catalog: CatalogModel[], model: string) {
  const entry = catalog.find((m) => m.id === model && m.active);
  return entry?.perImageMicros
    ? { perImageMicros: entry.perImageMicros, verifiedAt: entry.verifiedAt }
    : null;
}
