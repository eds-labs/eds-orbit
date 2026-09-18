import {
  proposeBrief,
  briefProposalInput,
  importCommunityQuestions,
  communityImportInput,
  linkCommunityGroup,
  communityLinkInput,
  adaptContent,
  contentAdaptationInput,
} from "./modules/editorial.ts";
import { matomoImportInput, importMatomoReport } from "./modules/matomo.ts";
import { withdrawFact } from "../../../packages/knowledge/src/index.ts";
import {
  queueIndexEvaluation,
  indexEvaluationRequest,
} from "./modules/index-evaluation.ts";
import {
  preparePostizVerification,
  executePostizVerification,
  reconcilePostizVerification,
  postizVerificationInput,
  postizVerificationApproval,
} from "./modules/postiz-verification.ts";
import { pauseProject } from "./modules/pause.ts";
import {
  blockCalendar,
  unblockCalendar,
  calendarBlock,
} from "./modules/calendar.ts";
import {
  listIndexGenerations,
  beginIndexBuild,
  activateIndexGeneration,
  rollbackIndexGeneration,
} from "../../../packages/knowledge/src/index.ts";
import { runtimeHealth, closeRuntime } from "./modules/runtime.ts";
import {
  configureSlack,
  queueSlackDigest,
  handleSlackInteraction,
  slackConfiguration,
} from "./modules/slack.ts";
import { readiness } from "./modules/readiness.ts";
import {
  publicOpenAiConfiguration,
  saveOpenAiConfiguration,
} from "./modules/openai-configuration.ts";
import {
  correctMetric,
  memoryLifecycle,
  evaluateExperiment,
  stopExperiment,
  retention,
} from "./modules/lifecycle.ts";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { z } from "zod";
import { authDb, scoped, jsonSafe } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import * as schemas from "../../../packages/schemas/src/index.ts";
import {
  ingest,
  retrieve,
  setFact,
  revokeSource,
  setSourceRights,
  revokeDocument,
  extractDocument,
  validateEvidence,
  KnowledgeError,
} from "../../../packages/knowledge/src/index.ts";
import { makeAuth, scopeFor, userFor, fromNodeHeaders } from "./auth.ts";
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
  encrypt,
  decrypt,
  exception,
  hash,
} from "./shared.ts";
import { approve, preflight } from "./modules/policy.ts";
import { invalidateContent } from "./modules/content-invalidation.ts";
import {
  currentMarketingProfile,
  saveMarketingProfile,
  assertCampaignContext,
  assertContentCampaignContext,
} from "./modules/marketing-profile.ts";
import {
  planMission,
  publishIntent,
  analyze,
  reviewContent,
  enqueue,
} from "./modules/workflow.ts";
import {
  createPostizClient,
  createMatomoClient,
  importAdsCsv,
  exportBlogArticle,
  ConnectorError,
} from "../../../packages/connectors/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
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
    language: z.enum(["en", "de"]),
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
import { retrieveHybrid } from "./modules/retrieval.ts";
import {
  commitKnowledgeImport,
  importPreview,
  knowledgeImportInput,
  retryKnowledgeImport,
} from "./modules/knowledge-import.ts";
import { installOpenApiSchemas, contractSchemas } from "./openapi.ts";
const object = z.record(z.string(), z.unknown());
export async function buildServer(diagnostic?: (error: unknown) => void) {
  const config = loadConfig(),
    auth = makeAuth();
  const app = Fastify({ logger: false, bodyLimit: 1500000, trustProxy: false });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, {
    max: (req) => (["GET", "HEAD"].includes(req.method) ? 600 : 100),
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      req.ip + (["GET", "HEAD"].includes(req.method) ? ":read" : ":write"),
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
    if (
      !/^\/api\/slack\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/interactions$/.test(
        req.url,
      ) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.APP_ORIGIN
    )
      throw new DomainError("ORIGIN_REQUIRED", 403);
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
    reply.code(status).send({
      error: { code, message: code.replaceAll("_", " ").slice(0, 200) },
    });
  });
  app.post(
    "/api/slack/:workspaceId/:projectId/interactions",
    async (req, reply) => {
      const params = z
        .object({ workspaceId: schemas.id, projectId: schemas.id })
        .parse(req.params);
      try {
        await handleSlackInteraction({
          ...params,
          rawBody: z.string().max(1000000).parse(req.body),
          timestamp: z.string().parse(req.headers["x-slack-request-timestamp"]),
          signature: z.string().parse(req.headers["x-slack-signature"]),
        });
        return reply.code(200).send("");
      } catch (error) {
        if (error instanceof ConnectorError) {
          if (error.code === "SLACK_REPLAY") return reply.code(200).send("");
          throw new DomainError(
            error.code,
            error.code === "SLACK_PAYLOAD_INVALID" ? 400 : 403,
          );
        }
        throw error;
      }
    },
  );
  app.get("/health", async () => ({ status: "ok", service: "orbit-api" }));
  app.get("/api/setup", async () => ({
    configured: (await authDb.workspace.count()) > 0,
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
          req.ip + ":" + req.method + ":" + req.url.split("?")[0],
      },
    },
    handler: async (req, reply) => {
      const endpoint = req.url.split("?")[0];
      const permitted = [
        "/api/auth/sign-in/email",
        "/api/auth/sign-out",
        "/api/auth/get-session",
      ];
      if (!permitted.includes(endpoint!))
        throw new DomainError("AUTH_ENDPOINT_DISABLED", 403);
      const response = await auth.handler(
        new Request(new URL(req.url, config.APP_ORIGIN), {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((v, k) => {
        if (k !== "set-cookie") reply.header(k, v);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
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
    return {
      user,
      workspaces: memberships.map((x) => ({ ...x.workspace, role: x.role })),
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
        language: z.enum(["en", "de"]).default("en"),
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
        workspaceId: member.workspaceId,
        members: {
          create: {
            userId: user.id,
            role: "owner",
          },
        },
      },
    });
    return reply.code(201).send(project);
  });
  app.get("/api/projects/:projectId/dashboard", async (req) => {
    const { projectId } = req.params as any;
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      const counts: Record<string, number> = {};
      for (const kind of schemas.collections)
        counts[kind] = await tx.entity.count({ where: { projectId, kind } });
      const reservations = await tx.budgetReservation.findMany({
        where: { projectId },
      });
      const policy = (await list(tx, scope, "policies")).find(
        (x) => data(x).active,
      );
      counts.verifiedFacts = (await list(tx, scope, "facts")).filter(
        (f) => data(f).status === "verified",
      ).length;
      counts.connectedConnectors = (await list(tx, scope, "connectors")).filter(
        (c) => ["read_verified", "write_verified"].includes(data(c).status),
      ).length;
      const capabilityReadiness = await readiness(tx, scope);
      return {
        project,
        counts,
        exceptions: await list(tx, scope, "exceptions"),
        publications: await list(tx, scope, "publications"),
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
  app.get("/api/projects/:projectId/openai-configuration", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, false, true);
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
  app.get("/api/projects/:projectId/knowledge-health", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const facts = await list(tx, scope, "facts"),
        sources = await list(tx, scope, "sources"),
        contents = await list(tx, scope, "content");
      return {
        conflicts: facts.filter((x) => data(x).status === "conflicting"),
        expiredFacts: facts.filter(
          (x) =>
            data(x).validUntil && new Date(data(x).validUntil) <= new Date(),
        ),
        failedImports: (await list(tx, scope, "jobs")).filter(
          (x) => data(x).topic === "ingestion" && data(x).status === "failed",
        ),
        staleSources: sources.filter(
          (x) =>
            !data(x).lastSuccessfulSyncAt ||
            Date.now() - new Date(data(x).lastSuccessfulSyncAt).valueOf() >
              data(x).maxAgeHours * 3600000,
        ),
        missingEvidence: contents.filter(
          (x) => data(x).status === "needs_review",
        ),
        impacts: contents.filter((x) => data(x).status === "needs_review"),
      };
    });
  });
  app.get("/api/projects/:projectId/documents", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      items: await tx.knowledgeDocument.findMany({
        where: { projectId },
        include: {
          versions: { include: { chunks: true }, orderBy: { version: "desc" } },
        },
        take: 200,
      }),
    }));
  });
  app.get("/api/projects/:projectId/export", async (req) => {
    const { projectId } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      entities: (
        await tx.entity.findMany({
          where: { projectId, kind: { notIn: ["connectors", "evidence"] } },
        })
      ).map(publicEntity),
    }));
  });
  app.get("/api/projects/:projectId/content/:id/export", async (req, reply) => {
    const { projectId, id } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    const bundle = await scoped(scope.workspaceId, projectId, async (tx) => {
      const c = await entity(tx, scope, "content", id),
        v = data(c);
      const evidence = await entity(tx, scope, "evidence", v.evidenceId);
      if (
        data(evidence).purpose !== "public" ||
        !(await validateEvidence(tx, scope, evidence.id, new Date())).valid
      )
        throw new DomainError("EVIDENCE_INVALIDATED");
      const asset = v.assetId
        ? await entity(tx, scope, "assets", v.assetId)
        : null;
      const a = data(asset);
      const bundle = exportBlogArticle({
        title: v.title,
        slug:
          (v.slug ??
            v.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 100)) ||
          "article",
        language: v.language,
        bodyMarkdown: v.body,
        description: v.description ?? v.title,
        updatedAt: c.updatedAt.toISOString(),
        sourceUrls: (data(evidence).items ?? [])
          .filter((i: any) => i.publicUse && i.canonicalUrl)
          .map((i: any) => i.canonicalUrl),
        assets:
          asset && a.usageApproved && a.mime === "image/png"
            ? [
                {
                  filename: "creative.png",
                  mime: "image/png",
                  bytes: Buffer.from(a.base64, "base64"),
                  alt: a.title ?? v.title,
                },
              ]
            : [],
      });
      return {
        ...bundle,
        contentType: v.type,
        deliveryStatus: "draft_export",
        metadata: {
          outline: v.outline ?? [],
          internalLinks: v.internalLinks ?? [],
          altTexts: v.altTexts ?? [],
          ...(v.type === "newsletter"
            ? {
                newsletter: v.newsletter ?? null,
                sendCapability: "not_configured",
              }
            : {}),
        },
      };
    });
    return reply
      .header("Content-Type", "application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="orbit-article-bundle.json"',
      )
      .send(bundle);
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
    await scopeFor(auth, req, projectId, false, true);
    return {
      items: await authDb.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    };
  });
  app.get("/api/projects/:projectId/indexes", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, false, true);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      items: await listIndexGenerations(tx, scope),
    }));
  });
  app.get("/api/projects/:projectId/marketing-profile", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const profile = await currentMarketingProfile(tx, scope);
      return profile ? jsonSafe(profile) : null;
    });
  });
  app.put("/api/projects/:projectId/marketing-profile", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId, true, true);
    return scoped(scope.workspaceId, projectId, async (tx) =>
      jsonSafe(await saveMarketingProfile(tx, scope, req.body)),
    );
  });
  app.get("/api/projects/:projectId/:collection", async (req) => {
    const { projectId, collection } = req.params as any;
    schemas.collection.parse(collection);
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, async (tx) => ({
      items: (await list(tx, scope, collection))
        .slice(0, 500)
        .map(publicEntity),
    }));
  });
  app.post("/api/projects/:projectId/:collection", async (req, reply) => {
    const { projectId, collection } = req.params as any;
    const owner = ["sources", "facts", "policies", "preferences"].includes(
      collection,
    );
    const scope = await scopeFor(auth, req, projectId, true, owner);
    const result = await scoped(scope.workspaceId, projectId, async (tx) => {
      if (collection === "facts")
        return setFact(tx, scope, factSchema.parse(req.body));
      let parsed: Record<string, any>;
      if (collection === "sources") parsed = schemas.source.parse(req.body);
      else if (collection === "missions") {
        parsed = { ...schemas.mission.parse(req.body), status: "ready" };
        await assertCampaignContext(tx, scope, parsed);
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
      const row = await create(tx, scope, collection, parsed);
      if (
        collection === "policies" &&
        parsed.mode === "autopilot" &&
        config.EXECUTION_MODE === "live"
      ) {
        const state = await readiness(tx, scope);
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
  app.patch("/api/projects/:projectId/content/:id", async (req) => {
    const { projectId, id } = req.params as any,
      scope = await scopeFor(auth, req, projectId, true);
    const input = z
      .object({ version: z.number().int(), data: schemas.content })
      .strict()
      .parse(req.body);
    return scoped(scope.workspaceId, projectId, async (tx) => {
      const row = await entity(tx, scope, "content", id);
      if (row.version !== input.version)
        throw new DomainError("VERSION_CONFLICT", 409);
      await entity(tx, scope, "evidence", input.data.evidenceId);
      await assertContentCampaignContext(tx, scope, input.data);
      await invalidateContent(tx, scope, id);
      return update(tx, scope, row, {
        ...input.data,
        status: "draft",
        origin: data(row).origin,
        synthetic: data(row).synthetic ?? false,
      });
    });
  });
  app.post("/api/projects/:projectId/actions/:action", async (req) => {
    const { projectId, action } = req.params as any;
    const owner = [
      "withdraw-fact",
      "import-matomo",
      "evaluate-index",
      "postiz-test-prepare",
      "postiz-test-execute",
      "postiz-test-reconcile",
      "calendar-block",
      "calendar-unblock",
      "approve",
      "pause",
      "revoke-source",
      "source-pause",
      "revoke-document",
      "preference-update",
      "project-settings",
      "add-member",
      "brand-approval",
      "asset-status",
      "connector",
      "connector-health",
      "resolve-exception",
      "slack-configure",
      "slack-digest",
      "begin-index",
      "build-index",
      "activate-index",
      "rollback-index",
      "correct-metric",
      "memory-lifecycle",
      "retention",
      "stop-experiment",
      "openai-configure",
      "embed-document",
      "knowledge-import-commit",
      "knowledge-import-retry",
    ].includes(action);
    const scope = await scopeFor(
      auth,
      req,
      projectId,
      action !== "retrieve" && action !== "preflight",
      owner,
    );
    const input = object.parse(req.body);
    if (action === "retrieve" && input.useEmbeddings === true) {
      return retrieveHybrid(scope, {
        query: z.string().min(1).max(2000).parse(input.query),
        language: z.enum(["en", "de"]).default("en").parse(input.language),
        purpose: z
          .enum(["public", "internal"])
          .default("public")
          .parse(input.purpose),
        at: input.at ? new Date(z.iso.datetime().parse(input.at)) : new Date(),
        factKeys: z.array(z.string()).max(20).optional().parse(input.factKeys),
        sourceIds: z
          .array(schemas.id)
          .max(30)
          .optional()
          .parse(input.sourceIds),
      });
    }
    if (action === "openai-configure")
      return scoped(scope.workspaceId, projectId, async (tx) => {
        const result = await saveOpenAiConfiguration(tx, scope, input);
        await audit(
          tx,
          scope,
          "openai_configuration.update",
          "openai_configuration",
          {
            configured: result.configured,
            source: result.source,
            modelCount: result.verifiedModels.length,
          },
        );
        return result;
      });
    if (action === "knowledge-import-preview")
      return importPreview(knowledgeImportInput.parse(input));
    if (action === "import-matomo")
      return importMatomoReport(scope, matomoImportInput.parse(input));
    if (action === "postiz-test-execute")
      return executePostizVerification(
        scope,
        postizVerificationApproval.parse(input),
      );
    if (action === "postiz-test-reconcile")
      return reconcilePostizVerification(
        scope,
        schemas.id.parse(input.verificationId),
      );
    if (action === "add-member") {
      const i = z
        .object({
          email: z.email(),
          name: z.string().min(1).max(100),
          password: z.string().min(12).max(128),
          role: z.enum(["owner", "editor", "viewer"]),
        })
        .strict()
        .parse(input);
      let user = await authDb.user.findUnique({ where: { email: i.email } });
      if (!user) {
        const result = await auth.api.signUpEmail({
          body: { email: i.email, name: i.name, password: i.password },
        });
        user = result.user as any;
      }
      const userId = user!.id;
      await authDb.$transaction(async (tx) => {
        await tx.workspaceMember.upsert({
          where: {
            workspaceId_userId: { workspaceId: scope.workspaceId, userId },
          },
          create: { workspaceId: scope.workspaceId, userId, role: "viewer" },
          update: {},
        });
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } },
          create: {
            workspaceId: scope.workspaceId,
            projectId,
            userId,
            role: i.role,
          },
          update: { role: i.role },
        });
      });
      return { added: true };
    }
    if (action === "project-settings") {
      const i = z
        .object({
          name: z.string().min(1).max(100),
          timezone: z.string(),
          language: z.enum(["en", "de"]),
        })
        .strict()
        .parse(input);
      new Intl.DateTimeFormat("en", { timeZone: i.timezone });
      return authDb.project.update({ where: { id: projectId }, data: i });
    }
    if (action === "connector-health") {
      const c = await scoped(scope.workspaceId, projectId, (tx) =>
          entity(tx, scope, "connectors", schemas.id.parse(input.connectorId)),
        ),
        d = data(c);
      let result: Record<string, unknown>;
      const options = {
        baseUrl: d.baseUrl,
        token: decrypt(d.encryptedCredential, config.CREDENTIAL_KEY),
      };
      if (d.provider === "postiz") {
        const client = createPostizClient(options);
        const channels = await client.listIntegrations();
        result = {
          status: "read_verified",
          capabilities: client.capabilities,
          channels,
        };
      } else if (d.provider === "matomo") {
        const client = createMatomoClient({
          ...options,
          allowedSiteIds: [Number(d.siteId)],
        });
        await client.report({
          siteId: Number(d.siteId),
          method: "Goals.getGoals",
          period: "day",
          date: new Date().toISOString().slice(0, 10),
          siteTimezone: "UTC",
        });
        result = { status: "read_verified", capabilities: client.capabilities };
      } else
        throw new DomainError("SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION");
      return scoped(scope.workspaceId, projectId, async (tx) => {
        const current = await entity(tx, scope, "connectors", c.id);
        if (current.version !== c.version)
          throw new DomainError("CONNECTOR_CHANGED");
        return publicEntity(
          await update(tx, scope, current, {
            ...d,
            ...result,
            verifiedAt: new Date().toISOString(),
          }),
        );
      });
    }
    return scoped(scope.workspaceId, projectId, async (tx) => {
      if (action === "knowledge-import-commit")
        return commitKnowledgeImport(
          tx,
          scope,
          knowledgeImportInput.parse(input),
        );
      if (action === "knowledge-import-retry")
        return retryKnowledgeImport(
          tx,
          scope,
          schemas.id.parse(input.importId),
          knowledgeImportInput.parse(input.payload),
        );
      if (action === "editorial-propose-brief")
        return proposeBrief(briefProposalInput.parse(input));
      if (action === "community-import")
        return importCommunityQuestions(
          tx,
          scope,
          communityImportInput.parse(input),
        );
      if (action === "community-link")
        return linkCommunityGroup(tx, scope, communityLinkInput.parse(input));
      if (action === "adapt-content")
        return adaptContent(tx, scope, contentAdaptationInput.parse(input));
      if (action === "withdraw-fact")
        return withdrawFact(
          tx,
          scope,
          schemas.id.parse(input.factId),
          z.number().int().positive().parse(input.version),
        );
      if (action === "postiz-test-prepare")
        return preparePostizVerification(
          tx,
          scope,
          postizVerificationInput.parse(input),
        );
      if (action === "evaluate-index")
        return queueIndexEvaluation(
          tx,
          scope,
          indexEvaluationRequest.parse(input),
        );
      if (action === "calendar-block")
        return blockCalendar(tx, scope, calendarBlock.parse(input));
      if (action === "calendar-unblock")
        return unblockCalendar(
          tx,
          scope,
          schemas.id.parse(input.blockId),
          z.number().int().positive().parse(input.version),
        );
      if (action === "begin-index")
        return beginIndexBuild(
          tx,
          scope,
          z.string().max(200).parse(input.profile),
        );
      if (action === "build-index") {
        const indexId = schemas.id.parse(input.indexId);
        const index = await tx.knowledgeIndex.findFirst({
          where: { id: indexId, projectId },
        });
        if (!index || index.state !== "building")
          throw new DomainError("INDEX_NOT_BUILDING");
        const count = await tx.chunkEmbedding.count({
          where: {
            projectId,
            profile: index.profile,
            indexGeneration: index.generation,
          },
        });
        return enqueue(
          tx,
          scope,
          "reindex",
          index.id,
          "reindex:" + index.id + ":" + count,
        );
      }
      if (action === "activate-index")
        return activateIndexGeneration(
          tx,
          scope,
          schemas.id.parse(input.indexId),
        );
      if (action === "rollback-index")
        return rollbackIndexGeneration(
          tx,
          scope,
          schemas.id.parse(input.indexId),
        );
      if (action === "slack-configure")
        return configureSlack(tx, scope, slackConfiguration.parse(input));
      if (action === "slack-digest") return queueSlackDigest(tx, scope);
      if (action === "correct-metric") {
        const i = z
          .object({
            metricId: schemas.id,
            version: z.number().int(),
            values: schemas.metric,
            reason: z.string().min(5).max(500),
          })
          .strict()
          .parse(input);
        return correctMetric(
          tx,
          scope,
          i.metricId,
          i.version,
          i.values,
          i.reason,
        );
      }
      if (action === "memory-lifecycle") {
        const i = z
          .object({
            kind: z.enum(["preferences", "insights"]),
            id: schemas.id,
            version: z.number().int(),
            operation: z.enum(["disable", "delete"]),
          })
          .strict()
          .parse(input);
        return memoryLifecycle(tx, scope, i.kind, i.id, i.version, i.operation);
      }
      if (action === "retention")
        return retention(
          tx,
          scope,
          z.number().int().min(30).max(3650).parse(input.days),
        );
      if (action === "evaluate-experiment")
        return evaluateExperiment(
          tx,
          scope,
          schemas.id.parse(input.experimentId),
        );
      if (action === "stop-experiment") {
        const i = z
          .object({
            experimentId: schemas.id,
            version: z.number().int(),
            reason: z.string().min(5).max(500),
          })
          .strict()
          .parse(input);
        return stopExperiment(tx, scope, i.experimentId, i.version, i.reason);
      }
      if (action === "import") {
        const source = await entity(
          tx,
          scope,
          "sources",
          schemas.id.parse(input.sourceId),
        );
        if (input.url) {
          const url = z.url().parse(input.url);
          const request = await create(tx, scope, "sync_requests", {
            sourceId: source.id,
            url,
            expectedGeneration: data(source).generation,
            language: input.language ?? "en",
          });
          return enqueue(
            tx,
            scope,
            "ingestion",
            request.id,
            "sync:" + request.id,
          );
        }
        const parsed = z
          .object({
            sourceId: schemas.id,
            externalId: z.string().min(1).max(300),
            title: z.string().min(1).max(300),
            text: z.string().max(1000000).optional(),
            base64: z.string().max(1400000).optional(),
            mimeType: z.enum([
              "text/plain",
              "text/markdown",
              "text/html",
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ]),
            language: z.enum(["en", "de"]),
          })
          .strict()
          .parse(input);
        const extracted = await extractDocument(
          parsed.base64
            ? Buffer.from(parsed.base64, "base64")
            : Buffer.from(parsed.text ?? ""),
          parsed.mimeType,
        );
        return ingest(tx, scope, {
          sourceId: source.id,
          externalId: parsed.externalId,
          title: parsed.title,
          text: extracted.text,
          mimeType: parsed.mimeType,
          language: parsed.language,
          expectedGeneration: data(source).generation,
        });
      }
      if (action === "retrieve")
        return retrieve(tx, scope, {
          query: z.string().min(1).max(2000).parse(input.query),
          language: z.enum(["en", "de"]).default("en").parse(input.language),
          purpose: z
            .enum(["public", "internal"])
            .default("public")
            .parse(input.purpose),
          at: input.at
            ? new Date(z.iso.datetime().parse(input.at))
            : new Date(),
          factKeys: z
            .array(z.string())
            .max(20)
            .optional()
            .parse(input.factKeys),
          sourceIds: z
            .array(schemas.id)
            .max(30)
            .optional()
            .parse(input.sourceIds),
        });
      if (action === "revoke-source")
        return revokeSource(tx, scope, schemas.id.parse(input.sourceId));
      if (action === "source-pause")
        return setSourceRights(tx, scope, schemas.id.parse(input.sourceId), {
          paused: z.boolean().parse(input.paused),
        });
      if (action === "revoke-document")
        return revokeDocument(
          tx,
          scope,
          schemas.id.parse(input.documentId),
          typeof input.versionId === "string" ? input.versionId : undefined,
        );
      if (action === "preference-update") {
        const i = z
          .object({
            preferenceId: schemas.id,
            version: z.number().int(),
            status: z.enum(["confirmed", "disabled"]),
            rule: z.string().min(1).max(2000).optional(),
          })
          .strict()
          .parse(input);
        const p = await entity(tx, scope, "preferences", i.preferenceId);
        if (p.version !== i.version)
          throw new DomainError("VERSION_CONFLICT", 409);
        return update(tx, scope, p, {
          ...data(p),
          status: i.status,
          rule: i.rule ?? data(p).rule,
          confirmedBy: scope.userId,
        });
      }
      if (action === "import-metrics") {
        const i = z
          .object({
            csv: z.string().max(1000000),
            source: z.string().max(100).default("csv"),
            accountId: z.string().max(100).default("manual"),
            currency: z.string().regex(/^[A-Z]{3}$/),
            timezone: z.string(),
            columns: z.object({
              date: z.string(),
              campaignId: z.string(),
              impressions: z.string().optional(),
              clicks: z.string().optional(),
              spend: z.string().optional(),
              conversions: z.string().optional(),
            }),
          })
          .strict()
          .parse(input);
        const previous = await list(tx, scope, "metrics");
        const result = importAdsCsv(i.csv, {
          ...i,
          projectId,
          existing: new Map(
            previous.map((x) => [data(x).externalId, data(x).contentHash]),
          ),
        });
        for (const row of result.rows) {
          const micros =
            row.spendMinor === null ? null : BigInt(row.spendMinor) * 10000n;
          if (micros !== null && micros > BigInt(Number.MAX_SAFE_INTEGER))
            throw new DomainError("MONEY_OUT_OF_RANGE");
          await create(tx, scope, "metrics", {
            ...row,
            externalId: row.key,
            campaign: row.campaignId,
            sampleSize: row.impressions ?? row.clicks ?? 0,
            sessions: null,
            costMicros:
              row.spendMinor === null
                ? null
                : Number(BigInt(row.spendMinor) * 10000n),
            periodStart: row.date + "T00:00:00.000Z",
            periodEnd: row.date + "T23:59:59.999Z",
            dateInterpretation: "source-local-calendar-day",
            synthetic: false,
          });
        }
        return result;
      }
      if (action === "render") {
        const i = z
          .object({
            title: z.string().min(1).max(500),
            subtitle: z.string().max(500).optional(),
            format: z.enum(["square", "landscape", "portrait", "story"]),
            logoAssetId: schemas.id.optional(),
          })
          .strict()
          .parse(input);
        const brand = i.logoAssetId
          ? await entity(tx, scope, "assets", i.logoAssetId)
          : null;
        const result = await renderRasterTemplate({
          ...i,
          logoApproved: data(brand).usageApproved === true,
        });
        if (result.status === "blocked_asset") return result;
        const { bytes, ...metadata } = result;
        return create(tx, scope, "assets", {
          ...metadata,
          base64: bytes.toString("base64"),
          source: "template",
          usageApproved: true,
          assetStatus: "approved",
          approvedBy: scope.userId,
          brandAssetId: i.logoAssetId,
        });
      }
      if (action === "brand-approval") {
        const i = z
          .object({
            brandName: z.literal("EDS Labs"),
            confirmUsageRights: z.literal(true),
          })
          .strict()
          .parse(input);
        return create(tx, scope, "assets", {
          type: "original_logo",
          brandName: i.brandName,
          usageApproved: true,
          assetStatus: "approved",
          sha256:
            "a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c",
          approvedBy: scope.userId,
          source: "EDS Labs local original",
          license: "Brand rights reserved",
        });
      }
      if (action === "asset-status") {
        const i = z
          .object({
            assetId: schemas.id,
            version: z.number().int().positive(),
            assetStatus: z.enum(["approved", "reference", "outdated"]),
          })
          .strict()
          .parse(input);
        const asset = await entity(tx, scope, "assets", i.assetId);
        if (asset.version !== i.version)
          throw new DomainError("VERSION_CONFLICT", 409);
        return update(tx, scope, asset, {
          ...data(asset),
          assetStatus: i.assetStatus,
          assetStatusUpdatedBy: scope.userId,
          assetStatusUpdatedAt: new Date().toISOString(),
        });
      }
      if (action === "embed-document") {
        const i = z
          .object({
            documentId: schemas.id,
            confirmEmbeddingMayBeSentToOpenAI: z.literal(true),
          })
          .strict()
          .parse(input);
        const document = await tx.knowledgeDocument.findFirst({
          where: { id: i.documentId, projectId },
        });
        if (!document) throw new DomainError("NOT_FOUND", 404);
        return enqueue(
          tx,
          scope,
          "embedding",
          document.id,
          "embedding:" + document.activeVersionId,
        );
      }
      if (action === "reconcile") {
        const pub = await entity(
          tx,
          scope,
          "publications",
          schemas.id.parse(input.publicationId),
        );
        return enqueue(
          tx,
          scope,
          "reconciliation",
          pub.id,
          "reconcile-manual:" + pub.id + ":" + pub.version,
        );
      }
      if (action === "run-mission")
        return planMission(tx, scope, schemas.id.parse(input.missionId));
      if (action === "review")
        return reviewContent(
          tx,
          scope,
          schemas.id.parse(input.contentId),
          z.number().int().parse(input.version),
          input.humanConfirm === true,
        );
      if (action === "preflight") {
        const p = await preflight(
          tx,
          scope,
          schemas.id.parse(input.contentId),
          { test: config.EXECUTION_MODE === "test" },
        );
        return {
          allowed: p.allowed,
          blockers: p.blockers,
          packageHash: p.packageHash,
          contentVersion: p.content.version,
        };
      }
      if (action === "approve")
        return approve(
          tx,
          scope,
          z
            .object({
              contentId: schemas.id,
              version: z.number().int(),
              packageHash: z.string().length(64),
            })
            .strict()
            .parse(input),
        );
      if (action === "publish")
        return publishIntent(
          tx,
          scope,
          z
            .object({
              contentId: schemas.id,
              version: z.number().int(),
              scheduledAt: z.iso.datetime().optional(),
            })
            .strict()
            .parse(input),
        );
      if (action === "analyze")
        return analyze(tx, scope, z.string().optional().parse(input.campaign));
      if (action === "pause")
        return pauseProject(tx, scope, z.boolean().parse(input.paused));
      if (action === "retry") {
        const job = await entity(
          tx,
          scope,
          "jobs",
          schemas.id.parse(input.jobId),
        );
        if (
          !["failed", "blocked_dependency"].includes(data(job).status) ||
          data(job).attempts >= data(job).maxAttempts
        )
          throw new DomainError("RETRY_NOT_ALLOWED");
        if (data(job).topic === "publishing") {
          const p = await entity(
            tx,
            scope,
            "publications",
            data(job).resourceId,
          );
          if (
            [
              "sending",
              "outcome_unknown",
              "published",
              "published_test",
            ].includes(data(p).status)
          )
            throw new DomainError("RECONCILIATION_REQUIRED");
        }
        await update(tx, scope, job, { ...data(job), status: "queued" });
        await tx.outbox.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId,
            topic: data(job).topic,
            entityId: job.id,
            payload: { jobId: job.id },
          },
        });
        return { queued: true };
      }
      if (action === "connector") {
        const c = z
          .object({
            provider: z.enum(["postiz", "matomo", "slack"]),
            baseUrl: z.url().optional(),
            credential: z.string().min(10).max(1000),
            siteId: z.string().max(100).optional(),
            channelId: z.string().max(100).optional(),
          })
          .strict()
          .parse(input);
        if (c.baseUrl && new URL(c.baseUrl).protocol !== "https:")
          throw new DomainError("HTTPS_REQUIRED");
        const { credential, ...metadata } = c;
        return publicEntity(
          await create(tx, scope, "connectors", {
            ...metadata,
            encryptedCredential: encrypt(credential, config.CREDENTIAL_KEY),
            status: "configured",
            capabilities: [],
          }),
        );
      }
      if (action === "resolve-exception") {
        const e = await entity(
          tx,
          scope,
          "exceptions",
          schemas.id.parse(input.exceptionId),
        );
        return update(tx, scope, e, {
          ...data(e),
          status: "resolved",
          resolvedBy: scope.userId,
        });
      }
      throw new DomainError("ACTION_NOT_SUPPORTED", 400);
    });
  });
  app.get("/api/openapi.json", async (req) => {
    await userFor(auth, req);
    return { ...app.swagger(), components: { schemas: contractSchemas } };
  });
  app.addHook("onClose", async () => closeRuntime());
  await app.ready();
  return app;
}
