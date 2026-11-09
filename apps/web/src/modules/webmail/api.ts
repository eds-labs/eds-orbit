// The webmail module's client side (ADR 0026, docs/plans/WEBMAIL.md). Local
// types of the /webmail API until the generated client includes them.
import { api, ApiError, patch, post, put } from "@/lib/api";

export const webmailPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/webmail${rest}`;

export const mailboxPath = (projectId: string, mailboxId: string, rest = "") =>
  webmailPath(projectId, `/mailboxes/${encodeURIComponent(mailboxId)}${rest}`);

export type MailboxCapabilities = {
  read: boolean;
  send: boolean;
  organize: boolean;
  convert: boolean;
  manage: boolean;
};

/** One mailbox of GET /webmail/mailboxes; the server lists only granted ones. */
export type WebmailMailbox = {
  id: string;
  address: string;
  displayName: string | null;
  sensitive: boolean;
  capabilities: MailboxCapabilities;
  status: "ok" | "error" | "disabled";
  sync: "ok" | "backlog" | "error";
  lastError: string | null;
};
export type MailboxesResponse = { origin: string; mailboxes: WebmailMailbox[] };

/** The answer of POST .../session. Holds the one-time token: never keep it. */
export type HandoffSession = {
  action: string;
  fields: Record<string, string>;
  expiresAt: string;
};

/** A message in a mailbox, as the embedded client names it. */
export type ConvertReference = {
  folder: string;
  uid: number;
  uidValidity: number;
};

export type ConvertDestination = {
  id: string;
  name: string;
  /** The address replies leave from. */
  address: string | null;
  categories: readonly string[];
  priorities: readonly string[];
};
export type ConvertTarget = {
  key: string;
  label: string;
  destinations: readonly ConvertDestination[];
};
export type ConvertOptions = { targets: ConvertTarget[] };
export type ConvertRecordHit = {
  id: string;
  number: number | null;
  title: string;
  status: string;
};
export type ConvertStatus =
  | { converted: false }
  | { converted: true; target: string; recordId: string; number: number | null };
export type ConvertMode =
  | {
      kind: "create";
      destinationId: string;
      subject?: string;
      priority?: string;
      category?: string;
      customerAddress: "from" | "reply_to";
    }
  | { kind: "append"; recordId: string };
export type ConvertAnswer =
  | { status: "pending" }
  | {
      status: "done";
      target: string;
      recordId: string;
      number: number | null;
      duplicate: boolean;
      skippedAttachments: number;
    };

export type WebmailRights = {
  canRead: boolean;
  canSend: boolean;
  canOrganize: boolean;
  canConvert: boolean;
  canManage: boolean;
};
export type GrantMember = {
  userId: string;
  name: string;
  email: string;
  grant: WebmailRights | null;
};
export type OpenedMailbox = {
  id: string;
  enabled: boolean;
  sensitive: boolean;
  displayName: string | null;
  version: number;
};
export type SettingsConnection = {
  connectionId: string;
  address: string;
  /** The module that owns the mailbox, such as "finance". */
  owner: string | null;
  opened: OpenedMailbox | null;
};
export type WebmailSettings = { connections: SettingsConnection[] };

/** DELETE answers 204 without a body, which the shared `request` cannot read. */
async function deleteNoContent(path: string, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new ApiError(body?.error?.code ?? "REQUEST_FAILED", response.status);
}

const SESSION_TIMEOUT_MS = 15_000;
const END_TIMEOUT_MS = 5_000;

export const createSession = (projectId: string, mailboxId: string) =>
  api<HandoffSession>(mailboxPath(projectId, mailboxId, "/session"), {
    method: "POST",
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  });

export const endSession = (projectId: string, mailboxId: string) =>
  deleteNoContent(
    mailboxPath(projectId, mailboxId, "/session"),
    AbortSignal.timeout(END_TIMEOUT_MS),
  );

const referenceQuery = (reference: ConvertReference) =>
  new URLSearchParams({
    folder: reference.folder,
    uid: String(reference.uid),
    uidValidity: String(reference.uidValidity),
  }).toString();

/** The calls of the takeover; only the message's reference leaves the browser. */
export function convertClient(projectId: string, mailboxId: string) {
  const path = (rest: string) => mailboxPath(projectId, mailboxId, rest);
  return {
    options: () => api<ConvertOptions>(path("/convert/options")),
    status: (reference: ConvertReference) =>
      api<ConvertStatus>(path(`/convert/status?${referenceQuery(reference)}`)),
    convert: (reference: ConvertReference, target: string, mode: ConvertMode) =>
      post<ConvertAnswer>(path("/convert"), { ...reference, target, mode }),
  };
}
export type ConvertClient = ReturnType<typeof convertClient>;

export const recordsPath = (
  projectId: string,
  mailboxId: string,
  target: string,
  query: string,
) =>
  mailboxPath(
    projectId,
    mailboxId,
    `/convert/records?${new URLSearchParams({ target, q: query })}`,
  );

export const settingsApi = {
  open: (projectId: string, connectionId: string) =>
    post<OpenedMailbox>(webmailPath(projectId, "/settings/mailboxes"), {
      connectionId,
    }),
  update: (
    projectId: string,
    mailboxId: string,
    change: { version: number; enabled?: boolean; sensitive?: boolean },
  ) =>
    patch<OpenedMailbox>(
      webmailPath(
        projectId,
        `/settings/mailboxes/${encodeURIComponent(mailboxId)}`,
      ),
      change,
    ),
  close: (projectId: string, mailboxId: string) =>
    deleteNoContent(
      webmailPath(
        projectId,
        `/settings/mailboxes/${encodeURIComponent(mailboxId)}`,
      ),
    ),
  setGrant: (
    projectId: string,
    mailboxId: string,
    userId: string,
    rights: WebmailRights,
  ) =>
    put<unknown>(
      mailboxPath(
        projectId,
        mailboxId,
        `/grants/${encodeURIComponent(userId)}`,
      ),
      rights,
    ),
};
