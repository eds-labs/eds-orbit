import { formatDriveSize } from "@/platform/drive/api";

// Wording and readable facts of the brand asset library (WP4): [English,
// German] per key, as in creative-copy.ts. Raw ids, hashes and provider
// names stay in the tile's technical details.
type Pair = readonly [string, string];

export const ASSET_TEXT = {
  heading: ["Brand kit & asset library", "Markenkit & Medienbibliothek"],
  intro: [
    "Project-scoped originals, rights, approved variants and generated artwork.",
    "Originale, Rechte, freigegebene Varianten und erzeugte Bilder dieses Projekts.",
  ],
  upload: ["Upload asset", "Asset hochladen"],
  generate: ["Generate with OpenAI", "Mit OpenAI erzeugen"],
  generateNotReady: [
    "Configure an OpenAI image model and cost ceiling first",
    "Richte zuerst ein OpenAI-Bildmodell und eine Kostenobergrenze ein",
  ],
  imageDisabled: [
    "OpenAI image generation remains disabled until an owner stores a key, verifies a GPT Image 2.5 model and sets a current maximum cost per image.",
    "Die Bilderzeugung mit OpenAI bleibt aus, bis ein Owner einen Schlüssel hinterlegt, ein GPT-Image-2.5-Modell prüft und aktuelle Höchstkosten pro Bild festlegt.",
  ],
  search: ["Search assets", "Assets durchsuchen"],
  category: ["Category", "Kategorie"],
  status: ["Status", "Status"],
  source: ["Source", "Quelle"],
  showOutdated: ["Show outdated", "Veraltete anzeigen"],
  listView: ["List view", "Listenansicht"],
  gridView: ["Grid view", "Kachelansicht"],
  count: ["Assets", "Assets"],
  empty: ["No assets yet", "Noch keine Assets"],
  emptyHint: [
    "Upload an image or generate one to start the library.",
    "Lade ein Bild hoch oder erzeuge eines, um die Bibliothek zu füllen.",
  ],
  noMatch: [
    "No asset matches these filters",
    "Kein Asset passt zu diesen Filtern",
  ],
  noMatchHint: [
    "Change the search or the filters. Outdated assets are hidden unless you show them.",
    "Ändere die Suche oder die Filter. Veraltete Assets bleiben ausgeblendet, bis du sie anzeigst.",
  ],
  download: ["Download", "Herunterladen"],
  approve: ["Approve rights & use", "Freigeben"],
  approveHint: [
    "Confirms the rights and allows the asset in marketing material",
    "Bestätigt die Rechte und erlaubt das Asset in Marketing-Material",
  ],
  outdated: ["Mark outdated", "Als veraltet markieren"],
  retryDrive: ["Retry Drive upload", "Drive-Upload wiederholen"],
  driveFailed: ["Drive upload failed", "Drive-Upload fehlgeschlagen"],
  drivePending: ["Saving to Drive", "Wird in Drive gespeichert"],
  forAssignment: ["Made for an assignment", "Für einen Auftrag erzeugt"],
  bannerBackground: [
    "Banner background of an assignment",
    "Banner-Hintergrund eines Auftrags",
  ],
  technical: ["Technical details", "Technische Details"],
  assetId: ["Asset ID", "Asset-ID"],
  rawType: ["Type", "Typ"],
  filename: ["File name", "Dateiname"],
  driveFileId: ["Drive file ID", "Drive-Datei-ID"],
  driveFolderId: ["Drive folder ID", "Drive-Ordner-ID"],
  sha256: ["SHA-256", "SHA-256"],
  model: ["Model", "Modell"],
  profileVersion: ["Profile version", "Profilversion"],
  assignmentId: ["Assignment ID", "Auftrags-ID"],
  license: ["Rights", "Rechte"],
  createdAt: ["Created", "Erstellt"],
  prompt: ["Prompt", "Prompt"],
  unnamed: ["Asset", "Asset"],
  previewAlt: ["Preview of", "Vorschau von"],
} as const satisfies Record<string, Pair>;

export const CATEGORY_LABELS = {
  all: ["All categories", "Alle Kategorien"],
  logos: ["Logos", "Logos"],
  images: ["Images", "Bilder"],
  generated: ["Generated", "Erzeugt"],
  documents: ["Documents", "Dokumente"],
} as const satisfies Record<string, Pair>;
export type AssetCategory = keyof typeof CATEGORY_LABELS;

export const STATUS_LABELS: Record<string, Pair> = {
  approved: ["Approved", "Freigegeben"],
  reference: ["Reference", "Referenz"],
  outdated: ["Outdated", "Veraltet"],
};
export const STATUS_FILTERS = {
  all: ["All statuses", "Alle Status"],
  approved: STATUS_LABELS.approved!,
  reference: STATUS_LABELS.reference!,
  outdated: STATUS_LABELS.outdated!,
} as const satisfies Record<string, Pair>;
export type AssetStatusFilter = keyof typeof STATUS_FILTERS;

export const SOURCE_LABELS = {
  all: ["All sources", "Alle Quellen"],
  ai: ["AI-generated (OpenAI)", "KI-generiert (OpenAI)"],
  template: ["Composed by Orbit", "Von Orbit gestaltet"],
  upload: ["Upload", "Upload"],
  drive: ["Google Drive", "Google Drive"],
  original: ["EDS Labs original", "EDS-Labs-Original"],
  other: ["Other source", "Andere Quelle"],
} as const satisfies Record<string, Pair>;
export type AssetSource = Exclude<keyof typeof SOURCE_LABELS, "all">;
export type AssetSourceFilter = keyof typeof SOURCE_LABELS;

/** The pair's text in the locale. */
export const say = (pair: Pair, de: boolean) => pair[de ? 1 : 0];

type AssetData = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Where the asset came from, read from what its writers record. */
export function assetSource(d: AssetData): AssetSource {
  if (d.type === "original_logo") return "original";
  if (
    d.provider === "openai" ||
    d.source === "OpenAI Images API" ||
    d.sourceType === "AI_GENERATED"
  )
    return "ai";
  if (d.sourceType === "TEMPLATE_GENERATED" || d.source === "template")
    return "template";
  if (d.sourceType === "DRIVE_EXISTING" || d.source === "Google Drive")
    return "drive";
  if (d.sourceType === "USER_UPLOAD" || typeof d.uploadedBy === "string")
    return "upload";
  return "other";
}

/**
 * The readable source: the kind, and for an upload the credit its uploader
 * recorded ("Source / creator").
 */
export function sourceLabel(d: AssetData, de: boolean) {
  const kind = assetSource(d);
  const credit = text(d.source).trim();
  if ((kind === "upload" || kind === "other") && credit)
    return kind === "upload"
      ? `${say(SOURCE_LABELS.upload, de)} · ${credit}`
      : credit;
  return say(SOURCE_LABELS[kind], de);
}

/** The status in the locale; an unknown one reads as itself. */
export function statusLabel(status: unknown, de: boolean) {
  const raw = text(status) || "unknown";
  const pair = STATUS_LABELS[raw];
  return pair ? say(pair, de) : raw.replaceAll("_", " ");
}

const FORMATS: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/svg+xml": "SVG",
  "application/pdf": "PDF",
};

/** "PNG · 1536×1024 · 3,1 MB": format, dimensions when known, size. */
export function assetFacts(d: AssetData, de: boolean) {
  const mime = text(d.mime);
  const format = FORMATS[mime] ?? (mime.split("/")[1] ?? "").toUpperCase();
  const width = Number(d.width);
  const height = Number(d.height);
  const dimensions =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? `${width}×${height}`
      : "";
  const bytes = Number(d.bytes);
  const size = bytes > 0 ? formatDriveSize(String(bytes)) : "";
  return [format, dimensions, de ? size.replace(".", ",") : size]
    .filter(Boolean)
    .join(" · ");
}

/** Whether the asset belongs to the chosen category. */
export function inCategory(d: AssetData, category: AssetCategory) {
  const image = text(d.mime).startsWith("image/");
  switch (category) {
    case "all":
      return true;
    case "logos":
      return ["logo", "original_logo"].includes(text(d.type));
    case "images":
      return image;
    case "generated":
      return d.type === "generated_artwork";
    case "documents":
      return !image && d.type !== "original_logo";
  }
}

/**
 * Whether the asset passes the status filter. Outdated assets are hidden
 * unless they are asked for, by the filter or the "show outdated" toggle.
 */
export function inStatus(
  d: AssetData,
  filter: AssetStatusFilter,
  showOutdated: boolean,
) {
  const status = text(d.assetStatus);
  if (filter !== "all") return status === filter;
  return showOutdated || status !== "outdated";
}
