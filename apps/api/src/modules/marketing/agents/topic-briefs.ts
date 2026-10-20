import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, entity, DomainError } from "../../../shared.ts";
import { reserveTopic } from "./novelty.ts";
/** Saves accepted holds in the same transaction as the strategy output and
 * successor queueing. Conflicts drop only the affected deliverable. */
export async function reserveStrategyBriefs(
  tx: DbTx,
  scope: Scope,
  task: { id: string; runId: string; assignmentId: string },
  raw: any,
) {
  if (!raw?.briefs) return raw;
  const run = data(await entity(tx, scope, "assignment_runs", task.runId));
  const assignment = data(
    await entity(tx, scope, "assignments", task.assignmentId),
  );
  const plan = assignment.marketingPlan
    ? data(
        await entity(
          tx,
          scope,
          "marketing_plans",
          assignment.marketingPlan.planId,
        ),
      ).spec
    : null;
  const briefs = [],
    dropped = [...(raw.dropped ?? [])],
    uncovered = [...(raw.uncovered ?? [])];
  for (const brief of raw.briefs) {
    const channels = run.sharedAcrossChannels
      ? (run.slots ?? [])
          .filter((s: any) => (s.groupAt ?? s.at) === brief.slotAt)
          .map((s: any) => s.channel)
      : [brief.channel];
    const unique = [
      ...new Set<string>(channels.length ? channels : [brief.channel]),
    ];
    const identity = {
      topic: String(brief.topic),
      angle: String(brief.angle),
      pillar:
        plan?.pillars.find((p: any) =>
          String(brief.topic).toLowerCase().includes(p.title.toLowerCase()),
        )?.title ?? "",
    };
    // A savepoint prevents a shared multi-channel conflict leaving partial holds.
    await tx.$executeRaw`SAVEPOINT reserve_brief`;
    try {
      const reservations = [];
      for (const channel of unique)
        reservations.push(
          (
            await reserveTopic(tx, scope, {
              channel,
              identity,
              ownerKey: `run:${task.runId}:${brief.channel}:${brief.slotAt}`,
              runId: task.runId,
            })
          ).id,
        );
      briefs.push({
        ...brief,
        novelty: identity,
        noveltyReservationIds: reservations,
      });
      await tx.$executeRaw`RELEASE SAVEPOINT reserve_brief`;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT reserve_brief`;
      await tx.$executeRaw`RELEASE SAVEPOINT reserve_brief`;
      if (
        !(error instanceof DomainError) ||
        !["TOPIC_ANGLE_RESERVED", "TOPIC_IDENTITY_EMPTY"].includes(error.code)
      )
        throw error;
      for (const channel of unique) {
        dropped.push({ channel, slotAt: brief.slotAt, code: error.code });
        uncovered.push({ channel, slotAt: brief.slotAt });
      }
    }
  }
  return { ...raw, briefs, dropped, uncovered };
}
