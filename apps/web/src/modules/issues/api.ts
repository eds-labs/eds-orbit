import { api } from "@/lib/api";

// The issue center's client side (ADR 0018): types of the /issues API and
// the pure helpers the views share. Texts arrive redacted from the server.

export const ISSUE_STATUSES = [
  "new",
  "triage",
  "needs_info",
  "confirmed",
  "duplicate",
  "wont_fix",
  "planned",
  "in_progress",
  "fix_ready",
  "released",
  "verified",
  "closed",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_TYPES = ["bug", "feature_request", "improvement", "technical_problem"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const SEVERITIES = ["s1_critical", "s2_major", "s3_minor", "s4_trivial"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const SOURCES = ["support", "manual", "webhook", "n8n", "sentry", "github", "monitoring"] as const;

/** The moves a person may make (server: modules/issues/status.ts). */
export const TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  new: ["triage", "needs_info", "confirmed", "wont_fix"],
  triage: ["needs_info", "confirmed", "wont_fix"],
  needs_info: ["triage", "confirmed", "wont_fix"],
  confirmed: ["triage", "planned", "in_progress", "wont_fix"],
  planned: ["confirmed", "in_progress", "wont_fix"],
  in_progress: ["planned", "fix_ready", "wont_fix"],
  fix_ready: ["in_progress", "released"],
  released: ["in_progress", "verified"],
  verified: ["in_progress", "closed"],
  wont_fix: ["triage", "closed"],
  duplicate: [],
  closed: ["triage"],
};

export type TriageSuggestion = {
  type: IssueType;
  severity: Severity;
  priority: Priority;
  components: string[];
  missingInformation: string[];
  reproductionSteps: string[];
  createTask: boolean;
  rationale: string;
  confidence: number;
};

export type Issue = {
  id: string;
  number: number;
  key: string;
  type: IssueType;
  title: string;
  summary: string | null;
  status: IssueStatus;
  severity: Severity | null;
  priority: Priority | null;
  category: string | null;
  components: string[];
  assigneeUserId: string | null;
  environment: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  reportCount: number;
  ticketCount: number;
  mergedIntoIssueId: string | null;
  acceptanceCriteria: string[];
  shareReviewed: boolean;
  aiTriage: { suggestion?: TriageSuggestion; createdAt?: string; forVersion?: number };
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};
export type IssueItem = Issue & { counts: { tasks: number; tickets: number; reports: number } };
export type IssuePage = { items: IssueItem[]; total: number; nextCursor: string | null };

export type Report = {
  id: string;
  sourceKind: (typeof SOURCES)[number];
  externalSystem: string | null;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  symptoms: string;
  severityHint: Severity | null;
  typeHint: IssueType | null;
  redaction: Record<string, number>;
  occurredAt: string;
  receivedAt: string;
  reportedByKind: string;
  erased: boolean;
  diagnostics?: Record<string, string | number | boolean>;
  environment?: string | null;
  release?: string | null;
  fingerprint?: string | null;
};
export type LinkView = {
  id: string;
  relation: string;
  direction: "outgoing" | "incoming";
  object: {
    type: string;
    id: string;
    label: { en: string; de: string } | null;
    state: "ok" | "restricted" | "missing";
    title?: string;
    status?: string;
    statusCategory?: string;
    href?: string;
  };
};
export type Delivery = {
  id: string;
  kind: "pr_opened" | "pr_merged" | "checks" | "deployed" | "verified";
  repository: string | null;
  prNumber: number | null;
  commitSha: string | null;
  environment: string | null;
  source: string;
  status: string | null;
  observedAt: string;
};
export type Candidate = {
  id: string;
  method: string;
  score: number;
  reasons: string[];
  issue: { id: string; key: string; title: string; status: IssueStatus; reportCount: number } | null;
};
export type IssueDetail = {
  issue: Issue;
  reports: Report[];
  duplicateCandidates: Candidate[];
  links: LinkView[];
  progress: { tasks: number; done: number; restricted: number };
  deliveries: Delivery[];
  externalRefs: Array<{ id: string; system: string; externalId: string; url: string | null; state: string | null }>;
  timeline: Array<{ id: string; type: string; actorKind: string; actorId: string | null; after: Record<string, unknown>; createdAt: string }>;
  permissions: { diagnostics: boolean };
};
export type Overview = {
  metrics: {
    open: number;
    critical: number;
    newLast7Days: number;
    awaitingTriage: number;
    fixReadyNotReleased: number;
    releasedLast30Days: number;
    duplicatesPending: number;
  };
  critical: Issue[];
  mostReported: Issue[];
  byStatus: Record<string, number>;
  byComponent: Array<{ component: string; open: number }>;
  bySource: Record<string, number>;
  openAge: { under_7d: number; under_30d: number; over_30d: number };
  leadTimesHours: {
    newToConfirmed: number | null;
    confirmedToFixReady: number | null;
    fixReadyToReleased: number | null;
    newToReleased: number | null;
  };
};
export type Releases = {
  productionEnvironments: string[];
  items: Array<{
    id: string;
    key: string;
    title: string;
    status: IssueStatus;
    severity: Severity | null;
    merged: boolean;
    deployments: Delivery[];
    lastRecord: Delivery | null;
  }>;
};
export type IssuesSettings = {
  components: Array<{ key: string; label: { en: string; de: string }; repository?: string; team?: string }>;
  categories: Array<{ key: string; label: { en: string; de: string } }>;
  dedupe: { autoAttachFingerprint: boolean; suggestThreshold: number; vectorEnabled: false; aiJudgeEnabled: false; aiDailyCeilingMicros: number };
  triage: { aiEnabled: boolean; aiDailyCeilingMicros: number };
  sync: { autoFixReady: boolean; autoRelease: boolean };
  intake: { dailyReportCap: number };
  retention: { closedIssueMonths: number; diagnosticsMonths: number };
  productionEnvironments: string[];
};
export type Source = { id: string; name: string; kind: "webhook" | "n8n"; status: string; path: string; createdAt: string };
export type Member = { userId: string; name: string; role: "owner" | "editor" | "viewer" };
export type IntakeResult = { outcome: "created" | "attached" | "duplicate"; issueId: string; reportId: string; candidates: number };

export const issuesPath = (projectId: string, rest = "") => `/projects/${encodeURIComponent(projectId)}/issues${rest}`;

export const send = <T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", data?: unknown) =>
  api<T>(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });

/** A query string of the set filters only. */
export function query(filters: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value);
  return q.toString();
}

/** The open item in the URL (?issue=), kept without a reload. */
export function readParam(name: string) {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}
export function writeParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(null, "", url);
}

/** Hours as the member reads them; "—" without data. */
export function hours(value: number | null, locale: "en" | "de") {
  if (value === null) return "—";
  if (value < 48) return `${value.toLocaleString(locale === "de" ? "de-DE" : "en-GB")} h`;
  return `${(value / 24).toLocaleString(locale === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 1 })} ${locale === "de" ? "Tage" : "days"}`;
}

/** A time as the member reads it. */
export function when(value: string, locale: "en" | "de") {
  return new Date(value).toLocaleString(locale === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}
