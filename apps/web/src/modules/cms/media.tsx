"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { api, patch, post, useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Modal,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  assetSrc,
  cmsPath,
  projectLocales,
  type AssetList,
  type AssetUpload,
  type CmsAsset,
  type SiteList,
} from "./api";
import { cmsText, libraryError } from "./labels";

// The content media library (ADR 0029 §5, CH1.14c): upload, alt text and
// caption per language, credit and license, AI labels, archive. Uploads go
// as raw bytes; the server normalizes the image and creates the variants.

// The server default (FILES_MAX_BYTES); the server checks its own setting.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

/** Uploads one image file to the content library. */
export function uploadAsset(projectId: string, file: File) {
  return api<AssetUpload>(cmsPath(projectId, "/assets"), {
    method: "POST",
    body: file,
    headers: {
      "Content-Type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
  });
}

/** The languages of a project that still miss alt text on an asset. */
export const missingAlt = (asset: Pick<CmsAsset, "alt">, locales: string[]) =>
  locales.filter((l) => !asset.alt[l]?.trim());

function AssetDetails({
  asset,
  locales,
  editable,
  onClose,
  onSaved,
}: {
  asset: CmsAsset;
  locales: string[];
  editable: boolean;
  onClose: () => void;
  onSaved: (asset: CmsAsset) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).library;
  const m = t.media;
  const [alt, setAlt] = useState<Record<string, string>>(asset.alt);
  const [caption, setCaption] = useState<Record<string, string>>(asset.caption);
  const [credit, setCredit] = useState(asset.credit ?? "");
  const [license, setLicense] = useState(asset.license ?? "");
  const save = useMutation();
  const [done, setDone] = useState(false);
  const path = cmsPath(project.id, `/assets/${asset.id}`);
  const src = assetSrc(project.id, asset);
  const canEdit = editable && !asset.archived;
  const submit = async () => {
    setDone(false);
    const next = await save.run(() =>
      patch<CmsAsset>(path, {
        version: asset.version,
        alt,
        caption,
        credit: credit.trim() || null,
        license: license.trim() || null,
      }),
    );
    if (next) {
      setDone(true);
      onSaved(next);
    }
  };
  const archive = async (on: boolean) => {
    const next = await save.run(() =>
      post<CmsAsset>(`${path}/${on ? "archive" : "unarchive"}`, {
        version: asset.version,
      }),
    );
    if (next) onSaved(next);
  };
  return (
    <Modal title={asset.name ?? m.details} onClose={onClose} wide>
      <div className="cms-asset-detail">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- private, uncached member route
          <img src={src} alt={asset.alt[locale] ?? ""} />
        ) : (
          <div className="cms-figure-missing" />
        )}
        <div className="cms-panel">
          <dl className="detail-grid">
            <dt>{m.size}</dt>
            <dd>
              {asset.width}×{asset.height}
            </dd>
            <dt>{m.sizes}</dt>
            <dd>{asset.renditions.map((r) => r.name).join(", ")}</dd>
          </dl>
          {asset.aiLabel && (
            <p>
              <Badge tone="blue">{m.ai}</Badge>{" "}
              <span className="field-hint">{m.aiHint}</span>
            </p>
          )}
          {asset.archived && <Alert kind="info">{m.archivedHint}</Alert>}
          <FieldGroup>
            {locales.map((l) => (
              <Field key={`alt-${l}`}>
                <FieldLabel htmlFor={`cms-alt-${l}`}>{m.alt(l)}</FieldLabel>
                <Input
                  id={`cms-alt-${l}`}
                  value={alt[l] ?? ""}
                  maxLength={500}
                  readOnly={!canEdit}
                  onChange={(e) => setAlt({ ...alt, [l]: e.target.value })}
                />
              </Field>
            ))}
            <span className="field-hint">{m.altHint}</span>
            {locales.map((l) => (
              <Field key={`caption-${l}`}>
                <FieldLabel htmlFor={`cms-caption-${l}`}>
                  {m.caption(l)}
                </FieldLabel>
                <Input
                  id={`cms-caption-${l}`}
                  value={caption[l] ?? ""}
                  maxLength={300}
                  readOnly={!canEdit}
                  onChange={(e) =>
                    setCaption({ ...caption, [l]: e.target.value })
                  }
                />
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor="cms-credit">{m.credit}</FieldLabel>
              <Input
                id="cms-credit"
                value={credit}
                maxLength={200}
                readOnly={!canEdit}
                onChange={(e) => setCredit(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cms-license">{m.license}</FieldLabel>
              <Input
                id="cms-license"
                value={license}
                maxLength={200}
                readOnly={!canEdit}
                onChange={(e) => setLicense(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {save.error && (
            <Alert kind="error">{libraryError(t, save.error)}</Alert>
          )}
          {done && <Alert kind="success">{m.saved}</Alert>}
          {editable && (
            <div className="cms-actions">
              {canEdit && (
                <Button disabled={save.pending} onClick={() => void submit()}>
                  {m.save}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={save.pending}
                onClick={() => void archive(!asset.archived)}
              >
                {asset.archived ? m.unarchive : m.archive}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function UploadButton({
  onUploaded,
  label,
}: {
  onUploaded: (result: AssetUpload) => void;
  label?: string;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).library;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES)
      return setError(libraryError(t, "FILE_TOO_LARGE"));
    setBusy(true);
    try {
      onUploaded(await uploadAsset(project.id, file));
    } catch (e) {
      setError(
        libraryError(t, e instanceof Error ? e.message : "REQUEST_FAILED"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="cms-upload">
      <label className={`button button-primary${busy ? " is-busy" : ""}`}>
        {busy ? t.media.uploading : (label ?? t.media.upload)}
        <input
          type="file"
          accept={IMAGE_TYPES}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
    </span>
  );
}

export function MediaView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = cmsText(locale).library;
  const m = t.media;
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<CmsAsset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "100" });
  if (applied) params.set("q", applied);
  if (archived) params.set("archived", "true");
  const list = useResource<AssetList>(cmsPath(project.id, `/assets?${params}`));
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const locales = projectLocales(
    sites.data?.items ?? [],
    project.contentLanguages ?? [project.language],
  );
  return (
    <div className="support-page">
      <PageHead title={m.title} description={m.intro}>
        {canEdit && (
          <UploadButton
            onUploaded={(result) => {
              setNotice(result.duplicate ? m.duplicate : m.uploaded);
              list.refresh();
              setOpen(result.asset);
            }}
          />
        )}
      </PageHead>
      {canEdit && <p className="field-hint">{m.uploadHint}</p>}
      {notice && <Alert kind="success">{notice}</Alert>}
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
            aria-label={cmsText(locale).editor.mediaSearch}
            placeholder={cmsText(locale).editor.mediaSearch}
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <label className="cms-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          <span>{m.showArchived}</span>
        </label>
      </form>
      <ResourceError error={list.error} retry={list.refresh} />
      {list.data &&
        (list.data.items.length ? (
          <ul className="cms-media-grid">
            {list.data.items.map((asset) => {
              const src = assetSrc(project.id, asset);
              const missing = missingAlt(asset, locales);
              return (
                <li key={asset.id} className="cms-media-item">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element -- private, uncached member route
                    <img
                      src={src}
                      alt={asset.alt[locale] ?? ""}
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
                    {missing.length ? (
                      <Badge tone="warning">
                        {m.altMissing(missing.join(", "))}
                      </Badge>
                    ) : (
                      <Badge tone="success">{m.altComplete}</Badge>
                    )}
                    {asset.aiLabel && <Badge tone="blue">{m.ai}</Badge>}
                    {asset.archived && <Badge>{m.archivedBadge}</Badge>}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen(asset)}
                  >
                    {m.edit}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title={m.empty} />
        ))}
      {open && (
        <AssetDetails
          // Keyed by the image only: a save keeps the form and its confirmation.
          key={open.id}
          asset={open}
          locales={locales}
          editable={canEdit}
          onClose={() => setOpen(null)}
          onSaved={(next) => {
            setOpen(next);
            list.refresh();
          }}
        />
      )}
    </div>
  );
}
