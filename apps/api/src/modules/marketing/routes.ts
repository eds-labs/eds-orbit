import { z } from "zod";
import { jsonSafe, scoped } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import { ConnectorError } from "../../../../../packages/connectors/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import {
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../platform/tenancy/permissions.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  publicEntity,
  update,
} from "../../shared.ts";
import {
  assetBytes,
  brandAssetUploadInput,
  normalizeBrandAsset,
} from "../assets.ts";
import { driveContent } from "../../platform/connections/google-drive.ts";
import {
  brandAssets,
  importDriveFile,
  saveGeneratedAsset,
  uploadUserRaster,
} from "./brand/drive-assets.ts";
import { exportContentBundle } from "./pipeline/content-export.ts";
import { invalidateContent } from "./pipeline/content-invalidation.ts";
import { withGenerationProvenance } from "./pipeline/content-provenance.ts";
import {
  assertContentCampaignContext,
  currentMarketingProfile,
  saveMarketingProfile,
} from "./brand/marketing-profile.ts";
import { generateProjectImage } from "./brand/image-generation.ts";
import { handleSlackInteraction } from "./publishing/slack.ts";
import { agentsEnabled, setAssignmentStatus } from "./agents/assignments.ts";
import {
  assignmentStatusInput,
  draftsAwaitingOwner,
  listAssignments,
  upcomingAssignmentPosts,
  vetoInput,
} from "./agents/assignment-overview.ts";
import { agentActivity } from "./agents/agent-activity.ts";
import { vetoPublication } from "./agents/veto.ts";
import {
  releaseAssignmentDraft,
  releaseInput,
} from "./agents/owner-release.ts";
import { cancelContentPackage } from "./agents/content-packages.ts";
import { attachPackageImage } from "./agents/package-image.ts";
import { cancelPackageSchedule } from "./agents/package-schedule.ts";
import { confirmProposal } from "./assistant/proposals.ts";

/**
 * Marketing's HTTP routes (WP2.1f), moved unchanged from server.ts and
 * registered at the same paths: Slack interactions, content export and
 * edit, the marketing profile, Orbit Agents, brand assets and images, and
 * content package controls. The Orbit Agents gate stays in the platform's
 * onRequest hook, keyed by these route patterns.
 */
export const marketingRoutes: RoutesContribution = ({ app, auth }) => {
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

  app.get("/api/projects/:projectId/content/:id/export", async (req, reply) => {
    const { projectId, id } = req.params as any,
      scope = await scopeFor(auth, req, projectId);
    const bundle = await exportContentBundle(scope, id);
    return reply
      .header("Content-Type", "application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="orbit-article-bundle.json"',
      )
      .send(bundle);
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
    const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
    return scoped(scope.workspaceId, projectId, async (tx) =>
      jsonSafe(await saveMarketingProfile(tx, scope, req.body)),
    );
  });

  // Orbit Agents for the web: assignments and their upcoming posts (404 while off).
  app.get("/api/projects/:projectId/assignments", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, (tx) =>
      listAssignments(tx, scope),
    );
  });

  // Pause and end are an editor's; resuming is the owner's (setAssignmentStatus).
  app.post("/api/projects/:projectId/assignments/:id/status", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    const input = assignmentStatusInput.parse(req.body);
    const saved = await scoped(scope.workspaceId, projectId, (tx) =>
      setAssignmentStatus(
        tx,
        scope,
        z.uuid().parse(id),
        input.status,
        input.version,
      ),
    );
    return { id: saved.id, version: saved.version, status: data(saved).status };
  });

  app.get("/api/projects/:projectId/assignment-posts", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    return {
      items: await scoped(scope.workspaceId, projectId, (tx) =>
        upcomingAssignmentPosts(tx, scope),
      ),
    };
  });

  // What the agents work on, what comes next and whether anything needs attention (overview).
  app.get("/api/projects/:projectId/agent-activity", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    return scoped(scope.workspaceId, projectId, (tx) =>
      agentActivity(tx, scope),
    );
  });

  // Stop in Orbit (spec §10 fallback): the same veto as the bot's Stop button.
  app.post("/api/projects/:projectId/publications/:id/veto", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    const input = vetoInput.parse(req.body);
    return scoped(scope.workspaceId, projectId, (tx) =>
      vetoPublication(
        tx,
        scope,
        z.uuid().parse(id),
        input.version,
        "orbit",
        input.reason,
      ),
    );
  });

  // Assignment drafts left for the owner (R70): the list, and the owner's release of one.
  app.get("/api/projects/:projectId/assignment-drafts", async (req) => {
    if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
    const { projectId } = req.params as { projectId: string };
    const scope = await scopeFor(auth, req, projectId);
    return {
      items: await scoped(scope.workspaceId, projectId, (tx) =>
        draftsAwaitingOwner(tx, scope),
      ),
    };
  });

  app.post(
    "/api/projects/:projectId/assignment-drafts/:id/release",
    async (req) => {
      if (!agentsEnabled()) throw new DomainError("NOT_FOUND", 404);
      const { projectId, id } = req.params as {
        projectId: string;
        id: string;
      };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      const input = releaseInput.parse(req.body);
      return scoped(scope.workspaceId, projectId, (tx) =>
        releaseAssignmentDraft(tx, scope, z.uuid().parse(id), input.version),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/assets/:assetId/drive-retry",
    async (req, reply) => {
      const { projectId, assetId } = req.params as {
        projectId: string;
        assetId: string;
      };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return reply.send(
        publicEntity(
          await saveGeneratedAsset(scope, schemas.id.parse(assetId)),
        ),
      );
    },
  );

  app.post(
    "/api/projects/:projectId/assets/upload",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      const normalized = await normalizeBrandAsset(
        brandAssetUploadInput.parse(req.body),
      );
      const row = await scoped(scope.workspaceId, projectId, async (tx) => {
        const asset = await create(tx, scope, "assets", {
          ...normalized,
          assetStatus: "reference",
          usageApproved: false,
          uploadedBy: scope.userId,
          uploadedAt: new Date().toISOString(),
        });
        await audit(tx, scope, "asset.upload", asset.id, {
          type: normalized.type,
          sha256: normalized.sha256,
          bytes: normalized.bytes,
        });
        return asset;
      });
      return reply.code(201).send(publicEntity(row));
    },
  );

  app.get(
    "/api/projects/:projectId/assets/:assetId/content",
    async (req, reply) => {
      const { projectId, assetId } = req.params as {
        projectId: string;
        assetId: string;
      };
      const scope = await scopeFor(auth, req, projectId);
      const assetData = await scoped(scope.workspaceId, projectId, async (tx) =>
        data(await entity(tx, scope, "assets", schemas.id.parse(assetId))),
      );
      const content =
        assetData.driveFileId && !assetData.base64
          ? await driveContent(scope, assetData.driveFileId)
          : assetBytes(assetData);
      return reply
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("X-Content-Type-Options", "nosniff")
        .type(content.mime)
        .send(content.bytes);
    },
  );

  app.post(
    "/api/projects/:projectId/images/generate",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return reply.send(
        publicEntity(await generateProjectImage(scope, req.body)),
      );
    },
  );

  // Stops what has not started; the requester only.
  app.post("/api/projects/:projectId/chat/packages/:id/cancel", async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
    return cancelContentPackage(scope, z.uuid().parse(id));
  });

  // Attaches the package's rights-approved image to chosen drafts; the requester only.
  app.post(
    "/api/projects/:projectId/chat/packages/:id/attach-image",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      return attachPackageImage(scope, z.uuid().parse(id), req.body);
    },
  );

  // Cancels a package post's schedule before the handoff; the requester or an owner.
  app.post(
    "/api/projects/:projectId/chat/packages/:id/unschedule",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      return cancelPackageSchedule(scope, z.uuid().parse(id), req.body);
    },
  );

  app.patch("/api/projects/:projectId/content/:id", async (req) => {
    const { projectId, id } = req.params as any,
      scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
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
        ...withGenerationProvenance(data(row), input.data),
        status: "draft",
        origin: data(row).origin,
        synthetic: data(row).synthetic ?? false,
      });
    });
  });

  // A user confirms a campaign proposal into a draft-only mission (WP2.2).
  app.post(
    "/api/projects/:projectId/chat/proposals/:id/confirm",
    async (req) => {
      const { projectId, id } = req.params as { projectId: string; id: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_WRITE);
      return confirmProposal(scope, z.uuid().parse(id), req.body);
    },
  );

  // Brand assets from and into the project's Drive (WP2.5d), moved unchanged
  // from server.ts; the Drive connection itself stays with the platform.
  app.get("/api/projects/:projectId/google-drive/brand", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return { files: await brandAssets(await scopeFor(auth, req, projectId)) };
  });
  app.post(
    "/api/projects/:projectId/google-drive/files/:fileId/import",
    async (req, reply) => {
      const { projectId, fileId } = req.params as {
        projectId: string;
        fileId: string;
      };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      const { type } = z
        .object({
          type: z
            .enum([
              "logo",
              "photo",
              "background",
              "banner",
              "icon",
              "document",
              "other",
            ])
            .default("photo"),
        })
        .parse(req.body ?? {});
      return reply
        .code(201)
        .send(publicEntity(await importDriveFile(scope, fileId, type)));
    },
  );
  app.post(
    "/api/projects/:projectId/google-drive/upload",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
      return reply
        .code(201)
        .send(publicEntity(await uploadUserRaster(scope, req.body)));
    },
  );
};
