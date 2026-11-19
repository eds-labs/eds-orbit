import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { findEntry } from "../entries/common.ts";
import { sitesOf } from "../entries/entries.ts";
import { CMS_BASE, inCms } from "../http-scope.ts";
import { CMS_PUBLISH_REQUEST, CMS_READ } from "../permissions.ts";
import { cancelPublication, requestPublication, requestUnpublish } from "./approval.ts";
import { preflight } from "./preflight.ts";
import { getPublication, listPublications } from "./publications.ts";

// Publishing routes of the content module (ADR 0029 §4.6, CH1.10). Asking is
// editor work (cms.publish.request); whether it publishes directly or waits
// for a decision follows the module's approval settings. Decisions use the
// platform's action request routes.

const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");

export const cmsPublishingRoutes: RoutesContribution = ({ app, auth }) => {
  const E = `${CMS_BASE}/entries/:entryId`;
  // What would stop the current draft from going live, without saving anything.
  app.get(`${E}/preflight`, (req) =>
    inCms(auth, req, CMS_READ, async (tx, scope) => {
      const entry = await findEntry(tx, scope, param(req, "entryId"));
      const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
      const siteIds = await sitesOf(tx, scope, entry.id);
      const issues = await preflight(tx, scope, entry, { ...draft, slug: entry.slug }, siteIds);
      return { ok: issues.length === 0, issues };
    }),
  );
  app.post(`${E}/publication-requests`, async (req, reply) => {
    const result = await inCms(auth, req, CMS_PUBLISH_REQUEST, (tx, scope) =>
      requestPublication(tx, scope, param(req, "entryId"), req.body),
    );
    return reply.code(result.mode === "direct" ? 200 : 202).send(result);
  });
  app.post(`${E}/unpublish-requests`, async (req, reply) => {
    const result = await inCms(auth, req, CMS_PUBLISH_REQUEST, (tx, scope) =>
      requestUnpublish(tx, scope, param(req, "entryId"), req.body),
    );
    return reply.code(result.mode === "direct" ? 200 : 202).send(result);
  });
  app.post(`${E}/publication/cancel`, (req) =>
    inCms(auth, req, CMS_PUBLISH_REQUEST, (tx, scope) => cancelPublication(tx, scope, param(req, "entryId"), req.body)),
  );
  app.get(`${E}/publications`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => listPublications(tx, scope, param(req, "entryId"), req.query)),
  );
  app.get(`${CMS_BASE}/publications/:publicationId`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => getPublication(tx, scope, param(req, "publicationId"))),
  );
};
