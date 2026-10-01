import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  exception,
  list,
  update,
} from "../shared.ts";
import { importMatomoReport } from "./matomo.ts";

/**
 * Saved Matomo import settings. The worker reads yesterday's and today's
 * aggregate reports twice a day; re-reading a day corrects existing metrics
 * instead of duplicating them.
 */
export const matomoScheduleInput = z
  .object({
    enabled: z.boolean(),
    connectorId: z.uuid(),
    siteId: z.number().int().positive(),
    siteTimezone: z.string().min(1).max(80),
    currency: z.string().regex(/^[A-Z]{3}$/),
    methods: z
      .array(
        z.enum([
          "VisitsSummary.get",
          "Referrers.getCampaigns",
          "Actions.getPageUrls",
          "Goals.get",
        ]),
      )
      .min(1)
      .max(4),
  })
  .strict();

export const MATOMO_INTERVAL_MS = 12 * 3600_000;

export async function matomoSchedule(tx: DbTx, scope: Scope) {
  return (await list(tx, scope, "matomo_schedules"))[0] ?? null;
}

export async function configureMatomoSchedule(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = matomoScheduleInput.parse(raw);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.siteTimezone });
  } catch {
    throw new DomainError("INVALID_TIMEZONE", 400);
  }
  const connector = data(
    await entity(tx, scope, "connectors", input.connectorId),
  );
  if (
    connector.provider !== "matomo" ||
    !["read_verified", "write_verified"].includes(connector.status) ||
    Number(connector.siteId) !== input.siteId
  )
    throw new DomainError("MATOMO_CONNECTOR_SCOPE", 403);
  const existing = await matomoSchedule(tx, scope);
  const settings = {
    ...input,
    configuredBy: scope.userId,
    configuredAt: new Date().toISOString(),
    lastRunAt: existing ? (data(existing).lastRunAt ?? null) : null,
  };
  const row = existing
    ? await update(tx, scope, existing, settings)
    : await create(tx, scope, "matomo_schedules", settings);
  await audit(tx, scope, "matomo.schedule_configured", row.id, {
    enabled: input.enabled,
    methods: input.methods,
  });
  return row;
}

/** When the saved import next becomes due; null when disabled or never run (it then runs on the next visit). */
export async function nextMatomoRunAt(tx: DbTx, scope: Scope) {
  const row = await matomoSchedule(tx, scope);
  if (!row || data(row).enabled !== true) return null;
  const last = Date.parse(data(row).lastRunAt ?? "");
  return Number.isFinite(last) ? new Date(last + MATOMO_INTERVAL_MS) : null;
}

function siteDay(at: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Worker entry: runs due imports for one project; failures are recorded, never thrown. */
export async function runScheduledMatomo(scope: Scope, now = new Date()) {
  const due = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await matomoSchedule(tx, scope);
    if (!row || data(row).enabled !== true) return null;
    const last = Date.parse(data(row).lastRunAt ?? "");
    if (Number.isFinite(last) && now.valueOf() - last < MATOMO_INTERVAL_MS)
      return null;
    // Claim the run first so a slow import cannot start twice.
    await update(tx, scope, row, {
      ...data(row),
      lastRunAt: now.toISOString(),
    });
    return data(row) as z.infer<typeof matomoScheduleInput>;
  });
  if (!due) return { ran: false };
  const days = [
    siteDay(new Date(now.valueOf() - 86_400_000), due.siteTimezone),
    siteDay(now, due.siteTimezone),
  ];
  let failed = 0;
  for (const date of days)
    for (const method of due.methods) {
      try {
        await importMatomoReport(
          { ...scope, role: "owner" },
          {
            connectorId: due.connectorId,
            siteId: due.siteId,
            date,
            siteTimezone: due.siteTimezone,
            currency: due.currency,
            method,
          },
        );
      } catch {
        failed++;
      }
    }
  if (failed)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      exception(tx, scope, "MATOMO_SCHEDULED_IMPORT_FAILED", due.connectorId),
    );
  return { ran: true, failed };
}
