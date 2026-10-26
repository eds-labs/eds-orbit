import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { approvedOperation, readOperation } from "../../platform/tasks/operation-tools.ts";
import { ISSUES_SCOPE, WORK_SCOPE } from "../../platform/mcp/scopes.ts";
import type { RequestedBy } from "../action-requests.ts";
import { DomainError } from "../../shared.ts";
import { componentKey, ISSUE_TYPES, issueKey, PRIORITIES, SEVERITIES, type IssueActor } from "./common.ts";
import { ingestReport } from "./intake.ts";
import { assertTaxonomy, loadIssue, setIssueStatus, updateIssue } from "./issues.ts";
import { mergeIssue } from "./merge.ts";
import { ISSUES_READ, ISSUES_REPORT, ISSUES_TRIAGE } from "./permissions.ts";
import { issueDetail, listIssues } from "./queries.ts";
import { readIssuesSettings } from "./settings.ts";
import { issuesOverview } from "./stats.ts";
import { assertTransition, ISSUE_STATUSES } from "./status.ts";
import { createTaskFromIssue } from "./tasks.ts";

// The issue center's assistant and MCP tools (plan §6): four reads and
// four proposals. Texts are redacted at intake; diagnostics never leave
// through a tool. Proposals become exact approval requests an owner or
// editor decides; nothing changes before. Over MCP every tool needs the
// explicit content scope orbit:issues.

const shared = { module: "issues", feature: "issues" as const, mcpScopes: [ISSUES_SCOPE] };
const proposal = {
  ...shared,
  deciderRole: "editor" as const,
  mcpProjectRequired: true,
  policyRequired: false,
  requires: [] as const,
};

const actorOf = (scope: Scope, requester?: RequestedBy): IssueActor => ({
  kind: requester?.kind === "mcp" ? "mcp" : "agent",
  id: scope.userId,
});
const number = z.int().min(1);

async function issueByNumber(tx: DbTx, scope: Scope, n: number) {
  const row = await tx.issue.findFirst({ where: { projectId: scope.projectId, number: n }, select: { id: true } });
  if (!row) throw new DomainError("ISSUES_NOT_FOUND", 404);
  return row.id;
}

// --------------------------------------------------------------- reads

export const issuesSearch = readOperation({
  ...shared,
  name: "issues_search",
  description:
    "Find product issues by words or ISS-number, filtered by status (open, triage, all or one status), severity and component. Returns redacted titles, counts and the version to pass to proposals.",
  input: z
    .object({
      query: z.string().trim().max(200).optional(),
      status: z.union([z.enum(ISSUE_STATUSES), z.enum(["open", "triage", "all"])]).optional(),
      severity: z.enum(SEVERITIES).optional(),
      component: componentKey.optional(),
      limit: z.int().min(1).max(50).optional(),
    })
    .strict(),
  permission: ISSUES_READ,
  async run(tx, scope, args) {
    const page = await listIssues(tx, scope, {
      ...(args.query ? { q: args.query } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.component ? { component: args.component } : {}),
      limit: args.limit ?? 20,
    });
    return {
      total: page.total,
      items: page.items.map((i) => ({
        key: i.key,
        number: i.number,
        title: i.title,
        type: i.type,
        status: i.status,
        severity: i.severity,
        priority: i.priority,
        components: i.components,
        reports: i.reportCount,
        tickets: i.ticketCount,
        tasks: i.counts.tasks,
        lastSeenAt: i.lastSeenAt,
        version: i.version,
      })),
    };
  },
});

export const issuesGet = readOperation({
  ...shared,
  name: "issues_get",
  description:
    "Read one issue by number: fields, version, redacted reports (no diagnostics), pending duplicate candidates, linked tasks and tickets (ticket titles stay in Orbit), deliveries and recent history.",
  input: z.object({ number }).strict(),
  permission: ISSUES_READ,
  async run(tx, scope, args) {
    const d = await issueDetail(tx, scope, await issueByNumber(tx, scope, args.number));
    const { aiTriage: _ai, ...issue } = d.issue;
    return {
      issue,
      // Diagnostics never leave through a tool (plan §6).
      reports: d.reports.slice(0, 10).map((r) => ({
        sourceKind: r.sourceKind,
        title: r.title,
        symptoms: r.symptoms,
        occurredAt: r.occurredAt,
        erased: r.erased,
      })),
      duplicateCandidates: d.duplicateCandidates.map((c) => ({ key: c.issue?.key ?? null, score: c.score, reasons: c.reasons })),
      links: d.links.map((l) => ({
        relation: l.relation,
        type: l.object.type,
        state: l.object.state,
        status: l.object.status,
        title: l.object.state === "ok" && !l.object.sensitive ? l.object.title : undefined,
      })),
      progress: d.progress,
      deliveries: d.deliveries.map((x) => ({ kind: x.kind, environment: x.environment, observedAt: x.observedAt })),
      history: d.timeline.slice(0, 15).map((e) => ({ at: e.createdAt, type: e.type })),
    };
  },
});

export const issuesStats = readOperation({
  ...shared,
  name: "issues_stats",
  description: "The issue center's dashboard numbers: open, critical, awaiting triage, fix ready, released, by component and source, and median lead times in hours.",
  input: z.object({}).strict(),
  permission: ISSUES_READ,
  async run(tx, scope) {
    const o = await issuesOverview(tx, scope);
    return { metrics: o.metrics, byStatus: o.byStatus, byComponent: o.byComponent, bySource: o.bySource, leadTimesHours: o.leadTimesHours };
  },
});

export const issuesDuplicates = readOperation({
  ...shared,
  name: "issues_duplicates",
  description: "Pending duplicate candidates of one issue by number, with score and reason codes. Merging needs a person's approval.",
  input: z.object({ number }).strict(),
  permission: ISSUES_READ,
  async run(tx, scope, args) {
    const d = await issueDetail(tx, scope, await issueByNumber(tx, scope, args.number));
    return { items: d.duplicateCandidates };
  },
});

// ----------------------------------------------------------- proposals

const reportInput = z
  .object({
    issueNumber: number.optional(),
    title: z.string().trim().min(1).max(200),
    symptoms: z.string().trim().max(4000).optional(),
    type: z.enum(ISSUE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    components: z.array(componentKey).max(20).optional(),
  })
  .strict();

export const issuesProposeReport = approvedOperation({
  ...proposal,
  name: "issues_propose_report",
  description:
    "Propose a product issue report: a new issue, or a report on an existing issue by number. Never include customer names, e-mail addresses or account identifiers; Orbit redacts them anyway.",
  input: reportInput,
  permission: ISSUES_REPORT,
  summary: (args) => ({ operation: { kind: "issue_report", title: args.title, issueNumber: args.issueNumber ?? null } }),
  async validate(tx, scope, args) {
    if (args.issueNumber) await issueByNumber(tx, scope, args.issueNumber);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof reportInput>;
    const issueId = input.issueNumber ? await issueByNumber(tx, scope, input.issueNumber) : undefined;
    const result = await ingestReport(
      tx,
      scope,
      {
        sourceKind: "manual",
        title: input.title,
        symptoms: input.symptoms ?? "",
        typeHint: input.type,
        severityHint: input.severity,
        componentHints: input.components ?? [],
      },
      actorOf(scope, requester),
      { issueId },
    );
    return { outcome: result.outcome, issueId: result.issueId, candidates: result.candidates };
  },
});

const updateInput = z
  .object({
    number,
    expectedVersion: z.int().min(1),
    changes: z
      .object({
        status: z.enum(ISSUE_STATUSES).optional(),
        type: z.enum(ISSUE_TYPES).optional(),
        severity: z.enum(SEVERITIES).nullable().optional(),
        priority: z.enum(PRIORITIES).nullable().optional(),
        components: z.array(componentKey).max(20).optional(),
        assigneeUserId: z.string().min(1).max(100).nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        summary: z.string().max(10_000).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const issuesProposeUpdate = approvedOperation({
  ...proposal,
  name: "issues_propose_update",
  description:
    "Propose changes to one issue by number with the version you read: status (validated by the status machine), type, severity, priority, components, assignee, title or summary. Refused if the issue changed meanwhile.",
  input: updateInput,
  permission: ISSUES_TRIAGE,
  summary: (args) => ({ operation: { kind: "issue_update", number: args.number, fields: Object.keys(args.changes ?? {}) } }),
  async validate(tx, scope, args) {
    const input = args as z.infer<typeof updateInput>;
    const issue = await loadIssue(tx, scope, await issueByNumber(tx, scope, input.number));
    if (issue.version !== input.expectedVersion) throw new DomainError("ISSUES_VERSION_CONFLICT", 409);
    if (input.changes.status === "duplicate") throw new DomainError("ISSUES_MERGE_REQUIRED", 409);
    if (input.changes.status && input.changes.status !== issue.status) assertTransition(issue.status, input.changes.status);
    assertTaxonomy((await readIssuesSettings(tx, scope)).settings, input.changes);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof updateInput>;
    const id = await issueByNumber(tx, scope, input.number);
    const { status, ...fields } = input.changes;
    const actor = actorOf(scope, requester);
    let row = Object.keys(fields).length
      ? await updateIssue(tx, scope, id, { expectedVersion: input.expectedVersion, ...fields }, actor)
      : await loadIssue(tx, scope, id);
    if (status && status !== row.status) row = await setIssueStatus(tx, scope, id, { status, expectedVersion: row.version }, actor);
    return { key: issueKey(row.number), version: row.version, status: row.status };
  },
});

const mergeInput = z.object({ number, intoNumber: number, expectedVersion: z.int().min(1) }).strict();

export const issuesProposeMerge = approvedOperation({
  ...proposal,
  name: "issues_propose_merge",
  description:
    "Propose merging one issue (number, with its version) into another (intoNumber) as its duplicate. Every report and link moves to the kept issue; a person approves it.",
  input: mergeInput,
  permission: ISSUES_TRIAGE,
  summary: (args) => ({ operation: { kind: "issue_merge", number: args.number, intoNumber: args.intoNumber } }),
  async validate(tx, scope, args) {
    const input = args as z.infer<typeof mergeInput>;
    if (input.number === input.intoNumber) throw new DomainError("ISSUES_MERGE_SELF", 422);
    const issue = await loadIssue(tx, scope, await issueByNumber(tx, scope, input.number));
    const target = await loadIssue(tx, scope, await issueByNumber(tx, scope, input.intoNumber));
    if (issue.version !== input.expectedVersion) throw new DomainError("ISSUES_VERSION_CONFLICT", 409);
    if (issue.status === "duplicate" || target.status === "duplicate") throw new DomainError("ISSUES_ISSUE_MERGED", 409);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof mergeInput>;
    const result = await mergeIssue(
      tx,
      scope,
      await issueByNumber(tx, scope, input.number),
      { targetIssueId: await issueByNumber(tx, scope, input.intoNumber), expectedVersion: input.expectedVersion },
      actorOf(scope, requester),
    );
    return { reports: result.reports, links: result.links };
  },
});

const taskInput = z.object({ number, initiativeId: z.uuid().optional() }).strict();

export const issuesProposeTask = approvedOperation({
  ...proposal,
  mcpScopes: [ISSUES_SCOPE, WORK_SCOPE],
  name: "issues_propose_task",
  description:
    "Propose a development task for a confirmed issue by number, optionally in an initiative. The task is built from the issue's redacted fields and implements it; it needs project management too.",
  input: taskInput,
  permission: ISSUES_TRIAGE,
  summary: (args) => ({ operation: { kind: "issue_task", number: args.number } }),
  async validate(tx, scope, args) {
    const issue = await loadIssue(tx, scope, await issueByNumber(tx, scope, args.number));
    if (["new", "triage", "needs_info"].includes(issue.status)) throw new DomainError("ISSUES_NOT_CONFIRMED", 409);
  },
  async run(tx, scope, args, requester) {
    const input = args as z.infer<typeof taskInput>;
    return createTaskFromIssue(
      tx,
      scope,
      await issueByNumber(tx, scope, input.number),
      input.initiativeId ? { initiativeId: input.initiativeId } : {},
      actorOf(scope, requester),
    );
  },
});

const proposals = [issuesProposeReport, issuesProposeUpdate, issuesProposeMerge, issuesProposeTask];

/** The module's tools: reads first, then proposals. */
export const issuesTools = [issuesSearch, issuesGet, issuesStats, issuesDuplicates, ...proposals.map((p) => p.tool)];

/** The proposals' approval request types. */
export const issuesActionTypes = Object.fromEntries(proposals.map((p) => [p.actionType, p.action]));

/** The assistant prompt fragment: short, factual, English. */
export const issuesInstructions = [
  "Issue center (module issues): product issues (ISS-12) aggregate redacted reports from Support, people and webhooks and are implemented by tasks. Status runs new → triage → confirmed → planned → in_progress → fix_ready (merged, not deployed) → released (in production) → verified → closed. Look issues up with issues_search or issues_get before proposing, pass the version you read, never put customer names or addresses into a report, and never claim a fix is live unless the issue is released. Proposals change nothing until a member approves them in Orbit.",
];
