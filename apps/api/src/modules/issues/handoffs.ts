import { z } from "zod";
import type { HandoffTarget } from "../../platform/handoffs/types.ts";
import type { EventSubscription } from "../../platform/events/types.ts";
import { createLink } from "../../platform/links/links.ts";
import { audit, DomainError } from "../../shared.ts";
import { componentKey, ISSUE_TYPE, ISSUE_TYPES, issueEvent, issueKey, SEVERITIES, uuid, type IssueActor } from "./common.ts";
import { issuesActive, requireIssues } from "./gate.ts";
import { ingestReport } from "./intake.ts";
import { ISSUES_REPORT } from "./permissions.ts";
import { SUPPORT_TICKET_SYSTEM } from "./reports.ts";

// Support's hand-in (ADR 0018, plan §2.4): a ticket becomes a report on a
// new or chosen issue, linked `reported_in` to the ticket. Support passes
// the text an agent wrote or confirmed and the contact's names, which are
// removed from it; the issue keeps no customer identity. The ticket stays
// unchanged, and Support never imports this module.

const reportInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    symptoms: z.string().trim().max(4000).default(""),
    type: z.enum(ISSUE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    components: z.array(componentKey).max(20).default([]),
    issueId: uuid.optional(),
    /** The contact's names, only to remove them; never stored. */
    names: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  })
  .strict();

const report: HandoffTarget = {
  label: { en: "Report as product issue", de: "Als Produkt-Issue melden" },
  accepts: ["support.ticket"],
  permission: ISSUES_REPORT,
  risk: "W0_internal",
  input: reportInput,
  async create(tx, scope, from, raw, actor) {
    await requireIssues(tx, scope);
    const input = reportInput.parse(raw);
    const result = await ingestReport(
      tx,
      scope,
      {
        sourceKind: "support",
        externalRef: { system: SUPPORT_TICKET_SYSTEM, id: from.id },
        title: input.title,
        symptoms: input.symptoms,
        typeHint: input.type,
        severityHint: input.severity,
        componentHints: input.components,
      },
      actor as IssueActor,
      { names: input.names, issueId: input.issueId },
    );
    try {
      await createLink(
        tx,
        scope,
        { source: { type: ISSUE_TYPE, id: result.issueId }, target: from, relation: "reported_in" },
        actor,
      );
    } catch (error) {
      // A ticket reported again keeps its one link.
      if (!(error instanceof DomainError && error.code === "LINK_EXISTS")) throw error;
    }
    return { target: { type: ISSUE_TYPE, id: result.issueId } };
  },
};

export const issuesHandoffTargets = { report };

const ERASED = "[removed on erasure]";

/**
 * Support erased a contact (`support.contact.erased`): reports from their
 * tickets lose their texts and diagnostics, keeping their counts; an
 * issue whose title or summary is still the report's text loses it too.
 */
export const erasureSubscriber: EventSubscription = {
  name: "issues.erasure",
  types: ["support.contact.erased"],
  async handler(tx, scope, event) {
    if (!(await issuesActive(tx, scope))) return;
    const ticketIds = z.array(uuid).max(1000).catch([]).parse(event.data.ticketIds);
    if (!ticketIds.length) return;
    const reports = await tx.issueReport.findMany({
      where: { projectId: scope.projectId, externalSystem: SUPPORT_TICKET_SYSTEM, externalId: { in: ticketIds }, erasedAt: null },
    });
    const actor: IssueActor = { kind: "system", id: null, origin: "issues.erasure" };
    for (const r of reports) {
      await tx.issueReport.update({
        where: { id: r.id },
        data: { title: ERASED, symptoms: ERASED, diagnostics: {}, externalUrl: null, erasedAt: new Date() },
      });
      const issue = await tx.issue.findFirst({ where: { projectId: scope.projectId, id: r.issueId } });
      if (issue && (issue.title === r.title || (issue.summary && issue.summary === r.symptoms)))
        await tx.issue.update({
          where: { id: issue.id },
          data: {
            ...(issue.title === r.title ? { title: `${issueKey(issue.number)} ${ERASED}` } : {}),
            ...(issue.summary && issue.summary === r.symptoms ? { summary: null } : {}),
            shareReviewedAt: null,
            shareReviewedBy: null,
            version: { increment: 1 },
          },
        });
      await issueEvent(tx, scope, r.issueId, "erased", actor, {}, { reportId: r.id });
      await audit(tx, scope, "issues.report.erased", r.id, { issueId: r.issueId });
    }
  },
};
