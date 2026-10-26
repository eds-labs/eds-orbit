import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import type { IssueActor } from "./common.ts";
import { suggestDuplicates } from "./duplicates.ts";
import { createIssue, loadIssue } from "./issues.ts";
import { attachReport, findExternalReport, normalizedReport, redactReport } from "./reports.ts";
import { readIssuesSettings } from "./settings.ts";

// Intake (plan §2.4): the same pipeline for every source. The caller has
// authenticated the input (a signed webhook or a member); here it is
// bounded, normalized, redacted, matched cheapest first and attached to an
// existing issue or turned into a new one with lexical duplicate
// candidates. Only redacted text is stored; raw payloads never.

const DAY = 86_400_000;
const startOfDay = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);
/** Recently closed issues still take reports with their fingerprint. */
const REOPEN_DAYS = 30;

export type IntakeResult = {
  outcome: "created" | "attached" | "duplicate";
  /** How a report found its issue: a reference, a fingerprint or nothing (new). */
  method: "external_ref" | "fingerprint" | "new" | "target";
  issueId: string;
  reportId: string;
  candidates: number;
};

/** Throws 429 ISSUES_DAILY_CAP when the project took its reports for today. */
async function enforceCap(tx: DbTx, scope: Scope, cap: number, sourceKind: string) {
  const today = await tx.issueReport.count({
    where: { projectId: scope.projectId, receivedAt: { gte: startOfDay(new Date()) } },
  });
  if (today < cap) return;
  await audit(tx, scope, "issues.intake.dropped", scope.projectId, { sourceKind, reason: "daily_cap" });
  throw new DomainError("ISSUES_DAILY_CAP", 429);
}

/**
 * Takes one report. `issueId` attaches it to that issue (a person's choice);
 * otherwise an external reference (stage 2) or a fingerprint (stage 1)
 * finds its issue, or a new issue is created. `names` are names the caller
 * knows (a Support contact's), removed from every text.
 */
export async function ingestReport(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: IssueActor,
  options: { names?: readonly string[]; issueId?: string } = {},
): Promise<IntakeResult> {
  const input = normalizedReport.parse(raw);
  const { settings } = await readIssuesSettings(tx, scope);
  // The cap bounds floods from integrations; members are not capped.
  if (actor.kind !== "user") await enforceCap(tx, scope, settings.intake.dailyReportCap, input.sourceKind);
  const attach = async (issueId: string, method: IntakeResult["method"]): Promise<IntakeResult> => {
    const { report, duplicate } = await attachReport(tx, scope, issueId, input, actor, { names: options.names });
    return { outcome: duplicate ? "duplicate" : "attached", method, issueId: report.issueId, reportId: report.id, candidates: 0 };
  };
  if (options.issueId) return attach((await loadIssue(tx, scope, options.issueId)).id, "target");
  if (input.externalRef) {
    const seen = await findExternalReport(tx, scope, input.sourceKind, input.externalRef);
    if (seen) return { outcome: "duplicate", method: "external_ref", issueId: seen.issueId, reportId: seen.id, candidates: 0 };
    const ref = await tx.issueExternalRef.findFirst({
      where: { projectId: scope.projectId, system: input.externalRef.system, externalId: input.externalRef.id },
    });
    if (ref) return attach(await surviving(tx, scope, ref.issueId), "external_ref");
  }
  if (input.fingerprint && settings.dedupe.autoAttachFingerprint) {
    const match = await tx.issue.findFirst({
      where: {
        projectId: scope.projectId,
        fingerprint: input.fingerprint,
        status: { not: "duplicate" },
        OR: [{ closedAt: null }, { closedAt: { gte: new Date(Date.now() - REOPEN_DAYS * DAY) } }],
      },
      orderBy: { lastSeenAt: "desc" },
    });
    if (match) return attach(match.id, "fingerprint");
  }
  // A new issue starts from the redacted report; triage curates it.
  const clean = redactReport(input, options.names);
  const configured = new Set(settings.components.map((c) => c.key));
  const issue = await createIssue(
    tx,
    scope,
    {
      type: input.typeHint ?? "bug",
      title: clean.title,
      summary: clean.symptoms || undefined,
      components: input.componentHints.filter((c) => configured.has(c)),
    },
    actor,
    { fingerprint: input.fingerprint, firstSeenAt: input.occurredAt, environment: input.environment },
  );
  const { report } = await attachReport(tx, scope, issue.id, input, actor, { names: options.names });
  const candidates = await suggestDuplicates(tx, scope, await loadIssue(tx, scope, issue.id), actor);
  return { outcome: "created", method: "new", issueId: issue.id, reportId: report.id, candidates };
}

/** A merged issue's reports go to the issue it was merged into. */
async function surviving(tx: DbTx, scope: Scope, issueId: string) {
  let issue = await loadIssue(tx, scope, issueId);
  for (let hops = 0; issue.mergedIntoIssueId && hops < 10; hops++)
    issue = await loadIssue(tx, scope, issue.mergedIntoIssueId);
  return issue.id;
}
