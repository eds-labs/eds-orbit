import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { disconnectAccount, listAccounts, updateAccountSettings } from "./accounts/accounts.ts";
import { requestWriteVerification } from "./accounts/verify-write.ts";
import { appReadiness, redirectUri } from "./accounts/apps.ts";
import { connectHandler, oauthPlatform } from "./accounts/connect.ts";
import { handleMetaDataDeletion, metaDataDeletionStatus } from "./accounts/data-deletion.ts";
import { checkAccount } from "./accounts/health.ts";
import { consumeOAuthState, projectOfState } from "./accounts/oauth-state.ts";
import { connectTelegramChannel } from "./accounts/telegram.ts";
import type { FastifyRequest } from "fastify";
import { contentDisposition } from "../../platform/files/routes.ts";
import { assertModuleEnabledFor } from "../../platform/modules/enforcement.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { DomainError } from "../../shared.ts";
import { listMedia, mediaContent, removeMedia, updateMedia, uploadMedia } from "./media/library.ts";
import { servePublicMedia } from "./media/public-url.ts";
import { inSocial, SOCIAL_BASE, type Params } from "./http-scope.ts";
import { requireSocial } from "./gate.ts";
import { socialPostRoutes } from "./posts/routes.ts";
import { socialModule } from "./manifest.ts";
import { SOCIAL_ACCOUNTS_MANAGE, SOCIAL_COMPOSE, SOCIAL_READ, SOCIAL_SETTINGS } from "./permissions.ts";
import { readSocialSettings, saveSocialSettings } from "./settings.ts";

// The social module's HTTP API (ADR 0020, plan §6.2). Every route runs
// through `inSocial` (http-scope.ts); post routes live in posts/routes.ts.

const BASE = SOCIAL_BASE;

const settingsInput = z.object({ settings: z.unknown(), version: z.int().min(1) }).strict();
const appParam = z.object({ app: z.enum(["meta", "x"]) });
const accountParam = z.object({ accountId: z.uuid() }).passthrough();
const mediaParam = z.object({ mediaId: z.uuid() }).passthrough();
const renditionQuery = z.object({ rendition: z.enum(["original", "jpeg"]).default("original") }).passthrough();
const UPLOAD_RATE = { rateLimit: { max: 60, timeWindow: "1 minute" } };
const callbackQuery = z
  .object({
    state: z.string().min(40).max(200),
    code: z.string().min(1).max(2000).optional(),
    error: z.string().max(200).optional(),
  })
  .passthrough();
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^SOCIAL_[A-Z0-9_]{1,60}$/.test(code) ? code : "SOCIAL_CONNECT_FAILED";
};

/** Social module routes (plan §6.2); later phases add accounts, posts and media. */
export const socialRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.get(`${BASE}/status`, (req) =>
    inSocial(auth, req, SOCIAL_READ, async (tx, scope) => {
      const { settings, version } = await readSocialSettings(tx, scope);
      return {
        module: "social" as const,
        version: socialModule.version,
        settings,
        settingsVersion: version,
      };
    }),
  );
  app.post(`${BASE}/accounts/connect/:app`, (req) =>
    inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, (tx, scope, params) =>
      connectHandler(appParam.parse(params).app).begin(tx, scope),
    ),
  );
  app.get(`${BASE}/accounts`, (req) => inSocial(auth, req, SOCIAL_READ, (tx, scope) => listAccounts(tx, scope)));
  // Which developer apps can start a connection (owners only; no secret).
  app.get(`${BASE}/accounts/apps`, (req) =>
    inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, (tx, scope) => appReadiness(tx, scope)),
  );
  // A real test post per account, approved by the owner (S5).
  app.post(`${BASE}/accounts/:accountId/verify-write`, (req) =>
    inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, (tx, scope) =>
      requestWriteVerification(tx, scope, accountParam.parse(req.params).accountId, req.body),
    ),
  );
  app.patch(`${BASE}/accounts/:accountId`, (req) =>
    inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, (tx, scope) =>
      updateAccountSettings(tx, scope, accountParam.parse(req.params).accountId, req.body),
    ),
  );
  app.post(`${BASE}/accounts/:accountId/check`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return checkAccount(scope, accountParam.parse(req.params).accountId, { manual: true });
  });
  app.post(`${BASE}/accounts/:accountId/disconnect`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return disconnectAccount(scope, accountParam.parse(req.params).accountId, req.body);
  });
  // Permission and module first; the provider calls run outside the project
  // transaction, which they would otherwise hold open.
  app.post(`${BASE}/accounts/telegram`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_ACCOUNTS_MANAGE, async (_tx, scope) => scope);
    return connectTelegramChannel(scope, req.body);
  });
  // Meta's data-deletion request (public ingress only; signed by Meta).
  app.post(
    "/api/callbacks/social/meta-data-deletion",
    { bodyLimit: 16_384, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    (req) => handleMetaDataDeletion(req.body),
  );
  // The status behind a confirmation code, for the public status page.
  app.get(
    "/api/public/social/data-deletion/:code",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { code } = z.object({ code: z.string().max(100) }).parse(req.params);
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Robots-Tag", "noindex, nofollow")
        .send(metaDataDeletionStatus(code));
    },
  );
  // The provider sends the browser here (outside the project path, so the
  // project comes from the state). The member must be the signed-in owner
  // who started the flow; the state is used once, before any token exchange.
  app.get("/api/social/oauth/callback/:app", async (req, reply) => {
    const { app: provider } = appParam.parse(req.params);
    const query = callbackQuery.parse(req.query);
    const projectId = projectOfState(query.state);
    const scope = await scopeFor(auth, req, projectId, SOCIAL_ACCOUNTS_MANAGE);
    const accounts = `/p/${projectId}/social/accounts`;
    let attempt;
    try {
      attempt = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        await requireSocial(tx, scope);
        return consumeOAuthState(tx, scope, { state: query.state, platform: oauthPlatform(provider) });
      });
    } catch (error) {
      if (errorCode(error) !== "SOCIAL_OAUTH_STATE_INVALID") throw error;
      return reply.redirect(`${accounts}?error=SOCIAL_OAUTH_STATE_INVALID`);
    }
    if (query.error || !query.code)
      return reply.redirect(`${attempt.redirectAfter}?error=SOCIAL_OAUTH_CANCELLED`);
    const raw = req.url.slice(req.url.indexOf("?") + 1);
    try {
      const done = await connectHandler(provider).finish(scope, {
        callbackUrl: `${redirectUri(loadConfig(), provider)}?${raw}`,
        state: query.state,
        attempt,
      });
      return reply.redirect(`${attempt.redirectAfter}?connected=${done.accounts}`);
    } catch (error) {
      return reply.redirect(`${attempt.redirectAfter}?error=${errorCode(error)}`);
    }
  });
  // Media library (S3). The upload takes the raw bytes like the platform
  // file route; membership, module, permission and content type are checked
  // before a byte of the body is read.
  const uploadScope = new WeakMap<object, Scope>();
  app.register(async (child) => {
    child.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: loadConfig().FILES_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      `${BASE}/media`,
      {
        bodyLimit: loadConfig().FILES_MAX_BYTES,
        config: UPLOAD_RATE,
        onRequest: async (req) => {
          (req as { orbitModule?: string }).orbitModule = "social";
          const { projectId } = req.params as Params;
          const member = await scopeFor(auth, req, projectId);
          await assertModuleEnabledFor(member, "social");
          authorize(member, SOCIAL_COMPOSE);
          await scoped(member.workspaceId, member.projectId, (tx) => requireSocial(tx, member));
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
        const media = await uploadMedia(scope, {
          bytes: req.body,
          mime: String(req.headers["x-file-type"] ?? ""),
          ...(name ? { name } : {}),
        });
        return reply.code(201).send(media);
      },
    );
  });
  app.get(`${BASE}/media`, (req) => inSocial(auth, req, SOCIAL_READ, (tx, scope) => listMedia(tx, scope)));
  app.get(`${BASE}/media/:mediaId/content`, async (req, reply) => {
    const scope = await inSocial(auth, req, SOCIAL_READ, async (_tx, scope) => scope);
    const { mediaId } = mediaParam.parse(req.params);
    const { rendition } = renditionQuery.parse(req.query ?? {});
    const content = await mediaContent(scope, mediaId, rendition);
    return reply
      .header("Content-Type", content.mime)
      .header("Content-Length", String(content.bytes.byteLength))
      .header("Content-Disposition", contentDisposition("inline", content.name))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .send(Buffer.from(content.bytes));
  });
  // Signed public media (public ingress only): a platform fetches a post's
  // image while the post is being sent.
  app.get(
    "/api/public/social/media/:token",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = z.object({ token: z.string().max(300) }).parse(req.params);
      const media = await servePublicMedia(token);
      return reply
        .header("Content-Type", media.mime)
        .header("Content-Length", String(media.bytes.byteLength))
        .header("Content-Disposition", contentDisposition("inline", media.name))
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Robots-Tag", "noindex, nofollow")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, no-store")
        .send(Buffer.from(media.bytes));
    },
  );
  app.patch(`${BASE}/media/:mediaId`, (req) =>
    inSocial(auth, req, SOCIAL_COMPOSE, (tx, scope) =>
      updateMedia(tx, scope, mediaParam.parse(req.params).mediaId, req.body),
    ),
  );
  app.delete(`${BASE}/media/:mediaId`, async (req) => {
    const scope = await inSocial(auth, req, SOCIAL_COMPOSE, async (_tx, scope) => scope);
    return removeMedia(scope, mediaParam.parse(req.params).mediaId);
  });
  socialPostRoutes(context);
  app.put(`${BASE}/settings`, (req) =>
    inSocial(auth, req, SOCIAL_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return saveSocialSettings(tx, scope, settings, version);
    }),
  );
};
