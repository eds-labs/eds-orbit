import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import { assignableIds, uuid } from "../common.ts";
import {
  defaultPmInitiativeSettings,
  pmInitiativeSettingsSchema,
  type PmInitiativeSettings,
} from "./settings-schema.ts";

// The PM state of one initiative (ADR 0017): whether the PM watches it and
// how. An initiative without a row has the PM off with default settings.

export type PmStateView = {
  initiativeId: string;
  enabled: boolean;
  settings: PmInitiativeSettings;
  lastScanAt: string | null;
  lastReportAt: string | null;
  version: number;
};

export const pmStateInput = z
  .object({
    expectedVersion: z.int().min(0),
    enabled: z.boolean().optional(),
    settings: pmInitiativeSettingsSchema.partial().optional(),
  })
  .strict();

async function initiativeOf(tx: DbTx, scope: Scope, initiativeId: string) {
  const row = await tx.workInitiative.findFirst({
    where: { projectId: scope.projectId, id: uuid.parse(initiativeId) },
    select: { id: true, archivedAt: true },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

/** Stored settings parsed again; a row from an older shape falls back per field. */
function settingsOf(raw: unknown): PmInitiativeSettings {
  const parsed = pmInitiativeSettingsSchema.partial().safeParse(raw);
  return { ...defaultPmInitiativeSettings(), ...(parsed.success ? parsed.data : {}) };
}

export async function getPmState(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
): Promise<PmStateView> {
  const initiative = await initiativeOf(tx, scope, initiativeId);
  const row = await tx.workPmState.findFirst({
    where: { projectId: scope.projectId, initiativeId: initiative.id },
  });
  return {
    initiativeId: initiative.id,
    enabled: row?.enabled ?? false,
    settings: settingsOf(row?.settings),
    lastScanAt: row?.lastScanAt?.toISOString() ?? null,
    lastReportAt: row?.lastReportAt?.toISOString() ?? null,
    // 0: no row yet.
    version: row?.version ?? 0,
  };
}

/** Enables, disables or configures the PM for an initiative (`work.pm.manage`). */
export async function setPmState(
  tx: DbTx,
  scope: Scope,
  initiativeId: string,
  raw: unknown,
) {
  const input = pmStateInput.parse(raw);
  const initiative = await initiativeOf(tx, scope, initiativeId);
  if (initiative.archivedAt && input.enabled)
    throw new DomainError("WORK_INITIATIVE_ARCHIVED", 409);
  const current = await getPmState(tx, scope, initiative.id);
  if (current.version !== input.expectedVersion)
    throw new DomainError("WORK_VERSION_CONFLICT", 409);
  const settings = { ...current.settings, ...input.settings };
  if (settings.escalateTo.length) {
    const members = await assignableIds(scope);
    if (settings.escalateTo.some((id) => !members.has(id)))
      throw new DomainError("WORK_ASSIGNEE_INVALID", 422);
  }
  const enabled = input.enabled ?? current.enabled;
  const json = settings as Prisma.InputJsonValue;
  if (current.version === 0)
    await tx.workPmState.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        initiativeId: initiative.id,
        enabled,
        settings: json,
        updatedBy: scope.userId,
      },
    });
  else {
    const updated = await tx.workPmState.updateMany({
      where: { projectId: scope.projectId, initiativeId: initiative.id, version: current.version },
      data: { enabled, settings: json, updatedBy: scope.userId, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new DomainError("WORK_VERSION_CONFLICT", 409);
  }
  await audit(tx, scope, "work.pm.state_saved", initiative.id, {
    enabled,
    reportSchedule: settings.reportSchedule,
    research: settings.research,
  });
  return getPmState(tx, scope, initiative.id);
}
