// The content module's client side (ADR 0029): types of the /cms API.

export type CmsSettings = {
  publishApprovers: "owner" | "owner_or_editor";
  fourEyes: boolean;
  timeZone: string | null;
  lateWindowHours: number;
};

/** GET /projects/:projectId/cms/status */
export type CmsStatus = {
  module: "cms";
  version: string;
  settings: CmsSettings;
  settingsVersion: number;
};

export const cmsPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/cms${rest}`;

export type EntryStatus =
  "draft" | "in_review" | "scheduled" | "published" | "archived";

export type PendingRequest = {
  id: string;
  actionType: "cms.entry.publish" | "cms.entry.unpublish";
  requesterId: string;
  revisionId: string | null;
  expiresAt: string;
  createdAt: string;
};

export type CmsEntry = {
  id: string;
  type: string;
  locale: string;
  translationGroupId: string;
  slug: string;
  status: EntryStatus;
  publishedRevisionId: string | null;
  scheduledRevisionId: string | null;
  scheduledAt: string | null;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  archivedAt: string | null;
  origin: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** GET /cms/entries */
export type EntryList = {
  items: Array<
    CmsEntry & {
      pendingRequest: PendingRequest | null;
      title: string;
      excerpt: string;
    }
  >;
  nextCursor: string | null;
};

/** GET /cms/entries/:id */
export type EntryDetail = {
  entry: CmsEntry;
  draft: {
    title: string;
    excerpt: string;
    /** orbit-doc-v1 (packages/content-doc). */
    body?: unknown;
    fields?: Record<string, unknown>;
    seo?: Record<string, unknown>;
    authorIds?: string[];
    termIds?: string[];
    version: number;
    updatedAt: string;
    heroAssetId: string | null;
  };
  siteIds: string[];
  translations: Array<{
    id: string;
    locale: string;
    slug: string;
    status: EntryStatus;
    updatedAt: string;
  }>;
  latestRevision: {
    id: string;
    number: number;
    contentHash?: string;
    createdAt: string;
  } | null;
  publishedRevision: { id: string; number: number; slug: string } | null;
  pendingRequest: PendingRequest | null;
  unsavedChanges: boolean;
};

export type PreflightIssue = {
  code: string;
  siteId?: string;
  siteIds?: string[];
  assetIds?: string[];
  slug?: string;
};

/** GET /cms/entries/:id/preflight */
export type Preflight = { ok: boolean; issues: PreflightIssue[] };

export type CmsSite = {
  id: string;
  name: string;
  baseUrl: string;
  locales: string[];
  defaultLocale: string;
  verification: "configured" | "read_verified" | "live_verified";
  /** Path patterns per type and locale, e.g. { article: { de: "/blog/{slug}/" } }. */
  routes?: Record<string, Record<string, string>>;
  trailingSlash?: boolean;
  archived: boolean;
  version: number;
};

/** GET /cms/sites */
export type SiteList = { items: CmsSite[] };

/** GET /cms/summary */
export type CmsSummary = {
  entries: {
    draft: number;
    scheduled: number;
    published: number;
    archived: number;
  };
  waiting: number;
  sites: number;
  recent: Array<{
    id: string;
    status: EntryStatus;
    locale: string;
    title: string;
    updatedAt: string;
  }>;
};

/** POST publication-requests, unpublish-requests (an entry detail plus the outcome). */
export type PublishResult = EntryDetail & {
  mode: "direct" | "requested";
  requestId: string | null;
};

/** POST /cms/entries/:id/preview */
export type PreviewResult = {
  token: string;
  expiresAt: string;
  path: string;
  previewUrl: string | null;
};

export type CmsAsset = {
  id: string;
  name: string | null;
  mime: string;
  width: number;
  height: number;
  bytes?: number;
  alt: Record<string, string>;
  caption: Record<string, string>;
  credit?: string | null;
  license?: string | null;
  createdAt?: string;
  renditions: Array<{
    name: string;
    mime: string;
    width: number;
    height: number;
  }>;
  aiLabel: { origin: string; labelState: string } | null;
  archived: boolean;
  version: number;
};

/** GET /cms/assets */
export type AssetList = { items: CmsAsset[]; nextCursor: string | null };

export type CmsTerm = {
  id: string;
  kind: "category" | "tag";
  locale: string;
  translationGroupId?: string;
  slug: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  archived: boolean;
  version?: number;
};

export type CmsAuthor = {
  id: string;
  name: string;
  slug: string;
  bio?: Record<string, string>;
  avatarAssetId?: string | null;
  sameAs?: string[];
  archived: boolean;
  version?: number;
};

/** POST /cms/assets (raw bytes) and /cms/assets/import */
export type AssetUpload = { asset: CmsAsset; duplicate: boolean };

/** The languages a project writes in: its sites', else its content languages. */
export function projectLocales(
  sites: Array<Pick<CmsSite, "locales" | "archived">>,
  fallback: string[],
) {
  const fromSites = [
    ...new Set(sites.filter((s) => !s.archived).flatMap((s) => s.locales)),
  ];
  return (fromSites.length ? fromSites : fallback).sort();
}

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** The editor's preview image of an asset: the smallest rendition of at least 480 px. */
export function previewFile(asset: Pick<CmsAsset, "renditions">) {
  const order = ["w480", "w960", "w1600", "original"];
  const found = order
    .map((name) => asset.renditions.find((r) => r.name === name))
    .find(Boolean);
  return found ? `${found.name}.${EXTENSIONS[found.mime] ?? "webp"}` : null;
}

/** The editor's preview URL of an asset (private member route, not cached). */
export function assetSrc(
  projectId: string,
  asset: Pick<CmsAsset, "id" | "renditions">,
) {
  const file = previewFile(asset);
  return file
    ? `/api${cmsPath(projectId, `/assets/${asset.id}/files/${file}`)}`
    : null;
}

export type RevisionSummary = {
  id: string;
  number: number;
  slug: string;
  title: string;
  contentHash: string;
  wordCount: number;
  changeNote: string | null;
  basedOnRevisionId: string | null;
  live: boolean;
  scheduled: boolean;
  createdBy: string;
  createdAt: string;
};

/** GET /cms/entries/:id/revisions */
export type RevisionList = {
  items: RevisionSummary[];
  nextBefore: number | null;
};

export type BodyOp =
  | { op: "equal"; count: number }
  | { op: "added" | "removed"; type: string; text: string };

/** GET /cms/entries/:id/revisions/diff?from=&to= */
export type RevisionDiff = {
  from: { id: string; number: number };
  to: "draft" | { id: string; number: number };
  fields: Array<{ name: string; from: unknown; to: unknown }>;
  body: BodyOp[];
  changed: boolean;
};

export type PublicationStatus =
  | "queued"
  | "claimed"
  | "visible"
  | "notified"
  | "live_verified"
  | "needs_attention"
  | "cancelled"
  | "failed";

export type CmsPublication = {
  id: string;
  revisionId: string;
  siteId: string;
  action: "publish" | "update" | "unpublish";
  status: PublicationStatus;
  approvalRequestId: string | null;
  scheduledAt: string;
  visibleAt: string | null;
  notifiedAt: string | null;
  liveVerifiedAt: string | null;
  errorCode: string | null;
  attempts: number;
  createdAt: string;
};

/** GET /cms/entries/:id/publications */
export type PublicationList = {
  items: CmsPublication[];
  nextBefore: string | null;
};
