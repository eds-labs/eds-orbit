import { api, post } from "@/lib/api";

// The support module's client side (WP5.2): types of the support API and
// the pure helpers the views share.

export type Ticket = {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  tags: string[];
  assigneeUserId: string | null;
  channel: string;
  inboxId: string;
  contactId: string;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  mergedIntoTicketId: string | null;
  updatedAt: string;
  createdAt: string;
  contact?: { id: string; name: string | null; email: string | null } | null;
};
export type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  claimedEmail: string | null;
  locale: string | null;
  notes: string | null;
  tickets?: Array<{
    id: string;
    number: number;
    subject: string;
    status: string;
    createdAt: string;
  }>;
};
export type Attachment = {
  id: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
};
export type TicketDetail = {
  ticket: Ticket;
  contact: Contact | null;
  inbox: {
    id: string;
    name: string;
    channels: string[];
    aiMode?: string;
  } | null;
  timeline: Array<Record<string, any>>;
  aiCostMicros?: number;
};
export type Inbox = {
  id: string;
  name: string;
  channels: string[];
  emailAddress: string | null;
  /** The mailbox the inbox answers from (e-mail channel). */
  emailConnectionId?: string | null;
  allowedOrigins: string[];
  defaultCategory: string | null;
  assignmentPolicy: string;
  language: string;
  aiMode: string;
  rules?: { autoAck?: boolean; autoClose?: boolean; sla?: boolean };
  version: number;
  archivedAt: string | null;
  hasWidgetSecret: boolean;
};
/** A project mailbox as the inbox form offers it (no credentials). */
export type Mailbox = {
  id: string;
  address: string;
  name: string | null;
  verified: boolean;
  isDefault: boolean;
  /** The live inbox answering from it, if any. */
  inboxId: string | null;
};
export type Agent = { userId: string; name: string };
export type Summary = {
  open: number;
  unassigned: number;
  atRisk: number;
  breached: number;
};

export const STATUSES = [
  "new",
  "open",
  "pending_customer",
  "pending_internal",
  "resolved",
  "closed",
] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const VIEWS = ["mine", "unassigned", "all"] as const;

export const supportPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/support${rest}`;

/** The list query: only set filters, trimmed search, the cursor encoded. */
export function ticketQuery(filters: {
  view: string;
  status?: string | null;
  inboxId?: string | null;
  priority?: string | null;
  q?: string | null;
  cursor?: string | null;
}) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(filters)) {
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (value) params.set(key, value);
  }
  return params.toString();
}

const AT_RISK_MS = 60 * 60_000;
const ACTIVE = ["new", "open", "pending_internal"];

/**
 * The SLA state the views show: done once resolved or closed, paused while
 * waiting on the customer, else breached, at risk (within an hour) or ok,
 * judged on the pending due times only. Mirrors the server's summary.
 */
export function slaState(
  ticket: Pick<
    Ticket,
    | "status"
    | "firstRespondedAt"
    | "resolvedAt"
    | "firstResponseDueAt"
    | "resolutionDueAt"
  >,
  now = new Date(),
): "ok" | "at_risk" | "breached" | "paused" | "done" {
  if (ticket.status === "resolved" || ticket.status === "closed") return "done";
  if (!ACTIVE.includes(ticket.status)) return "paused";
  const pending = [
    ticket.firstRespondedAt ? null : ticket.firstResponseDueAt,
    ticket.resolvedAt ? null : ticket.resolutionDueAt,
  ]
    .filter((v): v is string => Boolean(v))
    .map((v) => new Date(v).getTime());
  if (pending.some((t) => t < now.getTime())) return "breached";
  if (pending.some((t) => t < now.getTime() + AT_RISK_MS)) return "at_risk";
  return "ok";
}

export type TimelineEntry =
  | {
      entry: "message";
      id: string;
      kind: string;
      internal: boolean;
      bodyText: string;
      createdAt: string;
      authorUserId?: string | null;
      deliveryState?: string | null;
      attachments: Attachment[];
    }
  | {
      entry: "event";
      id: string;
      type: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      createdAt: string;
    };

/** The server's timeline as typed entries (messages have a kind). */
export function timelineEntries(
  items: Array<Record<string, any>>,
): TimelineEntry[] {
  return items.map((item) =>
    item.kind
      ? {
          entry: "message",
          id: item.id,
          kind: item.kind,
          internal: item.kind === "internal_note" || item.kind === "ai_draft",
          bodyText: item.bodyText ?? "",
          createdAt: item.createdAt,
          authorUserId: item.authorUserId ?? null,
          deliveryState: item.deliveryState ?? null,
          attachments: item.attachments ?? [],
        }
      : {
          entry: "event",
          id: item.id,
          type: item.type,
          before: item.before ?? {},
          after: item.after ?? {},
          createdAt: item.createdAt,
        },
  );
}

export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const put = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export { post };

/** Uploads a file into the support module's platform files. */
export async function uploadSupportFile(projectId: string, file: File) {
  return api<{ id: string; name: string | null }>(
    `/projects/${encodeURIComponent(projectId)}/files?module=support`,
    {
      method: "POST",
      body: file,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-file-type": file.type || "application/octet-stream",
      },
    },
  );
}
