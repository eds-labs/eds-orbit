import { isApprovedAsset } from "./asset-rules.ts";

/**
 * The one gate for sending an asset's bytes (or a creative made of assets)
 * to an AI provider: reference images for image generation, vision review.
 * The owner approved the asset's rights (`isApprovedAsset`) and also set
 * `providerUse` on it; any other asset is composed locally only, whatever
 * its type (R28, R64).
 */
export function mayTransmitToProvider(asset: Record<string, any>): boolean {
  return isApprovedAsset(asset) && asset.providerUse === true;
}
