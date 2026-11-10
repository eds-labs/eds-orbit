"use client";
import { useContext, useState } from "react";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Button, Empty, Field, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { ShellContext } from "@/platform/shell/shell-context";
import { DriveBrowser } from "@/platform/drive/drive-browser";
import { driveText } from "@/platform/drive/labels";
import { isDriveVideo, type DriveFile } from "@/platform/drive/api";
import { importFromDrive, SOCIAL_DRIVE_TYPES, socialPath, type SocialMedia, type SocialMediaList } from "./api";
import { mediaMessage, socialText } from "./labels";

// The social media library (ADR 0020, S3): everybody in the module sees the
// images; owners and editors upload, describe and remove them. The hints
// repeat the server's platform rules (modules/social/media/rules.ts) for
// the two limits people meet most.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const X_MAX = 5 * 1024 * 1024;

/** Platforms an image does not fit as it is. */
export function mediaHints(media: SocialMedia, locale: "en" | "de"): string[] {
  const t = socialText(locale).media;
  const hints: string[] = [];
  const ratio = media.jpegWidth / media.jpegHeight;
  if (ratio < 0.799 || ratio > 1.911) hints.push(t.hintInstagramRatio);
  if (media.jpegWidth < 320) hints.push(t.hintInstagramSmall);
  if (Math.min(media.size, media.jpegSize) > X_MAX) hints.push(t.hintX);
  return hints;
}

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "REQUEST_FAILED");

function MediaCard({
  media,
  editable,
  onMessage,
  onRemove,
}: {
  media: SocialMedia;
  editable: boolean;
  onMessage: (text: string | null) => void;
  onRemove: (media: SocialMedia) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = socialText(locale).media;
  const [alt, setAlt] = useState(media.altText ?? "");
  const id = `social-media-alt-${media.id}`;
  return (
    <li className="work-settings-row">
      <img
        src={`/api${socialPath(project.id, `/media/${media.id}/content?rendition=jpeg`)}`}
        alt={media.altText ?? media.name}
        width={160}
        height={Math.max(1, Math.round((160 * media.jpegHeight) / media.jpegWidth))}
        loading="lazy"
      />
      <div>
        <strong>{media.name}</strong>
        <p className="field-hint">
          {media.width} × {media.height}
        </p>
        {mediaHints(media, locale).map((hint) => (
          <p key={hint} className="field-hint">
            {hint}
          </p>
        ))}
        {editable && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api(socialPath(project.id, `/media/${media.id}`), {
                  method: "PATCH",
                  body: JSON.stringify({ altText: alt || null, version: media.version }),
                });
                onMessage(null);
              } catch (e) {
                onMessage(mediaMessage(codeOf(e), locale));
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={id}>{t.description}</FieldLabel>
              <Input id={id} maxLength={1000} value={alt} onChange={(e) => setAlt(e.target.value)} />
            </Field>
            <Button type="submit" size="sm" variant="outline">
              {t.save}
            </Button>{" "}
            <Button type="button" size="sm" variant="outline" onClick={() => onRemove(media)}>
              {t.remove}
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}

export function MediaView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = socialText(locale).media;
  const list = useResource<SocialMediaList>(socialPath(project.id, "/media"));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SocialMedia | null>(null);
  const googleDrive = useContext(ShellContext)?.features?.googleDrive === true;
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveFolder, setDriveFolder] = useState<string | null>(null);
  const [drivePending, setDrivePending] = useState<string | null>(null);
  const [driveNotice, setDriveNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const fromDrive = async (file: DriveFile) => {
    setDrivePending(file.id);
    setDriveNotice(null);
    try {
      const media = await importFromDrive(project.id, file.id);
      setDriveNotice({ kind: "success", text: `${t.addedToSocial}: ${media.name}` });
      list.refresh();
    } catch (e) {
      setDriveNotice({ kind: "error", text: mediaMessage(codeOf(e), locale) });
    } finally {
      setDrivePending(null);
    }
  };

  const upload = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) return setMessage(mediaMessage("FILE_TOO_LARGE", locale));
    setBusy(true);
    setMessage(null);
    try {
      await api(socialPath(project.id, "/media"), {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-type": file.type,
        },
      });
      list.refresh();
    } catch (e) {
      setMessage(mediaMessage(codeOf(e), locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="support-page">
      <PageHead title={t.title} description={t.intro}>
        {canEdit && (
          <label className="button button-primary media-upload">
            {busy ? t.uploading : t.upload}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
          </label>
        )}
        {canEdit && googleDrive && (
          <Button variant="outline" onClick={() => setDriveOpen(true)}>
            {t.fromDrive}
          </Button>
        )}
      </PageHead>
      {message && <Alert kind="error">{message}</Alert>}
      <ResourceError error={list.error} retry={list.refresh} />
      {list.data &&
        (list.data.items.length ? (
          <ul className="settings-rows">
            {list.data.items.map((media) => (
              <MediaCard
                key={`${media.id}:${media.version}`}
                media={media}
                editable={canEdit}
                onMessage={(text) => {
                  setMessage(text);
                  list.refresh();
                }}
                onRemove={setRemoving}
              />
            ))}
          </ul>
        ) : (
          <Empty title={t.empty} />
        ))}
      {driveOpen && (
        <Modal wide title={t.fromDriveTitle} description={t.fromDriveIntro} onClose={() => setDriveOpen(false)}>
          {driveNotice && <Alert kind={driveNotice.kind}>{driveNotice.text}</Alert>}
          <DriveBrowser
            projectId={project.id}
            folderId={driveFolder}
            onFolderChange={setDriveFolder}
            mode="pick"
            onPick={fromDrive}
            pickPending={drivePending}
            pickDisabled={(file) =>
              isDriveVideo(file)
                ? driveText(locale).videosLater
                : SOCIAL_DRIVE_TYPES.has(file.mimeType)
                  ? null
                  : socialText(locale).posts.driveTypes
            }
            locale={locale}
          />
          <Button variant="outline" onClick={() => setDriveOpen(false)}>
            {t.close}
          </Button>
        </Modal>
      )}
      {removing && (
        <Modal title={t.confirmTitle(removing.name)} description={t.confirmBody} onClose={() => setRemoving(null)}>
          <Button variant="outline" onClick={() => setRemoving(null)}>
            {t.cancel}
          </Button>{" "}
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(socialPath(project.id, `/media/${removing.id}`), { method: "DELETE" });
              } catch (e) {
                setMessage(mediaMessage(codeOf(e), locale));
              }
              setRemoving(null);
              list.refresh();
            }}
          >
            {t.remove}
          </Button>
        </Modal>
      )}
    </div>
  );
}
