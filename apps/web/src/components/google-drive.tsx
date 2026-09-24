"use client";
import { useState } from "react";
import { api, post, useMutation, useResource } from "@/lib/api";
import { useWorkspace } from "./workspace-context";
import { Alert, Button, Empty, Modal } from "./ui/primitives";
import { DataForm, str } from "./form";
import { FolderOpen, RefreshCw } from "lucide-react";

type Status = {
  configured: boolean;
  connected: boolean;
  account: string | null;
  rootFolderId: string | null;
  brandLogoFolderId: string | null;
  brandImagesFolderId: string | null;
  enabled: boolean;
  scope: string;
};
type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
};
const folderMime = "application/vnd.google-apps.folder";
export function GoogleDriveSettings() {
  const { project, isOwner, refresh } = useWorkspace();
  const base = `/projects/${encodeURIComponent(project.id)}/google-drive`;
  const status = useResource<Status>(base);
  const [root, setRoot] = useState("");
  const [candidatePage, setCandidatePage] = useState<string | null>(null);
  const [showFolderChooser, setShowFolderChooser] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderStack, setFolderStack] = useState<string[]>([]);
  const [pageToken, setPageToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [importTypes, setImportTypes] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const files = useResource<{
    files: DriveFile[];
    folderId: string;
    nextPageToken: string | null;
  }>(
    status.data?.enabled
      ? `${base}/files?${new URLSearchParams({ ...(folder ? { folderId: folder } : {}), ...(query ? { query } : {}), ...(pageToken ? { pageToken } : {}) })}`
      : null,
  );
  const candidates = useResource<{
    folders: { id: string; name: string }[];
    nextPageToken: string | null;
  }>(
    status.data?.connected &&
      (!status.data.enabled || showFolderChooser) &&
      isOwner
      ? `${base}/root-candidates${candidatePage ? `?pageToken=${encodeURIComponent(candidatePage)}` : ""}`
      : null,
  );
  const mutation = useMutation(() => {
    status.refresh();
    candidates.refresh();
    files.refresh();
    refresh();
  });
  const enabled = status.data?.enabled;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Integrations · Google Drive</h2>
          <p>Private project assets and generated media.</p>
        </div>
        <span>
          {status.data?.connected
            ? `Connected · ${status.data.account}`
            : "Disconnected"}
        </span>
      </div>
      {status.error && <Alert kind="error">{status.error.message}</Alert>}
      {!status.data?.configured && (
        <Alert>
          Set the Google OAuth client ID and secret on the server to connect
          Drive.
        </Alert>
      )}
      {status.data?.configured && isOwner && (
        <div className="page-actions">
          <Button
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(async () => {
                const result = await post<{ url: string }>(
                  `${base}/connect`,
                  {},
                );
                window.location.assign(result.url);
              })
            }
          >
            {status.data.connected ? "Reconnect" : "Connect Google Drive"}
          </Button>
          {status.data.connected && (
            <Button
              variant="outline"
              disabled={mutation.pending}
              onClick={() => mutation.run(() => post(`${base}/disconnect`, {}))}
            >
              Disconnect
            </Button>
          )}
          {status.data.connected && (
            <Button
              variant="outline"
              onClick={() =>
                mutation.run(async () => {
                  const result = await api<{
                    healthy: boolean;
                    rootAccessible: boolean;
                  }>(`${base}/health`);
                  setHealth(
                    result.rootAccessible
                      ? "Connection healthy · root accessible"
                      : "Connection healthy · choose a root",
                  );
                })
              }
            >
              Test connection
            </Button>
          )}
        </div>
      )}
      {health && <Alert>{health}</Alert>}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {status.data?.connected && enabled && isOwner && (
        <Button
          variant="outline"
          onClick={() => setShowFolderChooser(!showFolderChooser)}
        >
          {showFolderChooser
            ? "Close folder selection"
            : "Change project folder"}
        </Button>
      )}
      {status.data?.connected && (!enabled || showFolderChooser) && isOwner && (
        <div>
          <p>
            Select the project folder in Google Drive. Orbit will find the brand
            folders inside it.
          </p>
          {candidates.error && (
            <Alert kind="error">{candidates.error.message}</Alert>
          )}
          <div className="page-actions">
            {candidates.data?.folders.map((candidate) => (
              <Button
                key={candidate.id}
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    api(`${base}/root`, {
                      method: "PUT",
                      body: JSON.stringify({ rootFolderId: candidate.id }),
                    }),
                  )
                }
              >
                <FolderOpen data-icon="inline-start" /> {candidate.name} (
                {candidate.id})
              </Button>
            ))}
            {candidates.data?.nextPageToken && (
              <Button
                variant="outline"
                onClick={() => setCandidatePage(candidates.data!.nextPageToken)}
              >
                More folders
              </Button>
            )}
          </div>
          <details>
            <summary>Enter a folder ID instead</summary>
            <div className="page-actions">
              <input
                aria-label="Drive root folder ID"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
              <Button
                disabled={!root || mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    api(`${base}/root`, {
                      method: "PUT",
                      body: JSON.stringify({ rootFolderId: root }),
                    }),
                  )
                }
              >
                Use folder
              </Button>
            </div>
          </details>
        </div>
      )}
      {enabled ? (
        <>
          <div className="page-actions">
            <Button
              variant="outline"
              onClick={() => {
                setFolder(null);
                setFolderStack([]);
                setPageToken(null);
                setQuery("");
              }}
            >
              Root
            </Button>
            {folderStack.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setFolder(folderStack.at(-1) || null);
                  setFolderStack(folderStack.slice(0, -1));
                  setPageToken(null);
                }}
              >
                Back
              </Button>
            )}
            {isOwner && (
              <Button variant="outline" onClick={() => setUploadOpen(true)}>
                Upload to Drive
              </Button>
            )}
            <Button variant="outline" onClick={files.refresh}>
              <RefreshCw data-icon="inline-start" /> Sync from Drive
            </Button>
            <Button
              variant="outline"
              onClick={() => setView(view === "grid" ? "list" : "grid")}
            >
              {view === "grid" ? "List view" : "Grid view"}
            </Button>
            <input
              aria-label="Search files in folder"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPageToken(null);
              }}
              placeholder="Search files"
            />
          </div>
          {files.error && <Alert kind="error">{files.error.message}</Alert>}
          {files.data?.files.length ? (
            <div className={view === "grid" ? "asset-library" : "data-list"}>
              {files.data.files.map((file) => (
                <article className="asset-card" key={file.id}>
                  {file.mimeType.startsWith("image/") ? (
                    <img
                      src={`/api${base}/files/${encodeURIComponent(file.id)}/content`}
                      alt={file.name}
                    />
                  ) : (
                    <FolderOpen aria-hidden="true" />
                  )}
                  <strong>{file.name}</strong>
                  <p>
                    {file.mimeType} ·{" "}
                    {file.size ? `${file.size} bytes` : "folder"}
                  </p>
                  <div className="page-actions">
                    {file.mimeType === folderMime ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setFolderStack([...folderStack, folder ?? ""]);
                          setFolder(file.id);
                          setPageToken(null);
                          setQuery("");
                        }}
                      >
                        Open folder
                      </Button>
                    ) : (
                      <>
                        {isOwner && (
                          <select
                            aria-label={`Asset type for ${file.name}`}
                            value={
                              importTypes[file.id] ??
                              (file.mimeType.startsWith("image/")
                                ? "photo"
                                : "document")
                            }
                            onChange={(e) =>
                              setImportTypes({
                                ...importTypes,
                                [file.id]: e.target.value,
                              })
                            }
                          >
                            {(file.mimeType.startsWith("image/")
                              ? [
                                  "photo",
                                  "logo",
                                  "background",
                                  "banner",
                                  "icon",
                                ]
                              : ["document", "other"]
                            ).map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </select>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!isOwner || mutation.pending}
                          onClick={() =>
                            mutation.run(() =>
                              post(
                                `${base}/files/${encodeURIComponent(file.id)}/import`,
                                {
                                  type:
                                    importTypes[file.id] ??
                                    (file.mimeType.startsWith("image/")
                                      ? "photo"
                                      : "document"),
                                },
                              ),
                            )
                          }
                        >
                          Add to library
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            mutation.run(() =>
                              navigator.clipboard.writeText(
                                `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
                              ),
                            )
                          }
                        >
                          Copy Drive link
                        </Button>
                        <a
                          href={`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Drive
                        </a>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon={FolderOpen}
              title="No Drive files in this folder"
              description="Choose a folder or search its contents."
            />
          )}
          {files.data?.nextPageToken && (
            <Button
              variant="outline"
              onClick={() => setPageToken(files.data?.nextPageToken ?? null)}
            >
              Next page
            </Button>
          )}
          {pageToken && (
            <Button variant="outline" onClick={() => setPageToken(null)}>
              First page
            </Button>
          )}
        </>
      ) : null}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {uploadOpen && (
        <Modal
          title="Upload private Drive asset"
          description="PNG, JPEG or WebP. The server validates the image and removes metadata before uploading."
          onClose={() => setUploadOpen(false)}
        >
          <DataForm
            fields={[
              { name: "name", label: "Asset name", required: true },
              {
                name: "type",
                label: "Asset type",
                type: "select",
                value: "photo",
                options: ["logo", "photo", "background", "banner", "icon"].map(
                  (value) => ({ value, label: value }),
                ),
              },
              {
                name: "file",
                label: "Image file",
                type: "file",
                accept: "image/png,image/jpeg,image/webp",
                required: true,
              },
              { name: "source", label: "Source / creator", required: true },
              {
                name: "license",
                label: "License / rights basis",
                required: true,
              },
              {
                name: "validUses",
                label: "Valid uses (comma separated)",
                value: "brand, social",
                required: true,
              },
              {
                name: "confirmRightsInformation",
                label:
                  "I confirm the source and rights information is accurate",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Upload as reference"
            onCancel={() => setUploadOpen(false)}
            onSubmit={async (values) => {
              await mutation.run(async () => {
                const file = values.file;
                if (
                  !(file instanceof File) ||
                  !file.size ||
                  file.size > 1_000_000
                )
                  throw new Error("ASSET_UPLOAD_TOO_LARGE");
                const binary = new Uint8Array(await file.arrayBuffer());
                let encoded = "";
                for (let offset = 0; offset < binary.length; offset += 0x8000)
                  encoded += String.fromCharCode(
                    ...binary.subarray(offset, offset + 0x8000),
                  );
                const result = await post(`${base}/upload`, {
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
                  ...(folder ? { folderId: folder } : {}),
                });
                setUploadOpen(false);
                return result;
              });
            }}
          />
        </Modal>
      )}
    </section>
  );
}
