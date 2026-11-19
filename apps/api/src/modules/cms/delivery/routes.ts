import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { inV1, sendCached, v1RateLimit, V1_PREFIX } from "../../../platform/http/v1.ts";
import type { ApiPrincipal } from "../../../platform/api-keys/keys.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import { CMS_BASE, inCms } from "../http-scope.ts";
import { CMS_READ } from "../permissions.ts";
import { liveAuthors, liveEntryBySlug, liveFeed, listLiveEntries, liveManifest, liveRedirects, liveSitemap, liveTerms } from "./delivery.ts";
import { deliverySite, type SiteRow } from "./live.ts";
import { createPreview, readPreview, servePreviewMedia } from "./preview.ts";

// Delivery API v1 of the content module (ADR 0029 §4.1–4.2, CH1.12): what a
// website's server reads with a project API key (`cms:delivery.read`, the
// key's site filter applies). Answers carry an ETag and short freshness with
// long stale fallbacks, so a site keeps serving while Orbit is away.

const DELIVERY_SCOPE = "cms:delivery.read";
const PREVIEW_SCOPE = "cms:preview.read";
const SITE = `${V1_PREFIX}/cms/sites/:siteId`;
const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");

/** One delivery read of a site: key, scope, module, site filter, then the work. */
const onSite = <T>(req: FastifyRequest, work: (tx: DbTx, principal: ApiPrincipal, site: SiteRow) => Promise<T>) =>
  inV1(req, DELIVERY_SCOPE, async (tx, principal) => work(tx, principal, await deliverySite(tx, principal, param(req, "siteId"))));

const cached = (req: FastifyRequest, reply: FastifyReply, body: unknown) => sendCached(req, reply, body);

export const cmsDeliveryRoutes: RoutesContribution = ({ app, auth }) => {
  const delivery = { config: v1RateLimit("delivery") };
  app.get(`${SITE}/entries`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => listLiveEntries(tx, p.scope, site, req.query))),
  );
  app.get(`${SITE}/entries/:type/by-slug/:slug`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveEntryBySlug(tx, p.scope, site, param(req, "type"), param(req, "slug"), req.query))),
  );
  app.get(`${SITE}/taxonomies/:kind`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveTerms(tx, p.scope, site, param(req, "kind"), req.query))),
  );
  app.get(`${SITE}/authors`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveAuthors(tx, p.scope, site, req.query))),
  );
  app.get(`${SITE}/redirects`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveRedirects(tx, p.scope, site, req.query))),
  );
  app.get(`${SITE}/sitemap`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveSitemap(tx, p.scope, site, req.query))),
  );
  app.get(`${SITE}/feed`, delivery, async (req, reply) => {
    const feed = await onSite(req, (tx, p, site) => liveFeed(tx, p.scope, site, req.query));
    if (feed.kind === "rss") reply.type("application/rss+xml; charset=utf-8");
    return cached(req, reply, feed.body);
  });
  app.get(`${SITE}/manifest`, delivery, async (req, reply) =>
    cached(req, reply, await onSite(req, (tx, p, site) => liveManifest(tx, p.scope, site))),
  );

  // Draft previews: a member creates the token; the site's server reads with it.
  app.post(`${CMS_BASE}/entries/:entryId/preview`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => createPreview(tx, scope, param(req, "entryId"), req.body)),
  );
  app.get(`${V1_PREFIX}/cms/preview/entries`, { config: v1RateLimit("preview") }, async (req, reply) => {
    const body = await inV1(req, PREVIEW_SCOPE, (tx, principal) => readPreview(tx, principal, req.query));
    return reply.header("Cache-Control", "private, no-store").send(body);
  });
  app.get(
    "/api/public/cms/preview-media/:assetId/:file",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { assetId, file } = z.object({ assetId: z.string().max(40), file: z.string().max(20) }).parse(req.params);
      const { token } = z.object({ token: z.string().max(400) }).parse(req.query);
      const media = await servePreviewMedia(token, assetId, file);
      return reply
        .header("Content-Type", media.mime)
        .header("Content-Length", String(media.bytes.byteLength))
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Cache-Control", "private, max-age=300")
        .send(Buffer.from(media.bytes));
    },
  );
};
