import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { addCounts, redact, type RedactionCounts } from "../../platform/privacy/redact.ts";
import {
  componentKey,
  ISSUE_TYPES,
  issueDomainEvent,
  issueEvent,
  SEVERITIES,
  type IssueActor,
} from "./common.ts";
import { loadIssue, reopenOnReport } from "./issues.ts";

// Source reports (ADR 0018 I-2): one inbound signal each, stored redacted
// with the counts of what was removed. Raw payloads are never stored;
// diagnostics keep allow-listed keys with short values only.

export const REPORT_SOURCES = ["support", "manual", "webhook", "n8n", "sentry", "github", "monitoring"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];
/** The external system of a Support hand-in; its id is the ticket id. */
export const SUPPORT_TICKET_SYSTEM = "orbit_support";

const diagnosticValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

/** A report as a source adapter normalizes it (plan §2.4), before redaction. */
export const normalizedReport = z
  .object({
    sourceKind: z.enum(REPORT_SOURCES),
    sourceConnectionId: z.uuid().optional(),
    externalRef: z
      .object({
        system: z.string().regex(/^[a-z][a-z0-9_.-]{1,40}$/),
        id: z.string().min(1).max(200),
        url: z.url({ protocol: /^https$/ }).max(500).optional(),
      })
      .strict()
      .optional(),
    fingerprint: z.string().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200),
    symptoms: z.string().trim().max(4000).default(""),
    severityHint: z.enum(SEVERITIES).optional(),
    typeHint: z.enum(ISSUE_TYPES).optional(),
    componentHints: z.array(componentKey).max(20).default([]),
    occurredAt: z.coerce.date().optional(),
    environment: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
    release: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/).optional(),
    diagnostics: z
      .record(z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,40}$/), diagnosticValue)
      .refine((d) => Object.keys(d).length <= 30, "at most 30 diagnostics")
      .default({}),
  })
  .strict();
export type NormalizedReport = z.input<typeof normalizedReport>;

const reporterKind = (actor: IssueActor) =>
  actor.kind === "user" ? "user" : actor.kind === "agent" || actor.kind === "mcp" ? "agent" : "integration";

/**
 * The report's texts and diagnostic strings, strictly redacted; `names`
 * are names the caller knows (a Support contact's name).
 */
export function redactReport(input: z.output<typeof normalizedReport>, names: readonly string[] = []) {
  const title = redact(input.title, { names });
  const symptoms = redact(input.symptoms, { names });
  const counts: RedactionCounts[] = [title.counts, symptoms.counts];
  const diagnostics: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input.diagnostics)) {
    if (typeof value !== "string") diagnostics[key] = value;
    else {
      const r = redact(value, { names });
      counts.push(r.counts);
      diagnostics[key] = r.text;
    }
  }
  if (Buffer.byteLength(JSON.stringify(diagnostics)) > 4000)
    throw new DomainError("ISSUES_DIAGNOSTICS_TOO_LARGE", 422);
  return { title: title.text, symptoms: symptoms.text, diagnostics, counts: addCounts(...counts) };
}

/**
 * Attaches a report to an issue: stores it redacted, updates the issue's
 * counters and last occurrence, reopens a closed issue into triage and
 * records history and the content-free `issues.report.received` event.
 * A re-delivered external report returns the stored one (`duplicate`).
 */
export async function attachReport(
  tx: DbTx,
  scope: Scope,
  issueId: string,
  raw: unknown,
  actor: IssueActor,
  options: { names?: readonly string[] } = {},
) {
  const input = normalizedReport.parse(raw);
  const issue = await loadIssue(tx, scope, issueId);
  if (issue.status === "duplicate") throw new DomainError("ISSUES_ISSUE_MERGED", 409);
  const existing = input.externalRef ? await findExternalReport(tx, scope, input.sourceKind, input.externalRef) : null;
  if (existing) return { report: existing, duplicate: true as const };
  const clean = redactReport(input, options.names);
  const now = new Date();
  const occurredAt = input.occurredAt && input.occurredAt < now ? input.occurredAt : now;
  const report = await tx.issueReport.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      issueId: issue.id,
      sourceKind: input.sourceKind,
      sourceConnectionId: input.sourceConnectionId,
      externalSystem: input.externalRef?.system,
      externalId: input.externalRef?.id,
      externalUrl: input.externalRef?.url,
      fingerprint: input.fingerprint,
      title: clean.title,
      symptoms: clean.symptoms,
      diagnostics: clean.diagnostics as Prisma.InputJsonValue,
      redaction: clean.counts as Prisma.InputJsonValue,
      severityHint: input.severityHint,
      typeHint: input.typeHint,
      componentHints: input.componentHints,
      environment: input.environment,
      release: input.release,
      occurredAt,
      reportedByKind: reporterKind(actor),
      reportedById: actor.id,
    },
  });
  const fromTicket = input.externalRef?.system === SUPPORT_TICKET_SYSTEM;
  await tx.issue.update({
    where: { id: issue.id },
    data: {
      reportCount: { increment: 1 },
      ...(fromTicket ? { ticketCount: { increment: 1 } } : {}),
      lastSeenAt: occurredAt > issue.lastSeenAt ? occurredAt : issue.lastSeenAt,
      firstSeenAt: occurredAt < issue.firstSeenAt ? occurredAt : issue.firstSeenAt,
      version: { increment: 1 },
    },
  });
  await issueEvent(tx, scope, issue.id, "report_attached", actor, {}, {
    reportId: report.id,
    sourceKind: report.sourceKind,
    redaction: clean.counts,
  });
  await issueDomainEvent(tx, scope, "issues.report.received", { type: "issues.report", id: report.id }, actor, {
    issueId: issue.id,
    sourceKind: report.sourceKind,
  });
  await reopenOnReport(tx, scope, { ...issue, version: issue.version + 1 }, actor);
  return { report, duplicate: false as const };
}

export function findExternalReport(
  tx: DbTx,
  scope: Scope,
  sourceKind: string,
  ref: { system: string; id: string },
) {
  return tx.issueReport.findFirst({
    where: { projectId: scope.projectId, sourceKind, externalSystem: ref.system, externalId: ref.id },
  });
}

/** Recounts an issue's reports and distinct tickets (after a merge). */
export async function recount(tx: DbTx, scope: Scope, issueId: string) {
  const [reports, tickets] = await Promise.all([
    tx.issueReport.count({ where: { projectId: scope.projectId, issueId } }),
    tx.issueReport.findMany({
      where: { projectId: scope.projectId, issueId, externalSystem: SUPPORT_TICKET_SYSTEM },
      select: { externalId: true },
      distinct: ["externalId"],
    }),
  ]);
  return { reportCount: reports, ticketCount: tickets.length };
}

type ReportRow = NonNullable<Awaited<ReturnType<DbTx["issueReport"]["findFirst"]>>>;

/** A report as members see it; diagnostics only with issues.diagnostics.read. */
export function reportView(row: ReportRow, options: { diagnostics: boolean }) {
  return {
    id: row.id,
    issueId: row.issueId,
    sourceKind: row.sourceKind,
    externalSystem: row.externalSystem,
    // A Support hand-in names its ticket by link, never here.
    externalId: row.externalSystem === SUPPORT_TICKET_SYSTEM ? null : row.externalId,
    externalUrl: row.externalUrl,
    title: row.title,
    symptoms: row.symptoms,
    severityHint: row.severityHint,
    typeHint: row.typeHint,
    componentHints: row.componentHints,
    redaction: row.redaction as RedactionCounts,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    reportedByKind: row.reportedByKind,
    erased: Boolean(row.erasedAt),
    ...(options.diagnostics
      ? {
          diagnostics: row.diagnostics as Record<string, string | number | boolean>,
          environment: row.environment,
          release: row.release,
          fingerprint: row.fingerprint,
        }
      : {}),
  };
}
