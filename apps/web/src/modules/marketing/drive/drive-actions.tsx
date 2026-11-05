"use client";
import { useContext, useState } from "react";
import { post, uploadAssetTypes, useMutation } from "@/lib/api";
import { Alert, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import { DataForm, str } from "@/platform/ui/form";
import {
  isDriveFolder,
  isDriveImage,
  type DriveFileActionProps,
  type DriveToolbarProps,
} from "@/platform/drive/api";

// Marketing's actions on the Google Drive page (design 2026-11-05 §5.3),
// moved from the former settings card: import a Drive file into the brand
// asset library, and upload a reviewed image into the open Drive folder.
// Both routes are owner-only on the server.

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/google-drive`;

export function AddToLibraryAction({ projectId, file, onDone }: DriveFileActionProps) {
  const { isOwner } = useWorkspace();
  // Product screenshots and images come with the Creative Studio (R61).
  const studio = useContext(ShellContext)?.features?.creativeStudio === true;
  const image = isDriveImage(file);
  const [type, setType] = useState(image ? "photo" : "document");
  const mutation = useMutation(onDone);
  if (!isOwner || isDriveFolder(file)) return null;
  return (
    <>
      <select aria-label={`Asset type for ${file.name}`} value={type} onChange={(e) => setType(e.target.value)}>
        {(image ? uploadAssetTypes(studio) : ["document", "other"]).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={mutation.pending}
        onClick={() =>
          mutation.run(() => post(`${base(projectId)}/files/${encodeURIComponent(file.id)}/import`, { type }))
        }
      >
        {mutation.success ? "Added to library" : "Add to library"}
      </Button>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </>
  );
}

export function UploadToDriveToolbar({ projectId, folderId, onDone }: DriveToolbarProps) {
  const { isOwner } = useWorkspace();
  const studio = useContext(ShellContext)?.features?.creativeStudio === true;
  const [open, setOpen] = useState(false);
  const mutation = useMutation(onDone);
  if (!isOwner) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Upload to Drive
      </Button>
      {open && (
        <Modal
          title="Upload private Drive asset"
          description="PNG, JPEG or WebP. The server validates the image and removes metadata before uploading."
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              { name: "name", label: "Asset name", required: true },
              {
                name: "type",
                label: "Asset type",
                type: "select",
                value: "photo",
                options: uploadAssetTypes(studio).map((value) => ({ value, label: value })),
              },
              {
                name: "file",
                label: "Image file",
                type: "file",
                accept: "image/png,image/jpeg,image/webp",
                required: true,
              },
              { name: "source", label: "Source / creator", required: true },
              { name: "license", label: "License / rights basis", required: true },
              {
                name: "validUses",
                label: "Valid uses (comma separated)",
                value: "brand, social",
                required: true,
              },
              {
                name: "confirmRightsInformation",
                label: "I confirm the source and rights information is accurate",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Upload as reference"
            onCancel={() => setOpen(false)}
            onSubmit={async (values) => {
              await mutation.run(async () => {
                const file = values.file;
                if (!(file instanceof File) || !file.size || file.size > 1_000_000)
                  throw new Error("ASSET_UPLOAD_TOO_LARGE");
                const binary = new Uint8Array(await file.arrayBuffer());
                let encoded = "";
                for (let offset = 0; offset < binary.length; offset += 0x8000)
                  encoded += String.fromCharCode(...binary.subarray(offset, offset + 0x8000));
                const result = await post(`${base(projectId)}/upload`, {
                  name: str(values, "name"),
                  type: str(values, "type"),
                  mime: file.type,
                  base64: btoa(encoded),
                  source: str(values, "source"),
                  license: str(values, "license"),
                  validUses: str(values, "validUses")
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                  confirmRightsInformation: true,
                  ...(folderId ? { folderId } : {}),
                });
                setOpen(false);
                return result;
              });
            }}
          />
        </Modal>
      )}
    </>
  );
}
