import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, entity, update } from "../shared.ts";
import type { JobDef } from "../jobs/types.ts";
import { userScoped } from "../tenancy/scope.ts";
import { highestRole } from "../tenancy/module-roles.ts";
import { AGENTS_READ, can, PROJECT_OWN, PROJECT_WRITE } from "../tenancy/permissions.ts";
import { openDecidableRequests } from "../governance/action-requests.ts";
import { moduleAttentionItems } from "../attention/attention.ts";
import { agentPlatformEnabled, maySeeWorkOrder } from "../agents/work-orders/service.ts";
import { platformSpendLimits } from "../ai/spend-mandate.ts";
import { budgetMonthStart } from "../ai/budget.ts";
import { appendNotice } from "../assistant/notices.ts";
import type { ChatCard } from "../assistant/cards.ts";
import { publishEvent } from "../events/events.ts";
import { sendSystemMail } from "../email/system-mail.ts";
import { localOf } from "../time/zoned-time.ts";
import { readUserProjects, userContact } from "./collect.ts";
import {
  proactiveEnabled,
  readPreferences,
  readState,
  writeState,
  type Preferences,
} from "./preferences.ts";
import { summarizeBriefing } from "./summarizer.ts";

// Briefings (ADR 0023 item 8, plan §2.5, WP4.4). Off by default. At the
// user's local briefing time the personal space's scheduler queues one job
// per slot; it reads every included business project in its own
// transaction with the user's current role there and aggregates counts
// without any model call: approvals the user may decide, failed and
// finished agent work, urgent ticket counts, due tasks and the budget
// status (owners only). The result is one `notice` message with a card per
// project in the dedicated "Briefings" conversation (T4-1), optionally an
// e-mail through the system sender (titles, counts, links), and, only when
// the user opted in, the AI summary appended as a second notice.

export const BRIEFING_QUEUE = "assistant_briefing";
export const BRIEFING_SUMMARY_FAILED_EVENT = "platform.assistant.briefing_summary_failed";
const DAY = 86_400_000;
const BRIEFINGS_TITLE = "Briefings";

/**
 * The attention items of these modules make up two briefing sections. Only
 * module ids as strings: the platform reads the modules' own attention
 * contributions and never imports a module.
 */
const SECTION_MODULES = { urgentTickets: "support", dueTasks: "work" } as const;

export type BriefingProject = {
  projectId: string;
  projectName: string;
  approvals?: number;
  agentFailed?: number;
  agentFinished?: number;
  urgentTickets?: number;
  dueTasks?: number;
  /** Month spend as a percentage of the project's AI budget (owners). */
  budgetPercent?: number;
};

async function projectBriefing(
  tx: DbTx,
  member: Scope,
  project: { id: string; name: string },
  sections: Preferences["briefing"]["sections"],
  now: Date,
): Promise<BriefingProject> {
  const out: BriefingProject = { projectId: project.id, projectName: project.name };
  if (sections.approvals && can({ role: highestRole(member) }, PROJECT_WRITE))
    out.approvals = (await openDecidableRequests(tx, member, now)).length;
  if (sections.agentWork && agentPlatformEnabled() && can(member, AGENTS_READ)) {
    const rows = await tx.agentWorkOrder.findMany({
      where: {
        projectId: project.id,
        target: "agent",
        finishedAt: { gte: new Date(now.getTime() - DAY) },
      },
      take: 200,
    });
    const visible = rows.filter((row) => maySeeWorkOrder(member, row));
    out.agentFailed = visible.filter((row) => ["failed", "blocked", "outcome_unknown"].includes(row.status)).length;
    out.agentFinished = visible.filter((row) => row.status === "succeeded").length;
  }
  if (sections.urgentTickets || sections.dueTasks) {
    const items = await moduleAttentionItems(tx, member, now);
    const count = (moduleId: string) =>
      items
        .filter((item) => item.moduleId === moduleId && item.severity !== "info")
        .reduce((n, item) => n + (item.count ?? 1), 0);
    if (sections.urgentTickets) out.urgentTickets = count(SECTION_MODULES.urgentTickets);
    if (sections.dueTasks) out.dueTasks = count(SECTION_MODULES.dueTasks);
  }
  if (sections.budget && can(member, PROJECT_OWN)) {
    const limits = await platformSpendLimits(tx, member);
    if (limits?.monthlyBudgetMicros) {
      const rows = await tx.budgetReservation.findMany({
        where: {
          projectId: project.id,
          createdAt: { gte: budgetMonthStart(now) },
          state: { not: "released" },
        },
        select: { state: true, amountMicros: true, settledMicros: true },
      });
      const spent = rows.reduce(
        (n, r) => n + Number(r.state === "settled" ? r.settledMicros : r.amountMicros),
        0,
      );
      out.budgetPercent = Math.floor((spent / limits.monthlyBudgetMicros) * 100);
    }
  }
  return out;
}

/** Whether a project has anything worth reporting. */
export function hasNews(p: BriefingProject) {
  return Boolean(
    p.approvals || p.agentFailed || p.agentFinished || p.urgentTickets || p.dueTasks || (p.budgetPercent ?? 0) >= 80,
  );
}

const TEXT = {
  en: {
    head: (date: string) => `Briefing ${date}`,
    nothing: "Nothing new.",
    approvals: (n: number) => `${n} approval${n === 1 ? "" : "s"} to decide`,
    failed: (n: number) => `${n} failed agent run${n === 1 ? "" : "s"}`,
    finished: (n: number) => `${n} finished agent run${n === 1 ? "" : "s"}`,
    tickets: (n: number) => `${n} urgent ticket item${n === 1 ? "" : "s"}`,
    tasks: (n: number) => `${n} due task item${n === 1 ? "" : "s"}`,
    budget: (n: number) => `AI budget ${n} % used`,
  },
  de: {
    head: (date: string) => `Briefing ${date}`,
    nothing: "Nichts Neues.",
    approvals: (n: number) => `${n} Freigabe${n === 1 ? "" : "n"} zu entscheiden`,
    failed: (n: number) => `${n} fehlgeschlagene Agenten-Ausführung${n === 1 ? "" : "en"}`,
    finished: (n: number) => `${n} erledigte Agenten-Ausführung${n === 1 ? "" : "en"}`,
    tickets: (n: number) => `${n} dringende Ticket-Hinweis${n === 1 ? "" : "e"}`,
    tasks: (n: number) => `${n} fällige Aufgaben-Hinweis${n === 1 ? "" : "e"}`,
    budget: (n: number) => `KI-Budget zu ${n} % verbraucht`,
  },
};

/** One project's line: counts only, the sections that have something. */
export function projectLine(p: BriefingProject, locale: "en" | "de") {
  const t = TEXT[locale];
  return [
    p.approvals ? t.approvals(p.approvals) : null,
    p.agentFailed ? t.failed(p.agentFailed) : null,
    p.agentFinished ? t.finished(p.agentFinished) : null,
    p.urgentTickets ? t.tickets(p.urgentTickets) : null,
    p.dueTasks ? t.tasks(p.dueTasks) : null,
    (p.budgetPercent ?? 0) >= 80 ? t.budget(p.budgetPercent!) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The local date of the slot, e.g. "Mon 10 Nov" (en) or "Mo., 10. Nov." (de). */
export function briefingDate(slot: Date, timeZone: string, locale: "en" | "de") {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(slot);
}

/** The deterministic briefing: the notice text and one card per project with news. */
export function composeBriefing(
  projects: readonly BriefingProject[],
  options: { slot: Date; timeZone: string; locale: "en" | "de" },
) {
  const t = TEXT[options.locale];
  const withNews = projects.filter(hasNews);
  const head = t.head(briefingDate(options.slot, options.timeZone, options.locale));
  const cards: ChatCard[] = withNews.slice(0, 19).map((p) => ({
    kind: "status",
    label: `${p.projectName}: ${projectLine(p, options.locale)}`.slice(0, 160),
    status: "briefing",
    href: `/p/${p.projectId}`,
    projectId: p.projectId,
    projectName: p.projectName,
  }));
  const text = withNews.length
    ? [head, ...withNews.map((p) => `${p.projectName}: ${projectLine(p, options.locale)}`)].join("\n")
    : `${head}\n${t.nothing}`;
  return { empty: !withNews.length, text: text.slice(0, 2000), cards };
}

/** The user's "Briefings" conversation, created on first use and kept in the state. */
async function briefingsConversation(personal: Scope, known: string | undefined) {
  return userScoped(personal, async (tx) => {
    if (known) {
      const found = await tx.chatConversation.findFirst({
        where: { id: known, projectId: personal.projectId, userId: personal.userId },
        select: { id: true },
      });
      if (found) return found.id;
    }
    const created = await tx.chatConversation.create({
      data: {
        workspaceId: personal.workspaceId,
        projectId: personal.projectId,
        userId: personal.userId,
        title: BRIEFINGS_TITLE,
      },
      select: { id: true },
    });
    return created.id;
  });
}

/** Runs one briefing job of a personal space; records its outcome, never runs twice. */
export async function runBriefing(base: Scope, jobId: string, now = new Date()) {
  const prepared = await scoped(base.workspaceId, base.projectId, async (tx) => {
    const job = await entity(tx, base, "jobs", jobId);
    const d = data(job);
    if (d.outcome) return null;
    const finish = async (status: string) => {
      await update(tx, base, job, { ...d, outcome: { status, at: now.toISOString() } });
      return null;
    };
    if (!proactiveEnabled()) return finish("disabled");
    const space = await tx.project.findFirst({
      where: { id: base.projectId, kind: "personal" },
      select: { personalUserId: true },
    });
    if (!space?.personalUserId) return finish("not_personal");
    const personal: Scope = {
      workspaceId: base.workspaceId,
      projectId: base.projectId,
      userId: space.personalUserId,
      role: "owner",
    };
    const { preferences } = await readPreferences(tx, personal);
    if (!preferences.briefing.enabled) return finish("off");
    const { state } = await readState(tx, personal);
    await update(tx, base, job, { ...d, outcome: { status: "running", at: now.toISOString() } });
    return {
      personal,
      preferences,
      conversationId: state.briefingConversationId,
      slot: new Date(Date.parse(String(d.slot ?? "")) || now.getTime()),
    };
  });
  if (!prepared) return;
  const { personal, preferences } = prepared;
  const record = (outcome: Record<string, unknown>) =>
    scoped(base.workspaceId, base.projectId, async (tx) => {
      const job = await entity(tx, base, "jobs", jobId);
      await update(tx, base, job, { ...data(job), outcome: { ...outcome, at: new Date().toISOString() } });
    });
  const contact = await userContact(personal.userId);
  if (!contact) return record({ status: "no_user" });
  const { slot } = prepared;
  const reads = await readUserProjects(
    { workspaceId: personal.workspaceId, userId: personal.userId, projectIds: preferences.briefing.projectIds },
    (tx, member, project) => projectBriefing(tx, member, project, preferences.briefing.sections, now),
  );
  const projects = reads.map((r) => r.value);
  const composed = composeBriefing(projects, {
    slot,
    timeZone: preferences.timeZone,
    locale: contact.locale,
  });
  if (composed.empty && preferences.briefing.skipEmpty) return record({ status: "skipped_empty" });
  const conversationId = await briefingsConversation(personal, prepared.conversationId);
  const slotKey = slot.toISOString();
  await scoped(personal.workspaceId, personal.projectId, (tx) =>
    writeState(tx, personal, { briefingConversationId: conversationId }),
  );
  await userScoped(personal, (tx) =>
    appendNotice(
      tx,
      personal,
      conversationId,
      { kind: "briefing", key: `briefing:${slotKey}` },
      composed.text,
      composed.cards,
    ),
  );
  let mail = "none";
  if (preferences.briefing.email) {
    const origin = loadConfig().APP_ORIGIN.replace(/\/+$/, "");
    const result = await sendSystemMail({
      to: contact.email,
      subject: composed.text.split("\n")[0]!.replace(/\s+/g, " "),
      text: [
        composed.text,
        "",
        ...projects.filter(hasNews).map((p) => `${p.projectName}: ${origin}/p/${p.projectId}`),
        "--",
        contact.locale === "de"
          ? "Orbit-Briefing. Ändere es in Orbit unter Verwaltung & Einstellungen → Mein Konto → Assistent → Mein Kontext."
          : "Orbit briefing. Change it in Orbit under Administration & settings → My account → Assistant → My context.",
      ].join("\n"),
    });
    mail = result.status === "failed" ? `failed:${result.code}` : result.status;
  }
  let summary = "off";
  // The only AI step: an opt-in summary, at most once per slot.
  if (preferences.briefing.aiSummary && !composed.empty) {
    let result: Awaited<ReturnType<typeof summarizeBriefing>> | null = null;
    try {
      result = await summarizeBriefing(personal, {
        slot: slotKey,
        locale: contact.locale,
        briefing: projects.filter(hasNews),
      });
    } catch {
      result = null;
    }
    if (result?.status === "ok") {
      summary = "ok";
      await userScoped(personal, (tx) =>
        appendNotice(
          tx,
          personal,
          conversationId,
          { kind: "briefing_summary", key: `briefing_summary:${slotKey}` },
          result.output.summary,
        ),
      );
    } else {
      // The deterministic briefing stands; the failure is a signal.
      const code = result ? result.code : "UNEXPECTED";
      summary = `failed:${code}`;
      await scoped(personal.workspaceId, personal.projectId, (tx) =>
        publishEvent(tx, personal, {
          type: BRIEFING_SUMMARY_FAILED_EVENT,
          subject: { type: "platform.briefing_job", id: jobId },
          actor: { kind: "system", id: null },
          origin: "platform.briefings",
          data: { slot: slotKey, code },
        }),
      );
    }
  }
  return record({ status: "done", projects: projects.length, empty: composed.empty, mail, summary, local: localOf(slot, preferences.timeZone) });
}

export const briefingJob: JobDef = {
  queueClass: BRIEFING_QUEUE,
  // A briefing with an AI summary may take a minute.
  leaseMs: 180_000,
  handler: ({ scope, jobId }) => runBriefing(scope, jobId),
};
