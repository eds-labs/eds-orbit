import { DRIVE_FOLDER_MIME } from "./api";

// Texts of the Drive page and browser (en, de).

const en = {
  title: "Google Drive",
  description: "Files in the project's Drive folder.",
  folders: "Folders",
  treeLabel: "Drive folders",
  moreFolders: "More folders",
  foldersFailed: "Folders could not be loaded.",
  retry: "Try again",
  pathLabel: "Folder path",
  search: "Search in this folder",
  searchButton: "Search",
  sort: "Sort by",
  sortName: "Name",
  sortModified: "Last modified",
  viewTable: "List",
  viewGrid: "Grid",
  viewLabel: "View",
  refresh: "Refresh",
  loadMore: "Load more",
  name: "Name",
  type: "Type",
  size: "Size",
  modified: "Modified",
  actions: "Actions",
  folder: "Folder",
  open: "Open",
  choose: "Choose",
  copyLink: "Copy Drive link",
  copied: "Link copied",
  openInDrive: "Open in Drive",
  empty: "No files in this folder",
  emptyHint: "Choose another folder or change the search.",
  videosLater: "Videos later",
  notSupported: "Not supported here",
  outsideRoot: "Folder not found in the project folder. Showing the project folder.",
  toRoot: "Go to the project folder",
  notReadyTitle: "Google Drive is not set up for this project",
  notReadyOwner: "Connect Google Drive and choose the project folder in the settings.",
  notReadyMember: "Ask a project owner to connect Google Drive.",
  toSettings: "Open the Drive settings",
  reconnect:
    "Google rejected the stored Drive access. Files cannot be read until an owner reconnects Google Drive.",
  types: {
    [DRIVE_FOLDER_MIME]: "Folder",
    "image/png": "PNG image",
    "image/jpeg": "JPEG image",
    "image/webp": "WebP image",
    "image/gif": "GIF image",
    "image/svg+xml": "SVG image",
    "application/pdf": "PDF",
    "application/vnd.google-apps.document": "Google Doc",
    "application/vnd.google-apps.spreadsheet": "Google Sheet",
    "application/vnd.google-apps.presentation": "Google Slides",
  } as Record<string, string>,
  video: "Video",
  image: "Image",
  file: "File",
};
type DriveText = typeof en;

const de: DriveText = {
  title: "Google Drive",
  description: "Dateien im Drive-Ordner des Projekts.",
  folders: "Ordner",
  treeLabel: "Drive-Ordner",
  moreFolders: "Weitere Ordner",
  foldersFailed: "Ordner konnten nicht geladen werden.",
  retry: "Erneut versuchen",
  pathLabel: "Ordnerpfad",
  search: "In diesem Ordner suchen",
  searchButton: "Suchen",
  sort: "Sortieren nach",
  sortName: "Name",
  sortModified: "Zuletzt geändert",
  viewTable: "Liste",
  viewGrid: "Raster",
  viewLabel: "Ansicht",
  refresh: "Aktualisieren",
  loadMore: "Mehr laden",
  name: "Name",
  type: "Typ",
  size: "Größe",
  modified: "Geändert",
  actions: "Aktionen",
  folder: "Ordner",
  open: "Öffnen",
  choose: "Auswählen",
  copyLink: "Drive-Link kopieren",
  copied: "Link kopiert",
  openInDrive: "In Drive öffnen",
  empty: "Keine Dateien in diesem Ordner",
  emptyHint: "Wähle einen anderen Ordner oder ändere die Suche.",
  videosLater: "Videos folgen später",
  notSupported: "Hier nicht unterstützt",
  outsideRoot: "Ordner nicht im Projektordner gefunden. Der Projektordner wird angezeigt.",
  toRoot: "Zum Projektordner",
  notReadyTitle: "Google Drive ist für dieses Projekt nicht eingerichtet",
  notReadyOwner: "Verbinde Google Drive und wähle den Projektordner in den Einstellungen.",
  notReadyMember: "Bitte einen Projekteigentümer, Google Drive zu verbinden.",
  toSettings: "Drive-Einstellungen öffnen",
  reconnect:
    "Google hat den gespeicherten Drive-Zugriff abgelehnt. Dateien können erst wieder gelesen werden, wenn ein Owner Google Drive erneut verbindet.",
  types: {
    [DRIVE_FOLDER_MIME]: "Ordner",
    "image/png": "PNG-Bild",
    "image/jpeg": "JPEG-Bild",
    "image/webp": "WebP-Bild",
    "image/gif": "GIF-Bild",
    "image/svg+xml": "SVG-Bild",
    "application/pdf": "PDF",
    "application/vnd.google-apps.document": "Google-Dokument",
    "application/vnd.google-apps.spreadsheet": "Google-Tabelle",
    "application/vnd.google-apps.presentation": "Google-Präsentation",
  },
  video: "Video",
  image: "Bild",
  file: "Datei",
};

export const driveText = (locale: "en" | "de"): DriveText =>
  locale === "de" ? de : en;

export function driveTypeLabel(mimeType: string, locale: "en" | "de") {
  const t = driveText(locale);
  return (
    t.types[mimeType] ??
    (mimeType.startsWith("video/")
      ? t.video
      : mimeType.startsWith("image/")
        ? t.image
        : t.file)
  );
}
