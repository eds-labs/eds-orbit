import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { contentDisposition } from "../../../platform/files/routes.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { assertModuleEnabledFor } from "../../../platform/modules/enforcement.ts";
import { scopeFor } from "../../../platform/tenancy/auth.ts";
import { authorize } from "../../../platform/tenancy/permissions.ts";
import { DomainError } from "../../../shared.ts";
import { versionInput } from "../entries/common.ts";
import { requireCms } from "../gate.ts";
import { CMS_BASE, inCms, type Params } from "../http-scope.ts";
import { CMS_MODULE_ID } from "../manifest.ts";
import { CMS_COMPOSE, CMS_READ } from "../permissions.ts";
import { assetContent, getAsset, importAsset, ingestAsset, listAssets, setAssetArchived, updateAsset } from "./assets.ts";
import { PUBLIC_MEDIA_CACHE, servePublicCmsMedia } from "./public-media.ts";

// Media routes of the content module (ADR 0029 §5, CH1.9). The upload takes
// the raw bytes like the platform file route; membership, module, permission
// and content type are checked before a byte of the body is read. Imports
// read Drive or an Orbit file outside any transaction.

const UPLOAD_RATE = { rateLimit: { max: 60, timeWindow: "1 minute" } };
const versionBody = z.object({ version: versionInput }).strict();
const param = (req: { params: unknown }, name: string) => String((req.params as Record<string, unknown>)[name] ?? "");
const fileParam = z.object({ file: z.string().max(20) }).passthrough();

/**
 * Member scope for a write route outside inCms, in the platform's order:
 * membership, module switch and project row (404), then the permission (403).
 */
async function memberFor(auth: Parameters<RoutesContribution>[0]["auth"], req: FastifyRequest) {
  (req as { orbitModule?: string }).orbitModule = CMS_MODULE_ID;
  const { projectId } = req.params as Params;
  const member = await scopeFor(auth, req, projectId);
  await assertModuleEnabledFor(member, CMS_MODULE_ID);
  await scoped(member.workspaceId, member.projectId, (tx) => requireCms(tx, member));
  authorize(member, CMS_COMPOSE);
  return member;
}

export const cmsMediaRoutes: RoutesContribution = ({ app, auth }) => {
  const M = `${CMS_BASE}/assets`;
  const uploadScope = new WeakMap<object, Scope>();
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
        config: UPLOAD_RATE,
        onRequest: async (req) => {
          const member = await memberFor(auth, req);
          const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
          if (type !== "application/octet-stream") throw new DomainError("FILE_BODY_REQUIRED", 415);
          uploadScope.set(req, member);
        },
      },
      async (req: FastifyRequest, reply) => {
        const scope = uploadScope.get(req);
        if (!scope || !Buffer.isBuffer(req.body)) throw new DomainError("FILE_BODY_REQUIRED", 415);
        const raw = req.headers["x-file-name"];
        let name: string | undefined;
        if (typeof raw === "string")
          try {
            name = decodeURIComponent(raw);
          } catch {
            name = undefined;
          }
        const result = await ingestAsset(scope, { bytes: req.body, ...(name ? { name } : {}) }, { source: "upload" });
        return reply.code(result.duplicate ? 200 : 201).send(result);
      },
    );
  });
  app.post(`${M}/import`, { config: UPLOAD_RATE }, async (req, reply) => {
    const member = await memberFor(auth, req);
    const result = await importAsset(member, req.body);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
  app.get(M, (req) => inCms(auth, req, CMS_READ, (tx, scope) => listAssets(tx, scope, req.query)));
  app.get(`${M}/:assetId`, (req) => inCms(auth, req, CMS_READ, (tx, scope) => getAsset(tx, scope, param(req, "assetId"))));
  app.patch(`${M}/:assetId`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => updateAsset(tx, scope, param(req, "assetId"), req.body)),
  );
  app.post(`${M}/:assetId/archive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setAssetArchived(tx, scope, param(req, "assetId"), true, versionBody.parse(req.body).version)),
  );
  app.post(`${M}/:assetId/unarchive`, (req) =>
    inCms(auth, req, CMS_COMPOSE, (tx, scope) => setAssetArchived(tx, scope, param(req, "assetId"), false, versionBody.parse(req.body).version)),
  );
  // One rendition for the editor's preview: private, never cached.
  app.get(`${M}/:assetId/files/:file`, async (req, reply) => {
    const scope = await inCms(auth, req, CMS_READ, async (_tx, scope) => scope);
    const content = await assetContent(scope, param(req, "assetId"), fileParam.parse(req.params).file);
    return reply
      .header("Content-Type", content.mime)
      .header("Content-Length", String(content.bytes.byteLength))
      .header("Content-Disposition", contentDisposition("inline", content.name))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .send(Buffer.from(content.bytes));
  });
  // Public images of live content (public ingress only). The URL is the
  // credential; the bytes never change for a URL, so caches may keep them.
  app.get(
    "/api/public/cms/media/:token/:file",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token, file } = z.object({ token: z.string().max(100), file: z.string().max(20) }).parse(req.params);
      const media = await servePublicCmsMedia(token, file);
      return reply
        .header("Content-Type", media.mime)
        .header("Content-Length", String(media.bytes.byteLength))
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Cache-Control", PUBLIC_MEDIA_CACHE)
        .send(Buffer.from(media.bytes));
    },
  );
};
