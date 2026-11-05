"use client";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { DriveFileActionProps } from "@/platform/drive/api";
import { importFromDrive, SOCIAL_DRIVE_TYPES } from "./api";
import { mediaMessage, socialText } from "./labels";

// Social's action on the Google Drive page (design 2026-11-05 §5.3): owners
// and editors copy a PNG, JPEG or WebP image into the media library.

export function AddToSocialAction({ projectId, file }: DriveFileActionProps) {
  const { canEdit, locale } = useWorkspace();
  const t = socialText(locale).media;
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!canEdit || !SOCIAL_DRIVE_TYPES.has(file.mimeType)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          setError(null);
          try {
            await importFromDrive(projectId, file.id);
            setState("done");
          } catch (e) {
            setError(mediaMessage(e instanceof ApiError ? e.code : "REQUEST_FAILED", locale));
            setState("idle");
          }
        }}
      >
        {state === "busy" ? t.adding : state === "done" ? t.addedToSocial : t.addToSocial}
      </Button>
      {error && (
        <span role="alert" className="field-hint">
          {error}
        </span>
      )}
    </>
  );
}
