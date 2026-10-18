import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { enabledModules } from "../modules/enforcement.ts";
import {
  ownerEnabled,
  registeredAttention,
  registeredAttentionStatus,
} from "../modules/contributions.ts";
import { hiddenModules, moduleScope } from "../tenancy/module-roles.ts";
import { runtimeHealth } from "../../modules/runtime.ts";
import {
  aiMonthStatus,
  platformAttention,
  reservationMonth,
} from "./platform-items.ts";
import type {
  AttentionItem,
  AttentionResponse,
  AttentionSeverity,
  AttentionStatus,
} from "./types.ts";

// The project's attention items (UI restructure §4.1): read-only, no audit
// row, nothing logged beyond what the route logs on a failure.

/** At most this many items in a response; `counts` covers all of them. */
export const ATTENTION_LIMIT = 50;

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Ascending ISO times, missing ones last. */
function byTime(a: string | undefined, b: string | undefined) {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return Date.parse(a) - Date.parse(b);
}

/**
 * Most urgent first: severity (critical, warning, info), then `dueAt`
 * ascending with undated items last, then `since` ascending, then `id`.
 */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      byTime(a.dueAt, b.dueAt) ||
      byTime(a.since, b.since) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * A module's attention contribution threw. The route answers 500 and logs
 * the module id: a broken contribution is a defect to see and fix, so its
 * items are never silently left out (the member would miss what is due).
 */
export class AttentionContributionError extends Error {
  constructor(
    readonly moduleId: string,
    cause: unknown,
  ) {
    super("ATTENTION_CONTRIBUTION_FAILED", { cause });
    this.name = "AttentionContributionError";
  }
}

/** Runs a module's contribution, failing the read with its module id. */
async function contributed<T>(moduleId: string, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    throw new AttentionContributionError(moduleId, error);
  }
}

/**
 * What needs the member's attention in the project: every enabled module the
 * member may use, each read with the member's role in that module, plus the
 * platform's items, all in one project transaction. Sorted and capped at
 * ATTENTION_LIMIT; `counts` per nav entry sum `count ?? 1` over all items
 * before the cap. `status` adds the modules' parts (the marketing mode) and
 * the AI month.
 */
export async function projectAttention(
  scope: Scope,
  now = new Date(),
): Promise<AttentionResponse> {
  // Redis before the transaction: a slow heartbeat read holds no connection.
  const worker = await runtimeHealth();
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: scope.projectId },
      select: { paused: true },
    });
    if (!project) throw new DomainError("NOT_FOUND", 404);
    const enabled = await enabledModules(tx, scope);
    const hidden = hiddenModules(scope);
    const usable = (moduleId: string) =>
      ownerEnabled(moduleId, enabled) && !hidden.includes(moduleId);
    const items: AttentionItem[] = [];
    const status: AttentionStatus = { paused: project.paused };
    for (const [moduleId, contribution] of registeredAttention()) {
      if (!usable(moduleId)) continue;
      items.push(
        ...(await contributed(moduleId, () =>
          contribution(tx, moduleScope(scope, moduleId), now),
        )),
      );
    }
    for (const [moduleId, contribution] of registeredAttentionStatus()) {
      if (!usable(moduleId)) continue;
      const part = await contributed(moduleId, () =>
        contribution(tx, moduleScope(scope, moduleId), now),
      );
      if (part.mode !== undefined) status.mode = part.mode;
    }
    const month = await reservationMonth(tx, scope, now);
    items.push(...(await platformAttention(tx, scope, now, { worker, month })));
    status.aiMonth = await aiMonthStatus(tx, scope, month);
    // An aggregated item ("2 unassigned tickets") adds its count (R17).
    const counts: Record<string, number> = {};
    for (const item of items)
      counts[item.navKey] = (counts[item.navKey] ?? 0) + (item.count ?? 1);
    return {
      items: sortAttention(items).slice(0, ATTENTION_LIMIT),
      counts,
      status,
    };
  });
}
