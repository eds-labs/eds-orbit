import { randomUUID } from "node:crypto";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { readModuleSettings } from "../../platform/modules/settings.ts";
import { DomainError } from "../../shared.ts";
import {
  supportSettingsDefaults,
  supportSettingsSchema,
  type SupportPriority,
  type SupportSettings,
} from "./settings.ts";

// Helpers shared by ticket creation, the workspace and the channels.

const MINUTE = 60_000;
/** A pending due time this close (or past) counts as at risk. */
export const SLA_AT_RISK_MINUTES = 60;
/** Statuses whose SLA clocks run: waiting on the team. */
export const SLA_ACTIVE_STATUSES = ["new", "open", "pending_internal"];
/** Statuses of a ticket that is not finished. */
export const OPEN_STATUSES = [
  "new",
  "open",
  "pending_customer",
  "pending_internal",
];

/** The project's support settings, today's defaults where none are saved. */
export async function supportSettings(tx: DbTx, scope: Scope) {
  return (
    await readModuleSettings(
      tx,
      scope,
      "support",
      supportSettingsSchema,
      supportSettingsDefaults,
    )
  ).settings;
}

/** First-response and resolution due times for a priority, from `from`. */
export function dueTimes(
  settings: SupportSettings,
  priority: SupportPriority,
  from: Date,
) {
  const sla = settings.sla[priority];
  return {
    firstResponseDueAt: new Date(
      from.getTime() + sla.firstResponseMinutes * MINUTE,
    ),
    resolutionDueAt: new Date(from.getTime() + sla.resolutionMinutes * MINUTE),
  };
}

/**
 * Live platform files of the support module in this project, in the given
 * order; 400 ATTACHMENT_INVALID when any id is not one.
 */
export async function supportFiles(tx: DbTx, scope: Scope, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.file.findMany({
    where: {
      id: { in: ids },
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      moduleId: "support",
      deletedAt: null,
    },
  });
  if (rows.length !== new Set(ids).size)
    throw new DomainError("ATTACHMENT_INVALID", 400);
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/** Links stored files to a message as its attachments. */
export async function attachFiles(
  tx: DbTx,
  scope: Scope,
  messageId: string,
  files: Array<{ id: string; name: string | null; mime: string; size: number }>,
) {
  return Promise.all(
    files.map((file) =>
      tx.supportAttachment.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          messageId,
          fileId: file.id,
          name: (file.name ?? "attachment").slice(0, 200),
          mime: file.mime,
          size: file.size,
        },
      }),
    ),
  );
}

/** One timeline event: field values only, never message text. */
export function ticketEvent(
  tx: DbTx,
  scope: Scope,
  input: {
    ticketId: string;
    type: string;
    actorKind: "user" | "contact" | "system" | "ai";
    actorId: string | null;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  return tx.supportTicketEvent.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ticketId: input.ticketId,
      type: input.type,
      actorKind: input.actorKind,
      actorId: input.actorId,
      before: (input.before ?? {}) as Prisma.InputJsonValue,
      after: (input.after ?? {}) as Prisma.InputJsonValue,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}
