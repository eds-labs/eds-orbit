import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "../../../../../packages/db/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import { userScoped } from "../tenancy/scope.ts";
import { DomainError } from "../shared.ts";

const widget = z.strictObject({
  id: z
    .string()
    .max(80)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]*$/),
  size: z.enum(["compact", "wide"]),
});
const widgets = z.array(widget).max(100).nullable();
const layout = z.strictObject({
  revision: z.int().min(0).max(2147483647),
  widgets,
});
const layoutInput = layout.refine(
  ({ widgets }) =>
    !widgets || new Set(widgets.map(({ id }) => id)).size === widgets.length,
  { path: ["widgets"], message: "Widget IDs must be unique." },
);
export const homeLayoutSchema = z.toJSONSchema(layout, { target: "draft-7" });
export const HOME_LAYOUT_PATH = "/api/projects/:projectId/home-layout";
const pathParams = z.strictObject({ projectId: z.uuid() });
const selection = { revision: true, widgets: true } as const;

export function registerHomeLayoutRoutes(
  app: FastifyInstance,
  auth: Auth,
  enabled: boolean,
) {
  async function member(req: FastifyRequest) {
    const { projectId } = pathParams.parse(req.params);
    const scope = await scopeFor(auth, req, projectId);
    if (!enabled) throw new DomainError("NOT_FOUND", 404);
    return scope;
  }

  app.get(HOME_LAYOUT_PATH, async (req) => {
    const scope = await member(req);
    const { projectId, userId } = scope;
    return userScoped(
      scope,
      async (tx) =>
        (await tx.projectHomeLayout.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: selection,
        })) ?? { revision: 0, widgets: null },
    );
  });

  app.put(
    HOME_LAYOUT_PATH,
    {
      schema: { body: homeLayoutSchema },
      // Preserve strict validation of the original body. The handler reports
      // any validation error after checking project access.
      validatorCompiler:
        ({ httpPart }) =>
        (data) => {
          const parsed = (
            httpPart === "body" ? layoutInput : pathParams
          ).safeParse(data);
          return parsed.success
            ? { value: parsed.data }
            : { error: parsed.error };
        },
      attachValidation: true,
    },
    async (req) => {
      const scope = await member(req);
      if (req.validationError) throw req.validationError;
      const input = req.body as z.infer<typeof layout>;
      const { workspaceId, projectId, userId } = scope;
      const key = { projectId, userId };
      return userScoped(scope, async (tx) => {
        // userScoped takes the project transaction lock before comparing the
        // revision, including when two devices try to create the first layout.
        const where = { projectId_userId: key };
        const current = await tx.projectHomeLayout.findUnique({
          where,
          select: { revision: true },
        });
        if ((current?.revision ?? 0) !== input.revision)
          throw new DomainError("HOME_LAYOUT_CONFLICT", 409);
        const data = {
          revision: input.revision + 1,
          widgets: input.widgets ?? Prisma.DbNull,
        };
        return current
          ? tx.projectHomeLayout.update({ where, data, select: selection })
          : tx.projectHomeLayout.create({
              data: { ...key, workspaceId, ...data },
              select: selection,
            });
      });
    },
  );
}
