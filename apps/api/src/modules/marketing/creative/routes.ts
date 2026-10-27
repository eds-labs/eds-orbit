import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_FORMATS,
  CREATIVE_TEMPLATE_IDS,
  CREATIVE_VARIANT_IDS,
  DEFAULT_CHANNEL_FORMATS,
  LOGO_PLACEMENTS,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  TEXT_SCALES,
  variantsFor,
} from "../../../../../../packages/creative/src/index.ts";
import {
  id as idSchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { clientIp } from "../../../client-ip.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { scopeFor } from "../../../platform/tenancy/auth.ts";
import {
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { DomainError } from "../../../shared.ts";
import { artConfirmation, artCorrectionInput } from "./art.ts";
import { resolveBrandKit } from "./brand-kit.ts";
import { projectRow } from "./components.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  attachCreative,
  produceCreative,
  recomposeCreative,
  regenerateCreativeArt,
  type ProduceRequest,
} from "./pipeline.ts";
import {
  creativeView,
  findCreative,
  latestCreativeOfContent,
} from "./store.ts";
import { visionReviewCreative } from "./vision-review.ts";

// The Creative Studio's HTTP surface (spec §11). Every route first checks the
// switch (CS-D6: off, there is no route), then the caller's role, then parses
// a strict body; the functions of the pipeline do the rest, with their own
// checks. A request body never chooses the attach mode (R45).

/** Off, the studio does not exist: the same answer as a route that is not there. */
function studio() {
  if (!creativeStudioEnabled()) throw new DomainError("NOT_FOUND", 404);
}

const copyText = z.string().max(500);
const copyBody = z
  .object({
    eyebrow: copyText.optional(),
    headline: copyText,
    subline: copyText.optional(),
    cta: copyText.optional(),
  })
  .strict();
const optionsBody = z
  .object({
    logoPlacement: z.enum(LOGO_PLACEMENTS).optional(),
    textScale: z.enum(TEXT_SCALES).optional(),
  })
  .strict();
/** The owner's confirmation of one paid image and the client's id for it (R51). */
const artBody = artConfirmation.extend({ requestId: z.uuid().optional() });

const produceBody = z
  .object({
    contentId: idSchema,
    template: z.enum(CREATIVE_TEMPLATE_IDS).optional(),
    variant: z.enum(CREATIVE_VARIANT_IDS).optional(),
    copy: copyBody.optional(),
    artAssetId: idSchema.optional(),
    // Duplicates are ignored; the pipeline allows one product frame.
    productAssetIds: z.array(idSchema).max(10).optional(),
    options: optionsBody.optional(),
    generateArt: artBody.optional(),
  })
  .strict();
const recomposeBody = z
  .object({
    template: z.enum(CREATIVE_TEMPLATE_IDS).optional(),
    variant: z.enum(CREATIVE_VARIANT_IDS).optional(),
    options: optionsBody.optional(),
    copy: copyBody.optional(),
  })
  .strict();
const regenerateBody = artBody.extend({
  correction: artCorrectionInput.optional(),
});
const noBody = z.object({}).strict();
// Only the owner's acceptance of findings; never the attach mode (R45).
const attachBody = z
  .object({ acceptQaFindings: z.literal(true).optional() })
  .strict();

/** A body that asks for nothing may be left out. */
const optionalBody = (req: FastifyRequest) => req.body ?? {};

/** What the studio offers, the same for every project (spec §6, §7). */
const OFFERS = {
  templates: CREATIVE_TEMPLATE_IDS.map((id) => ({
    id,
    variants: Object.fromEntries(
      CREATIVE_FORMAT_IDS.map((format) => [format, variantsFor(id, format)]),
    ),
    needs: TEMPLATE_NEEDS[id],
    copyLimits: TEMPLATE_COPY_LIMITS[id],
  })),
  formats: CREATIVE_FORMATS,
  defaultChannelFormats: DEFAULT_CHANNEL_FORMATS,
};

/** Why a project has no brand kit to produce from yet; its settings are then `null`. */
const NO_BRAND_KIT = new Set([
  "MARKETING_PROFILE_REQUIRED",
  "MARKETING_PROFILE_INVALID",
  "PRIMARY_LOGO_REQUIRED",
  "APPROVED_LOGO_ASSET_REQUIRED",
]);

/** The project's creative settings, or null while its brand kit cannot compose. */
async function creativeConfig(tx: DbTx, scope: Scope) {
  try {
    return (await resolveBrandKit(tx, scope)).config;
  } catch (error) {
    if (error instanceof DomainError && NO_BRAND_KIT.has(error.code))
      return null;
    throw error;
  }
}

/** Whether the request asks for a paid image; read once the body is parsed. */
const asksForArt = (req: FastifyRequest) =>
  Boolean(
    (req.body as { generateArt?: unknown } | null | undefined)?.generateArt,
  );
/**
 * Creatives with new art are paid: three a minute per client in a bucket of
 * their own (`<ip>:paid`). Every produce request, free or paid, is also an
 * ordinary write under the server's write limit (`<ip>:write`, M4). The
 * paid limit runs after the body is parsed, because the body says whether
 * the image is paid.
 */
const PAID_PRODUCE_RATE = {
  max: 3,
  timeWindow: "1 minute",
  keyGenerator: (req: FastifyRequest) => `${clientIp(req)}:paid`,
};
const PAID_RATE = { rateLimit: { max: 3, timeWindow: "1 minute" } };

type ProjectParams = { projectId: string };
type CreativeParams = ProjectParams & { creativeId: string };

/**
 * Registers the creative routes: options, produce, view, the creative of a
 * post, recompose, regenerate the art, vision review and attach.
 */
export const creativeRoutes: RoutesContribution = ({ app, auth }) => {
  const paidProduce = app.createRateLimit(PAID_PRODUCE_RATE);
  app.get("/api/projects/:projectId/creative/options", async (req) => {
    studio();
    const { projectId } = req.params as ProjectParams;
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => ({
      ...OFFERS,
      config: await creativeConfig(tx, scope),
    }));
  });

  app.post(
    "/api/projects/:projectId/creatives",
    {
      preHandler: async (req, reply) => {
        if (!asksForArt(req)) return;
        const limit = await paidProduce(req);
        if (limit.isAllowed || !limit.isExceeded) return;
        reply.header("retry-after", String(limit.ttlInSeconds));
        throw new DomainError("RATE_LIMITED", 429);
      },
    },
    async (req, reply) => {
      studio();
      const { projectId } = req.params as ProjectParams;
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      const { generateArt, ...rest } = produceBody.parse(req.body);
      const request: ProduceRequest = rest;
      if (generateArt) {
        const { requestId, ...confirmation } = generateArt;
        request.generateArt = confirmation;
        request.requestId = requestId;
      }
      return reply.code(201).send(await produceCreative(scope, request));
    },
  );

  app.get("/api/projects/:projectId/creatives/:creativeId", async (req) => {
    studio();
    const { projectId, creativeId } = req.params as CreativeParams;
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, scope.projectId, async (tx) =>
      creativeView(await findCreative(tx, scope, creativeId), scope),
    );
  });

  app.get(
    "/api/projects/:projectId/content/:contentId/creative",
    async (req, reply) => {
      studio();
      const { projectId, contentId } = req.params as ProjectParams & {
        contentId: string;
      };
      const scope = await scopeFor(auth, req, projectId);
      const view = await scoped(
        scope.workspaceId,
        scope.projectId,
        async (tx) => {
          await projectRow(tx, scope, "content", contentId);
          const row = await latestCreativeOfContent(tx, scope, contentId);
          return row ? creativeView(row, scope) : null;
        },
      );
      // `null` is the answer for a post without a creative; sent as is, not
      // through the default object schema.
      return view
        ? reply.send(view)
        : reply.type("application/json; charset=utf-8").send("null");
    },
  );

  app.post(
    "/api/projects/:projectId/creatives/:creativeId/recompose",
    async (req) => {
      studio();
      const { projectId, creativeId } = req.params as CreativeParams;
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      return recomposeCreative(
        scope,
        creativeId,
        recomposeBody.parse(optionalBody(req)),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/creatives/:creativeId/regenerate-art",
    { config: PAID_RATE },
    async (req) => {
      studio();
      const { projectId, creativeId } = req.params as CreativeParams;
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return regenerateCreativeArt(
        scope,
        creativeId,
        regenerateBody.parse(req.body),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/creatives/:creativeId/review",
    { config: PAID_RATE },
    async (req) => {
      studio();
      const { projectId, creativeId } = req.params as CreativeParams;
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      noBody.parse(optionalBody(req));
      return visionReviewCreative(scope, creativeId);
    },
  );

  app.post(
    "/api/projects/:projectId/creatives/:creativeId/attach",
    async (req) => {
      studio();
      const { projectId, creativeId } = req.params as CreativeParams;
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      const { acceptQaFindings } = attachBody.parse(optionalBody(req));
      return attachCreative(
        scope,
        creativeId,
        acceptQaFindings ? { acceptQaFindings } : {},
      );
    },
  );
};
