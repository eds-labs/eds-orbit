/**
 * Schedule triggers (ADR 0021, plan §2.7, WP1.7): a platform scheduler
 * contribution. Slots are local times in the project's timezone (daylight
 * saving handled by zoned-time: a slot in a gap runs at the first valid
 * minute, an ambiguous one at its earlier instant). Each slot starts one
 * work order (`agent:<id>:slot:<iso>`); slots older than two hours are
 * skipped, never caught up.
 */
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { SchedulerContribution } from "../../jobs/types.ts";
import { entitlementsFor, entitled } from "../../entitlements/entitlements.ts";
import { DomainError } from "../../shared.ts";
import { localOf, resolveLocalTime } from "../../time/zoned-time.ts";
import { AGENT_DEFINITIONS, AgentDefinition, type Trigger } from "../definitions/schema.ts";
import { agentAutomationEnabled, agentPlatformEnabled, insertWorkOrder } from "../work-orders/service.ts";

/** How far back a missed slot is still started. */
export const SLOT_GRACE_MS = 2 * 3_600_000;
const DAY = 86_400_000;
const HORIZON_DAYS = 8;

type ScheduleTrigger = Extract<Trigger, { kind: "schedule" }>;

const instant = (local: string, timeZone: string) => {
  const r = resolveLocalTime(local, timeZone);
  return r.kind === "exact" ? r.at : r.kind === "gap" ? r.suggestedAt : r.earlier;
};

/** ISO weekday 1 (Monday) to 7 (Sunday) of a local date `YYYY-MM-DD`. */
const weekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** The trigger's slots in [from, to], ascending. */
export function slotsBetween(trigger: ScheduleTrigger, timeZone: string, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  if (trigger.rhythm === "interval") {
    const step = trigger.everyMinutes! * 60_000;
    for (let at = Math.ceil(from.getTime() / step) * step; at <= to.getTime(); at += step)
      out.push(new Date(at));
    return out;
  }
  const first = Date.parse(`${localOf(from, timeZone).slice(0, 10)}T00:00:00Z`) - DAY;
  const last = Date.parse(`${localOf(to, timeZone).slice(0, 10)}T00:00:00Z`) + DAY;
  for (let day = first; day <= last; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (trigger.rhythm === "weekly" && !trigger.days?.includes(weekday(date))) continue;
    for (const time of trigger.times) {
      const at = instant(`${date}T${time}`, timeZone);
      if (at >= from && at <= to) out.push(at);
    }
  }
  return [...new Map(out.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
}

async function scheduledAgents(tx: DbTx, scope: Scope) {
  const rows = await tx.entity.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: AGENT_DEFINITIONS },
  });
  const out: Array<{ id: string; triggers: ScheduleTrigger[] }> = [];
  for (const row of rows) {
    const parsed = AgentDefinition.safeParse(row.data);
    if (!parsed.success || parsed.data.status !== "active" || !parsed.data.active) continue;
    const triggers = parsed.data.active.triggers.filter((t): t is ScheduleTrigger => t.kind === "schedule");
    if (triggers.length) out.push({ id: row.id, triggers });
  }
  return out;
}

async function automationAllowed(scope: Scope) {
  if (!agentPlatformEnabled() || !agentAutomationEnabled()) return false;
  const entitlements = await entitlementsFor(scope.workspaceId);
  return entitled(entitlements, "agentsAutomation") && entitled(entitlements, { triggerKind: "schedule" });
}

async function timeZoneOf(tx: DbTx, scope: Scope) {
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { timezone: true } });
  return project?.timezone ?? "UTC";
}

export const agentScheduleScheduler: SchedulerContribution = {
  async sweep(tx, scope, at) {
    if (!(await automationAllowed(scope))) return { queued: 0 };
    const timeZone = await timeZoneOf(tx, scope);
    let queued = 0;
    for (const agent of await scheduledAgents(tx, scope))
      for (const trigger of agent.triggers)
        for (const slot of slotsBetween(trigger, timeZone, new Date(at.getTime() - SLOT_GRACE_MS), at)) {
          try {
            const { created } = await insertWorkOrder(
              tx,
              scope,
              {
                agentId: agent.id,
                origin: "schedule",
                originRef: slot.toISOString(),
                idempotencyKey: `agent:${agent.id}:slot:${slot.toISOString()}`,
                requestedBy: { kind: "schedule" },
              },
              at,
            );
            if (created) queued++;
          } catch (error) {
            // A full day or a paused agent skips the slot; anything else is a fault.
            if (!(error instanceof DomainError) || !["AGENT_RUN_LIMIT", "AGENT_NOT_ACTIVE"].includes(error.code))
              throw error;
          }
        }
    return { queued };
  },
  async nextDueAt(tx, scope, at) {
    if (!(await automationAllowed(scope))) return null;
    const timeZone = await timeZoneOf(tx, scope);
    let next: Date | null = null;
    const to = new Date(at.getTime() + HORIZON_DAYS * DAY);
    for (const agent of await scheduledAgents(tx, scope))
      for (const trigger of agent.triggers) {
        const slot = slotsBetween(trigger, timeZone, new Date(at.getTime() + 1), to)[0];
        if (slot && (!next || slot < next)) next = slot;
      }
    return next;
  },
};

/** Two schedulers as one: both sweep, the earlier due time wins. */
export function combineSchedulers(...all: SchedulerContribution[]): SchedulerContribution {
  return {
    async sweep(tx, scope, at) {
      let queued = 0;
      for (const s of all) queued += (await s.sweep(tx, scope, at)).queued;
      return { queued };
    },
    async nextDueAt(tx, scope, at) {
      let next: Date | null = null;
      for (const s of all) {
        const due = await s.nextDueAt(tx, scope, at);
        if (due && (!next || due < next)) next = due;
      }
      return next;
    },
  };
}
