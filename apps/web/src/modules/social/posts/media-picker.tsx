"use client";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { Tabs } from "@/components/ui/primitives";
import { isDriveVideo, type DriveFile } from "@/platform/drive/api";
import { DriveBrowser } from "@/platform/drive/drive-browser";
import { driveText } from "@/platform/drive/labels";
import { importFromDrive, SOCIAL_DRIVE_TYPES, socialPath, type MediaRef, type SocialMedia } from "../api";
import { mediaMessage, socialText } from "../labels";

// Choosing library images for a post (S4): in the order they are chosen,
// at most ten. An image the post has but the library no longer lists (it
// was removed while a post used it) stays shown, so it can be taken out.

const MAX = 10;

/** Why a Drive file cannot be added to a post with `selectedCount` images. */
export function drivePickBlock(file: DriveFile, selectedCount: number, locale: "en" | "de"): string | null {
  const t = socialText(locale).posts;
  if (isDriveVideo(file)) return driveText(locale).videosLater;
  if (!SOCIAL_DRIVE_TYPES.has(file.mimeType)) return t.driveTypes;
  return selectedCount >= MAX ? t.driveLimit : null;
}

export function MediaPicker({
  projectId,
  target,
  legend,
  library,
  known = [],
  selected,
  disabled,
  locale,
  onChange,
  driveEnabled = false,
  onImported,
}: {
  projectId: string;
  /** "base" or an account id; makes the field ids unique. */
  target: string;
  legend: string;
  library: SocialMedia[];
  /** Images the post already has, for those the library no longer lists. */
  known?: MediaRef[];
  selected: string[];
  disabled?: boolean;
  locale: "en" | "de";
  onChange: (ids: string[]) => void;
  /** Offers the project's Google Drive next to the library (design 2026-11-05). */
  driveEnabled?: boolean;
  /** A Drive image was copied into the library. */
  onImported?: (media: SocialMedia) => void;
}) {
  const t = socialText(locale).posts;
  const [tab, setTab] = useState<"library" | "drive">("library");
  const [folder, setFolder] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gone = selected
    .filter((id) => !library.some((m) => m.id === id))
    .map((id) => {
      const ref = known.find((k) => k.mediaId === id);
      return { id, name: t.removedFromLibrary, altText: ref?.altText ?? null };
    });
  const items = [...library.map((m) => ({ id: m.id, name: m.name, altText: m.altText })), ...gone];
  const pick = async (file: DriveFile) => {
    if (drivePickBlock(file, selected.length, locale)) return;
    setPending(file.id);
    setError(null);
    try {
      const media = await importFromDrive(projectId, file.id);
      onImported?.(media);
      onChange([...selected, media.id]);
      setTab("library");
    } catch (e) {
      setError(mediaMessage(e instanceof ApiError ? e.code : "REQUEST_FAILED", locale));
    } finally {
      setPending(null);
    }
  };
  const libraryList = items.length ? (
        <ul className="settings-rows">
          {items.map((m) => {
            const position = selected.indexOf(m.id);
            const id = `social-post-media-${target}-${m.id}`;
            return (
              <li key={m.id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={position >= 0}
                  disabled={disabled || (position < 0 && selected.length >= MAX)}
                  onChange={() =>
                    onChange(position >= 0 ? selected.filter((x) => x !== m.id) : [...selected, m.id])
                  }
                />{" "}
                <label htmlFor={id}>
                  <img
                    src={`/api${socialPath(projectId, `/media/${m.id}/content?rendition=jpeg`)}`}
                    alt={m.altText ?? m.name}
                    width={64}
                    loading="lazy"
                  />{" "}
                  {position >= 0 ? `${position + 1}. ` : ""}
                  {m.name}
                </label>
              </li>
            );
          })}
        </ul>
  ) : (
    <p className="field-hint">{t.mediaEmpty}</p>
  );
  return (
    <fieldset>
      <legend>{legend}</legend>
      {driveEnabled && !disabled ? (
        <>
          <Tabs
            tabs={[
              { key: "library", label: t.mediaTabLibrary },
              { key: "drive", label: t.mediaTabDrive },
            ]}
            value={tab}
            onChange={(value) => setTab(value === "drive" ? "drive" : "library")}
          />
          <div role="tabpanel" aria-label={t.mediaTabLibrary} hidden={tab !== "library"}>
            {libraryList}
          </div>
          {tab === "drive" && (
            <div role="tabpanel" aria-label={t.mediaTabDrive}>
              {error && (
                <p role="alert" className="field-hint">
                  {error}
                </p>
              )}
              <DriveBrowser
                projectId={projectId}
                folderId={folder}
                onFolderChange={setFolder}
                mode="pick"
                onPick={pick}
                pickPending={pending}
                pickDisabled={(file) => drivePickBlock(file, selected.length, locale)}
                locale={locale}
              />
            </div>
          )}
        </>
      ) : (
        libraryList
      )}
    </fieldset>
  );
}
