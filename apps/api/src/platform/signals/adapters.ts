import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import {
  ownerEnabled,
  registeredSignals,
  signalRuntime,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { proactiveEnabled } from "../proactive/preferences.ts";
import { deliverFindings } from "./deliver.ts";
import type { SignalEvery } from "./types.ts";

// The two adapters of the signal registry (ADR 0023 item 1, plan §7).
//
// Events: every event signal runs as a derived domain-event subscriber
// (`<owner>.signal_<name>`, one idempotent job per event, registered by the
// module registry). While ORBIT_PROACTIVE is off no such job is queued.
//
// Periodic: one platform PeriodicTask on the existing per-project pass runs
// the periodic detectors of the project's enabled modules at their
// granularity (hourly by default, T4-2). There is no new loop; a restarted
// worker may run a detector early, which the dedupe keys absorb.

signalRuntime.enabled = proactiveEnabled;
signalRuntime.runEvent = async (def, tx, scope, event) => {
  if (!proactiveEnabled() || !def.detect) return;
  const findings = await def.detect(tx, scope, { event });
  await deliverFindings(tx, scope, def, findings);
};

const EVERY_MS: Record<SignalEvery, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};
const lastRun = new Map<string, number>();
/** Tests only: forget when each detector last ran. */
export function resetSignalThrottle() {
  lastRun.clear();
}

const periodicSignals = () =>
  registeredSignals().filter((s) => "periodic" in s.source && s.detect);

function nextAt(projectId: string, now: number) {
  let next: number | null = null;
  for (const s of periodicSignals()) {
    const every = EVERY_MS[(s.source as { periodic: { every: SignalEvery } }).periodic.every];
    const due = (lastRun.get(`${projectId}:${s.key}`) ?? 0) + every;
    const at = Math.max(due, now);
    if (next === null || at < next) next = at;
  }
  return next;
}

export const signalsPeriodic: PeriodicTask = {
  name: "signals-periodic",
  async nextDueAt(tx, scope) {
    if (!proactiveEnabled()) return null;
    const project = await tx.project.findFirst({
      where: { id: scope.projectId },
      select: { kind: true },
    });
    if (!project || project.kind === "personal") return null;
    const next = nextAt(scope.projectId, Date.now());
    return next === null ? null : new Date(next);
  },
  async run(scope) {
    if (!proactiveEnabled()) return;
    const project = await authDb.project.findFirst({
      where: { id: scope.projectId },
      select: { kind: true },
    });
    if (!project || project.kind === "personal") return;
    const now = new Date();
    let delivered = 0;
    for (const def of periodicSignals()) {
      const key = `${scope.projectId}:${def.key}`;
      const every = EVERY_MS[(def.source as { periodic: { every: SignalEvery } }).periodic.every];
      if (now.getTime() < (lastRun.get(key) ?? 0) + every) continue;
      lastRun.set(key, now.getTime());
      delivered += await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        if (!ownerEnabled(def.owner, await enabledModules(tx, scope))) return 0;
        const findings = await def.detect!(tx, scope, { at: now });
        return deliverFindings(tx, scope, def, findings);
      });
    }
    const next = nextAt(scope.projectId, now.getTime());
    return {
      status: delivered ? `delivered ${delivered}` : "idle",
      ...(next ? { wakeAt: new Date(next) } : {}),
    };
  },
};
