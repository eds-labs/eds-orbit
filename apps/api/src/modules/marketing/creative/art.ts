import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  generateImage,
  sourceSizeFor,
  type ImageSize,
} from "../../../../../../packages/ai/src/index.ts";
import {
  failedBlockers,
  type CreativeCheck,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, update } from "../../../shared.ts";
import {
  currentImageTerms,
  generateProjectImage,
} from "../brand/image-generation.ts";
import { artPrompt, type ArtCorrection } from "./art-direction.ts";
import type { EntityRow } from "./brand-kit.ts";
import { briefLayout } from "./brief.ts";
import type { CreativePlan } from "./persist.ts";
import { artCorrectionFor } from "./quality.ts";
import { findCreative, type CreativeRecord } from "./store.ts";

// Paid art for the manual Creative Studio (spec §8, §9): the owner confirms
// the per-image ceiling and that the prompt may be sent, the image takes the
// owner's image generation path (reserved at the ceiling before it is sent)
// and is stored as an unapproved reference: its rights are a separate
// decision of the owner. Regenerations are bounded by the brand kit's
// `maxArtCorrections`, and every attempt that was sent counts.

/** The owner's confirmation of one paid image, as `images/generate` asks for it. */
export const artConfirmation = z
  .object({
    confirmMaximumCostMicros: z.number().int().positive(),
    confirmPromptMayBeSentToProvider: z.literal(true),
  })
  .strict();
export type ArtConfirmation = z.infer<typeof artConfirmation>;

/** The change a regeneration asks of the new art (`artPrompt`'s correction). */
export const artCorrectionInput = z
  .object({
    kind: z.enum(["subject_larger", "calm_text_zone", "more_detail"]),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/** The image request for a creative's art, planned in a transaction. */
export type ArtRequest = {
  name: string;
  prompt: string;
  size: ImageSize;
  /** The configured per-image ceiling the image is reserved and settled at. */
  costMicros: number;
};

/** Paid art attempts recorded on a creative; they count against `maxArtCorrections`. */
export const artAttempts = (record: Pick<CreativeRecord, "corrections">) =>
  record.corrections.filter((c) => c.kind === "art").length;

/**
 * The change the creative's art findings ask for when the owner names none:
 * a larger subject or more detail (spec §9).
 */
export const findingsCorrection = (
  checks: CreativeCheck[],
): ArtCorrection | undefined =>
  artCorrectionFor(
    { artIsOrbitGenerated: true, artAttempts: 0, maxArtCorrections: 1 },
    failedBlockers(checks),
  ) ?? undefined;

/**
 * Plans the art of a creative: the art prompt for the layout of the brief's
 * first format (R29, R32) and the model's source size closest to the art box
 * drawn there. The confirmed ceiling must be the configured one
 * (`IMAGE_COST_CONFIRMATION_STALE`, 409; checked again when the image is
 * reserved); an unconfigured image route fails as image generation does.
 */
export async function planArt(
  tx: DbTx,
  scope: Scope,
  plan: Pick<CreativePlan, "brief" | "kit" | "options">,
  title: string,
  confirmation: ArtConfirmation,
  correction?: ArtCorrection,
): Promise<ArtRequest> {
  const { imageConfig } = await currentImageTerms(tx, scope);
  if (
    confirmation.confirmMaximumCostMicros !== imageConfig.maxCostMicrosPerImage
  )
    throw new DomainError("IMAGE_COST_CONFIRMATION_STALE", 409);
  const layout = briefLayout(plan.brief, plan.options.logoPlacement);
  const frame = layout.art ?? {
    w: layout.format.width,
    h: layout.format.height,
  };
  return {
    name: `Creative art: ${title}`.slice(0, 160),
    prompt: artPrompt(plan.brief, plan.kit.profile, layout, correction),
    size: sourceSizeFor(imageConfig.model, frame.w / frame.h),
    costMicros: imageConfig.maxCostMicrosPerImage,
  };
}

/**
 * Generates a creative's art through the owner's image generation
 * (`generateProjectImage`: owner only, project and policy checks, the
 * reservation at the per-image ceiling before transmission, settlement) and
 * returns the new asset's id. The asset is an unapproved `generated_artwork`
 * reference for social use, kept in Orbit (no Drive copy) until the owner
 * decides on its rights. `authorize` runs in the reservation transaction
 * after every other check; its throw stops before any cost.
 */
export async function generateArt(
  scope: Scope,
  request: ArtRequest & { requestId: string },
  confirmation: ArtConfirmation,
  provider: typeof generateImage = generateImage,
  authorize?: (tx: DbTx) => Promise<void>,
): Promise<string> {
  const asset = await generateProjectImage(
    scope,
    {
      requestId: request.requestId,
      name: request.name,
      prompt: request.prompt,
      size: request.size,
      quality: "medium",
      background: "opaque",
      validUses: ["social"],
      confirmPromptMayBeSentToOpenAI:
        confirmation.confirmPromptMayBeSentToProvider,
      confirmMaximumCostMicros: confirmation.confirmMaximumCostMicros,
      saveToDrive: false,
      channel: "Social",
    },
    provider,
    { authorize },
  );
  return asset.id;
}

/**
 * Records a regeneration attempt on the creative in the image's reservation
 * transaction, before anything is sent: from then on it counts against the
 * limit, even when its outcome stays unknown. The write is checked against
 * the creative's planned version, so a second regeneration racing this one
 * fails (`VERSION_CONFLICT`) before its own reservation.
 */
export async function recordArtAttempt(
  tx: DbTx,
  scope: Scope,
  planned: EntityRow,
  attempt: CreativeRecord["corrections"][number],
): Promise<void> {
  const record = data(planned) as CreativeRecord;
  await update(tx, scope, planned, {
    ...record,
    corrections: [...record.corrections, attempt],
  });
}

/**
 * Completes a recorded attempt from its image reservation once the call is
 * over: a settled image adds its cost (and the new art when it was stored), a
 * call whose outcome is unknown stays counted with its reserved amount as
 * unknown cost. An attempt that was never recorded (refused before anything
 * was reserved) changes nothing, and neither does one that was completed
 * before.
 */
export async function settleArtAttempt(
  scope: Scope,
  creativeId: string,
  requestId: string,
  assetId?: string,
): Promise<void> {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await findCreative(tx, scope, creativeId);
    const record = data(row) as CreativeRecord;
    const index = record.corrections.findIndex(
      (c) => c.requestId === requestId,
    );
    if (index < 0) return;
    const reservation = await tx.budgetReservation.findFirst({
      where: {
        projectId: scope.projectId,
        key: `${scope.projectId}:image:${requestId}`,
      },
    });
    // A retried request (the client's request id, R51) finds its attempt
    // counted already: the reservation is added to the creative once.
    if (!reservation || record.cost.reservationIds.includes(reservation.id))
      return;
    const settled =
      reservation.state === "settled"
        ? Number(reservation.settledMicros ?? 0)
        : null;
    const corrections = [...record.corrections];
    corrections[index] = {
      ...corrections[index]!,
      ...(settled !== null && { costMicros: settled }),
      ...(assetId && { assetId }),
    };
    await update(tx, scope, row, {
      ...record,
      corrections,
      cost: {
        reservationIds: [...record.cost.reservationIds, reservation.id],
        settledMicros: record.cost.settledMicros + (settled ?? 0),
        unknownMicros:
          record.cost.unknownMicros +
          (settled === null ? Number(reservation.amountMicros) : 0),
      },
    });
  });
}
