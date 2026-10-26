/** Image formats the layout engine can draw. */
export const RASTER_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type RasterMime = (typeof RASTER_MIMES)[number];

/** Asset types a brand kit's product images (`productAssetIds`) may have. */
export const PRODUCT_ASSET_TYPES = ["screenshot", "product", "photo"] as const;

/** Whether the owner approved the asset's rights and use. */
export function isApprovedAsset(asset: Record<string, any>): boolean {
  return asset.usageApproved === true && asset.assetStatus === "approved";
}

/** Whether `mime` is a raster image format the studio can draw. */
export function isRasterMime(mime: unknown): mime is RasterMime {
  return (RASTER_MIMES as readonly unknown[]).includes(mime);
}
