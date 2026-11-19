import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { pingWebhookEndpoint } from "../../../platform/outbound-webhooks/webhooks.ts";
import { boundedFetch, type FetchLike } from "../../../../../../packages/connectors/src/http.ts";
import { refused } from "../entries/common.ts";
import { CMS_BASE, inCms } from "../http-scope.ts";
import { CMS_READ, CMS_SITES_MANAGE } from "../permissions.ts";
import { storedNotifiers } from "./adapters.ts";
import { archiveSite, createSite, findSite, getSite, listSites, raiseVerification, restoreSite, siteView, updateSite } from "./sites.ts";

// Site routes of the content module (ADR 0029 §3.2, CH1.11). Members read;
// the owner manages sites, checks that Orbit reaches them and sends a test
// event to their notifiers.

const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");

let fetcher: FetchLike = boundedFetch;
/** Test hook: the real transport refuses private addresses by design. */
export function setSiteCheckFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

/** GET of the site's origin outside any transaction: reachable over HTTPS or not. */
async function reach(baseUrl: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(`${baseUrl}/`, { method: "GET", headers: { "user-agent": "OrbitSiteCheck/1" }, signal: controller.signal });
    return { reachable: response.status < 400, httpStatus: response.status };
  } catch {
    return { reachable: false, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

export const cmsSiteRoutes: RoutesContribution = ({ app, auth }) => {
  const S = `${CMS_BASE}/sites`;
  app.get(S, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listSites(tx, scope, req.query)));
  app.post(S, async (req, reply) => {
    const result = await inCms(auth, req, CMS_SITES_MANAGE, (tx, scope) => createSite(tx, scope, req.body));
    return reply.code(201).send(result);
  });
  app.get(`${S}/:siteId`, (req) => inCms(auth, req, CMS_READ, (tx, scope) => getSite(tx, scope, param(req, "siteId"))));
  app.patch(`${S}/:siteId`, (req) =>
    inCms(auth, req, CMS_SITES_MANAGE, (tx, scope) => updateSite(tx, scope, param(req, "siteId"), req.body)),
  );
  app.post(`${S}/:siteId/archive`, (req) =>
    inCms(auth, req, CMS_SITES_MANAGE, (tx, scope) => archiveSite(tx, scope, param(req, "siteId"), req.body)),
  );
  app.post(`${S}/:siteId/restore`, (req) =>
    inCms(auth, req, CMS_SITES_MANAGE, (tx, scope) => restoreSite(tx, scope, param(req, "siteId"), req.body)),
  );
  // Orbit reaches the site's origin: verification "read_verified".
  app.post(`${S}/:siteId/verify`, async (req) => {
    const siteId = param(req, "siteId");
    const site = await inCms(auth, req, CMS_SITES_MANAGE, async (tx, scope) => {
      const row = await findSite(tx, scope, siteId);
      if (row.archivedAt) throw refused("CMS_SITE_ARCHIVED", 409);
      return row;
    });
    const result = await reach(site.baseUrl);
    return inCms(auth, req, CMS_SITES_MANAGE, async (tx, scope) => {
      if (!result.reachable) throw refused("CMS_SITE_UNREACHABLE", 422, { httpStatus: result.httpStatus });
      const current = await findSite(tx, scope, siteId);
      // The origin changed while it was checked: the result says nothing about it.
      if (current.baseUrl === site.baseUrl) await raiseVerification(tx, scope, siteId, "read_verified");
      return { site: siteView(await findSite(tx, scope, siteId)), httpStatus: result.httpStatus };
    });
  });
  // A test event (orbit.ping) to each webhook the site names.
  app.post(`${S}/:siteId/notifiers/test`, (req) =>
    inCms(auth, req, CMS_SITES_MANAGE, async (tx, scope) => {
      const site = await findSite(tx, scope, param(req, "siteId"));
      const webhooks = storedNotifiers(site.notifiers).flatMap((n) => (n.kind === "webhook" ? [n.endpointId] : []));
      if (!webhooks.length) throw refused("CMS_NO_NOTIFIER", 422);
      const deliveries = [];
      for (const endpointId of webhooks) deliveries.push({ endpointId, ...(await pingWebhookEndpoint(tx, scope, endpointId)) });
      return { deliveries };
    }),
  );
};
