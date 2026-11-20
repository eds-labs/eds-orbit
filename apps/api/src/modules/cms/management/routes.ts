import type { FastifyReply, FastifyRequest } from "fastify";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { refuseLiveReference } from "./live-references.ts";
import { idempotent, inV1, limitKey, v1RateLimit, V1_PREFIX, type V1Result } from "../../../platform/http/v1.ts";
import { requireApiScope, resolveApiKey, type ApiPrincipal } from "../../../platform/api-keys/keys.ts";
import type { RequestedBy } from "../../../platform/governance/action-requests.ts";
import { assertModuleEnabled } from "../../../platform/modules/enforcement.ts";
import { DomainError } from "../../../shared.ts";
import { createAuthor, listAuthors, updateAuthor } from "../entries/authors.ts";
import { findEntry } from "../entries/common.ts";
import { createEntry, createTranslation, getEntry, listEntries, saveDraft, setEntrySites, sitesOf } from "../entries/entries.ts";
import { createRevision, getRevision, listRevisions } from "../entries/revisions.ts";
import { revisionBody } from "../entries/routes.ts";
import { createTerm, listTerms, updateTerm } from "../entries/taxonomies.ts";
import { CMS_MODULE_ID } from "../manifest.ts";
import { getAsset, ingestAsset, listAssets, updateAsset } from "../media/assets.ts";
import { requestPublication, requestUnpublish } from "../publishing/approval.ts";
import { preflight } from "../publishing/preflight.ts";
import { listPublications } from "../publishing/publications.ts";
import { listSites } from "../sites/sites.ts";

// Management API v1 of the content module (ADR 0029 §4.3, CH1.13): what an
// integration (an import tool, an automation, another system) may do with a
// project API key. `cms:manage.read` reads entries, drafts, revisions, media,
// terms, authors and sites; `cms:manage.write` creates and edits drafts,
// media, terms and authors; `cms:publish.propose` asks for a publication,
// which always waits for a person in Orbit (the key is never a decider).
// Writes accept an Idempotency-Key. Keys with a site filter are for
// delivery; management needs a key without one.

const READ = "cms:manage.read";
const WRITE = "cms:manage.write";
const PROPOSE = "cms:publish.propose";
const B = `${V1_PREFIX}/cms`;
const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");

const unfiltered = (principal: ApiPrincipal) => {
  if (principal.resourceFilter.siteIds) throw new DomainError("API_KEY_SITE_FILTER_UNSUPPORTED", 403);
};

/** A management call: key, scope, module, no site filter, one project transaction. */
const manage = <T>(req: FastifyRequest, scopeKey: string, work: (tx: DbTx, principal: ApiPrincipal) => Promise<T>) =>
  inV1(req, scopeKey, async (tx, principal) => {
    unfiltered(principal);
    return work(tx, principal);
  });

/** A management write with Idempotency-Key replay. */
const write = (req: FastifyRequest, reply: FastifyReply, scopeKey: string, work: (tx: DbTx, principal: ApiPrincipal) => Promise<V1Result>) =>
  manage(req, scopeKey, (tx, principal) => idempotent(tx, principal, req, reply, () => work(tx, principal)));

const byKey = (principal: ApiPrincipal): RequestedBy => ({
  kind: "api_key",
  userId: principal.scope.userId,
  keyId: principal.keyId,
  prefix: principal.prefix,
});

export const cmsManagementRoutes: RoutesContribution = ({ app }) => {
  const config = { config: v1RateLimit("management") };
  const E = `${B}/entries`;

  app.get(E, config, (req) => manage(req, READ, (tx, p) => listEntries(tx, p.scope, req.query)));
  app.post(E, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => ({
      status: 201,
      body: await createEntry(tx, p.scope, req.body, { origin: "api", originRef: { apiKey: p.prefix } }),
    })),
  );
  app.get(`${E}/:entryId`, config, (req) => manage(req, READ, (tx, p) => getEntry(tx, p.scope, param(req, "entryId"))));
  app.patch(`${E}/:entryId/draft`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => ({ status: 200, body: await saveDraft(tx, p.scope, param(req, "entryId"), req.body) })),
  );
  app.put(`${E}/:entryId/sites`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => ({ status: 200, body: await setEntrySites(tx, p.scope, param(req, "entryId"), req.body) })),
  );
  app.post(`${E}/:entryId/translations`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => ({ status: 201, body: await createTranslation(tx, p.scope, param(req, "entryId"), req.body) })),
  );
  app.get(`${E}/:entryId/revisions`, config, (req) =>
    manage(req, READ, (tx, p) => listRevisions(tx, p.scope, param(req, "entryId"), req.query)),
  );
  app.post(`${E}/:entryId/revisions`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => {
      const result = await createRevision(tx, p.scope, param(req, "entryId"), revisionBody.parse(req.body ?? {}));
      return { status: result.created ? 201 : 200, body: result };
    }),
  );
  app.get(`${E}/:entryId/revisions/:revisionId`, config, (req) =>
    manage(req, READ, (tx, p) => getRevision(tx, p.scope, param(req, "entryId"), param(req, "revisionId"))),
  );
  app.get(`${E}/:entryId/preflight`, config, (req) =>
    manage(req, READ, async (tx, p) => {
      const entry = await findEntry(tx, p.scope, param(req, "entryId"));
      const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: p.projectId } });
      const issues = await preflight(tx, p.scope, entry, { ...draft, slug: entry.slug }, await sitesOf(tx, p.scope, entry.id));
      return { ok: issues.length === 0, issues };
    }),
  );
  app.get(`${E}/:entryId/publications`, config, (req) =>
    manage(req, READ, (tx, p) => listPublications(tx, p.scope, param(req, "entryId"), req.query)),
  );
  // Proposals: a person in Orbit decides (202 with the request id).
  app.post(`${E}/:entryId/publication-requests`, config, (req, reply) =>
    write(req, reply, PROPOSE, async (tx, p) => ({
      status: 202,
      body: await requestPublication(tx, p.scope, param(req, "entryId"), req.body, byKey(p)),
    })),
  );
  app.post(`${E}/:entryId/unpublish-requests`, config, (req, reply) =>
    write(req, reply, PROPOSE, async (tx, p) => ({
      status: 202,
      body: await requestUnpublish(tx, p.scope, param(req, "entryId"), req.body, byKey(p)),
    })),
  );

  const T = `${B}/terms`;
  app.get(T, config, (req) => manage(req, READ, (tx, p) => listTerms(tx, p.scope, req.query)));
  app.post(T, config, (req, reply) => write(req, reply, WRITE, async (tx, p) => ({ status: 201, body: await createTerm(tx, p.scope, req.body) })));
  app.patch(`${T}/:termId`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => {
      await refuseLiveReference(tx, p.scope, "term", param(req, "termId"));
      return { status: 200, body: await updateTerm(tx, p.scope, param(req, "termId"), req.body) };
    }),
  );

  const A = `${B}/authors`;
  app.get(A, config, (req) => manage(req, READ, (tx, p) => listAuthors(tx, p.scope, req.query)));
  app.post(A, config, (req, reply) => write(req, reply, WRITE, async (tx, p) => ({ status: 201, body: await createAuthor(tx, p.scope, req.body) })));
  app.patch(`${A}/:authorId`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => {
      await refuseLiveReference(tx, p.scope, "author", param(req, "authorId"));
      return { status: 200, body: await updateAuthor(tx, p.scope, param(req, "authorId"), req.body) };
    }),
  );

  app.get(`${B}/sites`, config, (req) => manage(req, READ, (tx, p) => listSites(tx, p.scope, req.query)));

  const M = `${B}/assets`;
  app.get(M, config, (req) => manage(req, READ, (tx, p) => listAssets(tx, p.scope, req.query)));
  app.get(`${M}/:assetId`, config, (req) => manage(req, READ, (tx, p) => getAsset(tx, p.scope, param(req, "assetId"))));
  app.patch(`${M}/:assetId`, config, (req, reply) =>
    write(req, reply, WRITE, async (tx, p) => {
      await refuseLiveReference(tx, p.scope, "asset", param(req, "assetId"));
      return { status: 200, body: await updateAsset(tx, p.scope, param(req, "assetId"), req.body) };
    }),
  );
  // Upload: raw image bytes. The key is checked before the body is read; an
  // identical image is stored once (200 with the existing asset), so a
  // repeated upload is harmless without an Idempotency-Key.
  const uploader = new WeakMap<object, ApiPrincipal>();
  app.register(async (child) => {
    child.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: loadConfig().FILES_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      M,
      {
        bodyLimit: loadConfig().FILES_MAX_BYTES,
        config: v1RateLimit("management"),
        onRequest: async (req) => {
          const principal = await resolveApiKey(req.headers.authorization);
          await limitKey(req, principal.keyId);
          requireApiScope(principal, WRITE);
          unfiltered(principal);
          await scoped(principal.workspaceId, principal.projectId, (tx) => assertModuleEnabled(tx, principal.scope, CMS_MODULE_ID));
          const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
          if (type !== "application/octet-stream") throw new DomainError("FILE_BODY_REQUIRED", 415);
          uploader.set(req, principal);
        },
      },
      async (req, reply) => {
        const principal = uploader.get(req);
        if (!principal || !Buffer.isBuffer(req.body)) throw new DomainError("FILE_BODY_REQUIRED", 415);
        const raw = req.headers["x-file-name"];
        let name: string | undefined;
        if (typeof raw === "string")
          try {
            name = decodeURIComponent(raw).slice(0, 200);
          } catch {
            name = undefined;
          }
        const result = await ingestAsset(principal.scope, { bytes: req.body, ...(name ? { name } : {}) }, { source: "api" });
        return reply.code(result.duplicate ? 200 : 201).send(result);
      },
    );
  });
};
