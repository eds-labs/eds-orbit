// "May be sent to AI providers" (`providerUse`, R28): the owner's choice per
// approved asset, set with the existing `asset-status` action. Only assets
// with it may go to a provider as bytes (reference images, vision review).

/** The asset fields the control needs. */
export type ProviderUseAsset = {
  id: string;
  version: number;
  /** The owner approved the asset's rights and use. */
  approved: boolean;
  providerUse: boolean;
};

const LABEL = [
  "May be sent to AI providers",
  "Darf an KI-Anbieter gesendet werden",
] as const;

/**
 * The `asset-status` body that sets provider use: the asset stays approved
 * with its rights confirmed, at the version the owner saw.
 */
export const providerUseBody = (asset: ProviderUseAsset, next: boolean) => ({
  assetId: asset.id,
  version: asset.version,
  assetStatus: "approved" as const,
  confirmUsageRights: true,
  providerUse: next,
});

/**
 * The owner's checkbox for an approved asset; others see the state
 * read-only. An asset that is not approved shows nothing: provider use
 * exists only while it is approved.
 */
export function ProviderUseControl({
  asset,
  isOwner,
  de,
  pending,
  onChange,
}: {
  asset: ProviderUseAsset;
  isOwner: boolean;
  de: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
}) {
  if (!asset.approved) return null;
  const label = LABEL[de ? 1 : 0];
  if (!isOwner)
    return (
      <p className="panel-note">
        {label}: {asset.providerUse ? (de ? "ja" : "yes") : de ? "nein" : "no"}
      </p>
    );
  return (
    <label className="field-check">
      <input
        type="checkbox"
        disabled={pending}
        checked={asset.providerUse}
        onChange={(e) => onChange(e.target.checked)}
      />{" "}
      {label}
    </label>
  );
}
