import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { decidableBy } from "../governance/action-requests.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { AGENTS_MANAGE } from "../tenancy/permissions.ts";
import { assistantRequester } from "../assistant/notices.ts";
import type { UserNotificationKind } from "../notifications/members.ts";
import { BUDGET_THRESHOLD_EVENT } from "./budget-threshold.ts";
import type { SignalDefinition, SignalFinding } from "./types.ts";

// The platform's initial signals (plan §2.2): failed agent work (scenario
// E, replacing the Phase 1 guard), finished assistant delegations, budget
// thresholds and aging approvals. Titles carry ids, counts and codes only.

const DAY = 86_400_000;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);
const TERMINAL = new Set(["succeeded", "failed", "blocked", "canceled", "outcome_unknown"]);

/** The member notification kinds these signals write (with `agent_work_failed`). */
export const signalUserNotifications: Readonly<Record<string, UserNotificationKind>> = {
  assistant_delegation_done: {
    label: { en: "Delegated work finished", de: "Delegierte Arbeit erledigt" },
    emailDefault: false,
    proactive: true,
  },
  ai_budget_threshold: {
    label: { en: "AI budget threshold reached", de: "KI-Budgetschwelle erreicht" },
    emailDefault: true,
    proactive: true,
  },
  approval_aging: {
    label: { en: "Approval waiting for more than a day", de: "Freigabe wartet seit über einem Tag" },
    emailDefault: false,
    proactive: true,
  },
  assistant_briefing_summary_failed: {
    label: { en: "Briefing summary failed", de: "Briefing-Zusammenfassung fehlgeschlagen" },
    emailDefault: false,
    proactive: true,
  },
};

/** Published by the briefing job when the opt-in AI summary failed (proactive/briefing.ts). */
export const BRIEFING_SUMMARY_FAILED = "platform.assistant.briefing_summary_failed";

export const agentWorkFailedSignal: SignalDefinition = {
  key: "platform.agent_work_failed",
  kind: "agent_work_failed",
  title: { en: "Failed agent runs", de: "Fehlgeschlagene Agenten-Ausführungen" },
  titles: {
    failed: { en: "An agent run did not finish ({code})", de: "Eine Agenten-Ausführung wurde nicht beendet ({code})" },
  },
  source: { event: ["platform.agent.work_order.failed"] },
  async detect(tx, scope, input) {
    if (!("event" in input)) return [];
    const event = input.event;
    const row = await tx.agentWorkOrder.findFirst({
      where: { id: event.subject.id, projectId: scope.projectId },
      select: { agentId: true, sponsorUserId: true, target: true, errorCode: true },
    });
    if (!row?.agentId || row.target !== "agent") return [];
    const code = String(event.data.code ?? row.errorCode ?? "AGENT_FAILED");
    return [
      {
        // One notice per agent, code and UTC day (scenario E).
        fingerprint: `agent_failed:${row.agentId}:${code}:${utcDay(event.createdAt)}`,
        recipients: {
          userIds: row.sponsorUserId ? [row.sponsorUserId] : [],
          permission: AGENTS_MANAGE,
        },
        severity: "attention",
        titleKey: "failed",
        params: { code },
        link: `/p/${scope.projectId}/agents/${row.agentId}`,
      },
    ];
  },
};

export const delegationDoneSignal: SignalDefinition = {
  key: "platform.delegation_done",
  kind: "assistant_delegation_done",
  title: { en: "Finished assistant delegations", de: "Erledigte Delegationen des Assistenten" },
  titles: {
    done: { en: "{count} delegated work orders finished", de: "{count} delegierte Aufträge erledigt" },
    partial: {
      en: "{done} of {count} delegated work orders finished",
      de: "{done} von {count} delegierten Aufträgen erledigt",
    },
  },
  source: { event: ["platform.agent.work_order.finished", "platform.agent.work_order.failed"] },
  async detect(tx, scope, input) {
    if (!("event" in input)) return [];
    const row = await tx.agentWorkOrder.findFirst({
      where: { id: input.event.subject.id, projectId: scope.projectId },
      select: { requestedBy: true, origin: true },
    });
    if (!row || row.origin !== "assistant") return [];
    const requester = assistantRequester.safeParse(row.requestedBy);
    if (!requester.success) return [];
    const batch = await tx.agentWorkOrder.findMany({
      where: {
        projectId: scope.projectId,
        origin: "assistant",
        requestedBy: { path: ["batchId"], equals: requester.data.batchId },
      },
      select: { status: true },
      take: 10,
    });
    // One notice when the whole batch is over, like the Phase 3 notice.
    if (!batch.length || batch.some((w) => !TERMINAL.has(w.status))) return [];
    const done = batch.filter((w) => w.status === "succeeded").length;
    return [
      {
        fingerprint: `delegation_done:${requester.data.batchId}`,
        recipients: { userIds: [requester.data.userId] },
        severity: "info",
        titleKey: done === batch.length ? "done" : "partial",
        params: { count: batch.length, done },
        link: "/assistant",
      },
    ];
  },
};

export const budgetThresholdSignal: SignalDefinition = {
  key: "platform.budget_threshold",
  kind: "ai_budget_threshold",
  title: { en: "AI budget thresholds", de: "KI-Budgetschwellen" },
  titles: {
    project: { en: "AI budget of this project at {threshold} %", de: "KI-Budget dieses Projekts bei {threshold} %" },
    personal: { en: "Your assistant budget at {threshold} %", de: "Dein Assistenten-Budget bei {threshold} %" },
    organization: {
      en: "Organization AI budget at {threshold} %",
      de: "KI-Budget der Organisation bei {threshold} %",
    },
    provider: {
      en: "Organization {provider} budget at {threshold} %",
      de: "{provider}-Budget der Organisation bei {threshold} %",
    },
  },
  source: { event: [BUDGET_THRESHOLD_EVENT] },
  async detect(tx, scope, input) {
    if (!("event" in input)) return [];
    const d = input.event.data;
    const layer = String(d.layer ?? "");
    const threshold = Number(d.threshold);
    if (!layer || ![80, 100].includes(threshold) || typeof d.key !== "string") return [];
    const project = await tx.project.findFirst({
      where: { id: scope.projectId },
      select: { kind: true },
    });
    const personal = project?.kind === "personal";
    const organization = layer.startsWith("org_");
    return [
      {
        fingerprint: d.key,
        // Project owners for the project's own budget; organization owners
        // for the organization's budgets.
        recipients: organization ? { organizationOwners: true } : { roles: ["owner"] },
        severity: threshold >= 100 ? "urgent" : "attention",
        titleKey: organization
          ? layer === "org_month"
            ? "organization"
            : "provider"
          : personal
            ? "personal"
            : "project",
        params: { threshold, provider: layer.slice(4) },
        link: personal ? "/assistant" : `/p/${scope.projectId}/settings?section=ai`,
      },
    ];
  },
};

/** Members who may be deciders: the project's members and, outside a personal space, the organization's owners. */
async function candidates(scope: Scope) {
  const [owners, members] = await Promise.all([
    authDb.workspaceMember.findMany({
      where: { workspaceId: scope.workspaceId, role: "owner" },
      select: { userId: true },
    }),
    authDb.projectMember.findMany({
      where: { projectId: scope.projectId },
      select: { userId: true },
    }),
  ]);
  const out: Scope[] = [];
  for (const userId of new Set([...owners, ...members].map((m) => m.userId))) {
    const member = await actorScope(scope.workspaceId, scope.projectId, userId);
    if (member) out.push(member);
  }
  return out;
}

export const approvalsAgingSignal: SignalDefinition = {
  key: "platform.approvals_aging",
  kind: "approval_aging",
  title: { en: "Approvals waiting for more than a day", de: "Freigaben, die über einen Tag warten" },
  titles: {
    aging: {
      en: "An approval has been waiting for more than {hours} hours",
      de: "Eine Freigabe wartet seit über {hours} Stunden",
    },
  },
  source: { periodic: { every: "1h" } },
  async detect(tx, scope, input) {
    if (!("at" in input)) return [];
    const at = input.at;
    const rows = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "action_requests",
        data: { path: ["status"], equals: "pending" },
        createdAt: { lt: new Date(at.getTime() - DAY) },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    if (!rows.length) return [];
    const members = await candidates(scope);
    const findings: SignalFinding[] = [];
    for (const row of rows) {
      // Only users who may decide this request (the decisions inbox rule).
      const deciders = members.filter((m) => decidableBy(m, row, at)).map((m) => m.userId);
      if (!deciders.length) continue;
      findings.push({
        fingerprint: `approval_aging:${row.id}:${utcDay(at)}`,
        recipients: { userIds: deciders },
        severity: "attention",
        titleKey: "aging",
        params: { hours: 24 },
        link: `/p/${scope.projectId}/decisions`,
      });
    }
    return findings;
  },
};

export const briefingSummaryFailedSignal: SignalDefinition = {
  key: "platform.briefing_summary_failed",
  kind: "assistant_briefing_summary_failed",
  title: { en: "Failed briefing summaries", de: "Fehlgeschlagene Briefing-Zusammenfassungen" },
  titles: {
    failed: {
      en: "The AI summary of your briefing did not run ({code}); the briefing itself is there",
      de: "Die KI-Zusammenfassung deines Briefings lief nicht ({code}); das Briefing selbst ist da",
    },
  },
  source: { event: [BRIEFING_SUMMARY_FAILED] },
  async detect(tx, scope, input) {
    if (!("event" in input)) return [];
    const project = await tx.project.findFirst({
      where: { id: scope.projectId, kind: "personal" },
      select: { personalUserId: true },
    });
    if (!project?.personalUserId) return [];
    const code = String(input.event.data.code ?? "UNEXPECTED");
    return [
      {
        fingerprint: `briefing_summary_failed:${String(input.event.data.slot ?? input.event.subject.id)}`,
        recipients: { userIds: [project.personalUserId] },
        severity: "info",
        titleKey: "failed",
        params: { code },
        link: "/assistant",
      },
    ];
  },
};

/** The platform's signals, in the order the settings list them. */
export const platformSignals: readonly SignalDefinition[] = [
  agentWorkFailedSignal,
  delegationDoneSignal,
  budgetThresholdSignal,
  approvalsAgingSignal,
  briefingSummaryFailedSignal,
];
