import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  create,
  update,
  entity,
  list,
  data,
  audit,
  exception,
  DomainError,
} from "../shared.ts";
export const calendarBlock = z
  .object({
    title: z.string().min(1).max(160),
    channels: z.array(z.string().min(1).max(80)).max(20),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, { message: "End must follow start" });
export async function calendarConflicts(
  tx: DbTx,
  scope: Scope,
  channel: string,
  at: Date,
) {
  return (await list(tx, scope, "calendar_blocks")).filter((row) => {
    const b = data(row);
    return (
      b.status === "active" &&
      (!b.channels.length || b.channels.includes(channel)) &&
      at >= new Date(b.startAt) &&
      at < new Date(b.endAt)
    );
  });
}
export async function blockCalendar(
  tx: DbTx,
  scope: Scope,
  input: z.infer<typeof calendarBlock>,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const block = await create(tx, scope, "calendar_blocks", {
    ...input,
    status: "active",
    createdBy: scope.userId,
  });
  for (const row of await list(tx, scope, "publications")) {
    const p = data(row);
    if (
      (input.channels.length && !input.channels.includes(p.channel)) ||
      new Date(p.scheduledAt) < new Date(input.startAt) ||
      new Date(p.scheduledAt) >= new Date(input.endAt)
    )
      continue;
    if (p.status === "intent_created")
      await update(tx, scope, row, {
        ...p,
        status: "blocked_dependency",
        reason: "MANUAL_CALENDAR_BLOCK",
        calendarBlockId: block.id,
      });
    else if (
      ["sending", "scheduled_remote", "outcome_unknown"].includes(p.status)
    ) {
      await update(tx, scope, row, {
        ...p,
        status:
          p.status === "scheduled_remote" ? "cancellation_required" : p.status,
        calendarBlockId: block.id,
      });
      await exception(
        tx,
        scope,
        "CALENDAR_REMOTE_RECONCILIATION_REQUIRED",
        row.id,
      );
    }
  }
  await audit(tx, scope, "calendar.block", block.id);
  return block;
}
export async function unblockCalendar(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const row = await entity(tx, scope, "calendar_blocks", id);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const result = await update(tx, scope, row, {
    ...data(row),
    status: "inactive",
    releasedBy: scope.userId,
  });
  await audit(tx, scope, "calendar.unblock", id);
  return result;
}
