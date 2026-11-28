import { scoped } from "../../../../../packages/db/src/index.ts";
import { z } from "zod";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { projectCenterLink } from "../../platform/management/links.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { DomainError } from "../../shared.ts";
import { seoDimension, seoProviderId } from "./contract.ts";
import { requireSeoAccess } from "./gate.ts";
import { SEO_MANAGE, SEO_READ } from "./permissions.ts";
import { requireSeoProvider, seoProviders } from "./providers.ts";
import {
  archiveSeoWebsite,
  bindSeoProperty,
  createSeoWebsite,
  listSeoProperties,
  listSeoWebsites,
  searchPerformance,
  unbindSeoProperty,
} from "./service.ts";

const BASE = "/api/projects/:projectId/seo";
const ids = {
  projectId: z.uuid(),
  provider: seoProviderId,
  websiteId: z.uuid(),
  connectionId: z.uuid(),
};
const websiteParams = z.object({ websiteId: ids.websiteId });
const bindingParams = websiteParams.extend({ provider: ids.provider });
const providerParams = z.object({ provider: ids.provider });
const connectionParams = providerParams.extend({
  connectionId: ids.connectionId,
});
const connectInput = z
  .object({ connectionId: ids.connectionId.optional() })
  .strict();
const callbackInput = z.object({
  state: z.string().min(40).max(128),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(128).optional(),
});
const reportQuery = z
  .object({
    provider: seoProviderId,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dimension: seoDimension.optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .optional(),
  })
  .strict();
const limits = (max: number) => ({
  config: { rateLimit: { max, timeWindow: "1 minute" } },
});

export const seoRoutes: RoutesContribution = ({ app, auth }) => {
  const getScope = (req: Parameters<typeof scopeFor>[1], required = SEO_READ) =>
    scopeFor(
      auth,
      req,
      z.object({ projectId: ids.projectId }).parse(req.params).projectId,
      required,
    );

  app.get(BASE, async (req) => {
    const scope = await getScope(req);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const websites = await listSeoWebsites(tx, scope);
      const canManage = can(scope, SEO_MANAGE);
      const providers = await Promise.all(
        seoProviders.map(async (provider) => ({
          id: provider.id,
          label: provider.label,
          canConnect: Boolean(provider.oauth),
          ...(canManage
            ? await provider.status(tx, scope)
            : { appReady: false, connections: [] }),
        })),
      );
      return { canManage, providers, websites };
    });
  });

  app.post(`${BASE}/websites`, async (req, reply) => {
    const scope = await getScope(req, SEO_MANAGE);
    const website = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      createSeoWebsite(tx, scope, req.body),
    );
    return reply.code(201).send(website);
  });

  app.delete(`${BASE}/websites/:websiteId`, async (req, reply) => {
    const scope = await getScope(req, SEO_MANAGE);
    const { websiteId } = websiteParams.parse(req.params);
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      archiveSeoWebsite(tx, scope, websiteId),
    );
    return reply.code(204).send();
  });

  app.put(
    `${BASE}/websites/:websiteId/properties/:provider`,
    limits(20),
    async (req) => {
      const scope = await getScope(req, SEO_MANAGE);
      const { websiteId, provider } = bindingParams.parse(req.params);
      return bindSeoProperty(scope, websiteId, provider, req.body);
    },
  );

  app.delete(
    `${BASE}/websites/:websiteId/properties/:provider`,
    async (req, reply) => {
      const scope = await getScope(req, SEO_MANAGE);
      const { websiteId, provider } = bindingParams.parse(req.params);
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        unbindSeoProperty(tx, scope, websiteId, provider),
      );
      return reply.code(204).send();
    },
  );

  app.get(
    `${BASE}/websites/:websiteId/performance`,
    limits(30),
    async (req) => {
      const scope = await getScope(req);
      const { websiteId } = websiteParams.parse(req.params);
      return searchPerformance(scope, websiteId, reportQuery.parse(req.query));
    },
  );

  app.post(`${BASE}/providers/:provider/connect`, limits(10), async (req) => {
    const scope = await getScope(req, SEO_MANAGE);
    const { provider } = providerParams.parse(req.params);
    const { connectionId } = connectInput.parse(req.body ?? {});
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await requireSeoAccess(tx, scope, SEO_MANAGE);
      const oauth = requireSeoProvider(provider).oauth;
      if (!oauth)
        throw new DomainError("SEO_PROVIDER_CONNECT_UNSUPPORTED", 404);
      return oauth.beginConnect(tx, scope, connectionId);
    });
  });

  app.get(
    `${BASE}/providers/:provider/connections/:connectionId/properties`,
    limits(20),
    async (req) => {
      const scope = await getScope(req, SEO_MANAGE);
      const { provider, connectionId } = connectionParams.parse(req.params);
      const properties = await listSeoProperties(scope, provider, connectionId);
      return { properties };
    },
  );

  app.delete(
    `${BASE}/providers/:provider/connections/:connectionId`,
    async (req, reply) => {
      const scope = await getScope(req, SEO_MANAGE);
      const { provider, connectionId } = connectionParams.parse(req.params);
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        await requireSeoAccess(tx, scope, SEO_MANAGE);
        await requireSeoProvider(provider).disconnect(tx, scope, connectionId);
      });
      return reply.code(204).send();
    },
  );

  for (const provider of seoProviders) {
    const oauth = provider.oauth;
    if (!oauth) continue;
    app.get(oauth.callbackPath, limits(20), async (req, reply) => {
      const input = callbackInput.parse(req.query);
      const projectId = oauth.projectOfState(input.state);
      const scope = await scopeFor(auth, req, projectId, SEO_MANAGE);
      const target = projectCenterLink(
        projectId,
        "integrations",
        "seo",
        oauth.settingsSection,
      );
      const redirect = (result: "connected" | "error") =>
        reply
          .header("Cache-Control", "no-store")
          .redirect(`${target}?connection=${result}`);

      try {
        const finish = await scoped(
          scope.workspaceId,
          scope.projectId,
          async (tx) => {
            await requireSeoAccess(tx, scope, SEO_MANAGE);
            return oauth.claim(tx, scope, input.state);
          },
        );
        if (input.error || !input.code) return redirect("error");
        await finish(input.code);
        return redirect("connected");
      } catch (error) {
        const code =
          error instanceof DomainError ? error.code : "SEO_CONNECT_FAILED";
        req.log.warn({ code }, "SEO authorization callback failed");
        return redirect("error");
      }
    });
  }
};
