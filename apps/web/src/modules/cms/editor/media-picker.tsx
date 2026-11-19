"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { useResource } from "@/lib/api";
import { Badge, Button, Empty, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { assetSrc, cmsPath, type AssetList, type CmsAsset } from "../api";
import { cmsText } from "../labels";
import { UploadButton } from "../media";

// Chooses an image of the content library for the editor (CH1.14b): body
// images, the hero and the social image. A new upload is chosen at once.

export function MediaPicker({
  entryLocale,
  onPick,
  onClose,
}: {
  entryLocale: string;
  onPick: (asset: CmsAsset) => void;
  onClose: () => void;
}) {
  const { project, locale, canEdit } = useWorkspace();
  const t = cmsText(locale).editor;
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const list = useResource<AssetList>(
    cmsPath(
      project.id,
      `/assets?limit=60${applied ? `&q=${encodeURIComponent(applied)}` : ""}`,
    ),
  );
  return (
    <Modal title={t.mediaTitle} onClose={onClose} wide>
      {canEdit && (
        <UploadButton onUploaded={(result) => onPick(result.asset)} />
      )}
      <form
        className="filter-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <div className="search-field">
          <Search aria-hidden="true" />
          <Input
            type="search"
            aria-label={t.mediaSearch}
            placeholder={t.mediaSearch}
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </form>
      <ResourceError error={list.error} retry={list.refresh} />
      {list.data &&
        (list.data.items.length ? (
          <ul className="cms-media-grid">
            {list.data.items.map((asset) => {
              const src = assetSrc(project.id, asset);
              return (
                <li key={asset.id} className="cms-media-item">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element -- private, uncached member route
                    <img
                      src={src}
                      alt={asset.alt[entryLocale] ?? ""}
                      loading="lazy"
                    />
                  ) : (
                    <div className="cms-figure-missing" />
                  )}
                  <div className="cms-media-meta">
                    <span className="cms-media-name">
                      {asset.name ?? asset.id}
                    </span>
                    <span className="field-hint">
                      {asset.width}×{asset.height}
                    </span>
                    {!asset.alt[entryLocale] && (
                      <Badge tone="warning">{t.mediaAltMissing}</Badge>
                    )}
                    {asset.aiLabel && <Badge tone="blue">{t.mediaAi}</Badge>}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPick(asset)}
                  >
                    {t.mediaChoose}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title={t.mediaEmpty} />
        ))}
    </Modal>
  );
}
