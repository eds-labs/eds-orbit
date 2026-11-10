"use client";
import { useEffect, useState, type ComponentType } from "react";
import { File, FileImage, FileVideo, Folder, LayoutGrid, List, RefreshCw } from "lucide-react";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Button, Empty, Input } from "@/components/ui/primitives";
import {
  drivePaths,
  formatDriveSize,
  isDriveFolder,
  isDriveImage,
  isDriveVideo,
  openInDriveUrl,
  type DriveFile,
  type DriveFileActionProps,
  type DriveFolder,
  type DriveListing,
  type DriveSort,
  type DriveToolbarProps,
} from "./api";
import { FolderTree } from "./folder-tree";
import { driveErrorText, driveText, driveTypeLabel } from "./labels";

// The Drive browser (design 2026-11-05 §5.1): tree on the left, the open
// folder on the right as a table or a grid. "browse" shows the platform's
// and the modules' file actions; "pick" offers a choice per file instead,
// for the Social composer and library.

// Remembered per mode: browsing defaults to the table, choosing images to
// the grid of previews.
type View = "table" | "grid";
const viewKey = (mode: "browse" | "pick") => `orbit.drive.view.${mode}`;
const defaultView = (mode: "browse" | "pick"): View => (mode === "pick" ? "grid" : "table");

function readView(mode: "browse" | "pick"): View {
  try {
    const stored = globalThis.localStorage?.getItem(viewKey(mode));
    return stored === "grid" || stored === "table" ? stored : defaultView(mode);
  } catch {
    return defaultView(mode);
  }
}
function writeView(mode: "browse" | "pick", view: View) {
  try {
    globalThis.localStorage?.setItem(viewKey(mode), view);
  } catch {
    // A blocked storage only loses the remembered view.
  }
}

const dateFormats = {
  en: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }),
  de: new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }),
};
const formatDate = (value: string | undefined, locale: "en" | "de") =>
  value ? dateFormats[locale].format(new Date(value)) : "";
// Below this width the tree is a disclosure above the list (globals.css).
const NARROW = "(max-width: 760px)";

function FileIcon({ file }: { file: DriveFile }) {
  if (isDriveFolder(file)) return <Folder aria-hidden="true" />;
  if (isDriveImage(file)) return <FileImage aria-hidden="true" />;
  if (isDriveVideo(file)) return <FileVideo aria-hidden="true" />;
  return <File aria-hidden="true" />;
}

export function DriveBrowser({
  projectId,
  folderId,
  onFolderChange,
  mode,
  onPick,
  pickDisabled,
  pickPending,
  fileActions = [],
  toolbar = [],
  root: rootHint,
  settingsHref,
  locale,
}: {
  projectId: string;
  /** The open folder; null is the project folder. */
  folderId: string | null;
  onFolderChange: (folderId: string | null) => void;
  mode: "browse" | "pick";
  onPick?: (file: DriveFile) => void;
  /** Why a file cannot be chosen; null lets it be chosen. */
  pickDisabled?: (file: DriveFile) => string | null;
  /** The file being chosen right now. */
  pickPending?: string | null;
  fileActions?: readonly ComponentType<DriveFileActionProps>[];
  toolbar?: readonly ComponentType<DriveToolbarProps>[];
  /** The project folder, so the tree shows before the first listing. */
  root?: DriveFolder;
  /** Where an owner reconnects Google Drive. */
  settingsHref?: string;
  locale: "en" | "de";
}) {
  const t = driveText(locale);
  const paths = drivePaths(projectId);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [sort, setSort] = useState<DriveSort>("name");
  const [view, setView] = useState<View>(defaultView(mode));
  // Previews that failed to load show the file's icon instead.
  const [noPreview, setNoPreview] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [more, setMore] = useState<{ key: string; files: DriveFile[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  // A search belongs to its folder: another folder (also by back and
  // forward) starts without one.
  const [searchedIn, setSearchedIn] = useState(folderId);
  if (searchedIn !== folderId) {
    setSearchedIn(folderId);
    setQuery("");
    setDraft("");
  }
  // The tree starts closed on phones and is always open on wider screens.
  const [treeOpen, setTreeOpen] = useState(true);
  useEffect(() => {
    const narrow = globalThis.matchMedia?.(NARROW);
    if (!narrow) return;
    setTreeOpen(!narrow.matches);
    const change = (event: MediaQueryListEvent) => setTreeOpen(!event.matches);
    narrow.addEventListener("change", change);
    return () => narrow.removeEventListener("change", change);
  }, []);
  useEffect(() => setView(readView(mode)), [mode]);

  const listingPath = paths.files({ folderId, query, sort });
  const listing = useResource<DriveListing>(listingPath);
  const outside = listing.error instanceof ApiError && listing.error.code === "GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT";
  // A folder outside the project folder falls back to the project folder.
  useEffect(() => {
    if (outside && folderId) {
      setNotice(t.outsideRoot);
      onFolderChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outside, folderId]);

  const data = listing.path === listingPath || listing.path === undefined ? listing.data : null;
  // The last listing keeps the tree and the breadcrumb on screen while the
  // next folder loads (a new path empties the resource first).
  const [last, setLast] = useState<DriveListing | null>(null);
  if (data && data !== last) setLast(data);
  const shown = data ?? last;
  const extra = more?.key === listingPath ? more : null;
  const files = [...(data?.files ?? []), ...(extra?.files ?? [])];
  const next = extra ? extra.next : (data?.nextPageToken ?? null);
  const root = shown?.path[0] ?? rootHint;
  const current = data?.folderId ?? folderId ?? root?.id ?? "";
  const errorCode = listing.error instanceof ApiError ? listing.error.code : listing.error ? "REQUEST_FAILED" : null;

  const open = (id: string | null) => {
    setNotice(null);
    setQuery("");
    setDraft("");
    onFolderChange(id && id !== root?.id ? id : null);
  };
  const loadMore = () =>
    api<DriveListing>(paths.files({ folderId, query, sort, pageToken: next }))
      .then((page) => {
        setMoreError(null);
        setMore({ key: listingPath, files: [...(extra?.files ?? []), ...page.files], next: page.nextPageToken });
      })
      .catch((error) => setMoreError(error instanceof ApiError ? error.code : "REQUEST_FAILED"));
  const refresh = () => {
    setMore(null);
    listing.refresh();
  };
  const reason = (file: DriveFile) =>
    pickDisabled?.(file) ?? (isDriveVideo(file) ? t.videosLater : isDriveImage(file) ? null : t.notSupported);

  function actions(file: DriveFile) {
    if (isDriveFolder(file))
      return (
        <Button size="sm" variant="outline" onClick={() => open(file.id)}>
          {t.open}
        </Button>
      );
    if (mode === "pick") {
      const blocked = reason(file);
      return blocked ? (
        <span className="field-hint">{blocked}</span>
      ) : (
        <Button size="sm" disabled={Boolean(pickPending)} onClick={() => onPick?.(file)}>
          {t.choose}
        </Button>
      );
    }
    return (
      <div className="page-actions drive-file-actions">
        {fileActions.map((Action, i) => (
          <Action key={i} projectId={projectId} file={file} folderId={current} onDone={refresh} />
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigator.clipboard?.writeText(openInDriveUrl(file.id)).then(() => setCopied(file.id), () => undefined)
          }
        >
          {copied === file.id ? t.copied : t.copyLink}
        </Button>
        <a className="button button-outline button-sm" href={openInDriveUrl(file.id)} target="_blank" rel="noreferrer">
          {t.openInDrive}
        </a>
      </div>
    );
  }

  return (
    <div className="drive-layout">
      <details
        className="drive-tree-panel"
        open={treeOpen}
        onToggle={(event) => setTreeOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>{t.folders}</summary>
        {root && (
          <FolderTree
            projectId={projectId}
            rootId={root.id}
            rootName={shown?.rootName ?? root.name}
            path={shown?.path ?? [root]}
            current={current}
            onSelect={(id) => open(id)}
            locale={locale}
          />
        )}
      </details>
      <div className="drive-main">
        {shown && (
          <nav aria-label={t.pathLabel} className="drive-breadcrumb">
            <ol>
              {shown.path.map((item, i) =>
                i === shown.path.length - 1 ? (
                  <li key={item.id} aria-current="page">{item.name}</li>
                ) : (
                  <li key={item.id}>
                    <button type="button" className="drive-crumb" onClick={() => open(item.id)}>{item.name}</button>
                  </li>
                ),
              )}
            </ol>
          </nav>
        )}
        <div className="page-actions drive-toolbar">
          <form
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(draft.trim());
            }}
          >
            <Input aria-label={t.search} placeholder={t.search} value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} />
            <Button type="submit" variant="outline" size="sm">{t.searchButton}</Button>
          </form>
          <label className="drive-sort">
            {t.sort}{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value as DriveSort)}>
              <option value="name">{t.sortName}</option>
              <option value="modified">{t.sortModified}</option>
            </select>
          </label>
          <div role="group" aria-label={t.viewLabel} className="drive-view-toggle">
            {(["table", "grid"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={view === value ? "default" : "outline"}
                aria-pressed={view === value}
                onClick={() => {
                  setView(value);
                  writeView(mode, value);
                }}
              >
                {value === "table" ? <List data-icon="inline-start" /> : <LayoutGrid data-icon="inline-start" />}
                {value === "table" ? t.viewTable : t.viewGrid}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCw data-icon="inline-start" /> {t.refresh}
          </Button>
          {mode === "browse" &&
            toolbar.map((Tool, i) => <Tool key={i} projectId={projectId} folderId={current} onDone={refresh} />)}
        </div>
        {(notice || outside) && <Alert kind="warning">{notice ?? t.outsideRoot}</Alert>}
        {errorCode === "GOOGLE_DRIVE_RECONNECT_REQUIRED" ? (
          <Alert kind="error">
            {t.reconnect}
            {settingsHref && (
              <p>
                <a href={settingsHref}>{t.toSettings}</a>
              </p>
            )}
          </Alert>
        ) : (
          errorCode &&
          !outside && (
            <Alert kind="error">
              {driveErrorText(errorCode, locale)}
              {errorCode === "GOOGLE_DRIVE_OAUTH_FAILED" && settingsHref && (
                <p>
                  <a href={settingsHref}>{t.toSettings}</a>
                </p>
              )}
            </Alert>
          )
        )}
        {files.length ? (
          view === "table" ? (
            <div className="drive-table-wrap">
              <table className="drive-table">
                <thead>
                  <tr>
                    <th scope="col">{t.name}</th>
                    <th scope="col">{t.type}</th>
                    <th scope="col">{t.size}</th>
                    <th scope="col">{t.modified}</th>
                    <th scope="col">{t.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id}>
                      <th scope="row">
                        {isDriveFolder(file) ? (
                          <button type="button" className="drive-file-name" onClick={() => open(file.id)}>
                            <FileIcon file={file} /> {file.name}
                          </button>
                        ) : (
                          <span className="drive-file-name">
                            <FileIcon file={file} /> {file.name}
                          </span>
                        )}
                      </th>
                      <td>{driveTypeLabel(file.mimeType, locale)}</td>
                      <td>{formatDriveSize(file.size)}</td>
                      <td>{formatDate(file.modifiedTime, locale)}</td>
                      <td>{actions(file)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="drive-grid">
              {files.map((file) => (
                <li className="drive-card" key={file.id}>
                  {file.thumbnailLink && !noPreview.has(file.id) ? (
                    <img
                      src={paths.thumbnail(file.id)}
                      alt={file.name}
                      loading="lazy"
                      onError={() => setNoPreview((set) => new Set(set).add(file.id))}
                    />
                  ) : (
                    <span className="asset-placeholder"><FileIcon file={file} /></span>
                  )}
                  <strong>{file.name}</strong>
                  <p>
                    {driveTypeLabel(file.mimeType, locale)}
                    {file.size ? ` · ${formatDriveSize(file.size)}` : ""}
                  </p>
                  {actions(file)}
                </li>
              ))}
            </ul>
          )
        ) : (
          data && <Empty icon={Folder} title={t.empty} description={t.emptyHint} />
        )}
        {moreError && <Alert kind="error">{driveErrorText(moreError, locale)}</Alert>}
        {next && (
          <Button variant="outline" onClick={loadMore}>
            {t.loadMore}
          </Button>
        )}
      </div>
    </div>
  );
}
