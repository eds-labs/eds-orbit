import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";

// Support statistics (WP5.7): aggregated on read over tickets, events,
// messages and budget reservations of tickets created in the range. Numbers
// only; no subject, text or contact leaves this function. Rollups come when
// measurements ask for them.

export const statsInput = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    inboxId: z.uuid().optional(),
    category: z.string().max(41).optional(),
    tag: z.string().max(41).optional(),
    agent: z.string().max(100).optional(),
  })
  .strict();

const MAX_TICKETS = 5000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function minutes(values: number[]) {
  const sorted = values.map((v) => v / MIN).sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) return { count: 0, medianMinutes: null, meanMinutes: null };
  const mid = Math.floor(count / 2);
  const median =
    count % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = sorted.reduce((a, b) => a + b, 0) / count;
  return { count, medianMinutes: round1(median), meanMinutes: round1(mean) };
}

const tally = (values: Array<string | null>) =>
  values.reduce<Record<string, number>>((acc, v) => {
    const key = v ?? "none";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

/** "YYYY-MM-DD" of an instant on the calendar of a timezone. */
function localDay(at: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Zero-filling stops here; longer ranges list only days with tickets. */
const MAX_FILLED_DAYS = 400;

/**
 * Tickets per calendar day of the project's timezone. Every day of
 * `[from, to)` is present, zeros included.
 */
function perDay(dates: Date[], from: Date, to: Date, timezone: string) {
  let zone = timezone;
  try {
    localDay(from, zone);
  } catch {
    zone = "UTC";
  }
  const counts: Record<string, number> = {};
  const first = localDay(from, zone);
  const last = localDay(new Date(to.getTime() - 1), zone);
  // Calendar arithmetic on the date strings: no 24-hour steps across DST.
  const cursor = new Date(`${first}T00:00:00.000Z`);
  for (
    let n = 0;
    n < MAX_FILLED_DAYS && cursor.toISOString().slice(0, 10) <= last;
    n++
  ) {
    counts[cursor.toISOString().slice(0, 10)] = 0;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const at of dates) {
    const day = localDay(at, zone);
    counts[day] = (counts[day] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The support statistics of the tickets created in the range. */
export async function supportStats(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  const input = statsInput.parse(raw);
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (to <= from) throw new DomainError("RANGE_INVALID", 400);
  const filters = {
    projectId: scope.projectId,
    mergedIntoTicketId: null,
    ...(input.inboxId ? { inboxId: input.inboxId } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.tag ? { tags: { has: input.tag } } : {}),
    ...(input.agent ? { assigneeUserId: input.agent } : {}),
  };
  const tickets = await tx.supportTicket.findMany({
    where: { ...filters, createdAt: { gte: from, lt: to } },
    take: MAX_TICKETS,
  });
  const ids = tickets.map((t) => t.id);
  const [events, messages, open, reservations, project] = await Promise.all([
    tx.supportTicketEvent.findMany({
      where: {
        ticketId: { in: ids },
        type: {
          in: ["status", "sla_breached", "ai_draft_withheld", "handoff"],
        },
      },
      select: { ticketId: true, type: true, actorKind: true, before: true },
    }),
    tx.supportMessage.findMany({
      where: {
        ticketId: { in: ids },
        kind: { in: ["ai_draft", "agent_reply"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { ticketId: true, kind: true, bodyText: true, createdAt: true },
    }),
    tx.supportTicket.findMany({
      where: { ...filters, status: { notIn: ["resolved", "closed"] } },
      select: { createdAt: true },
      take: MAX_TICKETS,
    }),
    tx.budgetReservation.findMany({
      where: {
        projectId: scope.projectId,
        OR: ids.map((id) => ({ key: { contains: `support:${id}:` } })),
      },
      select: { key: true, amountMicros: true, settledMicros: true },
    }),
    tx.project.findUnique({
      where: { id: scope.projectId },
      select: { timezone: true },
    }),
  ]);

  const firstResponse = minutes(
    tickets
      .filter((t) => t.firstRespondedAt)
      .map((t) => t.firstRespondedAt!.getTime() - t.createdAt.getTime()),
  );
  const resolution = minutes(
    tickets
      .filter((t) => t.resolvedAt)
      .map((t) => t.resolvedAt!.getTime() - t.createdAt.getTime()),
  );
  const ages = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 };
  for (const t of open) {
    const age = now.getTime() - t.createdAt.getTime();
    if (age < DAY) ages.under1d++;
    else if (age < 3 * DAY) ages.d1to3++;
    else if (age < 7 * DAY) ages.d3to7++;
    else ages.over7d++;
  }
  const resolved = tickets.filter((t) => t.resolvedAt);
  const reopened = new Set(
    events
      .filter(
        (e) =>
          e.type === "status" &&
          ["resolved", "closed"].includes(
            String((e.before as { status?: string }).status),
          ),
      )
      .map((e) => e.ticketId),
  );
  const responded = tickets.filter(
    (t) => t.firstRespondedAt && t.firstResponseDueAt,
  );
  const met = responded.filter(
    (t) => t.firstRespondedAt!.getTime() <= t.firstResponseDueAt!.getTime(),
  ).length;

  // AI drafts: was the next agent reply of the ticket sent unchanged?
  let draftsSent = 0;
  let sentUnchanged = 0;
  const drafts = messages.filter((m) => m.kind === "ai_draft");
  for (const draft of drafts) {
    const reply = messages.find(
      (m) =>
        m.kind === "agent_reply" &&
        m.ticketId === draft.ticketId &&
        m.createdAt.getTime() > draft.createdAt.getTime(),
    );
    if (!reply) continue;
    draftsSent++;
    if (reply.bodyText.trim() === draft.bodyText.trim()) sentUnchanged++;
  }
  const costByTicket = new Map<string, number>();
  for (const r of reservations) {
    const ticketId = ids.find((id) => r.key.includes(`support:${id}:`));
    if (!ticketId) continue;
    costByTicket.set(
      ticketId,
      (costByTicket.get(ticketId) ?? 0) +
        Number(r.settledMicros ?? r.amountMicros),
    );
  }
  const costMicros = [...costByTicket.values()].reduce((a, b) => a + b, 0);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    truncated: tickets.length >= MAX_TICKETS,
    volume: {
      total: tickets.length,
      byChannel: tally(tickets.map((t) => t.channel)),
      byInbox: tally(tickets.map((t) => t.inboxId)),
      byCategory: tally(tickets.map((t) => t.category)),
      byTag: tally(tickets.flatMap((t) => t.tags)),
      byDay: perDay(
        tickets.map((t) => t.createdAt),
        from,
        to,
        project?.timezone ?? "UTC",
      ),
    },
    firstResponse,
    resolution,
    backlog: { open: open.length, ages },
    reopenRate: resolved.length
      ? round3(
          resolved.filter((t) => reopened.has(t.id)).length / resolved.length,
        )
      : null,
    sla: {
      firstResponseMet: met,
      firstResponseMissed: responded.length - met,
      attainment: responded.length ? round3(met / responded.length) : null,
      breaches: events.filter((e) => e.type === "sla_breached").length,
    },
    ai: {
      drafts: drafts.length,
      draftsSent,
      sentUnchanged,
      sentEdited: draftsSent - sentUnchanged,
      acceptanceRate: drafts.length ? round3(draftsSent / drafts.length) : null,
      withheld: events.filter((e) => e.type === "ai_draft_withheld").length,
      handoffs: events.filter(
        (e) => e.type === "handoff" && e.actorKind === "ai",
      ).length,
      costMicros,
      costPerTicketMicros: costByTicket.size
        ? Math.round(costMicros / costByTicket.size)
        : null,
    },
  };
}

export type SupportStats = Awaited<ReturnType<typeof supportStats>>;

/** The statistics as "metric,value" rows; nested keys joined by dots. */
export function statsCsv(stats: SupportStats) {
  const rows: string[] = ["metric,value"];
  const walk = (prefix: string, value: unknown) => {
    if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value))
        walk(prefix ? `${prefix}.${key}` : key, inner);
    else rows.push(`${prefix.replace(/[",\n]/g, "_")},${value ?? ""}`);
  };
  walk("", stats);
  return rows.join("\n") + "\n";
}
