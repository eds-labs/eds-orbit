import { z } from "zod";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  list,
  update,
} from "../../shared.ts";
import { chatScoped } from "../chat.ts";
import { channelLimitExceeded, resolveChannelRules } from "../channel-rules.ts";
import { invalidateContent } from "../content-invalidation.ts";
import { reviewContent } from "../workflow.ts";
import {
  assertPackageDraft,
  contentPackagesEnabled,
  currentDraft,
  packageSnapshot,
} from "./content-packages.ts";

/**
 * Package image in a post (Orbit Core J3.3). The package's generated image is
 * attached to chosen drafts only after an owner approved its usage rights; each
 * draft is reviewed again, and approvals or schedule proposals for the previous
 * version become stale.
 */
export const imageAttachment = z
  .object({
    deliverableKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
  })
  .strict();

// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

/** Attaches the image to every chosen draft, or to none when one cannot take it. */
export async function attachPackageImage(
  scope: Scope,
  packageId: string,
  raw: unknown,
) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const input = imageAttachment.parse(raw);
  return chatScoped(scope, async (tx) => {
    const pkg = await entity(tx, scope, "content_packages", packageId);
    const d = data(pkg);
    if (d.userId !== scope.userId) throw new DomainError("NOT_FOUND", 404);
    if (d.status !== "started")
      throw new DomainError("PACKAGE_NOT_STARTED", 409);
    const steps = (d.steps ?? []) as Array<Record<string, any>>;
    const imageStep = steps.find((step) => step.kind === "image");
    if (!imageStep) throw new DomainError("PACKAGE_IMAGE_REQUIRED", 409);
    const asset = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assets",
        data: { path: ["generationId"], equals: imageStep.actionRequestId },
      },
    });
    if (!asset) throw new DomainError("IMAGE_NOT_GENERATED", 409);
    if (
      data(asset).usageApproved !== true ||
      data(asset).assetStatus !== "approved"
    )
      throw new DomainError("ASSET_RIGHTS_REQUIRED", 409);
    const publications = await list(tx, scope, "publications");
    // One transaction: a refused draft leaves every chosen draft unchanged.
    for (const key of [...new Set(input.deliverableKeys)]) {
      const step = steps.find(
        (candidate) => candidate.kind === "copy" && candidate.key === key,
      );
      if (!step) throw new DomainError("DELIVERABLE_NOT_FOUND", 404);
      const current = await currentDraft(tx, scope, step);
      if (current.pending) throw new DomainError("REVISION_IN_PROGRESS", 409);
      if (!current.draft) throw new DomainError("DRAFT_REQUIRED", 409);
      const draft = current.draft;
      const v = data(draft);
      if (v.supersededBy) throw new DomainError("DRAFT_SUPERSEDED", 409);
      await assertPackageDraft(tx, scope, pkg.id, draft);
      if (
        publications.some(
          (row) =>
            data(row).contentId === draft.id &&
            !INACTIVE_PUBLICATION.includes(data(row).status),
        )
      )
        throw new DomainError("ALREADY_SCHEDULED", 409);
      if (v.assetId === asset.id) continue;
      // Telegram sends text with media as a caption with a smaller limit.
      if (
        channelLimitExceeded(
          v.body,
          v.targetUrl,
          await resolveChannelRules(tx, scope, v.channel, v.type, true),
        )
      )
        throw new DomainError("CAPTION_TOO_LONG", 409);
      const { review: _review, ...rest } = v;
      const attached = await update(tx, scope, draft, {
        ...rest,
        assetId: asset.id,
        status: "draft",
      });
      await invalidateContent(tx, scope, draft.id);
      await reviewContent(tx, scope, attached.id, attached.version);
      await audit(tx, scope, "content_package.image_attached", draft.id, {
        packageId: pkg.id,
        assetId: asset.id,
        assetVersion: asset.version,
      });
    }
    return packageSnapshot(
      tx,
      scope,
      await entity(tx, scope, "content_packages", pkg.id),
    );
  });
}
