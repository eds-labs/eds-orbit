import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  fallbackConfigurationSchema,
  imageGenerationConfigurationSchema,
  type OpenAiRuntimeConfig,
} from "../../../../../packages/ai/src/index.ts";
import { rateCardSchema } from "../../../../../packages/ai/src/cost.ts";
import {
  providerTierRoutesSchema,
  taskRoutesSchema,
} from "../../../../../packages/ai/src/routing.ts";
import {
  modelRegistrySchema,
  providerIdSchema,
  providerOfModel,
} from "../../../../../packages/ai/src/provider.ts";
import { DomainError } from "../shared.ts";
import {
  connectionSecret,
  connectionsEnabled,
  grantedConnections,
  type GrantedConnection,
} from "../connections/central.ts";

// Central AI infrastructure (ADR 0014): AI profiles for the system and an
// organization, and provider keys from granted connections. A project's own
// openai_configuration still overrides everything it sets, so a project
// that configured itself behaves exactly as before. Off
// (ORBIT_CONNECTIONS=false) nothing here applies.

const model = z.string().trim().min(1).max(120);
/** The non-secret fields of an AI profile; keys live in connections. */
export const aiProfileInput = z
  .object({
    verifiedModels: z.array(model).max(40).optional(),
    rateCard: rateCardSchema.optional(),
    modelRoutes: z
      .object({
        fast: model,
        standard: model,
        quality: model,
        escalation: model,
      })
      .strict()
      .optional(),
    anthropicTierRoutes: providerTierRoutesSchema.optional(),
    taskRoutes: taskRoutesSchema.optional(),
    models: modelRegistrySchema.optional(),
    defaultProvider: providerIdSchema.optional(),
    fallback: fallbackConfigurationSchema.optional(),
    imageGeneration: imageGenerationConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const verified = value.verifiedModels;
    if (verified && new Set(verified).size !== verified.length)
      context.addIssue({ code: "custom", message: "DUPLICATE_MODEL" });
    if (value.rateCard && Object.keys(value.rateCard).length > 40)
      context.addIssue({ code: "custom", message: "RATE_CARD_LIMIT" });
    const routed = value.modelRoutes
      ? [value.modelRoutes.fast, value.modelRoutes.standard, value.modelRoutes.quality]
      : [];
    if (verified && routed.some((m) => !verified.includes(m)))
      context.addIssue({ code: "custom", message: "ROUTED_MODEL_NOT_VERIFIED" });
  });
export type AiProfileData = z.infer<typeof aiProfileInput>;

/**
 * Which provider key a call uses: "image" for image models, otherwise
 * "text" (embeddings use the text key, as they always have).
 */
export function purposeOfModel(model: string) {
  return /^(gpt-image|dall-e)/i.test(model) ? "image" : "text";
}

type Layer = {
  profiles: { system?: AiProfileData; workspace?: AiProfileData };
  versions: string;
  keys: Partial<
    Record<"openai" | "image" | "anthropic", GrantedConnection>
  >;
};

/** The central profiles and granted provider connections of a project. */
async function layer(tx: DbTx, scope: Scope): Promise<Layer | null> {
  if (!connectionsEnabled()) return null;
  const profiles = await tx.aiProfile.findMany({
    where: {
      OR: [{ scope: "system" }, { workspaceId: scope.workspaceId }],
    },
  });
  const system = profiles.find((p) => p.scope === "system");
  const workspace = profiles.find((p) => p.scope === "workspace");
  const [text, image, anthropic] = await Promise.all([
    grantedConnections(tx, scope, { provider: "openai", purpose: "text" }),
    grantedConnections(tx, scope, { provider: "openai", purpose: "image" }),
    grantedConnections(tx, scope, { provider: "anthropic", purpose: "text" }),
  ]);
  const keys: Layer["keys"] = {
    ...(text[0] ? { openai: text[0] } : {}),
    ...(image[0] ? { image: image[0] } : {}),
    ...(anthropic[0] ? { anthropic: anthropic[0] } : {}),
  };
  if (!system && !workspace && !Object.keys(keys).length) return null;
  return {
    profiles: {
      ...(system ? { system: system.data as AiProfileData } : {}),
      ...(workspace ? { workspace: workspace.data as AiProfileData } : {}),
    },
    versions: [
      `s${system?.version ?? 0}`,
      `w${workspace?.version ?? 0}`,
      ...Object.entries(keys)
        .map(([k, g]) => `${k}:${g!.grant.id}:${g!.connection.id}`)
        .sort(),
    ].join("|"),
    keys,
  };
}

/** A positive 31-bit number for a version string (route versions are ints). */
function versionNumber(projectVersion: number | null, versions: string) {
  const digest = createHash("sha256")
    .update(`p${projectVersion ?? 0}|${versions}`)
    .digest();
  return (digest.readUInt32BE(0) & 0x7fffffff) || 1;
}

/**
 * The route version when central settings take part; the project version
 * otherwise. Any change to a profile or to a granted key changes it, so
 * in-flight runs stop before their next paid call as with a project save.
 */
export async function centralRouteVersion(
  tx: DbTx,
  scope: Scope,
  projectVersion: number | null,
) {
  const l = await layer(tx, scope);
  return l ? versionNumber(projectVersion, l.versions) : projectVersion;
}

/**
 * Applies the central layer under a project's runtime configuration:
 * project fields first, then the organization profile, the system profile
 * and the environment. `project` carries only the keys the project saved
 * itself. Keys: the project's own, else a granted connection, else the
 * environment rule of before (OpenAI only without a project row,
 * Anthropic always).
 */
export async function withCentralAi(
  tx: DbTx,
  scope: Scope,
  project: OpenAiRuntimeConfig | null,
  environment: OpenAiRuntimeConfig,
  projectVersion: number | null,
): Promise<OpenAiRuntimeConfig | null> {
  const l = await layer(tx, scope);
  if (!l) return null;
  const { apiKey: _a, imageApiKey: _i, anthropicApiKey: _c, ...envFields } =
    environment;
  const base = {
    ...envFields,
    ...stripUndefined(l.profiles.system ?? {}),
    ...stripUndefined(l.profiles.workspace ?? {}),
  } as OpenAiRuntimeConfig;
  const merged: OpenAiRuntimeConfig = project
    ? { ...base, ...stripUndefined(project) }
    : base;
  const sources: NonNullable<OpenAiRuntimeConfig["keySources"]> = {};
  const key = async (
    own: string | undefined,
    granted: GrantedConnection | undefined,
    fallback: string | undefined,
    source: keyof typeof sources,
  ) => {
    if (own) return own;
    if (granted) {
      const secret = await connectionSecret(tx, granted.connection.id);
      if (secret) {
        sources[source] = {
          connectionId: granted.connection.id,
          grantId: granted.grant.id,
        };
        return secret;
      }
    }
    return fallback;
  };
  merged.apiKey = await key(
    project?.apiKey,
    l.keys.openai,
    project ? undefined : environment.apiKey,
    "openai",
  );
  merged.imageApiKey = await key(
    project?.imageApiKey,
    l.keys.image,
    project ? undefined : environment.imageApiKey,
    "image",
  );
  merged.anthropicApiKey = await key(
    project?.anthropicApiKey,
    l.keys.anthropic,
    environment.anthropicApiKey,
    "anthropic",
  );
  merged.keySources = sources;
  merged.routeVersion = versionNumber(projectVersion, l.versions);
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * The grant a paid call of `model` is charged to, when its key comes from
 * a granted connection: the project has no own key for that provider.
 */
export async function chargedGrant(
  tx: DbTx,
  scope: Scope,
  model: string,
  registry?: Prisma.JsonValue,
): Promise<GrantedConnection | null> {
  if (!connectionsEnabled()) return null;
  const provider = providerOfModel(
    model,
    registry as Parameters<typeof providerOfModel>[1],
  );
  const purpose = provider === "anthropic" ? "text" : purposeOfModel(model);
  const own = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "openai_configuration",
    },
    select: { data: true },
  });
  const stored = (own?.data ?? {}) as Record<string, unknown>;
  const hasOwn =
    provider === "anthropic"
      ? Boolean(stored.encryptedAnthropicApiKey)
      : purpose === "image"
        ? Boolean(stored.encryptedImageApiKey || stored.encryptedApiKey)
        : Boolean(stored.encryptedApiKey);
  if (hasOwn) return null;
  const [granted] = await grantedConnections(tx, scope, { provider, purpose });
  return granted ?? null;
}

const counterKeys = (g: GrantedConnection) => [
  { key: `grant:${g.grant.id}`, workspaceId: true, limit: g.grant.monthlyBudgetMicros, code: "GRANT_BUDGET_EXCEEDED" },
  ...(g.parent
    ? [{ key: `grant:${g.parent.id}`, workspaceId: true, limit: g.parent.monthlyBudgetMicros, code: "ORGANIZATION_BUDGET_EXCEEDED" }]
    : []),
  { key: `connection:${g.connection.id}`, workspaceId: false, limit: g.connection.monthlyBudgetMicros, code: "CONNECTION_BUDGET_EXCEEDED" },
];

/**
 * Checks and adds a reservation to the grant, organization and connection
 * counters of the month, locking them in a fixed order so concurrent
 * reservations of several projects cannot pass a shared budget together.
 */
export async function reserveOnGrant(
  tx: DbTx,
  scope: Scope,
  granted: GrantedConnection,
  amount: number,
  month: Date,
) {
  for (const c of counterKeys(granted)) {
    const workspaceId = c.workspaceId ? scope.workspaceId : null;
    await tx.$executeRaw`INSERT INTO "SpendCounter" ("scopeKey","periodStart","connectionId","workspaceId")
      VALUES (${c.key}, ${month}, ${granted.connection.id}::uuid, ${workspaceId}::uuid)
      ON CONFLICT ("scopeKey","periodStart") DO NOTHING`;
    const [row] = await tx.$queryRaw<
      { reservedMicros: bigint; settledMicros: bigint }[]
    >`SELECT "reservedMicros","settledMicros" FROM "SpendCounter"
      WHERE "scopeKey" = ${c.key} AND "periodStart" = ${month} FOR UPDATE`;
    if (!row) throw new DomainError("SPEND_COUNTER_UNAVAILABLE", 409);
    if (
      c.limit !== null &&
      row.reservedMicros + row.settledMicros + BigInt(amount) > c.limit
    )
      throw new DomainError(c.code, 409);
  }
  for (const c of counterKeys(granted))
    await tx.$executeRaw`UPDATE "SpendCounter" SET "reservedMicros" = "reservedMicros" + ${BigInt(amount)}
      WHERE "scopeKey" = ${c.key} AND "periodStart" = ${month}`;
}

/**
 * Moves a settled (or written-off) reservation from reserved to settled on
 * its counters. An unknown outcome stays reserved, as everywhere else.
 */
export async function settleOnGrant(
  tx: DbTx,
  row: {
    grantId: string | null;
    parentGrantId: string | null;
    connectionId: string | null;
    amountMicros: bigint;
    createdAt: Date;
  },
  actual: bigint,
) {
  if (!row.grantId || !row.connectionId) return;
  const month = new Date(
    Date.UTC(row.createdAt.getUTCFullYear(), row.createdAt.getUTCMonth(), 1),
  );
  // The grants may be revoked by now; the reservation names them.
  const keys = [
    `grant:${row.grantId}`,
    ...(row.parentGrantId ? [`grant:${row.parentGrantId}`] : []),
    `connection:${row.connectionId}`,
  ];
  for (const key of keys)
    await tx.$executeRaw`UPDATE "SpendCounter"
      SET "reservedMicros" = GREATEST("reservedMicros" - ${row.amountMicros}, 0),
          "settledMicros" = "settledMicros" + ${actual}
      WHERE "scopeKey" = ${key} AND "periodStart" = ${month}`;
}
