// The project's Google Drive as the web sees it (Drive page design
// 2026-11-05 §5.1). The server owns the connection and checks every folder
// and file against the configured project folder; these are its shapes.

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  /** Google's preview link; the browser loads it only through Orbit. */
  thumbnailLink?: string;
};
export type DriveFolder = { id: string; name: string };
export type DriveListing = {
  folderId: string;
  files: DriveFile[];
  nextPageToken: string | null;
  /** From the project folder (first) to the open folder (last). */
  path: DriveFolder[];
  rootName: string | null;
};
export type DriveFolderPage = {
  parentId: string;
  folders: DriveFolder[];
  nextPageToken: string | null;
};
export type DriveStatus = {
  configured: boolean;
  connected: boolean;
  reconnectRequired: boolean;
  lastRefreshFailedAt: string | null;
  lastRefreshErrorCode: string | null;
  account: string | null;
  rootFolderId: string | null;
  /** Absent from an API before 2026-11-05. */
  rootName?: string | null;
  brandLogoFolderId: string | null;
  brandImagesFolderId: string | null;
  enabled: boolean;
  scope: string;
};
export type DriveSort = "name" | "modified";

/** What a module's action on one Drive file receives (WebModule.drive). */
export type DriveFileActionProps = {
  projectId: string;
  file: DriveFile;
  folderId: string;
  onDone: () => void;
};
/** What a module's button in the Drive toolbar receives. */
export type DriveToolbarProps = {
  projectId: string;
  folderId: string;
  onDone: () => void;
};

export function drivePaths(projectId: string) {
  const base = `/projects/${encodeURIComponent(projectId)}/google-drive`;
  return {
    status: base,
    files: (params: {
      folderId?: string | null;
      query?: string;
      sort?: DriveSort;
      pageToken?: string | null;
    }) => {
      const search = new URLSearchParams();
      if (params.folderId) search.set("folderId", params.folderId);
      if (params.query) search.set("query", params.query);
      if (params.sort && params.sort !== "name") search.set("sort", params.sort);
      if (params.pageToken) search.set("pageToken", params.pageToken);
      const text = search.toString();
      return `${base}/files${text ? `?${text}` : ""}`;
    },
    folders: (parentId?: string | null, pageToken?: string | null) => {
      const search = new URLSearchParams();
      if (parentId) search.set("parentId", parentId);
      if (pageToken) search.set("pageToken", pageToken);
      const text = search.toString();
      return `${base}/folders${text ? `?${text}` : ""}`;
    },
    /** A small preview through Orbit (Google's thumbnail, about 400 px); for <img src>, with the /api prefix. */
    thumbnail: (fileId: string) =>
      `/api${base}/files/${encodeURIComponent(fileId)}/thumbnail`,
  };
}

export const openInDriveUrl = (fileId: string) =>
  `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

export const isDriveFolder = (f: Pick<DriveFile, "mimeType">) =>
  f.mimeType === DRIVE_FOLDER_MIME;
export const isDriveImage = (f: Pick<DriveFile, "mimeType">) =>
  f.mimeType.startsWith("image/");
export const isDriveVideo = (f: Pick<DriveFile, "mimeType">) =>
  f.mimeType.startsWith("video/");

/** A `?folder=` value when it is a Drive id, else null. */
export function driveFolderParam(value: string | null | undefined) {
  return value && DRIVE_ID.test(value) ? value : null;
}

export function formatDriveSize(size: string | undefined) {
  const bytes = Number(size);
  if (!size || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
