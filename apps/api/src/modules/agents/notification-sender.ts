import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  ConnectorError,
  type FetchLike,
  type TelegramButton,
} from "../../../../../packages/connectors/src/index.ts";
import { audit, data, entity, exception, list, update } from "../../shared.ts";
import { finalPostText } from "../channel-rules.ts";
import { exportAssetContent } from "../content-export.ts";
import { zonedTime } from "../posting-slots.ts";
import {
  linkedTelegramConnection,
  stopCallbackData,
  telegramSender,
} from "../telegram.ts";
import { agentsEnabled } from "./assignments.ts";
import {
  dailyReportTime,
  NOTIFY_KINDS,
  type NotifyKind,
} from "./notifications.ts";
import { runProblems, SLOT_UNAVAILABLE } from "./assignment-runs.ts";
import { budgetMonthStart } from "../budget.ts";
import { localDate } from "./scheduling.ts";

/**
 * Renders and sends one queued `telegram_notification` job to the owner's
 * bot (Orbit Agents, spec §10). The message is built when the job runs, from
 * the state then: a preview of a post that was stopped, handed over or whose
 * veto deadline has passed is skipped as stale, and a project without a bound
 * owner gets nothing and nothing is retried (R61, R63). The job's idempotency
 * key `notify:<kind>:<ref>` says what to send.
 *
 * Delivery is tried once and retried three times with growing waits, but only
 * for network trouble and temporary Telegram errors. A delivery that still
 * fails is recorded on the job, audited and opened as the exception
 * `TELEGRAM_DELIVERY_FAILED` (kind and reference, never the token or the chat
 * id). It changes nothing about publishing: no publication, veto deadline or
 * review is touched, and the deadline applies whether or not the message got
 * through. The outcome (`sent`, `skipped`, `failed`) is kept on the job as
 * `notification`, which also makes a second call for the same job a no-op.
 */
const BACKOFF_MS = [1000, 3000, 9000];
// Telegram's own limits: 1024 characters under a photo, 4096 in a message.
const CAPTION_MAX = 1024;
const TEXT_MAX = 4000;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const FACT_WINDOW_MS = 7 * 86400000;
const FACTS_SHOWN = 5;
// An unclear answer (`INVALID_PROVIDER_RESPONSE`, usually after an HTTP 200) is no reason to
// send again: the message may be out already, and a retry would duplicate it.
const TRANSIENT_CODES = new Set([
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "DNS_TIMEOUT",
]);
// The longest wait Telegram's `retry_after` may impose on a notification.
const RETRY_AFTER_MAX_MS = 30_000;

export type NotificationOptions = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};
type Message = {
  text: string;
  // Shown under the photo when the text is too long for a caption.
  header: string;
  buttons: TelegramButton[];
  asset?: Record<string, any> | null;
};
type Built = Message | { skip: string };

const orbitUrl = () =>
  `${loadConfig().APP_ORIGIN.replace(/\/+$/, "")}/approvals`;
const openButton = (): TelegramButton => ({
  text: "In Orbit öffnen",
  url: orbitUrl(),
});
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;
const maybe = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch {
    return null;
  }
};

/** Weekday, date and time, e.g. "Fr., 09.10., 17:00". */
const dayTime = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
const when = (iso: unknown, timezone: string) => {
  const at = new Date(String(iso));
  if (!Number.isFinite(at.valueOf())) return "unbekannt";
  return `${dayTime(at, timezone)} (${timezone})`;
};
/** Only the time when it falls on the local day of sending; otherwise with weekday and date. */
const deadlineText = (iso: unknown, timezone: string) => {
  const at = new Date(String(iso));
  if (!Number.isFinite(at.valueOf())) return "unbekannt";
  return localDate(at, timezone) === localDate(new Date(), timezone)
    ? clock(at, timezone)
    : dayTime(at, timezone);
};
const clock = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
const shortDate = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("de-DE", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
  }).format(at);
const usd = (micros: bigint | null | undefined) =>
  (Number(micros ?? 0n) / 1_000_000).toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The channel's name from the Postiz connector; the id when it is not known. */
async function channelName(tx: DbTx, scope: Scope, channel: unknown) {
  const id = String(channel ?? "");
  for (const row of await list(tx, scope, "connectors")) {
    const found = (
      (data(row).channels ?? []) as Array<Record<string, any>>
    ).find((item) => item.id === id);
    if (found?.name) return String(found.name);
  }
  return id || "unbekannt";
}

function parseKey(key: unknown): { kind: NotifyKind; ref: string } | null {
  const match = /^notify:([a-z_]+):(.+)$/s.exec(String(key ?? ""));
  const kind = match?.[1] as NotifyKind | undefined;
  return kind && NOTIFY_KINDS.includes(kind) ? { kind, ref: match![2]! } : null;
}

async function preview(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const pubRow = await maybe(() => entity(tx, scope, "publications", ref));
  const p = data(pubRow);
  // Stopped, handed over, blocked or past its deadline: there is nothing left to stop.
  if (
    !pubRow ||
    p.status !== "intent_created" ||
    p.vetoedAt ||
    !(Date.parse(p.vetoDeadline) > Date.now())
  )
    return { skip: "STALE" };
  const contentRow = await maybe(() =>
    entity(tx, scope, "content", p.contentId),
  );
  if (!contentRow) return { skip: "STALE" };
  const c = data(contentRow);
  const asset = c.assetId
    ? data(await maybe(() => entity(tx, scope, "assets", c.assetId)))
    : null;
  const header = [
    "Neuer Beitrag",
    `Kanal: ${await channelName(tx, scope, p.channel)}`,
    `Zeit: ${when(p.scheduledAt, timezone)}`,
    `Stop möglich bis ${deadlineText(p.vetoDeadline, timezone)}`,
  ].join("\n");
  const body = finalPostText(String(c.body ?? ""), c.targetUrl);
  return {
    header,
    text: clip(`${header}\n\n${body}`, TEXT_MAX),
    asset: asset && Object.keys(asset).length ? asset : null,
    buttons: [
      {
        text: "Stop",
        callbackData: stopCallbackData(pubRow.id, pubRow.version),
      },
      openButton(),
    ],
  };
}

const plain = (text: string, buttons: TelegramButton[] = []): Message => ({
  text,
  header: text,
  buttons,
});

async function rejected(tx: DbTx, scope: Scope, ref: string): Promise<Built> {
  const contentRow = await maybe(() =>
    entity(tx, scope, "content", ref.split(":")[0]!),
  );
  if (!contentRow) return { skip: "STALE" };
  const c = data(contentRow);
  const reasons = ((c.agentReviewDecision?.reasons ?? []) as unknown[])
    .map(String)
    .filter(Boolean);
  const problems = (
    (c.agentReviewDecision?.deterministicProblems ?? []) as unknown[]
  ).map(String);
  return plain(
    [
      "Entwurf abgelehnt",
      `Kanal: ${await channelName(tx, scope, c.channel)}`,
      `Grund: ${clip([...reasons, ...problems].join("; ") || "nicht angegeben", 300)}`,
      "Es geht nichts raus.",
    ].join("\n"),
  );
}

async function needsOwner(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const [contentId, taskId] = ref.split(":");
  const contentRow = await maybe(() =>
    entity(tx, scope, "content", contentId!),
  );
  if (!contentRow) return { skip: "STALE" };
  const c = data(contentRow);
  // The agent approved it, but only the owner's release counts (R71).
  if (c.agentReview?.taskId === taskId) {
    // Released, replaced or otherwise decided meanwhile: nothing left to ask.
    if (c.status !== "needs_review" || c.supersededBy) return { skip: "STALE" };
    const mission = c.missionId
      ? data(await maybe(() => entity(tx, scope, "missions", c.missionId)))
      : {};
    return plain(
      [
        "Entwurf wartet auf deine Freigabe",
        `Kanal: ${await channelName(tx, scope, c.channel)}`,
        ...(mission.plannedSlotAt
          ? [`Geplant: ${when(mission.plannedSlotAt, timezone)}`]
          : []),
        "Orbit hat ihn geprüft. Er geht erst raus, wenn du ihn in Orbit freigibst.",
      ].join("\n"),
      [openButton()],
    );
  }
  const why = [
    ...((c.agentReviewDecision?.deterministicProblems ?? []) as unknown[]),
    c.agentReviewDecision?.revisionError,
  ]
    .filter(Boolean)
    .map(String);
  return plain(
    [
      "Entwurf wartet auf dich",
      `Kanal: ${await channelName(tx, scope, c.channel)}`,
      `Orbit konnte ihn nicht selbst freigeben${why.length ? ` (${clip(why.join(", "), 200)})` : ""}.`,
      "Bitte in Orbit prüfen. Bis dahin geht nichts raus.",
    ].join("\n"),
    [openButton()],
  );
}

async function dropped(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const contentRow = await maybe(() => entity(tx, scope, "content", ref));
  const runRow = contentRow
    ? await maybe(() =>
        entity(tx, scope, "assignment_runs", data(contentRow).assignmentRunId),
      )
    : null;
  const entry = (
    (data(runRow).scheduling?.dropped ?? []) as Array<Record<string, any>>
  ).find((item) => item.contentId === ref);
  if (!entry) return { skip: "STALE" };
  const reason =
    entry.code === SLOT_UNAVAILABLE
      ? "Kein freier Slot an dem Tag"
      : entry.code;
  return plain(
    [
      "Beitrag entfällt",
      `Kanal: ${await channelName(tx, scope, entry.channel)}`,
      `Geplant: ${when(entry.requestedAt, timezone)}`,
      `Grund: ${clip(String(reason), 200)}`,
    ].join("\n"),
  );
}

const withdrawnText = (count: number) =>
  count === 0
    ? "Keine geplanten Beiträge zurückgezogen"
    : count === 1
      ? "1 geplanter Beitrag zurückgezogen"
      : `${count} geplante Beiträge zurückgezogen`;

/** `ref` is `<assignmentId>:<version>`; the version names this exhaustion. */
async function budgetPaused(
  tx: DbTx,
  scope: Scope,
  ref: string,
): Promise<Built> {
  const [assignmentId, version] = ref.split(":");
  const row = await maybe(() =>
    entity(tx, scope, "assignments", assignmentId!),
  );
  if (!row) return { skip: "STALE" };
  // The scheduled posts the pause withdrew (R20/R23, M6).
  const withdrawn = await tx.entity.count({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["assignmentId"], equals: assignmentId! } },
        { data: { path: ["reason"], equals: "ASSIGNMENT_PAUSED" } },
        { data: { path: ["budgetPausedVersion"], equals: Number(version) } },
      ],
    },
  });
  return plain(
    [
      "Budget aufgebraucht",
      `Auftrag „${clip(String(data(row).name ?? ""), 120)}“ ist pausiert.`,
      `${withdrawnText(withdrawn)}.`,
      "Fortsetzen in Orbit.",
    ].join("\n"),
  );
}

/** The name of an assignment for a notice; empty when it is gone. */
async function assignmentName(tx: DbTx, scope: Scope, id: unknown) {
  const row = await maybe(() => entity(tx, scope, "assignments", String(id)));
  return clip(String(data(row).name ?? ""), 120);
}

// Codes that mean a Verified Fact was missing or not usable (spec §11 "missing facts").
const FACT_CODES = [
  "FACT_NOT_USABLE",
  "AGENT_UNKNOWN_FACT",
  "AGENT_FACTS_REQUIRED",
  "NO_BRIEF",
];
const reasonText = (code: string) =>
  code === SLOT_UNAVAILABLE
    ? "kein freier Slot an dem Tag"
    : FACT_CODES.includes(code)
      ? `Fakten fehlen (${code})`
      : code;

/** Deliverables of a new run that got no slot (`ref` is the run id). */
async function slotsUnavailable(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const r = data(await maybe(() => entity(tx, scope, "assignment_runs", ref)));
  const entries = (r.unavailable ?? []) as Array<Record<string, any>>;
  if (!entries.length) return { skip: "STALE" };
  const lines = [];
  for (const entry of entries.slice(0, 10))
    lines.push(
      `- ${await channelName(tx, scope, entry.channel)}, ${when(entry.requestedAt, timezone)}`,
    );
  return plain(
    [
      "Kein freier Slot",
      `Auftrag „${await assignmentName(tx, scope, r.assignmentId)}“: ${
        entries.length === 1
          ? "1 Beitrag entfällt"
          : `${entries.length} Beiträge entfallen`
      } (Tageslimit, Abstand oder Sperrzeit).`,
      ...lines,
      ...(entries.length > 10 ? [`- und ${entries.length - 10} weitere`] : []),
    ].join("\n"),
    [openButton()],
  );
}

/** One run that ended with failed steps or dropped briefs (`ref` is the run id). */
async function runProblem(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const runRow = await maybe(() => entity(tx, scope, "assignment_runs", ref));
  if (!runRow) return { skip: "STALE" };
  const problems = await runProblems(tx, scope, runRow);
  if (!problems.failed.length && !problems.dropped.length)
    return { skip: "STALE" };
  const r = data(runRow);
  const lines = [
    "Lauf mit Problemen",
    `Auftrag „${await assignmentName(tx, scope, r.assignmentId)}“, Lauf für den ${String(
      r.date ?? "",
    )
      .split("-")
      .reverse()
      .join(".")}`,
  ];
  if (problems.failed.length) {
    lines.push("Fehlgeschlagen:");
    for (const step of problems.failed.slice(0, 10))
      lines.push(`- ${step.stepKey}: ${reasonText(step.code)}`);
  }
  if (problems.dropped.length) {
    lines.push("Entfällt:");
    for (const entry of problems.dropped.slice(0, 10))
      lines.push(
        `- ${await channelName(tx, scope, entry.channel)}, ${when(entry.slotAt, timezone)}: ${reasonText(entry.code)}`,
      );
  }
  if (problems.skipped.length)
    lines.push(`Übersprungen: ${problems.skipped.join(", ")}`);
  return plain(clip(lines.join("\n"), TEXT_MAX), [openButton()]);
}

/** A post the owner expected that was blocked at claim or handoff (`ref` is the publication id). */
async function blocked(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const pubRow = await maybe(() => entity(tx, scope, "publications", ref));
  const p = data(pubRow);
  if (!pubRow || p.status !== "blocked_dependency") return { skip: "STALE" };
  const why = ((p.blockers ?? []) as unknown[]).map(String);
  return plain(
    [
      "Beitrag blockiert",
      `Kanal: ${await channelName(tx, scope, p.channel)}`,
      `Zeit: ${when(p.scheduledAt, timezone)}`,
      `Grund: ${clip(why.join(", ") || String(p.reason ?? "unbekannt"), 300)}`,
      "Er geht nicht raus. Bitte in Orbit prüfen.",
    ].join("\n"),
    [openButton()],
  );
}

/** Posts withdrawn because the owner moved the times; `ref` is `<assignmentId>:<version>`. */
async function retimed(tx: DbTx, scope: Scope, ref: string): Promise<Built> {
  const [assignmentId, version] = ref.split(":");
  const row = await maybe(() =>
    entity(tx, scope, "assignments", assignmentId!),
  );
  if (!row) return { skip: "STALE" };
  const withdrawn = await tx.entity.count({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["assignmentId"], equals: assignmentId! } },
        { data: { path: ["reason"], equals: "ASSIGNMENT_RETIMED" } },
        { data: { path: ["retimedVersion"], equals: Number(version) } },
      ],
    },
  });
  if (!withdrawn) return { skip: "STALE" };
  const times = ((data(row).schedule?.times ?? []) as unknown[])
    .map(String)
    .join(", ");
  return plain(
    [
      "Zeiten geändert",
      `Auftrag „${clip(String(data(row).name ?? ""), 120)}“: ${
        withdrawn === 1
          ? "1 geplanter Beitrag zurückgezogen"
          : `${withdrawn} geplante Beiträge zurückgezogen`
      }.`,
      `Die neuen Zeiten (${times}) gelten ab dem nächsten Lauf.`,
    ].join("\n"),
    [openButton()],
  );
}

async function postizError(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const pubRow = await maybe(() => entity(tx, scope, "publications", ref));
  if (!pubRow) return { skip: "STALE" };
  const p = data(pubRow);
  // The post moved on (published after all, withdrawn, ...): the error is no longer true.
  if (!["failed", "outcome_unknown"].includes(p.status))
    return { skip: "STALE" };
  return plain(
    [
      "Postiz-Fehler",
      `Kanal: ${await channelName(tx, scope, p.channel)}`,
      `Zeit: ${when(p.scheduledAt, timezone)}`,
      p.status === "outcome_unknown"
        ? "Ergebnis unklar. Bitte in Postiz prüfen, bevor etwas erneut gesendet wird."
        : "Der Beitrag wurde nicht veröffentlicht.",
    ].join("\n"),
  );
}

/** The report of the local day named by `ref` (`<projectId>:<YYYY-MM-DD>`). */
async function dailyReport(
  tx: DbTx,
  scope: Scope,
  ref: string,
  timezone: string,
): Promise<Built> {
  const date = ref.slice(-10);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts) return { skip: "STALE" };
  const [year, month, day] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const start = zonedTime(year, month, day, 0, 0, timezone);
  const end = zonedTime(year, month, day + 1, 0, 0, timezone);
  // The budget month (UTC) at the report time, as the assignment and project budgets count it (M4).
  const monthStart = budgetMonthStart(dailyReportTime(date, timezone));
  const within = (value: unknown) => {
    const at = Date.parse(String(value ?? ""));
    return at >= start.valueOf() && at < end.valueOf();
  };
  const pubs = (await list(tx, scope, "publications")).map(data);
  const published = pubs.filter(
    (p) =>
      ["published", "scheduled_remote"].includes(p.status) &&
      within(p.completedAt ?? p.handoffCompletedAt),
  ).length;
  const stopped = pubs.filter((p) => within(p.vetoedAt)).length;
  // A draft replaced by its revision (`revisedTo`) is not a rejection the owner was told about.
  const rejectedCount = (
    await tx.auditEvent.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        action: "content.agent_rejected",
        createdAt: { gte: start, lt: end },
      },
      select: { metadata: true },
    })
  ).filter(
    (event) =>
      (event.metadata as Record<string, unknown> | null)?.revisedTo == null,
  ).length;
  // Deliverables that stopped today (I4), from the audits written with their notices.
  const events = await tx.auditEvent.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      action: {
        in: [
          "assignment.run_planned",
          "assignment.run_problems",
          "assignment.deliverable_dropped",
          "publication.claim_blocked",
        ],
      },
      createdAt: { gte: start, lt: end },
    },
    select: { action: true, metadata: true },
  });
  const sum = (action: string, field: string) =>
    events
      .filter((event) => event.action === action)
      .reduce(
        (total, event) =>
          total +
          (Number(
            (event.metadata as Record<string, unknown> | null)?.[field],
          ) || 0),
        0,
      );
  const count = (action: string) =>
    events.filter((event) => event.action === action).length;
  const failedSteps = sum("assignment.run_problems", "failedSteps");
  const droppedDeliverables =
    sum("assignment.run_planned", "unavailable") +
    sum("assignment.run_problems", "droppedDeliverables") +
    count("assignment.deliverable_dropped");
  const blockedPosts = count("publication.claim_blocked");
  const spent = (from: Date, state: "settled" | "unknown") =>
    tx.budgetReservation.aggregate({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        state,
        createdAt: { gte: from, lt: end },
      },
      _sum: { settledMicros: true, amountMicros: true },
    });
  const today = await spent(start, "settled");
  const thisMonth = await spent(monthStart, "settled");
  const unknown = await spent(monthStart, "unknown");
  const now = new Date();
  const expiring = (await list(tx, scope, "facts"))
    .map(data)
    .filter(
      (f) =>
        f.status === "verified" &&
        Date.parse(f.validUntil) > now.valueOf() &&
        Date.parse(f.validUntil) <= now.valueOf() + FACT_WINDOW_MS,
    )
    .sort((a, b) => Date.parse(a.validUntil) - Date.parse(b.validUntil));
  const keys = [...new Map(expiring.map((f) => [f.key, f])).values()];
  const lines = [
    `Tagesbericht ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
    `Veröffentlicht: ${published}`,
    `Gestoppt: ${stopped}`,
    `Abgelehnt: ${rejectedCount}`,
    `Fehlgeschlagene Schritte: ${failedSteps}`,
    `Entfallene Beiträge: ${droppedDeliverables}`,
    `Blockierte Beiträge: ${blockedPosts}`,
    `Kosten heute: ${usd(today._sum.settledMicros)} USD`,
    `Kosten Monat (UTC): ${usd(thisMonth._sum.settledMicros)} USD`,
    ...(unknown._sum.amountMicros
      ? [`Davon Ausgang unklar: ${usd(unknown._sum.amountMicros)} USD`]
      : []),
    keys.length
      ? "Fakten, die in 7 Tagen ablaufen:"
      : "Keine Fakten laufen in den nächsten 7 Tagen ab.",
    ...keys
      .slice(0, FACTS_SHOWN)
      .map(
        (f) =>
          `- ${clip(String(f.key), 80)} (bis ${shortDate(new Date(f.validUntil), timezone)})`,
      ),
    ...(keys.length > FACTS_SHOWN
      ? [`- und ${keys.length - FACTS_SHOWN} weitere`]
      : []),
  ];
  return plain(lines.join("\n"), [openButton()]);
}

function projectPaused(): Built {
  return plain(
    "Projekt pausiert. Es geht nichts mehr raus. Fortsetzen nur in Orbit.",
  );
}

async function render(
  tx: DbTx,
  scope: Scope,
  kind: NotifyKind,
  ref: string,
): Promise<Built> {
  const { timezone } = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { timezone: true },
  });
  switch (kind) {
    case "preview":
      return preview(tx, scope, ref, timezone);
    case "rejected":
      return rejected(tx, scope, ref);
    case "needs_owner":
      return needsOwner(tx, scope, ref, timezone);
    case "dropped":
      return dropped(tx, scope, ref, timezone);
    case "slots_unavailable":
      return slotsUnavailable(tx, scope, ref, timezone);
    case "run_problem":
      return runProblem(tx, scope, ref, timezone);
    case "blocked":
      return blocked(tx, scope, ref, timezone);
    case "budget_paused":
      return budgetPaused(tx, scope, ref);
    case "retimed":
      return retimed(tx, scope, ref);
    case "postiz_error":
      return postizError(tx, scope, ref, timezone);
    case "project_paused":
      return projectPaused();
    case "daily_report":
      return dailyReport(tx, scope, ref, timezone);
  }
}

/** Network trouble and temporary Telegram answers are tried again; a refusal that will not change is not. */
function transient(error: unknown) {
  if (!(error instanceof ConnectorError)) return false;
  if (error.status !== undefined)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return TRANSIENT_CODES.has(error.code);
}

/** One step of a delivery; `fallback` takes its place when Telegram refuses it for good. */
type Step = {
  send: () => Promise<unknown>;
  fallback?: () => Promise<unknown>;
};

/** Telegram's own wait after a 429 (at most 30 s), else the growing backoff. */
function waitBefore(error: unknown, attempt: number) {
  if (
    error instanceof ConnectorError &&
    error.status === 429 &&
    error.retryAfterMs
  )
    return Math.min(error.retryAfterMs, RETRY_AFTER_MAX_MS);
  return BACKOFF_MS[attempt]!;
}

async function withRetries(
  send: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; ; attempt++)
    try {
      return await send();
    } catch (error) {
      if (attempt >= BACKOFF_MS.length || !transient(error)) throw error;
      await sleep(waitBefore(error, attempt));
    }
}

async function deliver(steps: Step[], sleep: (ms: number) => Promise<void>) {
  for (const step of steps)
    try {
      await withRetries(step.send, sleep);
    } catch (error) {
      // A photo Telegram refuses for good (not a temporary error, not a revoked bot)
      // must not cost the owner the preview: the text goes out instead.
      if (
        !step.fallback ||
        !(error instanceof ConnectorError) ||
        transient(error) ||
        error.code === "PROVIDER_AUTH"
      )
        throw error;
      await withRetries(step.fallback, sleep);
    }
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function record(
  scope: Scope,
  jobId: string,
  notification: Record<string, unknown>,
  inTx?: (tx: DbTx) => Promise<void>,
) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const job = await entity(tx, scope, "jobs", jobId);
    await update(tx, scope, job, {
      ...data(job),
      notification: { ...notification, at: new Date().toISOString() },
    });
    await inTx?.(tx);
  });
}

/**
 * Sends the notification of a `telegram_notification` job. Never throws for a
 * delivery problem: it is recorded (see the file comment). Database errors
 * propagate so that the worker retries the job; an outcome already recorded
 * makes the call a no-op, so a retry never sends twice.
 */
export async function sendNotification(
  scope: Scope,
  jobId: string,
  options: NotificationOptions = {},
) {
  const sleep = options.sleep ?? wait;
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const job = await entity(tx, scope, "jobs", jobId);
      const d = data(job);
      if (d.notification) return null;
      const skip = async (reason: string) => {
        await update(tx, scope, job, {
          ...d,
          notification: {
            outcome: "skipped",
            reason,
            at: new Date().toISOString(),
          },
        });
        return null;
      };
      const key = parseKey(d.idempotencyKey);
      if (!key) return skip("UNKNOWN_KIND");
      if (!agentsEnabled()) return skip("DISABLED");
      // Only a bot bound to a current owner (R61); anything else is not retried.
      const connection = await linkedTelegramConnection(tx, scope);
      if (!connection) return skip("NO_BOT");
      const sender = telegramSender(connection, { fetch: options.fetch });
      if (!sender) return skip("NO_BOT");
      const built = await render(tx, scope, key.kind, key.ref);
      if ("skip" in built) return skip(built.skip);
      return { ...key, sender, message: built };
    },
  );
  if (!prepared) return;
  const { kind, ref, sender, message } = prepared;
  // The image is read outside the transaction (it may live in Drive); without it the text goes alone.
  const image = message.asset
    ? await maybe(() => exportAssetContent(scope, message.asset!))
    : null;
  const photo =
    image && image.bytes.byteLength <= PHOTO_MAX_BYTES ? image.bytes : null;
  const text = () =>
    sender.client.sendMessage(sender.chatId, message.text, message.buttons);
  const steps: Step[] = [];
  if (photo && message.text.length <= CAPTION_MAX)
    steps.push({
      send: () =>
        sender.client.sendPhoto(
          sender.chatId,
          photo,
          message.text,
          message.buttons,
        ),
      fallback: text,
    });
  else if (photo) {
    // The text follows in its own message, so a refused photo is simply left out.
    steps.push({
      send: () => sender.client.sendPhoto(sender.chatId, photo, message.header),
      fallback: async () => undefined,
    });
    steps.push({ send: text });
  } else steps.push({ send: text });
  try {
    await deliver(steps, sleep);
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : "UNEXPECTED";
    const status =
      error instanceof ConnectorError ? (error.status ?? null) : null;
    await record(scope, jobId, { outcome: "failed", code }, async (tx) => {
      await exception(tx, scope, "TELEGRAM_DELIVERY_FAILED", `${kind}:${ref}`);
      await audit(tx, scope, "telegram.delivery_failed", jobId, {
        kind,
        ref,
        code,
        status,
      });
    });
    return;
  }
  await record(scope, jobId, { outcome: "sent" });
}
