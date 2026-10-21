import { z } from "zod";
import { defineTool } from "../../agents/tools/registry.ts";
import {
  PROJECT_READ,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { chatScoped } from "../../chat.ts";
import { data } from "../../../shared.ts";
import { planAccess } from "../plans/service.ts";
import { REPORT_KIND, proposeReportRevision } from "../analytics/reports.ts";
import { planCard } from "./plan-tools.ts";
export const reportTools = [
  defineTool({
    name: "marketing_report_status",
    namespace: "marketing",
    description:
      "Saved periodic reports: source/period, explicit noData, coverage and proposal IDs. Project measurements are not plan totals; never infer a complete four-channel analysis from the specialist sample.",
    parameters: z.object({ planId: z.string().nullable() }).strict(),
    risk: "R0_read",
    permission: PROJECT_READ,
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { planId } = z.object({ planId: z.uuid().nullable() }).parse(args);
      const output = await chatScoped(context.scope, async (tx) => {
        await planAccess(tx, context.scope);
        const rows = await tx.entity.findMany({
          where: {
            workspaceId: context.scope.workspaceId,
            projectId: context.scope.projectId,
            kind: REPORT_KIND,
            ...(planId ? { data: { path: ["planId"], equals: planId } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: 4,
        });
        return {
          truncated: rows.length > 3,
          reports: rows.slice(0, 3).map((r) => {
            const d = data(r);
            return {
              id: r.id,
              version: r.version,
              planId: d.planId,
              period: d.period,
              status: d.status,
              revision: d.revision,
              generatedAt: d.generatedAt,
              noData: d.noData,
              complete: d.complete,
              coverage: d.coverage,
              sourceGroups: d.planReports.slice(0, 3).map((g: any) => ({
                source: g.source,
                accountId: g.accountId,
                freshness: g.freshness,
                report: g.report,
                currency: g.currency,
                timezone: g.timezone,
                complete: g.complete,
                sessions: g.sessions,
                clicks: g.clicks,
                impressions: g.impressions,
                conversions: g.conversions,
              })),
              projectSourceGroupCount: d.projectReports.length,
              planSourceGroupCount: d.planReports.length,
              groupsTruncated: d.planReports.length > 3,
              proposedPlanId: d.revisionProposal?.proposedPlanId ?? null,
              href: `/p/${context.scope.projectId}/marketing/analytics?report=${r.id}`,
            };
          }),
        };
      });
      return { output, cards: [] };
    },
  }),
  defineTool({
    name: "marketing_report_propose_revision",
    namespace: "marketing",
    description:
      "Prepare a separate native plan proposal from a saved report and exact version. Starts no work and changes no active mandate. Owner strategy review and exact activation remain mandatory.",
    parameters: z
      .object({ reportId: z.string(), version: z.number().int().positive() })
      .strict(),
    risk: "P_proposal",
    permission: PROJECT_WRITE,
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const { reportId, version } = z
        .object({ reportId: z.uuid(), version: z.number().int().positive() })
        .parse(args);
      const plan = await chatScoped(context.scope, (tx) =>
        proposeReportRevision(tx, context.scope, reportId, version),
      );
      return {
        output: {
          id: plan.id,
          status: plan.status,
          revision: plan.revision,
          actionRequestId: plan.actionRequest?.id ?? null,
        },
        cards: [planCard(plan)],
      };
    },
  }),
];
