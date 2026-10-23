import {
  prepareContentNovelty,
  commitTopic,
} from "./modules/marketing/agents/novelty.ts";
import { registerTaskRoutes } from "./platform/tasks/routes.ts";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_WRITE,
  platformActionPermissions,
} from "./platform/tenancy/permissions.ts";
import { knowledgeCollectionPermissions } from "./modules/knowledge/permissions.ts";
import { marketingCollectionPermissions } from "./modules/marketing/permissions.ts";
import { moduleRegistry, registerModules } from "./modules/registry.ts";
import {
  effectiveRole,
  hiddenKinds,
  highestRole,
  memberModuleRoles,
  moduleRolesEnabled,
  moduleScope,
  setMemberModuleRoles,
} from "./platform/tenancy/module-roles.ts";
import {
  registeredAction,
  registeredActionOwner,
  registeredActionPermission,
  registeredRegistry,
  registeredRoutesByOwner,
} from "./platform/modules/contributions.ts";
import {
  assertModuleEnabled,
  assertModuleEnabledFor,
} from "./platform/modules/enforcement.ts";
import {
  listModuleStates,
  moduleSwitchingEnabled,
  recordDefaultModules,
  setModuleEnabled,
} from "./platform/modules/activation.ts";
import { randomUUID } from "node:crypto";
import {
  agentRunsQuery,
  aiCostQuery,
  aiCostSummary,
  listAgentRuns,
  listRunSpans,
} from "./modules/ai-usage.ts";
import { pauseProject } from "./platform/governance/pause.ts";
import { exportProject } from "./platform/governance/export.ts";
import { closeRealtime, realtimeEnabled } from "./platform/realtime/fanout.ts";
import { serveEventStream } from "./platform/realtime/sse.ts";
import {
  runtimeHealth,
  closeRuntime,
  postizQueueState,
} from "./modules/runtime.ts";
import {
  createConversation,
  listConversations,
  archiveConversation,
  getConversation,
  sendMessage,
  getRun,
  cancelRun,
  runSnapshot,
  runStream,
  TERMINAL_RUN_STATUSES,
} from "./modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "./modules/action-requests.ts";
import { agentsEnabled } from "./modules/agents/assignments.ts";
import { assertMissionAssets } from "./modules/asset-tools.ts";
import { projectReadiness } from "./platform/governance/readiness.ts";
import { publicOpenAiConfiguration } from "./modules/openai-configuration.ts";
import { providerBudgetStatus } from "./platform/ai/provider-budget.ts";
import {
  beginConnect,
  finishConnect,
  connectionStatus,
  testDriveConnection,
  disconnect,
  configureRoot,
  rootCandidates,
  browseDrive,
  driveContent,
} from "./platform/connections/google-drive.ts";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { z } from "zod";
import { authDb, scoped, jsonSafe } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  authRequestBody,
  authRequestHeaders,
  isOriginExemptOAuth,
  oauthAuthPaths,
  pathOf,
  registerOAuthDiscovery,
  sendWebResponse,
} from "./platform/mcp-auth/http.ts";
import { registerMcpConnectRoutes } from "./platform/mcp-auth/routes.ts";
import * as schemas from "../../../packages/schemas/src/index.ts";
import { KnowledgeError } from "../../../packages/knowledge/src/index.ts";
import { setFact } from "./platform/knowledge/engine.ts";
import { makeAuth, renewedSessionCookies, scopeFor, userFor } from "./auth.ts";
import { clientIp, pinClientIpHeader } from "./client-ip.ts";
import {
  data,
  create,
  update,
  entity,
  list,
  publicEntity,
  DomainError,
  constantEqual,
  audit,
} from "./shared.ts";
import { activePolicy } from "./modules/policy.ts";
import {
  assertCampaignContext,
  assertContentCampaignContext,
} from "./modules/marketing-profile.ts";
import { type FetchLike } from "../../../packages/connectors/src/index.ts";
import {
  connectTelegram,
  disconnectTelegram,
  handleTelegramWebhook,
  telegramEnabled,
  telegramStatus,
} from "./platform/connections/telegram.ts";
const factSchema = z
  .object({
    id: schemas.id.optional(),
    key: z.string().min(1).max(160),
    value: z.string().min(1).max(1000),
    valueType: z.enum(["text", "decimal", "date", "status", "url"]),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    unit: z.string().max(50).optional(),
    language: schemas.languageCode,
    market: z.string().max(100).optional(),
    sourceId: schemas.id,
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().optional(),
    status: z.enum(["candidate", "verified"]),
    publicUse: z.boolean(),
    modelUse: z.boolean(),
    supersedesId: schemas.id.optional(),
    resolveConflictIds: z.array(schemas.id).max(50).optional(),
  })
  .strict();
import { installOpenApiSchemas, contractSchemas } from "./openapi.ts";
import {
  publicIngressEnabled,
  registerWebhookRoutes,
  WEBHOOK_PATH,
  WEBHOOK_URL,
} from "./platform/http/webhooks.ts";
import {
  createPublicKey,
  listPublicKeys,
  PUBLIC_URL,
  publicApiModules,
  registerPublicApi,
  revokePublicKey,
} from "./platform/http/public-api.ts";
import { connectionVerified } from "./platform/connections/connections.ts";
import {
  FILE_ROUTE_PREFIX,
  registerFileRoutes,
} from "./platform/files/routes.ts";
import { filesConfig } from "./platform/files/files.ts";
import {
  NOTIFICATION_ROUTES,
  registerNotificationRoutes,
} from "./platform/notifications/routes.ts";
import { notificationsEnabled } from "./platform/notifications/members.ts";
import { registerAttentionRoutes } from "./platform/attention/routes.ts";
import {
  isAdministrationRoute,
  registerAdministrationRoutes,
} from "./platform/administration/routes.ts";
import {
  accountEnabled,
  administrationEnabled,
} from "./platform/administration/authz.ts";
import { systemAudit } from "./platform/administration/audit.ts";
import {
  isConnectionRoute,
  registerConnectionRoutes,
} from "./platform/administration/connection-routes.ts";
import { connectionsEnabled } from "./platform/connections/central.ts";
import {
  isShareRoute,
  registerShareRoutes,
} from "./platform/knowledge/share-routes.ts";
import { sharesEnabled } from "./platform/knowledge/shares.ts";
import {
  isAccountRoute,
  registerAccountRoutes,
} from "./platform/account/routes.ts";
import { passwordResetAvailable } from "./platform/account/service.ts";
import { EMAIL_ROUTE, registerEmailRoutes } from "./platform/email/routes.ts";
import { emailEnabled } from "./platform/email/connection.ts";
const object = z.record(z.string(), z.unknown());
// Orbit Agents routes (Telegram bot, assignments, assignment posts), by registered pattern.
const AGENT_ROUTES = new Set([
  "/api/telegram/:projectId/:connectionId",
  "/api/projects/:projectId/telegram",
  "/api/projects/:projectId/telegram/connect",
  "/api/projects/:projectId/telegram/disconnect",
  "/api/projects/:projectId/assignments",
  "/api/projects/:projectId/assignments/:id/status",
  "/api/projects/:projectId/assignment-posts",
  "/api/projects/:projectId/agent-activity",
  "/api/projects/:projectId/publications/:id/veto",
  "/api/projects/:projectId/assignment-drafts",
  "/api/projects/:projectId/assignment-drafts/:id/release",
]);
// The plain webhook path only: exactly two lowercase UUIDs, nothing encoded.
const UUID_SEGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TELEGRAM_WEBHOOK_PATH = new RegExp(
  `^/api/telegram/${UUID_SEGMENT}/${UUID_SEGMENT}$`,
);
/** The permission an action needs; an unknown action needs the writer level. */
function actionPermission(action: string) {
  return (
    platformActionPermissions[action] ??
    registeredActionPermission(action) ??
    PROJECT_WRITE
  );
}
/** The module (or "platform") that owns a collection's entity kind. */
const collectionOwner = (collection: string) =>
  registeredRegistry().kindOwner.get(collection);
/** The permission a generic collection write needs. */
function collectionWritePermission(collection: string) {
  const owned: Record<string, ReturnType<typeof actionPermission>> = {
    ...knowledgeCollectionPermissions,
    ...marketingCollectionPermissions,
  };
  return owned[collection] ?? PROJECT_WRITE;
}
export async function buildServer(
  diagnostic?: (error: unknown) => void,
  options?: {
    logStream?: NodeJS.WritableStream;
    telegramFetch?: FetchLike;
    /** Test seam: the CIMD metadata transport (see makeAuth). */
    cimdFetch?: typeof fetch;
  },
) {
  // A broken module manifest stops the API before it serves anything.
  registerModules();
  const config = loadConfig(),
    auth = makeAuth({ cimdFetch: options?.cimdFetch });
  const app = Fastify({
    bodyLimit: 1500000,
    // req.ip stays the TCP peer; the forwarded client address is resolved by
    // clientIp(), which trusts it only from the internal web hop.
    trustProxy: false,
    // Never trust or echo client-supplied request ids.
    genReqId: () => randomUUID(),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      ...(options?.logStream ? { stream: options.logStream } : {}),
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
      // Path only (no query string), no headers, no bodies.
      serializers: {
        req: (req: { id: string; method: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: String(req.url).split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  // Before any hook or handler reads the header (Better Auth included).
  app.addHook("onRequest", async (req) => pinClientIpHeader(req));
  await app.register(rateLimit, {
    max: (req) => (["GET", "HEAD"].includes(req.method) ? 600 : 100),
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      clientIp(req) +
      (["GET", "HEAD"].includes(req.method) ? ":read" : ":write"),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "EDS Orbit API", version: "1.0.0" },
      servers: [{ url: config.APP_ORIGIN }],
    },
  });
  installOpenApiSchemas(app);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (
      _req: import("fastify").FastifyRequest,
      body: string,
      done: (error: Error | null, body?: unknown) => void,
    ) => done(null, body),
  );
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    // Orbit Agents routes do not exist while Orbit Agents is off: the same
    // 404 before Origin checking, body parsing and authentication. The
    // matched route pattern is checked, not the raw URL, so percent-encoded
    // paths cannot slip past (R62); each handler checks again.
    if (AGENT_ROUTES.has(req.routeOptions.url ?? "") && !agentsEnabled())
      throw new DomainError("NOT_FOUND", 404);
    // Platform files (WP4.6) do not exist while off or not configured.
    if (
      (req.routeOptions.url ?? "").startsWith(FILE_ROUTE_PREFIX) &&
      !filesConfig()
    )
      throw new DomainError("NOT_FOUND", 404);
    // The mailbox view (WP4.7) does not exist while e-mail is off.
    if (req.routeOptions.url === EMAIL_ROUTE && !emailEnabled())
      throw new DomainError("NOT_FOUND", 404);
    // Member notifications (WP4.7) do not exist while their flag is off.
    if (
      NOTIFICATION_ROUTES.has(req.routeOptions.url ?? "") &&
      !notificationsEnabled()
    )
      throw new DomainError("NOT_FOUND", 404);
    // System administration and account self-service (ADR 0013) do not
    // exist while their flags are off; the route pattern again.
    if (
      isAdministrationRoute(req.routeOptions.url ?? "") &&
      !administrationEnabled()
    )
      throw new DomainError("NOT_FOUND", 404);
    if (isAccountRoute(req.routeOptions.url ?? "") && !accountEnabled())
      throw new DomainError("NOT_FOUND", 404);
    // Central connections (ADR 0014) exist only while their flag is on.
    if (isConnectionRoute(req.routeOptions.url ?? "") && !connectionsEnabled())
      throw new DomainError("NOT_FOUND", 404);
    if (isShareRoute(req.routeOptions.url ?? "") && !sharesEnabled())
      throw new DomainError("NOT_FOUND", 404);
    // Public ingress (WP4.2) does not exist while its flag is off. The
    // route pattern, not the raw URL: /api/%70ublic/... matches it too.
    if (
      (req.routeOptions.url === WEBHOOK_PATH ||
        (req.routeOptions.url ?? "").startsWith("/api/public/")) &&
      !publicIngressEnabled()
    )
      throw new DomainError("NOT_FOUND", 404);
    // Signed provider webhooks carry their own authentication instead of a browser origin;
    // OAuth clients (token, revoke, introspect) authenticate in the request itself.
    if (
      !isOriginExemptOAuth(config, req.method, req.url) &&
      !/^\/api\/slack\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/interactions$/.test(
        req.url,
      ) &&
      !(req.method === "POST" && TELEGRAM_WEBHOOK_PATH.test(req.url)) &&
      !(req.method === "POST" && WEBHOOK_URL.test(req.url)) &&
      // Workflow outcomes are signed with the connection's secret (WP3.7).
      !(
        req.method === "POST" &&
        /^\/api\/automation\/callbacks\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(req.url)
      ) &&
      // The public API checks the Origin itself, against its key (WP4.2b).
      !(req.method === "POST" && PUBLIC_URL.test(req.url)) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.APP_ORIGIN
    )
      throw new DomainError("ORIGIN_REQUIRED", 403);
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const renewed = renewedSessionCookies(req);
    if (renewed.length) {
      const existing = reply.getHeader("set-cookie");
      reply.header("set-cookie", [
        ...(Array.isArray(existing)
          ? existing
          : existing
            ? [String(existing)]
            : []),
        ...renewed,
      ]);
    }
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    diagnostic?.(error);
    const status =
      error instanceof DomainError
        ? error.status
        : error instanceof KnowledgeError
          ? 409
          : error instanceof z.ZodError
            ? 400
            : ((error as any).statusCode ?? 500);
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof KnowledgeError
          ? error.code
          : error instanceof z.ZodError
            ? "VALIDATION_FAILED"
            : status === 429
              ? "RATE_LIMITED"
              : "REQUEST_FAILED";
    // Code/status only: error messages and stacks may carry secrets or user data.
    // errorName is added only for errors outside the known classes.
    const known =
      error instanceof DomainError ||
      error instanceof KnowledgeError ||
      error instanceof z.ZodError;
    req.log[status >= 500 ? "error" : "warn"](
      { code, status, ...(known ? {} : { errorName: (error as Error)?.name }) },
      "request failed",
    );
    reply.code(status).send({
      error: { code, message: code.replaceAll("_", " ").slice(0, 200) },
    });
  });
  // Orbit Telegram bot webhook (Orbit Agents): public, authenticated only by
  // the per-connection secret header and the bound chat (spec §10).
  app.post(
    "/api/telegram/:projectId/:connectionId",
    { bodyLimit: 262144 },
    async (req, reply) => {
      if (!telegramEnabled()) throw new DomainError("NOT_FOUND", 404);
      const { projectId, connectionId } = req.params as {
        projectId: string;
        connectionId: string;
      };
      const result = await handleTelegramWebhook(
        {
          projectId,
          connectionId,
          secret: req.headers["x-telegram-bot-api-secret-token"],
          body: req.body,
        },
        {
          fetch: options?.telegramFetch,
          log: (code) => req.log.warn({ code }, "telegram reply failed"),
        },
      );
      if (result.status === 401)
        return reply.code(401).send({
          error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED" },
        });
      return reply.code(200).send({ ok: true });
    },
  );
  // Signed provider webhooks of the modules (WP4.2a).
  await registerWebhookRoutes(app, { fetch: options?.telegramFetch });
  // The modules' public APIs (WP4.2b).
  await registerPublicApi(app);
  // Platform files (WP4.6).
  await registerFileRoutes(app, auth);
  // A member's own notifications and the project's mailbox (WP4.7).
  registerNotificationRoutes(app, auth);
  registerEmailRoutes(app, auth);
  // What needs the member's attention in the project (UI restructure §4.1).
  registerAttentionRoutes(app, auth);
  registerTaskRoutes(app, auth);
  // System administration, organization settings, invitations and the
  // user's own account (ADR 0013).
  registerAdministrationRoutes(app, auth, { runtimeHealth });
  registerAccountRoutes(app, auth);
  registerConnectionRoutes(app, auth);
  registerShareRoutes(app, auth);
  // Probes log at warn level only so they do not flood info logs.
  app.get("/health", { logLevel: "warn" }, async () => ({
    status: "ok",
    service: "orbit-api",
  }));
  // Public readiness for external uptime monitors: states only, no details.
  app.get("/api/health/ready", { logLevel: "warn" }, async (_req, reply) => {
    const database = await authDb.$queryRaw`SELECT 1`
      .then(() => "ok" as const)
      .catch(() => "unavailable" as const);
    const { worker } = await runtimeHealth();
    const ready = database === "ok" && worker === "ready";
    reply.status(ready ? 200 : 503);
    return { status: ready ? "ok" : "degraded", database, worker };
  });
  // Public Postiz delivery state for external monitors: 503 only when the worker saw overdue queued posts.
  app.get("/api/health/postiz", { logLevel: "warn" }, async (_req, reply) => {
    const status = await postizQueueState();
    reply.status(status === "stalled" ? 503 : 200);
    return { status };
  });
  app.get("/api/setup", async () => ({
    configured: (await authDb.workspace.count()) > 0,
    // Whether the sign-in page offers "forgot password" (ADR 0013).
    passwordReset: accountEnabled() && passwordResetAvailable(),
  }));
  app.post("/api/setup", async (req, reply) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        email: z.email(),
        password: z.string().min(12).max(128),
        workspaceName: z.string().min(1).max(100),
        setupToken: z.string().max(200),
      })
      .strict()
      .parse(req.body);
    if (!constantEqual(input.setupToken, config.ORBIT_SETUP_TOKEN))
      throw new DomainError("INVALID_SETUP_TOKEN", 403);
    await authDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(91377218)`;
        if (await tx.workspace.count())
          throw new DomainError("ALREADY_CONFIGURED", 409);
        const result = await auth.api.signUpEmail({
          body: {
            name: input.name,
            email: input.email,
            password: input.password,
          },
        });
        await tx.workspace.create({
          data: {
            name: input.workspaceName,
            members: { create: { userId: result.user.id, role: "owner" } },
          },
        });
        // A fresh installation's first user is its first system
        // administrator (ADR 0013); existing ones use the CLI.
        await tx.user.update({
          where: { id: result.user.id },
          data: { role: "admin" },
        });
        await systemAudit(
          {
            actorId: "system:setup",
            action: "system_admin.bootstrap",
            targetType: "user",
            targetId: result.user.id,
          },
          tx,
        );
      },
      { timeout: 30000 },
    );
    return reply.code(201).send({ configured: true });
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: {
      rateLimit: {
        max: 20,
        timeWindow: "1 minute",
        keyGenerator: (req: import("fastify").FastifyRequest) =>
          clientIp(req) + ":" + req.method + ":" + pathOf(req.url),
      },
    },
    handler: async (req, reply) => {
      const endpoint = pathOf(req.url);
      const permitted = [
        "/api/auth/sign-in/email",
        "/api/auth/sign-out",
        "/api/auth/get-session",
        ...oauthAuthPaths(config),
      ];
      if (!permitted.includes(endpoint))
        throw new DomainError("AUTH_ENDPOINT_DISABLED", 403);
      const body = authRequestBody(config, req);
      return sendWebResponse(
        reply,
        await auth.handler(
          new Request(new URL(req.url, config.APP_ORIGIN), {
            method: req.method,
            headers: authRequestHeaders(config, req),
            ...(body === undefined ? {} : { body }),
          }),
        ),
      );
    },
  });
  registerOAuthDiscovery(app, auth, config);
  registerMcpConnectRoutes(app, auth, config);
  app.get("/api/me", async (req) => {
    const user = await userFor(auth, req);
    const memberships = await authDb.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
    const projects = await authDb.project.findMany({
      where: {
        OR: [
          {
            workspace: {
              members: { some: { userId: user.id, role: "owner" } },
            },
          },
          { members: { some: { userId: user.id } } },
        ],
      },
      include: { members: { where: { userId: user.id } } },
    });
    const account = await authDb.user.findUnique({
      where: { id: user.id },
      select: { role: true, locale: true },
    });
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image ?? null,
        locale: account?.locale ?? null,
      },
      systemAdmin: administrationEnabled() && account?.role === "admin",
      administration: administrationEnabled(),
      account: accountEnabled(),
      connections: connectionsEnabled(),
      knowledgeShares: sharesEnabled(),
      workspaces: memberships.map((x) => ({
        ...x.workspace,
        role: x.role,
        canManage: administrationEnabled() && x.role === "owner",
      })),
      projects: projects.map((p) => ({
        ...p,
        role: memberships.find(
          (x) => x.workspaceId === p.workspaceId && x.role === "owner",
        )
          ? "owner"
          : p.members[0]?.role,
      })),
    };
  });
  app.get("/api/projects", async (req) => {
    const user = await userFor(auth, req);
    return {
      items: await authDb.project.findMany({
        where: {
          OR: [
            {
              workspace: {
                members: { some: { userId: user.id, role: "owner" } },
              },
            },
            { members: { some: { userId: user.id } } },
          ],
        },
      }),
    };
  });
  app.post("/api/projects", async (req, reply) => {
    const user = await userFor(auth, req);
    const input = z
      .object({
        name: z.string().min(1).max(100),
        timezone: z.string().default("UTC"),
        language: schemas.languageCode.default("en"),
        workspaceId: schemas.id.optional(),
      })
      .strict()
      .parse(req.body);
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new DomainError("INVALID_TIMEZONE");
    }
    const member = await authDb.workspaceMember.findFirst({
      where: {
        userId: user.id,
        role: "owner",
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
    });
    if (!member) throw new DomainError("OWNER_REQUIRED", 403);
    const project = await authDb.project.create({
      data: {
        name: input.name,
        timezone: input.timezone,
        language: input.language,
        contentLanguages: [input.language],
        workspaceId: member.workspaceId,
        members: {
          create: {
            userId: user.id,
            role: "owner",
          },
        },
      },
    });
    // The registry defaults, recorded as the migration did for existing
    // projects. Without these rows the same defaults apply.
    await scoped(project.workspaceId, project.id, (tx) =>
      recordDefaultModules(
        tx,
        {
          workspaceId: project.workspaceId,
          projectId: project.id,
          userId: user.id,
          role: "owner",
        },
        moduleRegistry(),
      ),
    );
    return reply
      .code(201)
      .send({
        ...project,
        ...(config.ORBIT_KNOWLEDGE_WORKSPACE === "true"
          ? { setupPath: `/p/${project.id}/knowledge/import` }
          : {}),
      });
  });
  // Module activation per project (WP1.4): readable by every member,
  // switchable by owners while ORBIT_MODULES is on. Not yet enforced.
  app.get("/api/projects/:projectId/modules", async (req) => {
    const { projectId } = req.params as any;
    const scope = await scopeFor(auth, req, projectId);
    const states = await scoped(scope.workspaceId, projectId, (tx) =>
      listModuleStates(tx, scope, moduleRegistry()),
    );
    return {
      features: {
        knowledgeWorkspace: config.ORBIT_KNOWLEDGE_WORKSPACE === "true",
        agents: agentsEnabled(),
        customerContext: config.ORBIT_CUSTOMER_CONTEXT === "true",
      },
      switchable: moduleSwitchingEnabled(),
      // The requesting member's role per module (WP4.5): "none" hides it.
      modules: states.map((state) => ({
        ...state,
        access: effectiveRole(scope, state.id),
      })),
    };
  });
  app.put("/api/projects/:projectId/modules/:moduleId", async (req) => {
    const { projectId, moduleId } = req.params as any;
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    if (!moduleSwitchingEnabled()) throw new DomainError("NOT_FOUND", 404);
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return {
      switchable: true,
      modules: await scoped(scope.workspaceId, projectId, (tx) =>
        setModuleEnabled(
          tx,
          scope,
          moduleRegistry(),
          String(moduleId),
          input.enabled,
        ),
      ),
    };
  });
  app.get("/api/projects/:projectId/dashboard", async (req) => {
    const { projectId } = req.params as any;
    const scope = await scopeFor(auth, req, projectId);
    // A module the member has no access to adds nothing here (WP4.5).
    const hidden = hiddenKinds(scope);
    const visible = (kind: string) => !hidden.includes(kind);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      const counts: Record<string, number> = {};
      for (const kind of schemas.collections.filter(visible))
        counts[kind] = await tx.entity.count({ where: { projectId, kind } });
      const reservations = await tx.budgetReservation.findMany({
        where: { projectId },
      });
      const policy = visible("policies")
        ? (await list(tx, scope, "policies")).find((x) => data(x).active)
        : undefined;
      if (visible("facts"))
        counts.verifiedFacts = (await list(tx, scope, "facts")).filter(
          (f) => data(f).status === "verified",
        ).length;
      counts.connectedConnectors = (await list(tx, scope, "connectors")).filter(
        (c) => connectionVerified(data(c).status),
      ).length;
      const capabilityReadiness = await projectReadiness(tx, scope);
      return {
        project,
        counts,
        exceptions: await list(tx, scope, "exceptions"),
        publications: visible("publications")
          ? await list(tx, scope, "publications")
          : [],
        jobs: await list(tx, scope, "jobs"),
        budget: {
          reservedMicros: reservations
            .filter((x) =>
              ["reserved", "in_flight", "unknown"].includes(x.state),
            )
            .reduce((n, x) => n + Number(x.amountMicros), 0),
          spentMicros: reservations
            .filter((x) => x.state === "settled")
            .reduce((n, x) => n + Number(x.settledMicros), 0),
          dailyLimitMicros: data(policy).dailyBudgetMicros ?? null,
          monthlyLimitMicros: data(policy).monthlyBudgetMicros ?? null,
        },
        readiness: capabilityReadiness,
      };
    });
  });
  app.get("/api/projects/:projectId/operations", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    const runtime = await runtimeHealth();
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      runtime,
      jobs: await list(tx, scope, "jobs"),
      pendingOutbox: await tx.outbox.count({
        where: { projectId, dispatchedAt: null },
      }),
      connectorStates: (await list(tx, scope, "connectors")).map(publicEntity),
      exceptions: await list(tx, scope, "exceptions"),
    }));
  });
  app.get("/api/projects/:projectId/agent-runs", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    return listAgentRuns(scope, agentRunsQuery.parse(req.query));
  });
  app.get("/api/projects/:projectId/agent-runs/:runId/spans", async (req) => {
    const { projectId, runId } = req.params as {
      projectId: string;
      runId: string;
    };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    return { items: await listRunSpans(scope, z.uuid().parse(runId)) };
  });
  app.get("/api/projects/:projectId/ai-cost", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    return aiCostSummary(scope, aiCostQuery.parse(req.query));
  });
  // The Anthropic credit budget of the project: period, spend and level
  // (plan D-A6, D-A8). Same level as /ai-cost; no key, no prompt content.
  app.get("/api/projects/:projectId/ai-budget", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    const status = await scoped(scope.workspaceId, projectId, (tx) =>
      providerBudgetStatus(tx, scope, "anthropic"),
    );
    return {
      providers: {
        anthropic: {
          configured: status.configured,
          budget: status.budget,
          level: status.level,
          spend: status.spend
            ? {
                spentMicros: String(status.spend.spentMicros),
                settledMicros: String(status.spend.settledMicros),
                pendingMicros: String(status.spend.pendingMicros),
                unknownMicros: String(status.spend.unknownMicros),
                count: status.spend.count,
                periodStart: status.spend.periodStart.toISOString(),
                periodEnd: status.spend.periodEnd.toISOString(),
              }
            : null,
          // Orbit calculates its spend itself; the credit balance is the
          // owner's manually verified value and is not read from Anthropic.
          creditSync: "manual",
        },
      },
    };
  });
  app.get("/api/projects/:projectId/openai-configuration", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, async (tx) =>
      publicOpenAiConfiguration(
        await tx.entity.findFirst({
          where: {
            workspaceId: scope.workspaceId,
            projectId,
            kind: "openai_configuration",
          },
        }),
      ),
    );
  });
  app.get("/api/projects/:projectId/export", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, (tx) =>
      exportProject(tx, scope),
    );
  });

  // Module routes at their existing paths (WP2.1f).
  // A disabled module's project routes answer 404 MODULE_DISABLED after the
  // membership check (WP2.4); public webhooks keep their own checks.
  for (const [owner, routes] of registeredRoutesByOwner())
    await app.register(async (child) => {
      child.addHook("preHandler", async (req) => {
        // scopeFor gives the module's routes the member's role in the module (WP4.5).
        (req as { orbitModule?: string }).orbitModule = owner;
        if (!moduleSwitchingEnabled()) return;
        if (!req.routeOptions.url?.startsWith("/api/projects/:projectId/"))
          return;
        const { projectId } = req.params as { projectId: string };
        await assertModuleEnabledFor(
          await scopeFor(auth, req, projectId),
          owner,
        );
      });
      routes({ app: child, auth, config });
    });

  app.post("/api/workspaces/:workspaceId/pause", async (req) => {
    const user = await userFor(auth, req),
      workspaceId = schemas.id.parse((req.params as any).workspaceId);
    const membership = await authDb.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (membership?.role !== "owner") throw new DomainError("FORBIDDEN", 403);
    const { paused } = z
      .object({ paused: z.boolean() })
      .strict()
      .parse(req.body);
    // All current projects are fenced atomically before reconciling individual pending intents.
    await authDb.project.updateMany({
      where: { workspaceId },
      data: { paused, generation: { increment: 1 } },
    });
    const projects = await authDb.project.findMany({ where: { workspaceId } });
    for (const project of projects)
      await scoped(workspaceId, project.id, (tx) =>
        pauseProject(
          tx,
          {
            workspaceId,
            projectId: project.id,
            userId: user.id,
            role: "owner",
          },
          paused,
        ),
      );
    return { paused, projectIds: projects.map((p) => p.id) };
  });
  app.get("/api/projects/:projectId/members", async (req) => {
    const { projectId } = req.params as any;
    await scopeFor(auth, req, projectId, PROJECT_OWN);
    return {
      items: await authDb.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    };
  });
  // Public API keys (WP4.2b): owners only, while ORBIT_PUBLIC_INGRESS is on.
  app.get("/api/projects/:projectId/public-keys", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return {
      items: await listPublicKeys(
        await scopeFor(auth, req, projectId, PROJECT_OWN),
      ),
      // The modules a new key can be issued for.
      modules: publicApiModules(),
    };
  });
  app.post("/api/projects/:projectId/public-keys", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return reply.code(201).send(await createPublicKey(scope, req.body));
  });
  app.post(
    "/api/projects/:projectId/public-keys/:keyId/revoke",
    async (req) => {
      const { projectId, keyId } = req.params as {
        projectId: string;
        keyId: string;
      };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return revokePublicKey(scope, z.uuid().parse(keyId));
    },
  );
  // A member's module roles (WP4.5): owners only, while ORBIT_MODULE_ROLES is on.
  app.get(
    "/api/projects/:projectId/members/:userId/module-roles",
    async (req) => {
      const { projectId, userId } = req.params as {
        projectId: string;
        userId: string;
      };
      await scopeFor(auth, req, projectId, PROJECT_OWN);
      if (!moduleRolesEnabled()) throw new DomainError("NOT_FOUND", 404);
      return { userId, roles: await memberModuleRoles(projectId, userId) };
    },
  );
  app.put(
    "/api/projects/:projectId/members/:userId/module-roles",
    async (req) => {
      const { projectId, userId } = req.params as {
        projectId: string;
        userId: string;
      };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return setMemberModuleRoles(scope, userId, req.body);
    },
  );
  // Owner-only Telegram bot setup (Orbit Agents). The token goes in once and never comes back.
  app.get("/api/projects/:projectId/telegram", async (req) => {
    if (!telegramEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, (tx) =>
      telegramStatus(tx, scope),
    );
  });
  app.post("/api/projects/:projectId/telegram/connect", async (req) => {
    if (!telegramEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    return connectTelegram(
      await scopeFor(auth, req, projectId, PROJECT_OWN),
      req.body,
      { fetch: options?.telegramFetch },
    );
  });
  app.post("/api/projects/:projectId/telegram/disconnect", async (req) => {
    if (!telegramEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    return disconnectTelegram(
      await scopeFor(auth, req, projectId, PROJECT_OWN),
      { fetch: options?.telegramFetch },
    );
  });
  app.get("/api/projects/:projectId/google-drive", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return connectionStatus(await scopeFor(auth, req, projectId));
  });
  app.post("/api/projects/:projectId/google-drive/connect", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return beginConnect(await scopeFor(auth, req, projectId, PROJECT_OWN));
  });
  app.get("/api/google-drive/callback", async (req, reply) => {
    const { code, state } = z
      .object({ code: z.string().min(1), state: z.string().min(40) })
      .parse(req.query);
    const projectId = z.uuid().parse(state.split(".")[0]);
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    const ready = await finishConnect(scope, state, code);
    return reply.redirect(
      `${config.APP_ORIGIN}/settings?googleDrive=${ready ? "ready" : "choose-root"}`,
    );
  });
  app.get(
    "/api/projects/:projectId/google-drive/root-candidates",
    async (req) => {
      const { projectId } = req.params as { projectId: string };
      const { pageToken } = z
        .object({ pageToken: z.string().max(500).optional() })
        .parse(req.query);
      return rootCandidates(
        await scopeFor(auth, req, projectId, PROJECT_OWN),
        pageToken,
      );
    },
  );
  app.get("/api/projects/:projectId/google-drive/health", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return testDriveConnection(await scopeFor(auth, req, projectId));
  });
  app.post("/api/projects/:projectId/google-drive/disconnect", async (req) => {
    const { projectId } = req.params as { projectId: string };
    await disconnect(await scopeFor(auth, req, projectId, PROJECT_OWN));
    return { connected: false };
  });
  app.put("/api/projects/:projectId/google-drive/root", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    await configureRoot(scope, req.body);
    return connectionStatus(scope);
  });
  app.get("/api/projects/:projectId/google-drive/files", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return browseDrive(await scopeFor(auth, req, projectId), req.query);
  });
  app.get(
    "/api/projects/:projectId/google-drive/files/:fileId/content",
    async (req, reply) => {
      const { projectId, fileId } = req.params as {
        projectId: string;
        fileId: string;
      };
      const content = await driveContent(
        await scopeFor(auth, req, projectId),
        fileId,
      );
      return reply
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("X-Content-Type-Options", "nosniff")
        .type(content.mime)
        .send(content.bytes);
    },
  );
  app.get("/api/projects/:projectId/chat/conversations", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    const cursor = z
      .uuid()
      .optional()
      .parse((req.query as any)?.cursor);
    return listConversations(
      scope,
      cursor,
      (req.query as any)?.archived === "true",
    );
  });
  app.post(
    "/api/projects/:projectId/chat/conversations/:id/archive",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId);
      return archiveConversation(scope, z.uuid().parse(id), req.body);
    },
  );
  app.post(
    "/api/projects/:projectId/chat/conversations",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId);
      return reply.code(201).send(await createConversation(scope));
    },
  );
  app.get("/api/projects/:projectId/chat/conversations/:id", async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId);
    return getConversation(scope, z.uuid().parse(id));
  });
  app.post(
    "/api/projects/:projectId/chat/conversations/:id/messages",
    async (req, reply) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId);
      return reply
        .code(202)
        .send(await sendMessage(scope, z.uuid().parse(id), req.body));
    },
  );
  app.get("/api/projects/:projectId/chat/runs/:id", async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId);
    return getRun(scope, z.uuid().parse(id));
  });
  app.get(
    "/api/projects/:projectId/chat/runs/:id/events",
    async (req, reply) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId);
      const runId = z.uuid().parse(id);
      await getRun(scope, runId);
      // WP4.3 Part B: wait on the real-time fan-out instead of polling.
      if (realtimeEnabled())
        return serveEventStream(req, reply, {
          projectId,
          stream: runStream(runId),
          async replay(after) {
            const run = await getRun(scope, runId);
            return {
              // The snapshot is the whole run, so only the latest counts.
              events:
                after === null || run.sequence > after
                  ? [
                      {
                        id: run.sequence,
                        event: "snapshot",
                        data: runSnapshot(run),
                      },
                    ]
                  : [],
              done: TERMINAL_RUN_STATUSES.includes(run.status),
            };
          },
        });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let last = Number(req.headers["last-event-id"] ?? -1);
      let busy = false;
      const started = Date.now();
      const timer = setInterval(async () => {
        if (busy || reply.raw.destroyed) return;
        busy = true;
        try {
          const run = await getRun(scope, runId);
          if (run.sequence !== last) {
            last = run.sequence;
            reply.raw.write(
              `id: ${run.sequence}\nevent: snapshot\ndata: ${JSON.stringify(runSnapshot(run))}\n\n`,
            );
          } else reply.raw.write(": keepalive\n\n");
          if (
            TERMINAL_RUN_STATUSES.includes(run.status) ||
            Date.now() - started > 39000
          ) {
            clearInterval(timer);
            reply.raw.end();
          }
        } catch {
          clearInterval(timer);
          reply.raw.end();
        } finally {
          busy = false;
        }
      }, 700);
      reply.raw.on("close", () => clearInterval(timer));
    },
  );
  app.post("/api/projects/:projectId/chat/runs/:id/cancel", async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId);
    return cancelRun(scope, z.uuid().parse(id));
  });
  // Owners' open decisions (image requests from editors' packages and others).
  app.get("/api/projects/:projectId/action-requests", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return {
      items: await scoped(scope.workspaceId, projectId, (tx) =>
        listActionRequests(tx, scope),
      ),
    };
  });
  // Decision on one exact action request; role and checks come from its
  // action type and the member's role in the type's module (WP4.5).
  app.post(
    "/api/projects/:projectId/action-requests/:id/decide",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId);
      // Writers only, in at least one module; the type's module decides next.
      authorize({ role: highestRole(scope) }, PROJECT_WRITE);
      const decided = await scoped(scope.workspaceId, projectId, (tx) =>
        decideActionRequest(tx, scope, z.uuid().parse(id), req.body),
      );
      return {
        id: decided.id,
        version: decided.version,
        status: data(decided).status,
      };
    },
  );
  app.get("/api/projects/:projectId/:collection", async (req) => {
    const { projectId, collection } = req.params as any;
    // A module may expose its own kinds for reading (EntityKindDef.collection).
    if (!registeredRegistry().collectionKinds.includes(collection))
      schemas.collection.parse(collection);
    const scope = moduleScope(
      await scopeFor(auth, req, projectId),
      collectionOwner(collection),
    );
    return scoped(scope.workspaceId, projectId, async (tx) => {
      await assertModuleEnabled(tx, scope, collectionOwner(collection));
      return {
        items: (await list(tx, scope, collection))
          // Composed assignment banners are bound to their post (R78): no library entry.
          .filter((row) => collection !== "assets" || !data(row).boundTo)
          .slice(0, 500)
          .map(publicEntity),
      };
    });
  });
  app.post("/api/projects/:projectId/:collection", async (req, reply) => {
    const { projectId, collection } = req.params as any;
    const scope = moduleScope(
      await scopeFor(auth, req, projectId),
      collectionOwner(collection),
    );
    authorize(scope, collectionWritePermission(collection));
    const result = await scoped(scope.workspaceId, projectId, async (tx) => {
      await assertModuleEnabled(tx, scope, collectionOwner(collection));
      if (collection === "facts")
        return setFact(tx, scope, factSchema.parse(req.body));
      let parsed: Record<string, any>;
      if (collection === "sources") parsed = schemas.source.parse(req.body);
      else if (collection === "missions") {
        parsed = { ...schemas.mission.parse(req.body), status: "ready" };
        await assertCampaignContext(tx, scope, parsed);
        const active = await activePolicy(tx, scope);
        if (active) {
          const mandate = data(active);
          if (
            parsed.channels.some(
              (channel: string) => !mandate.channels?.includes(channel),
            ) ||
            !mandate.contentTypes?.includes(parsed.contentType)
          )
            throw new DomainError("SCOPE_NOT_ALLOWED", 409);
          if (
            !mandate.allowedOrigins?.includes(new URL(parsed.targetUrl).origin)
          )
            throw new DomainError("LINK_NOT_ALLOWED", 409);
        }
        await assertMissionAssets(tx, scope, parsed.assetIds);
      } else if (collection === "content") {
        parsed = {
          ...schemas.content.parse(req.body),
          status: "draft",
          origin: "human_authored",
          synthetic: false,
        };
        await entity(tx, scope, "evidence", parsed.evidenceId);
        await assertContentCampaignContext(tx, scope, parsed);
      } else if (collection === "policies") {
        parsed = schemas.policy.parse(req.body);

        for (const p of await list(tx, scope, "policies"))
          if (data(p).active)
            await update(tx, scope, p, { ...data(p), active: false });
        parsed = {
          ...parsed,
          active: true,
          activatedBy: scope.userId,
          activatedAt: new Date().toISOString(),
        };
        await tx.project.update({
          where: { id: projectId },
          data: { mode: parsed.mode },
        });
      } else if (collection === "metrics") {
        parsed = schemas.metric.parse(req.body);
        const old = (await list(tx, scope, "metrics")).find(
          (x) =>
            data(x).source === parsed.source &&
            data(x).externalId === parsed.externalId,
        );
        if (old) return old;
      } else if (collection === "preferences")
        parsed = schemas.preference.parse(req.body);
      else if (collection === "experiments")
        parsed = { ...schemas.experiment.parse(req.body), status: "planned" };
      else throw new DomainError("COLLECTION_NOT_WRITABLE", 403);
      const hold =
        collection === "content"
          ? await prepareContentNovelty(tx, scope, parsed)
          : null;
      const row = await create(tx, scope, collection, parsed);
      if (hold) await commitTopic(tx, scope, hold, row.id);
      if (
        collection === "policies" &&
        parsed.mode === "autopilot" &&
        config.EXECUTION_MODE === "live"
      ) {
        const state = await projectReadiness(tx, scope);
        if (state.blockers.length)
          throw new DomainError(
            "LIVE_ACTIVATION_BLOCKED:" + state.blockers.join(","),
            409,
          );
      }
      await audit(tx, scope, collection + ".create", row.id);
      return row;
    });
    return reply.code(201).send(jsonSafe(result));
  });
  app.post("/api/projects/:projectId/actions/:action", async (req) => {
    const { projectId, action } = req.params as any;
    // Every action declares its permission in the owning module's catalogue;
    // an unknown name needs the writer level, as before (WP1.5).
    // The member's role in the action's module decides (WP4.5).
    const owner = registeredActionOwner(action);
    const scope = moduleScope(await scopeFor(auth, req, projectId), owner);
    authorize(scope, actionPermission(action));
    const input = object.parse(req.body);
    // Handlers come from the platform and the modules (WP2.1f).
    const handler = registeredAction(action);
    if (!handler) throw new DomainError("ACTION_NOT_SUPPORTED", 400);
    const ctx = { scope, input, config, auth };
    // A disabled module's actions answer 404 MODULE_DISABLED (WP2.4).
    if (handler.transaction === "own") {
      await assertModuleEnabledFor(scope, owner);
      return handler.run(ctx);
    }
    return scoped(scope.workspaceId, projectId, async (tx) => {
      await assertModuleEnabled(tx, scope, owner);
      return handler.run(tx, ctx);
    });
  });
  app.get("/api/openapi.json", async (req) => {
    await userFor(auth, req);
    return { ...app.swagger(), components: { schemas: contractSchemas } };
  });
  app.addHook("onClose", async () => {
    closeRuntime();
    await closeRealtime();
  });
  await app.ready();
  return app;
}
