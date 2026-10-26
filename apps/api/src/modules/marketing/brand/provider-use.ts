/**
 * The one gate for sending an asset (or a creative made of assets) to an AI
 * provider: style references for image generation, vision review. The
 * owner approved the asset's rights and also set `providerUse` on it; any
 * other asset is composed locally only, whatever its type (R28).
 */
export function mayTransmitToProvider(asset: Record<string, any>): boolean {
  return (
    asset.usageApproved === true &&
    asset.assetStatus === "approved" &&
    asset.providerUse === true
  );
}
