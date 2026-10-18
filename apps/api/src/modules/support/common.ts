import { randomUUID } from "node:crypto";
import {
  afterCommit,
  type DbTx,
  Prisma,
} from "../../../../../packages/db/src/index.ts";
import { publishChange } from "../../platform/realtime/fanout.ts";
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

type SlaClocks = {
  firstResponseDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
};

/**
 * The earliest due time that is still pending: the first-response clock runs
 * until the first response, the resolution clock until the ticket is
 * resolved. Null where neither runs or has a due time.
 */
export function slaDueAt(ticket: SlaClocks): Date | null {
  const pending = [
    ticket.firstRespondedAt ? null : ticket.firstResponseDueAt,
    ticket.resolvedAt ? null : ticket.resolutionDueAt,
  ].filter((due): due is Date => due !== null);
  if (!pending.length) return null;
  return new Date(Math.min(...pending.map((due) => due.getTime())));
}

/**
 * Prisma filter for tickets with a pending due time inside `range`; the
 * Prisma form of {@link slaDueAt} (a due time of either running clock).
 */
export const slaWhere = (range: { lt?: Date; gte?: Date }) => ({
  OR: [
    { firstRespondedAt: null, firstResponseDueAt: range },
    { resolvedAt: null, resolutionDueAt: range },
  ],
});

/** SQL form of {@link slaDueAt}: LEAST ignores NULLs, so none left is NULL. */
export const SLA_DUE_AT_SQL = Prisma.sql`LEAST(CASE WHEN "firstRespondedAt" IS NULL THEN "firstResponseDueAt" END, CASE WHEN "resolvedAt" IS NULL THEN "resolutionDueAt" END)`;

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

/** The real-time stream of one conversation (WP5.4); carries no content. */
export const conversationStream = (ticketId: string) =>
  `support-conversation:${ticketId}`;

/** Wakes the conversation's streams after the transaction commits. */
export function conversationChanged(tx: DbTx, scope: Scope, ticketId: string) {
  afterCommit(tx, () => {
    void publishChange(scope.projectId, conversationStream(ticketId));
  });
}
