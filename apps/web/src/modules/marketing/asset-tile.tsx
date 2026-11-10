"use client";
import { Download, ExternalLink, Image as ImageIcon } from "lucide-react";
import { when, type Entity } from "@/lib/api";
import { Badge, Button, Status } from "@/components/ui/primitives";
import { driveText } from "@/platform/drive/labels";
import { ProviderUseControl } from "./creative/provider-use";
import {
  ASSET_TEXT as T,
  assetFacts,
  say,
  sourceLabel,
  statusLabel,
} from "./asset-library-copy";

// One brand asset of the library (WP4): a preview, a readable name, facts
// and source, its status, the owner's actions, and the raw ids only in
// "Technical details". The handlers are the library's existing actions.

export type AssetTileProps = {
  asset: Entity;
  /** Where the browser loads the asset's bytes (Orbit's content route). */
  contentUrl: string;
  isOwner: boolean;
  locale: "en" | "de";
  timezone?: string;
  /** The Creative Studio is on: the owner decides AI provider use. */
  studio: boolean;
  pending: boolean;
  onProviderUse: (next: boolean) => void;
  onApprove: () => void;
  onOutdated: () => void;
  onRetryDrive: () => void;
};

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

export function assetName(asset: Entity, de: boolean) {
  const d = asset.data;
  return str(d.name) ?? str(d.brandName) ?? say(T.unnamed, de);
}

/** Whether the browser can show the asset as an image. */
export function hasPreview(asset: Entity) {
  const d = asset.data;
  return (
    d.hasContent === true ||
    (typeof d.driveFileId === "string" &&
      String(d.mime ?? "").startsWith("image/")) ||
    d.type === "original_logo"
  );
}

export function AssetTile({
  asset,
  contentUrl,
  isOwner,
  locale,
  timezone,
  studio,
  pending,
  onProviderUse,
  onApprove,
  onOutdated,
  onRetryDrive,
}: AssetTileProps) {
  const de = locale === "de";
  const d = asset.data;
  const name = assetName(asset, de);
  const facts = assetFacts(d, de);
  const driveFileId = str(d.driveFileId);
  const status = String(d.assetStatus ?? "");
  const original = d.type === "original_logo";
  const downloadable = d.hasContent === true || driveFileId !== null;
  const usage =
    d.bannerBackground === true
      ? say(T.bannerBackground, de)
      : str(d.assignmentId)
        ? say(T.forAssignment, de)
        : null;
  const created = str(d.generatedAt) ?? str(d.uploadedAt) ?? asset.createdAt;
  // Raw values for whoever needs to trace an asset; the prompt for owners only.
  const technical: [string, string | null][] = [
    [say(T.assetId, de), asset.id],
    [say(T.rawType, de), str(d.type)],
    [say(T.filename, de), str(d.filename)],
    [say(T.driveFileId, de), driveFileId],
    [say(T.driveFolderId, de), str(d.driveFolderId)],
    [say(T.sha256, de), str(d.sha256)],
    [say(T.model, de), str(d.providerModel)],
    [
      say(T.profileVersion, de),
      d.profileVersion === undefined || d.profileVersion === null
        ? null
        : String(d.profileVersion),
    ],
    [say(T.assignmentId, de), str(d.assignmentId)],
    [say(T.license, de), str(d.license)],
    [say(T.createdAt, de), created ? when(created, locale, timezone) : null],
    [say(T.prompt, de), isOwner ? str(d.prompt) : null],
  ];
  return (
    <article className="asset-card asset-tile">
      <div className="asset-tile-preview">
        {hasPreview(asset) ? (
          <img
            src={contentUrl}
            alt={`${say(T.previewAlt, de)} ${name}`}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="asset-placeholder">
            <ImageIcon aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="asset-tile-body">
        <h3 className="asset-tile-name" title={name}>
          {name}
        </h3>
        {facts && <p className="asset-tile-meta">{facts}</p>}
        <p className="asset-tile-meta">{sourceLabel(d, de)}</p>
        <div className="asset-tile-badges">
          <Status value={status || "unknown"} label={statusLabel(status, de)} />
          {d.driveSyncStatus === "FAILED" && (
            <Badge tone="danger">{say(T.driveFailed, de)}</Badge>
          )}
          {d.driveSyncStatus === "PENDING" && (
            <Badge tone="warning">{say(T.drivePending, de)}</Badge>
          )}
        </div>
        {usage && <p className="asset-tile-meta">{usage}</p>}
        {studio && !original && (
          <ProviderUseControl
            asset={{
              id: asset.id,
              version: asset.version,
              approved: d.usageApproved === true && status === "approved",
              providerUse: d.providerUse === true,
            }}
            isOwner={isOwner}
            de={de}
            pending={pending}
            onChange={onProviderUse}
          />
        )}
      </div>
      <div className="asset-tile-actions">
        {downloadable && (
          <Button asChild variant="outline">
            <a href={contentUrl} download={str(d.filename) ?? "asset"}>
              <Download data-icon="inline-start" aria-hidden="true" />
              {say(T.download, de)}
            </a>
          </Button>
        )}
        {driveFileId && (
          <Button asChild variant="outline">
            <a
              href={`https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/view`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink data-icon="inline-start" aria-hidden="true" />
              {driveText(locale).openInDrive}
            </a>
          </Button>
        )}
        {isOwner && d.driveSyncStatus === "FAILED" && (
          <Button variant="outline" disabled={pending} onClick={onRetryDrive}>
            {say(T.retryDrive, de)}
          </Button>
        )}
        {isOwner && !original && status !== "approved" && (
          <Button
            disabled={pending}
            title={say(T.approveHint, de)}
            onClick={onApprove}
          >
            {say(T.approve, de)}
          </Button>
        )}
        {isOwner && !original && status !== "outdated" && (
          <Button variant="outline" disabled={pending} onClick={onOutdated}>
            {say(T.outdated, de)}
          </Button>
        )}
      </div>
      <details className="asset-tile-details">
        <summary>{say(T.technical, de)}</summary>
        <dl>
          {technical
            .filter((row): row is [string, string] => row[1] !== null)
            .map(([label, raw]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{raw}</dd>
              </div>
            ))}
        </dl>
      </details>
    </article>
  );
}
