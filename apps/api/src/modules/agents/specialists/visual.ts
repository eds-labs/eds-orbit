import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { ImageReference } from "../../../../../../packages/ai/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  update,
} from "../../../shared.ts";
import { assetBytes } from "../../assets.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../../channel-rules.ts";
import { invalidateContent } from "../../content-invalidation.ts";
import { driveContent } from "../../google-drive.ts";
import {
  currentImageTerms,
  generateAssignmentImage,
} from "../../image-generation.ts";
import { assignmentHash } from "../assignments.ts";
import { errorCode } from "../../telemetry.ts";
import { assertTaskBudget, runBudgetKey } from "./runner.ts";
import type { AgentTask, StepHandler } from "./types.ts";

/**
 * Visual step of an assignment run (Orbit Agents, spec §5, §6, §8): one image
 * per run from the strategy's image idea, the brand profile and the
 * assignment's style references, generated through Orbit's image generation
 * without an owner request because the owner's assignment confirmation
 * carries the image rights consent. The asset is approved for use with that
 * consent as its rights source and is attached to every draft of the run
 * whose channel can carry it. Copywriters run in parallel: whichever step
 * finishes second attaches (the visual to existing drafts, a copywriter to an
 * existing image), so both orders end with the same drafts illustrated.
 */
export const ASSET_RIGHTS_REQUIRED = "ASSET_RIGHTS_REQUIRED";
const STYLES = "assignment_style_descriptions";
const MAX_STYLE_TEXT = 1500;
// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

/** One switch for reference images (`images.edit`); off uses the stored style description (R8). */
export function imageReferencesEnabled() {
  return loadConfig().ORBIT_IMAGE_REFERENCES === "true";
}

/** The image of a task's run: requested once per visual task (R26, R37). */
export const runImageRequestId = (taskId: string) => `agent:${taskId}:image`;

/**
 * The rights source of an assignment image: the owner's confirmation must
 * include the image consent and still cover the assignment's current content.
 */
export function imageRightsSource(row: { id: string; data: unknown }) {
  const d = data(row);
  const confirmation = d.confirmation;
  if (
    d.image !== true ||
    confirmation?.imageRightsConsent !== true ||
    confirmation.assignmentHash !== assignmentHash(d)
  )
    throw new DomainError(ASSET_RIGHTS_REQUIRED, 409);
  return {
    assignmentId: row.id,
    confirmationHash: String(confirmation.assignmentHash),
  };
}

/** The run's image, if one was generated. */
async function runImage(tx: DbTx, scope: Scope, runId: string) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      data: { path: ["assignmentRunId"], equals: runId },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Attaches the run's image to every draft of the run that can carry it and
 * does not have it yet: social drafts on a channel with known media support
 * whose text fits the media limit (Telegram sends it as a caption of at most
 * 1,024 characters), blog and newsletter drafts always. A draft that is
 * scheduled, archived or replaced is left alone. Idempotent.
 */
export async function attachRunImage(tx: DbTx, scope: Scope, runId: string) {
  const attached: string[] = [];
  const skipped: Array<{ contentId: string; code: string }> = [];
  const image = await runImage(tx, scope, runId);
  if (!image) return { assetId: null, attached, skipped };
  const drafts = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["assignmentRunId"], equals: runId },
    },
    orderBy: { createdAt: "asc" },
  });
  const approved =
    data(image).usageApproved === true &&
    data(image).assetStatus === "approved";
  for (const draft of drafts) {
    const v = data(draft);
    if (v.status === "archived" || v.supersededBy) continue;
    if (v.assetId === image.id) {
      attached.push(draft.id);
      continue;
    }
    const code = !approved
      ? ASSET_RIGHTS_REQUIRED
      : v.assetId
        ? "ASSET_ALREADY_ATTACHED"
        : await refusal(tx, scope, draft.id, v);
    if (code) {
      skipped.push({ contentId: draft.id, code });
      continue;
    }
    // The draft changed: a review or approval of the text without the image no longer applies.
    const { review: _review, ...rest } = v;
    await update(tx, scope, draft, {
      ...rest,
      assetId: image.id,
      status: "draft",
    });
    await invalidateContent(tx, scope, draft.id);
    await audit(tx, scope, "assignment.image_attached", draft.id, {
      assignmentRunId: runId,
      assetId: image.id,
      assetVersion: image.version,
    });
    attached.push(draft.id);
  }
  return { assetId: image.id, attached, skipped };
}

/** Why a draft cannot take the image, or null. */
async function refusal(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  v: Record<string, any>,
) {
  const scheduled = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["contentId"], equals: contentId } },
        {
          NOT: INACTIVE_PUBLICATION.map((status) => ({
            data: { path: ["status"], equals: status },
          })),
        },
      ],
    },
  });
  if (scheduled) return "ALREADY_SCHEDULED";
  if (v.type !== "social") return null;
  const rules = await resolveChannelRules(tx, scope, v.channel, v.type, true);
  if (!rules.liveCapabilityKnown) return "MEDIA_NOT_SUPPORTED";
  if (channelLimitExceeded(String(v.body ?? ""), v.targetUrl, rules))
    return "CAPTION_TOO_LONG";
  return null;
}

/** A written style from the references' recorded names, prompts and tags; no model call, no cost. */
function describeStyle(rows: Array<{ data: unknown }>) {
  const parts = rows.map((row) => {
    const d = data(row);
    return [
      String(d.name ?? "").trim(),
      typeof d.prompt === "string" ? d.prompt.trim() : "",
      Array.isArray(d.tags) && d.tags.length
        ? `tags: ${d.tags.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" - ");
  });
  return `Follow the look of these approved references: ${parts.join("; ")}`.slice(
    0,
    MAX_STYLE_TEXT,
  );
}

/**
 * The approved style references of an assignment (R6: uploaded or Orbit
 * generated assets with approved usage, raster images only).
 */
async function styleAssets(tx: DbTx, scope: Scope, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      id: { in: ids },
    },
  });
  return ids.flatMap((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    const d = data(row);
    return row &&
      d.usageApproved === true &&
      d.assetStatus === "approved" &&
      ["image/png", "image/jpeg", "image/webp"].includes(d.mime)
      ? [row]
      : [];
  });
}

/**
 * The style description stored for an assignment and its current references,
 * derived once and kept in its own row (changing the assignment row would
 * change its confirmed version).
 */
async function storedStyleDescription(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  rows: Array<{ id: string; data: unknown }>,
) {
  if (!rows.length) return null;
  const assetIds = rows.map((row) => row.id);
  const existing = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: STYLES,
      data: { path: ["assignmentId"], equals: assignmentId },
    },
  });
  if (
    existing &&
    JSON.stringify(data(existing).assetIds) === JSON.stringify(assetIds)
  )
    return String(data(existing).text);
  const value = {
    assignmentId,
    assetIds,
    text: describeStyle(rows),
    method: "asset_metadata",
    derivedAt: new Date().toISOString(),
  };
  if (existing) await update(tx, scope, existing, value);
  else await create(tx, scope, STYLES, value);
  return value.text;
}

/** Reference image bytes; a reference that cannot be read is left out. */
async function referenceImages(
  scope: Scope,
  rows: Array<{ id: string; data: unknown }>,
) {
  const references: ImageReference[] = [];
  for (const row of rows) {
    const d = data(row);
    try {
      const content =
        d.driveFileId && !d.base64
          ? await driveContent(scope, d.driveFileId, {
              md5Checksum: d.md5Checksum,
              modifiedTime: d.driveModifiedTime,
            })
          : assetBytes(d);
      if (!["image/png", "image/jpeg", "image/webp"].includes(content.mime))
        continue;
      references.push({
        bytes: content.bytes,
        mime: content.mime as ImageReference["mime"],
        filename: `reference-${references.length + 1}.${content.mime.split("/")[1]}`,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return references;
}

/** The image idea of the run: the first brief's, else its topic. */
function imageIdea(task: AgentTask) {
  const briefs = (task.input as any)?.inputs?.strategy?.briefs;
  if (!Array.isArray(briefs) || !briefs.length)
    throw new DomainError("AGENT_BRIEFS_MISSING");
  const withIdea = briefs.find(
    (brief: any) => typeof brief.imageIdea === "string" && brief.imageIdea,
  );
  return String(withIdea?.imageIdea ?? briefs[0].topic);
}

export const visualStep: StepHandler = async (scope, task) => {
  const idea = imageIdea(task);
  const requestId = runImageRequestId(task.id);
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  // A restarted task finds its image instead of generating a second one (R26).
  const existing = await inScope((tx) =>
    tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assets",
        data: { path: ["generationId"], equals: requestId },
      },
    }),
  );
  if (existing) return { assetId: existing.id, ...(await attach(scope, task)) };
  const prepared = await inScope(async (tx) => {
    const row = await entity(tx, scope, "assignments", task.assignmentId);
    const rightsSource = imageRightsSource(row);
    const rows = await styleAssets(
      tx,
      scope,
      (data(row).styleAssetIds ?? []) as string[],
    );
    const useReferences = imageReferencesEnabled();
    return {
      rightsSource,
      rows,
      useReferences,
      contentType: String(data(row).contentType),
      name: String(data(row).name),
      userId: String(data(row).confirmation.userId),
    };
  });
  const references = prepared.useReferences
    ? await referenceImages(scope, prepared.rows)
    : [];
  // Without readable references (switch off or none usable) the stored description carries the style.
  const styleDescription = references.length
    ? null
    : await inScope((tx) =>
        storedStyleDescription(tx, scope, task.assignmentId, prepared.rows),
      );
  const asset = await generateAssignmentImage(
    scope,
    {
      requestId,
      name: `Assignment image: ${prepared.name}`,
      prompt: idea,
      validUses: [
        prepared.contentType === "newsletter"
          ? "newsletter"
          : prepared.contentType === "blog"
            ? "blog"
            : "social",
      ],
      references,
      styleDescription,
      userId: prepared.userId,
      assetFields: {
        usageApproved: true,
        assetStatus: "approved",
        license:
          "AI-generated asset; usage approved by the owner's assignment confirmation",
        rightsSource: prepared.rightsSource,
        assignmentId: task.assignmentId,
        assignmentRunId: task.runId,
        agentTaskId: task.id,
      },
    },
    {
      runKey: runBudgetKey(task.runId),
      // In the reservation transaction: the consent still holds and the image fits the task and month.
      authorize: async (tx) => {
        imageRightsSource(
          await entity(tx, scope, "assignments", task.assignmentId),
        );
        const { imageConfig } = await currentImageTerms(tx, scope);
        await assertTaskBudget(
          tx,
          scope,
          task,
          imageConfig.maxCostMicrosPerImage,
        );
      },
    },
  );
  // The image is committed (and paid) before anything is attached.
  return { assetId: asset.id, ...(await attach(scope, task)) };
};

/**
 * Attaches the run image in its own transaction. A failure never touches the
 * stored image: it is reported, and the next attach of the run (a later
 * copywriter or a restarted task) puts the image on the drafts.
 */
async function attach(scope: Scope, task: AgentTask) {
  try {
    const result = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      attachRunImage(tx, scope, task.runId),
    );
    return { attached: result.attached, skipped: result.skipped };
  } catch (error) {
    return { attached: [], skipped: [], attachError: errorCode(error) };
  }
}
