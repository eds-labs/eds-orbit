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
  latestRevision: { id: string; number: number; createdAt: string } | null;
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
  archived: boolean;
  version: number;
};

/** GET /cms/sites */
export type SiteList = { items: CmsSite[] };
