import { z } from "zod";
import { jsonSafe } from "../../../../../../packages/db/src/index.ts";
import { marketingPlanSpec } from "../../../../../../packages/schemas/src/index.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { scopeFor } from "../../../platform/tenancy/auth.ts";
import { chatScoped } from "../../chat.ts";
import { data, entity } from "../../../shared.ts";
import { planAccess } from "../plans/service.ts";
import {
  REPORT_KIND,
  persistReport,
  acknowledgeReport,
  proposeReportRevision,
  reportInput,
  reportVersion,
} from "./reports.ts";
const ids = z.object({ projectId: z.uuid(), id: z.uuid() });
const json = (schema: z.ZodType) => {
  const { $schema, ...value } = z.toJSONSchema(schema, { io: "input" });
  return value;
};
const view = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    planId: z.uuid(),
    revision: z.number().int(),
    status: z.string(),
    noData: z.boolean(),
    complete: z.boolean(),
  })
  .passthrough();
export const marketingReportRoutes: RoutesContribution = ({ app, auth }) => {
  const gate =
    (write = false) =>
    async (req: import("fastify").FastifyRequest) => {
      const scope = await scopeFor(auth, req, (req.params as any).projectId);
      await chatScoped(scope, (tx) => planAccess(tx, scope, write));
    };
  const ownerGate = async (req: import("fastify").FastifyRequest) => {
    const scope = await scopeFor(
      auth,
      req,
      (req.params as any).projectId,
      PROJECT_OWN,
    );
    await chatScoped(scope, (tx) => planAccess(tx, scope));
  };
  app.get(
    "/api/projects/:projectId/marketing-reports",
    {
      preValidation: gate(),
      schema: {
        response: {
          200: json(z.object({ items: z.array(view), truncated: z.boolean() })),
        },
      },
    },
    async (req) => {
      const { projectId } = z.object({ projectId: z.uuid() }).parse(req.params);
      const scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        await planAccess(tx, scope);
        const rows = await tx.entity.findMany({
          where: {
            workspaceId: scope.workspaceId,
            projectId,
            kind: REPORT_KIND,
          },
          orderBy: { updatedAt: "desc" },
          take: 21,
        });
        return jsonSafe({
          items: rows
            .slice(0, 20)
            .map((row) => ({ id: row.id, version: row.version, ...data(row) })),
          truncated: rows.length > 20,
        });
      });
    },
  );
  app.get(
    "/api/projects/:projectId/marketing-reports/:id",
    { preValidation: gate(), schema: { response: { 200: json(view) } } },
    async (req) => {
      const { projectId, id } = ids.parse(req.params),
        scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        await planAccess(tx, scope);
        const row = await entity(tx, scope, REPORT_KIND, id);
        return jsonSafe({ id: row.id, version: row.version, ...data(row) });
      });
    },
  );
  app.post(
    "/api/projects/:projectId/marketing-reports",
    {
      preValidation: gate(true),
      schema: { body: json(reportInput), response: { 200: json(view) } },
    },
    async (req) => {
      const { projectId } = z.object({ projectId: z.uuid() }).parse(req.params),
        scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        await planAccess(tx, scope, true);
        const row = await persistReport(tx, scope, reportInput.parse(req.body));
        return jsonSafe({ id: row.id, version: row.version, ...data(row) });
      });
    },
  );
  app.post(
    "/api/projects/:projectId/marketing-reports/:id/acknowledge",
    { preValidation: ownerGate, schema: { body: json(reportVersion) } },
    async (req) => {
      const { projectId, id } = ids.parse(req.params),
        scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, (tx) =>
        acknowledgeReport(
          tx,
          scope,
          id,
          reportVersion.parse(req.body).version,
        ).then(jsonSafe),
      );
    },
  );
  app.post(
    "/api/projects/:projectId/marketing-reports/:id/proposal",
    {
      preValidation: gate(true),
      schema: {
        body: json(
          reportVersion.extend({ spec: marketingPlanSpec.optional() }).strict(),
        ),
      },
    },
    async (req) => {
      const { projectId, id } = ids.parse(req.params),
        scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        await planAccess(tx, scope, true);
        const input = reportVersion
          .extend({ spec: marketingPlanSpec.optional() })
          .strict()
          .parse(req.body);
        return jsonSafe(
          await proposeReportRevision(tx, scope, id, input.version, input.spec),
        );
      });
    },
  );
};
