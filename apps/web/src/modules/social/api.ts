// The social module's client side (ADR 0020): types of the /social API.
import { ApiError } from "@/lib/api";

export type SocialApproval = "owner_each" | "editor_each";

/** GET /projects/:projectId/social/status */
export type SocialStatus = {
  module: "social";
  version: string;
  settings: { approval: SocialApproval; mcpOwnerPublishWithoutApproval: boolean; xMetrics: boolean };
  settingsVersion: number;
};

export const socialPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/social${rest}`;

export type SocialPlatform = "x" | "facebook" | "instagram" | "telegram";
export type SocialAccountStatus = "active" | "reconnect_required" | "disabled";

/** GET /projects/:projectId/social/accounts (never a token). */
export type SocialAccount = {
  id: string;
  platform: SocialPlatform;
  handle: string;
  displayName: string;
  status: SocialAccountStatus;
  capability: "configured" | "read_verified" | "write_verified";
  connectedAt: string;
  lastCheckedAt: string | null;
  lastCheckCode: string | null;
  /** What posts may do on the account (S4); long posts only on X. */
  settings: { xLongPosts: boolean };
  version: number;
};
export type SocialAccounts = { items: SocialAccount[] };

/** GET /projects/:projectId/social/media (S3). */
export type SocialMedia = {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  jpegWidth: number;
  jpegHeight: number;
  jpegSize: number;
  altText: string | null;
  version: number;
  createdAt: string;
};
export type SocialMediaList = { items: SocialMedia[] };

/** A platform's verdict on one variant (S4); errors block scheduling. */
export type ValidationIssue = { code: string; severity: "error" | "warning"; path?: string };
export type MediaRef = { mediaId: string; width: number; height: number; altText: string | null };
export type ApprovalState = "none" | "pending" | "approved" | "rejected" | "expired" | "canceled";
export type PostStatus =
  | "draft"
  | "needs_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed"
  | "canceled"
  | "archived";
export type PostSchedule = {
  mode: "none" | "at" | "now";
  at: string | null;
  local: string | null;
  timeZone: string;
  fold: "earlier" | "later" | null;
};

/** GET /projects/:projectId/social/posts/:postId (S4). */
export type PostView = {
  id: string;
  status: PostStatus;
  title: string | null;
  baseText: string;
  baseMedia: MediaRef[];
  schedule: PostSchedule;
  approval: { state: ApprovalState; requestId: string | null; approvedAt: string | null; approvedBy: string | null };
  packageHash: string | null;
  origin: string;
  readOnly: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  variants: Array<{
    id: string;
    accountId: string;
    platform: SocialPlatform;
    handle: string;
    body: string;
    inheritsText: boolean;
    inheritsMedia: boolean;
    media: MediaRef[];
    options: Record<string, unknown>;
    issues: ValidationIssue[];
    version: number;
  }>;
  /** The deliveries of an approved post (S5), one per account. */
  publications?: PublicationView[];
};

/** One delivery of a post to one account (S5). */
export type PublicationView = {
  id: string;
  accountId: string;
  platform: SocialPlatform;
  status: string;
  blockedCode: string | null;
  lastErrorCode: string | null;
  externalPostId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  resolution: string | null;
  test: boolean;
  version: number;
};

/** GET /projects/:projectId/social/posts (S4). */
export type PostListItem = {
  id: string;
  status: PostStatus;
  title: string | null;
  excerpt: string;
  schedule: PostSchedule;
  approvalState: ApprovalState;
  origin: string;
  readOnly: boolean;
  accounts: Array<{ accountId: string; platform: SocialPlatform; handle: string }>;
  publications: { total: number; published: number; failed: number; unknown: number; test: boolean };
  version: number;
  updatedAt: string;
};
export type PostList = { items: PostListItem[]; nextCursor: string | null };

/** GET /projects/:projectId/social/calendar (S6): a post timed in the range. */
export type CalendarItem = {
  id: string;
  projectId: string;
  /** Only in the organization calendar. */
  projectName?: string;
  title: string | null;
  excerpt: string;
  status: PostStatus;
  origin: string;
  readOnly: boolean;
  schedule: PostSchedule;
  approvalState: ApprovalState;
  version: number;
  accounts: Array<{ accountId: string; platform: SocialPlatform; handle: string }>;
  publications: { total: number; published: number; failed: number; unknown: number; test: boolean };
};
export type CalendarResponse = {
  items: CalendarItem[];
  truncated: boolean;
  /** Only in the organization calendar: the projects it read. */
  projects?: Array<{ id: string; name: string }>;
};

/** POST /posts and PATCH /posts/:postId (with `version`): null = inherit the base. */
export type PostInput = {
  title: string | null;
  baseText: string;
  baseMedia: string[];
  variants: Array<{ accountId: string; text: string | null; media: string[] | null; options: Record<string, unknown> }>;
};

/** An API error that keeps the server's `error.detail` (issues, suggested times). */
export class SocialApiError extends ApiError {
  constructor(
    code: string,
    status: number,
    readonly detail: Record<string, unknown> | null,
  ) {
    super(code, status);
  }
}

/** POST or PATCH a social route; a failure keeps the error detail. */
export async function socialSend<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new SocialApiError(value?.error?.code ?? "REQUEST_FAILED", response.status, value?.error?.detail ?? null);
  return value as T;
}

/** GET …/social/posts/:postId/metrics (S8): the latest figures per publication. */
export type PostMetricsPublication = {
  publicationId: string;
  accountId: string;
  platform: SocialPlatform;
  available: boolean;
  reason?: "not_available" | "paid_reads_off" | null;
  observedAt: string | null;
  metrics: Record<string, number>;
};
export type PostMetrics = { postId: string; publications: PostMetricsPublication[] };

/** GET …/social/analytics?days (S8). */
export type AnalyticsItem = PostMetrics & { title: string | null; excerpt: string; publishedAt: string };
export type AnalyticsResponse = { items: AnalyticsItem[] };
