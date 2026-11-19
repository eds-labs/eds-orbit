import { z } from "zod";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { CMS_BASE, inCms } from "../http-scope.ts";
import { CMS_COMPOSE, CMS_READ } from "../permissions.ts";
import { createAuthor, listAuthors, setAuthorArchived, updateAuthor } from "./authors.ts";
import { versionInput } from "./common.ts";
import {
  archiveEntry,
  createEntry,
  createTranslation,
  getEntry,
  listEntries,
  saveDraft,
  setEntrySites,
  unarchiveEntry,
} from "./entries.ts";
import { createRedirect, listRedirects, removeRedirect } from "./redirects.ts";
import { createRevision, diffRevisions, getRevision, listRevisions, restoreRevision } from "./revisions.ts";
import { createTerm, listTerms, setTermArchived, updateTerm } from "./taxonomies.ts";

// Internal entry routes (ADR 0029 §4.1, CH1.8) for the Orbit web app. Members
// read with cms.read; editors and the owner write with cms.compose. Asking
// for publication and deciding it follow in CH1.10.

const versionBody = z.object({ version: versionInput }).strict();
export const revisionBody = z
  .object({ changeNote: z.string().trim().max(500).nullable().optional(), draftVersion: versionInput.optional() })
  .strict();
const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");

export const cmsEntryRoutes: RoutesContribution = ({ app, auth }) => {
  const E = `${CMS_BASE}/entries`;
  app.get(E, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listEntries(tx, scope, req.query)));
  app.post(E, async (req, reply) => {
    const created = await inCms(auth, req, CMS_COMPOSE, (tx, scope) => createEntry(tx, scope, req.body));
    return reply.code(201).send(created);
  });
  app.get(`${E}/:entryId`, (req) => inCms(auth, req, CMS_READ, (tx, scope) => getEntry(tx, scope, param(req, "entryId"))));
  app.patch(`${E}/:entryId/draft`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => saveDraft(tx, scope, param(req, "entryId"), req.body)),
  );
  app.put(`${E}/:entryId/sites`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setEntrySites(tx, scope, param(req, "entryId"), req.body)),
  );
  app.post(`${E}/:entryId/archive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => archiveEntry(tx, scope, param(req, "entryId"), versionBody.parse(req.body).version)),
  );
  app.post(`${E}/:entryId/unarchive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => unarchiveEntry(tx, scope, param(req, "entryId"), versionBody.parse(req.body).version)),
  );
  app.post(`${E}/:entryId/translations`, async (req, reply) => {
    const created = await inCms(auth, req, CMS_COMPOSE, (tx, scope) => createTranslation(tx, scope, param(req, "entryId"), req.body));
    return reply.code(201).send(created);
  });

  app.get(`${E}/:entryId/revisions`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => listRevisions(tx, scope, param(req, "entryId"), req.query)),
  );
  app.post(`${E}/:entryId/revisions`, async (req, reply) => {
    const result = await inCms(auth, req, CMS_COMPOSE, (tx, scope) =>
      createRevision(tx, scope, param(req, "entryId"), revisionBody.parse(req.body ?? {})),
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get(`${E}/:entryId/revisions/diff`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => diffRevisions(tx, scope, param(req, "entryId"), req.query)),
  );
  app.get(`${E}/:entryId/revisions/:revisionId`, (req) =>
    inCms(auth, req, CMS_READ, (tx, scope) => getRevision(tx, scope, param(req, "entryId"), param(req, "revisionId"))),
  );
  app.post(`${E}/:entryId/revisions/:revisionId/restore`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) =>
      restoreRevision(tx, scope, param(req, "entryId"), param(req, "revisionId"), req.body),
    ),
  );

  const T = `${CMS_BASE}/terms`;
  app.get(T, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listTerms(tx, scope, req.query)));
  app.post(T, async (req, reply) => {
    const created = await inCms(auth, req, CMS_COMPOSE, (tx, scope) => createTerm(tx, scope, req.body));
    return reply.code(201).send(created);
  });
  app.patch(`${T}/:termId`, (req) => inCms(auth, req, CMS_COMPOSE, (tx, scope) => updateTerm(tx, scope, param(req, "termId"), req.body)));
  app.post(`${T}/:termId/archive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setTermArchived(tx, scope, param(req, "termId"), true, versionBody.parse(req.body).version)),
  );
  app.post(`${T}/:termId/unarchive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setTermArchived(tx, scope, param(req, "termId"), false, versionBody.parse(req.body).version)),
  );

  const A = `${CMS_BASE}/authors`;
  app.get(A, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listAuthors(tx, scope, req.query)));
  app.post(A, async (req, reply) => {
    const created = await inCms(auth, req, CMS_COMPOSE, (tx, scope) => createAuthor(tx, scope, req.body));
    return reply.code(201).send(created);
  });
  app.patch(`${A}/:authorId`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => updateAuthor(tx, scope, param(req, "authorId"), req.body)),
  );
  app.post(`${A}/:authorId/archive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setAuthorArchived(tx, scope, param(req, "authorId"), true, versionBody.parse(req.body).version)),
  );
  app.post(`${A}/:authorId/unarchive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setAuthorArchived(tx, scope, param(req, "authorId"), false, versionBody.parse(req.body).version)),
  );

  const R = `${CMS_BASE}/sites/:siteId/redirects`;
  app.get(R, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listRedirects(tx, scope, param(req, "siteId"), req.query)));
  app.post(R, async (req, reply) => {
    const created = await inCms(auth, req, CMS_COMPOSE, (tx, scope) => createRedirect(tx, scope, param(req, "siteId"), req.body));
    return reply.code(201).send(created);
  });
  app.delete(`${R}/:redirectId`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => removeRedirect(tx, scope, param(req, "siteId"), param(req, "redirectId"))),
  );
};
