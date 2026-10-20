import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  marketingPlanSpec,
  marketingPlanChange,
  marketingPlanView,
} from "../../../../../../packages/schemas/src/index.ts";
import { jsonSafe } from "../../../../../../packages/db/src/index.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { scopeFor, userFor } from "../../../platform/tenancy/auth.ts";
import { chatScoped } from "../../chat.ts";
import { data, entity } from "../../../shared.ts";
import { PLAN_KIND, planAccess, planView, proposePlan } from "./service.ts";
const projectParams = z.object({ projectId: z.uuid() }).strict();
const params = z.object({ projectId: z.uuid(), id: z.uuid() }).strict();
const json = (schema: z.ZodType) => {
  const { $schema, ...value } = z.toJSONSchema(schema, { io: "input" });
  return value;
};
export const marketingPlanRoutes: RoutesContribution = ({ app, auth }) => {
  // Authentication and module/write permissions precede JSON-schema validation,
  // including for malformed requests. Keep the route access-matrix guarantees.
  const gate =
    (write = false) =>
    async (req: FastifyRequest) => {
      await userFor(auth, req);
      const projectId = z
        .uuid()
        .parse((req.params as { projectId: string }).projectId);
      const scope = await scopeFor(auth, req, projectId);
      await chatScoped(scope, (tx) => planAccess(tx, scope, write));
    };
  app.get(
    "/api/projects/:projectId/marketing-plans",
    {
      preValidation: gate(),
      schema: {
        params: json(projectParams),
        response: {
          200: json(
            z.object({
              items: z.array(marketingPlanView),
              truncated: z.boolean(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const { projectId } = z.object({ projectId: z.uuid() }).parse(req.params);
      const scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        await planAccess(tx, scope);
        const rows = await tx.entity.findMany({
          where: { workspaceId: scope.workspaceId, projectId, kind: PLAN_KIND },
          orderBy: { createdAt: "desc" },
          take: 21,
        });
        return jsonSafe({
          items: await Promise.all(
            rows.slice(0, 20).map((row) => planView(tx, scope, row.id)),
          ),
          truncated: rows.length > 20,
        });
      });
    },
  );
  app.post(
    "/api/projects/:projectId/marketing-plans",
    {
      preValidation: gate(true),
      schema: {
        params: json(projectParams),
        body: json(marketingPlanSpec),
        response: { 200: json(marketingPlanView) },
      },
    },
    async (req) => {
      const { projectId } = z.object({ projectId: z.uuid() }).parse(req.params);
      const scope = await scopeFor(auth, req, projectId);
      return jsonSafe(
        await chatScoped(scope, (tx) => proposePlan(tx, scope, req.body)),
      );
    },
  );
  app.get(
    "/api/projects/:projectId/marketing-plans/:id",
    {
      preValidation: gate(),
      schema: {
        params: json(params),
        response: { 200: json(marketingPlanView) },
      },
    },
    async (req) => {
      const { projectId, id } = params.parse(req.params);
      const scope = await scopeFor(auth, req, projectId);
      return jsonSafe(await chatScoped(scope, (tx) => planView(tx, scope, id)));
    },
  );
  app.put(
    "/api/projects/:projectId/marketing-plans/:id",
    {
      preValidation: gate(true),
      schema: {
        params: json(params),
        body: json(marketingPlanChange),
        response: { 200: json(marketingPlanView) },
      },
    },
    async (req) => {
      const { projectId, id } = params.parse(req.params),
        input = marketingPlanChange.parse(req.body);
      const scope = await scopeFor(auth, req, projectId);
      return jsonSafe(
        await chatScoped(scope, (tx) =>
          proposePlan(tx, scope, input.spec, null, {
            id,
            version: input.version,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/projects/:projectId/marketing-plans/:id/export",
    { preValidation: gate(), schema: { params: json(params) } },
    async (req) => {
      const { projectId, id } = params.parse(req.params);
      const scope = await scopeFor(auth, req, projectId);
      return chatScoped(scope, async (tx) => {
        const plan = await planView(tx, scope, id);
        const row = await entity(tx, scope, PLAN_KIND, id);
        const versions = await tx.entityVersion.findMany({
          where: { workspaceId: scope.workspaceId, projectId, entityId: id },
          orderBy: { version: "desc" },
          take: 51,
        });
        return jsonSafe({
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          plan,
          sources: data(row).sources,
          history: versions
            .slice(0, 50)
            .map((r) => ({ version: r.version, data: r.data })),
          historyTruncated: versions.length > 50,
        });
      });
    },
  );
};
