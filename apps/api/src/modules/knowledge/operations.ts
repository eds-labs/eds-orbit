import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  sourceExpiry,
  tracksFreshness,
} from "../../../../../packages/knowledge/src/index.ts";
import { notify } from "../../platform/notifications/notify.ts";
import { notifyMembers } from "../../platform/notifications/members.ts";
import type { NotificationContribution } from "../../platform/notifications/types.ts";
import { resolveRecipients } from "../../platform/signals/deliver.ts";
import { inProject, aiBudgetLink } from "../../platform/management/links.ts";
import { create, data, entity, update } from "../../shared.ts";

export const KNOWLEDGE_OPERATIONS = "knowledge_operations_settings";
export const KNOWLEDGE_ISSUES = "knowledge_issues";
const PROBLEM = "knowledge_operation_problem";
const RECOVERED = "knowledge_operation_recovered";

const settingsInput = z
  .object({
    monitoring: z.boolean().optional(),
    reviewExperience: z.boolean().optional(),
    automation: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0);

export async function lockKnowledge(tx: DbTx, s: Scope) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${s.projectId + ":knowledge-workspace"}, 0))`;
}

const projectWhere = (s: Scope) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
});

async function settingsRow(tx: DbTx, s: Scope) {
  return tx.entity.findFirst({
    where: { ...projectWhere(s), kind: KNOWLEDGE_OPERATIONS },
  });
}

export async function knowledgeOperationsSettings(tx: DbTx, s: Scope) {
  const d = data(await settingsRow(tx, s));
  return {
    monitoring: d.monitoring === true,
    reviewExperience: d.reviewExperience === true,
    automation: d.automation === true,
  };
}

export async function setKnowledgeOperations(tx: DbTx, s: Scope, raw: unknown) {
  const input = settingsInput.parse(raw);
  await lockKnowledge(tx, s);
  const row = await settingsRow(tx, s);
  const value = { ...data(row), ...input };
  if (row) await update(tx, s, row, value);
  else await create(tx, s, KNOWLEDGE_OPERATIONS, value);
  return knowledgeOperationsSettings(tx, s);
}

type Subject = "index" | "source" | "github";

async function openIssue(
  tx: DbTx,
  s: Scope,
  subject: Subject,
  subjectId: string,
) {
  return tx.entity.findFirst({
    where: {
      ...projectWhere(s),
      kind: KNOWLEDGE_ISSUES,
      AND: [
        { data: { path: ["subject"], equals: subject } },
        { data: { path: ["subjectId"], equals: subjectId } },
        { data: { path: ["state"], equals: "open" } },
      ],
    },
  });
}

function messageOf(d: Record<string, any>, de: boolean) {
  if (d.subject === "github")
    return de
      ? "Ein GitHub-Abruf braucht Aufmerksamkeit. Öffne die Quelle für den nächsten Schritt."
      : "A GitHub refresh needs attention. Open the source for the next step.";
  if (d.subject === "source")
    return de
      ? "Eine öffentliche Wissensquelle ist veraltet oder läuft bald ab."
      : "A public knowledge source is stale or nearing expiry.";
  if (d.code === "INDEX_REFRESH_RECONCILIATION_REQUIRED")
    return de
      ? "Eine KI-Abrechnung ist ungeklärt. Prüfe das KI-Budget vor einem neuen Indexlauf."
      : "The AI charge is uncertain. Check the AI budget before another refresh.";
  if (d.code === "PAID_MANDATE_REQUIRED" || String(d.code).includes("BUDGET"))
    return de
      ? "Orbit konnte den Wissensindex wegen der KI-Freigabe oder des Budgets nicht aktualisieren."
      : "AI authorization or budget blocked the knowledge index refresh.";
  if (
    d.code === "INDEX_REFRESH_CHECK_NOT_PASSED" ||
    d.code === "EVALUATION_SET_TOO_SMALL"
  )
    return de
      ? "Der neue Wissensindex erfüllt die Prüfanforderungen noch nicht."
      : "The new knowledge index has not met the validation requirements.";
  return de
    ? "Die Aktualisierung des Wissensindex braucht Aufmerksamkeit."
    : "The knowledge index refresh needs attention.";
}

function issueLink(s: Scope, d: Record<string, any>) {
  if (d.subject !== "index")
    return inProject(
      s.projectId,
      "/knowledge/sources?source=" + encodeURIComponent(d.subjectId),
    );
  if (
    d.code === "PAID_MANDATE_REQUIRED" ||
    d.code === "INDEX_REFRESH_RECONCILIATION_REQUIRED" ||
    String(d.code).includes("BUDGET")
  )
    return aiBudgetLink(s.projectId);
  return inProject(s.projectId, "/knowledge/health?expert=1");
}

export const knowledgeUserNotifications = {
  [PROBLEM]: {
    label: {
      de: "Wissen braucht Aufmerksamkeit",
      en: "Knowledge needs attention",
    },
    emailDefault: false,
  },
  [RECOVERED]: {
    label: { de: "Wissensproblem behoben", en: "Knowledge issue resolved" },
    emailDefault: false,
  },
};

async function announce(
  tx: DbTx,
  s: Scope,
  kind: typeof PROBLEM | typeof RECOVERED,
  id: string,
  d: Record<string, any>,
) {
  const project = await tx.project.findFirstOrThrow({
    where: { id: s.projectId },
    select: { language: true },
  });
  const language = project.language === "de" ? "de" : "en";
  const label = knowledgeUserNotifications[kind].label[language];
  const userIds = (
    await resolveRecipients(s, { roles: ["owner"] }, "knowledge")
  ).slice(0, 200);
  if (userIds.length)
    await notifyMembers(tx, s, {
      kind,
      userIds,
      title: label,
      body: kind === PROBLEM ? messageOf(d, language === "de") : label,
      link: issueLink(s, d),
    });
  const job = await notify(tx, s, kind, id);
  return job?.id ?? null;
}

/** Called while holding the knowledge lock. Source, cause and episode determine deduplication. */
export async function recordKnowledgeIssue(
  tx: DbTx,
  s: Scope,
  subject: Subject,
  subjectId: string,
  code: string,
  at: Date,
) {
  if (!(await knowledgeOperationsSettings(tx, s)).monitoring) return;
  const current = await openIssue(tx, s, subject, subjectId);
  if (current) {
    // A later observation of the same ongoing outage must not enqueue another message.
    if (data(current).code !== code)
      await update(tx, s, current, {
        ...data(current),
        code,
        changedAt: at.toISOString(),
      });
    return;
  }
  const d = {
    subject,
    subjectId,
    code,
    state: "open",
    openedAt: at.toISOString(),
  };
  const row = await create(tx, s, KNOWLEDGE_ISSUES, d);
  const alertJobId = await announce(tx, s, PROBLEM, row.id, d);
  await update(tx, s, row, { ...d, alertJobId });
}

export async function resolveKnowledgeIssue(
  tx: DbTx,
  s: Scope,
  subject: Subject,
  subjectId: string,
  at: Date,
) {
  const row = await openIssue(tx, s, subject, subjectId);
  if (!row) return;
  const d = { ...data(row), state: "resolved", resolvedAt: at.toISOString() };
  const alertJobId = data(row).alertJobId;
  const alert = alertJobId
    ? data(await entity(tx, s, "jobs", alertJobId))
    : null;
  if (
    alert &&
    ["queued", "running", "retry_scheduled"].includes(alert.status) &&
    (alert.notification?.outcome === "sending" || !alert.notification)
  ) {
    await update(tx, s, row, { ...d, state: "recovering" });
    return;
  }
  let recoveryJobId = null;
  if ((await knowledgeOperationsSettings(tx, s)).monitoring)
    recoveryJobId = await announce(tx, s, RECOVERED, row.id, d);
  await update(tx, s, row, { ...d, recoveryJobId });
}

export const knowledgeTelegramNotifications: NotificationContribution = {
  kinds: [PROBLEM, RECOVERED],
  preserveUncertainDelivery: true,
  async render(tx, s, kind, id) {
    if (!(await knowledgeOperationsSettings(tx, s)).monitoring)
      return { skip: "DISABLED" };
    const d = data(await entity(tx, s, KNOWLEDGE_ISSUES, id));
    if (
      (kind === PROBLEM && !["open", "recovering"].includes(d.state)) ||
      (kind === RECOVERED && d.state !== "resolved")
    )
      return { skip: "STALE" };
    if (kind === RECOVERED) {
      const alert = d.alertJobId
        ? data(await entity(tx, s, "jobs", d.alertJobId)).notification
        : null;
      if (alert?.outcome !== "sent") return { skip: "NO_DELIVERED_ALERT" };
    }
    const project = await tx.project.findFirstOrThrow({
      where: { id: s.projectId },
      select: { name: true, language: true },
    });
    const de = project.language === "de";
    const label =
      knowledgeUserNotifications[kind === PROBLEM ? PROBLEM : RECOVERED].label[
        de ? "de" : "en"
      ];
    return {
      header: label,
      text: [project.name, label, kind === PROBLEM ? messageOf(d, de) : ""]
        .filter(Boolean)
        .join("\n"),
      buttons: [
        {
          text: de ? "In Orbit prüfen" : "Check in Orbit",
          url: loadConfig().APP_ORIGIN.replace(/\/+$/, "") + issueLink(s, d),
        },
      ],
    };
  },
};

export async function sweepKnowledgeRecoveries(tx: DbTx, s: Scope) {
  const operations = await knowledgeOperationsSettings(tx, s);
  if (!operations.monitoring) return;
  const recovering = await tx.entity.findMany({
    where: {
      ...projectWhere(s),
      kind: KNOWLEDGE_ISSUES,
      data: { path: ["state"], equals: "recovering" },
    },
    take: 50,
  });
  for (const row of recovering) {
    const d = data(row);
    const alert = data(await entity(tx, s, "jobs", d.alertJobId));
    if (
      (alert.notification?.outcome === "sending" || !alert.notification) &&
      ["queued", "running", "retry_scheduled"].includes(alert.status)
    )
      continue;
    const newer = await openIssue(tx, s, d.subject, d.subjectId);
    const resolved = { ...d, state: "resolved" };
    const recoveryJobId =
      !newer && alert.notification?.outcome === "sent"
        ? await announce(tx, s, RECOVERED, row.id, resolved)
        : null;
    await update(tx, s, row, { ...resolved, recoveryJobId });
  }
}

export async function sweepKnowledgeSources(tx: DbTx, s: Scope, at: Date) {
  if (!(await knowledgeOperationsSettings(tx, s)).monitoring) return;
  const sources = await tx.entity.findMany({
    where: { ...projectWhere(s), kind: "sources" },
  });
  for (const row of sources) {
    const d = data(row);
    const expiry = sourceExpiry(d, at.getTime());
    const active =
      d.status === "active" && d.publicUse === true && tracksFreshness(d);
    if (
      active &&
      expiry.expiresAt &&
      expiry.expiresAt.getTime() - at.getTime() <= 86400000
    )
      await recordKnowledgeIssue(
        tx,
        s,
        "source",
        row.id,
        "PUBLIC_SOURCE_EXPIRY",
        at,
      );
    else if (active) await resolveKnowledgeIssue(tx, s, "source", row.id, at);
    else {
      // Deliberately paused or revoked sources are no longer actionable.
      const issue = await openIssue(tx, s, "source", row.id);
      if (issue)
        await update(tx, s, issue, { ...data(issue), state: "dismissed" });
    }
  }
}

export async function knowledgeIssueViews(tx: DbTx, s: Scope) {
  const rows = await tx.entity.findMany({
    where: {
      ...projectWhere(s),
      kind: KNOWLEDGE_ISSUES,
      data: { path: ["state"], equals: "open" },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return Promise.all(
    rows.map(async (row) => {
      const d = data(row);
      const job = d.alertJobId
        ? await tx.entity.findFirst({
            where: { ...projectWhere(s), kind: "jobs", id: d.alertJobId },
          })
        : null;
      return {
        id: row.id,
        subject: String(d.subject),
        code: String(d.code),
        openedAt: String(d.openedAt),
        href: issueLink(s, d),
        label: { de: messageOf(d, true), en: messageOf(d, false) },
        telegram: String(
          data(job).notification?.outcome ?? (job ? "pending" : "unavailable"),
        ),
      };
    }),
  );
}
