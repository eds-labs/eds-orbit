import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { RasterSource } from "../../../../../../packages/creative/src/index.ts";
import {
  id as idSchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, entity, update } from "../../../shared.ts";
import { isRasterMime, PRODUCT_ASSET_TYPES } from "../brand/asset-rules.ts";
import { assetContent } from "./asset-content.ts";
import type { EntityRow } from "./brand-kit.ts";

// The assets a creative is made of (art, logos, products) and its renditions,
// always read inside this project.

/** Asset types an art may have; logos and screenshots are never art. */
const ART_ASSET_TYPES = ["photo", "background", "banner", "generated_artwork"];

/** An entity of this project; a malformed or foreign id is `NOT_FOUND`. */
export function projectRow(tx: DbTx, scope: Scope, kind: string, id: unknown) {
  if (!idSchema.safeParse(id).success) throw new DomainError("NOT_FOUND", 404);
  return entity(tx, scope, kind, id as string);
}

/** The assets of this project among `ids`, by id; others are absent. */
export async function projectAssets(
  tx: DbTx,
  scope: Scope,
  ids: string[],
): Promise<Map<string, EntityRow>> {
  const rows = await tx.entity.findMany({
    where: {
      id: { in: ids.filter((id) => idSchema.safeParse(id).success) },
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/** An asset's stored SHA-256, lower case ("" without one). */
export const assetSha = (row: { data: unknown } | null | undefined) =>
  String(data(row).sha256 ?? "").toLowerCase();

/** A requested art: a raster picture of this project, never a logo or screenshot. */
export async function artAsset(tx: DbTx, scope: Scope, id: string) {
  const row = await projectRow(tx, scope, "assets", id);
  if (
    !ART_ASSET_TYPES.includes(data(row).type) ||
    !isRasterMime(data(row).mime)
  )
    throw new DomainError("APPROVED_VISUAL_ASSET_REQUIRED", 409);
  return row;
}

/** A requested screenshot or product image of this project. */
export async function productAsset(tx: DbTx, scope: Scope, id: string) {
  const row = await projectRow(tx, scope, "assets", id);
  if (
    !PRODUCT_ASSET_TYPES.includes(data(row).type) ||
    !isRasterMime(data(row).mime)
  )
    throw new DomainError("APPROVED_PRODUCT_ASSET_REQUIRED", 409);
  return row;
}

/** Art Orbit generated with an image model may be regenerated; uploaded art may not. */
export const isOrbitArt = (row: EntityRow | null) =>
  Boolean(
    row &&
    data(row).type === "generated_artwork" &&
    typeof data(row).generationId === "string",
  );

/** A component's bytes (outside any transaction), checked against its stored SHA-256. */
export async function componentBytes(
  scope: Scope,
  row: EntityRow,
): Promise<RasterSource> {
  const content = await assetContent(scope, data(row));
  const stored = assetSha(row);
  if (stored && stored !== content.sha256)
    throw new DomainError("BRAND_ASSET_INTEGRITY_FAILED", 409);
  return { bytes: content.bytes, sha256: content.sha256 };
}

/** Marks a rendition outdated: it no longer counts as an approved image. */
export async function outdateRendition(
  tx: DbTx,
  scope: Scope,
  row: EntityRow | undefined,
) {
  if (!row || data(row).assetStatus === "outdated") return;
  await update(tx, scope, row, {
    ...data(row),
    assetStatus: "outdated",
    usageApproved: false,
  });
}
