import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { environmentRuntimeConfig } from "../../../../../packages/ai/src/index.ts";
import { data } from "../shared.ts";
import {
  connectionsEnabled,
  grantedConnections,
  type GrantedConnection,
} from "../connections/central.ts";
import { aiDefaultsEnabled } from "./catalog.ts";
import { centralLayers, type CentralLayers } from "./central-ai.ts";
import {
  configurationRow,
  effectiveAiStatus,
  ownAiKeys,
  storedAiFields,
  type StoredAiFields,
} from "./openai-configuration.ts";

// One read of a project's AI layers side by side: its own saved fields,
// what its calls use now, the system's and organization's AI profiles and
// the granted keys. The MCP model view (ai_models_get) and the settings
// center both map it; neither reads a key, and this read returns none.

type AiProfileRow = Prisma.AiProfileGetPayload<object>;

export type RoutingMode = "unsaved" | "custom" | "preset" | "organization";

export type AiConfigurationState = {
  /** The project configuration's version; 0 without a row. */
  version: number;
  stored: StoredAiFields | null;
  ownKeys: { openai: boolean; image: boolean; anthropic: boolean };
  effective: Awaited<ReturnType<typeof effectiveAiStatus>>;
  profiles: { system: AiProfileRow | null; organization: AiProfileRow | null };
  layers: CentralLayers | null;
  grants: {
    openaiText?: GrantedConnection;
    openaiImage?: GrantedConnection;
    anthropic?: GrantedConnection;
  };
  global: { verified: Set<string>; rates: Record<string, unknown> };
  /** Status of the connections that serve the effective keys, by connection id. */
  keyConnections: Record<
    string,
    { status: string; disabled: boolean; scope: "system" | "workspace"; label: string }
  >;
  /** Whether the runtime applies a saved routing mode (ORBIT_AI_DEFAULTS). */
  routingApplied: boolean;
};

/** The system's and the organization's AI profile rows; none while central connections are off. */
async function profileRows(tx: DbTx, scope: Scope) {
  return connectionsEnabled()
    ? tx.aiProfile.findMany({
        where: { OR: [{ scope: "system" }, { workspaceId: scope.workspaceId }] },
      })
    : [];
}

function globalFrom(profiles: AiProfileRow[]) {
  const environment = environmentRuntimeConfig();
  const verified = new Set(environment.verifiedModels);
  const rates: Record<string, unknown> = { ...environment.rateCard };
  // The organization's profile wins over the system's, as at run time.
  for (const p of [
    ...profiles.filter((x) => x.scope === "system"),
    ...profiles.filter((x) => x.scope === "workspace"),
  ]) {
    const d = data(p);
    for (const m of d.verifiedModels ?? []) verified.add(m);
    Object.assign(rates, d.rateCard ?? {});
  }
  return { verified, rates };
}

/**
 * The models verified globally, with their global prices: the deployment's
 * configuration, then the system's and the organization's AI profile. A
 * project's own settings replace these in what it uses, so a project can
 * select from them again; prices still come from these sources only.
 */
export async function globalModels(
  tx: DbTx,
  scope: Scope,
): Promise<{ verified: Set<string>; rates: Record<string, unknown> }> {
  return globalFrom(await profileRows(tx, scope));
}

export async function aiConfigurationState(
  tx: DbTx,
  scope: Scope,
): Promise<AiConfigurationState> {
  const row = await configurationRow(tx, scope);
  const effective = await effectiveAiStatus(tx, scope);
  const profiles = await profileRows(tx, scope);
  const [text, image, anthropic] = await Promise.all([
    grantedConnections(tx, scope, { provider: "openai", purpose: "text" }),
    grantedConnections(tx, scope, { provider: "openai", purpose: "image" }),
    grantedConnections(tx, scope, { provider: "anthropic", purpose: "text" }),
  ]);
  const layers = await centralLayers(tx, scope);
  const ids = [
    ...new Set(
      Object.values(effective.keyConnections)
        .map((s) => s?.connectionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  // Readable here: the connection policy admits what the project is granted.
  const connections = ids.length
    ? await tx.connection.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, disabledAt: true, scope: true, label: true },
      })
    : [];
  return {
    version: row?.version ?? 0,
    stored: storedAiFields(row),
    ownKeys: ownAiKeys(row),
    effective,
    profiles: {
      system: profiles.find((p) => p.scope === "system") ?? null,
      organization: profiles.find((p) => p.scope === "workspace") ?? null,
    },
    layers,
    grants: {
      ...(text[0] ? { openaiText: text[0] } : {}),
      ...(image[0] ? { openaiImage: image[0] } : {}),
      ...(anthropic[0] ? { anthropic: anthropic[0] } : {}),
    },
    global: globalFrom(profiles),
    keyConnections: Object.fromEntries(
      connections.map((c) => [
        c.id,
        {
          status: c.status,
          disabled: c.disabledAt !== null,
          // AI providers allow system and organization connections only.
          scope: c.scope as "system" | "workspace",
          label: c.label,
        },
      ]),
    ),
    routingApplied: aiDefaultsEnabled(),
  };
}

/** The saved routing mode; `routingApplied` says whether the runtime uses it. */
export function routingModeOf(stored: StoredAiFields | null): RoutingMode {
  if (!stored) return "unsaved";
  return stored.routing?.source ?? "custom";
}

/** Where the project departs from the central configuration. */
export function projectAiExceptions(
  stored: StoredAiFields | null,
  ownKeys: AiConfigurationState["ownKeys"],
): {
  models: boolean;
  routes: boolean;
  prices: boolean;
  providerBudgets: boolean;
  keys: Array<"openai" | "image" | "anthropic">;
} {
  return {
    models: Boolean(stored && stored.verifiedModels.length > 0),
    routes:
      routingModeOf(stored) === "custom" ||
      Object.keys(stored?.routing?.overrides ?? {}).length > 0,
    prices: Boolean(stored && Object.keys(stored.rateCard).length > 0),
    providerBudgets: Boolean(
      stored && Object.values(stored.providerBudgets).some(Boolean),
    ),
    keys: (["openai", "image", "anthropic"] as const).filter((k) => ownKeys[k]),
  };
}
