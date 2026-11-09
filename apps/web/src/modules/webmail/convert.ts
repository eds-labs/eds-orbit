import { ApiError } from "@/lib/api";
import type {
  ConvertClient,
  ConvertDestination,
  ConvertMode,
  ConvertReference,
  ConvertTarget,
} from "./api";
import type { WebmailText } from "./labels";

// The logic of the takeover dialog (ADR 0026, E7). The browser names a message
// by folder and UID only; the server reads it again from the bound mailbox.

/** The gaps between checks while another attempt holds the lease (202). */
export const POLL_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export const SUPPORT_TICKET_TARGET = "support.ticket";

/** The existing ticket page; only Support's records have one. */
export function recordHref(projectId: string, target: string, recordId: string) {
  if (target !== SUPPORT_TICKET_TARGET) return null;
  return `/p/${encodeURIComponent(projectId)}/support/tickets?ticket=${encodeURIComponent(recordId)}`;
}

export type ConvertErrorKey = keyof WebmailText["convert"]["errors"];

export function convertErrorKey(error: unknown): ConvertErrorKey {
  if (!(error instanceof ApiError)) return "generic";
  switch (error.code) {
    case "WEBMAIL_MESSAGE_NOT_FOUND":
      return "messageGone";
    case "WEBMAIL_UID_VALIDITY_CHANGED":
      return "folderChanged";
    case "WEBMAIL_MESSAGE_TOO_LARGE":
      return "tooLarge";
    case "WEBMAIL_TARGET_UNAVAILABLE":
      return "targetUnavailable";
    case "WEBMAIL_MAILBOX_UNAVAILABLE":
      return "mailboxUnavailable";
    case "WEBMAIL_MAILBOX_NOT_FOUND":
      return "noAccess";
    case "WEBMAIL_DISABLED":
      return "disabled";
  }
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "messageGone";
  if (error.status === 409) return "conflict";
  if (error.status === 413) return "tooLarge";
  return "generic";
}

export type ConvertDone = {
  target: string;
  recordId: string;
  number: number | null;
  duplicate: boolean;
  /** Null when another attempt did the work and did not report it here. */
  skippedAttachments: number | null;
};

export type ConvertStage =
  | { kind: "loading" }
  /** No right or no active target: the option does not exist for this member. */
  | { kind: "hidden" }
  | { kind: "load_error"; error: ConvertErrorKey }
  | { kind: "already"; target: string; recordId: string; number: number | null }
  | { kind: "form"; targets: ConvertTarget[] }
  | { kind: "done"; result: ConvertDone };

/** The dialog's first step: is it allowed, and was the message taken over? */
export async function loadConvertStage(
  client: Pick<ConvertClient, "options" | "status">,
  reference: ConvertReference,
): Promise<ConvertStage> {
  const [options, status] = await Promise.allSettled([
    client.options(),
    client.status(reference),
  ]);
  if (options.status === "rejected") {
    const denied =
      options.reason instanceof ApiError &&
      (options.reason.status === 403 || options.reason.status === 404);
    return denied
      ? { kind: "hidden" }
      : { kind: "load_error", error: convertErrorKey(options.reason) };
  }
  if (options.value.targets.length === 0) return { kind: "hidden" };
  if (status.status === "rejected")
    return { kind: "load_error", error: convertErrorKey(status.reason) };
  if (status.value.converted)
    return {
      kind: "already",
      target: status.value.target,
      recordId: status.value.recordId,
      number: status.value.number,
    };
  return { kind: "form", targets: options.value.targets };
}

export type ConvertForm = {
  choice: "new" | "existing";
  targetKey: string;
  destinationId: string;
  subject: string;
  priority: string;
  category: string;
  customerAddress: "from" | "reply_to";
  query: string;
  recordId: string;
};

export function initialForm(targets: readonly ConvertTarget[]): ConvertForm {
  const target = targets[0];
  return {
    choice: target?.destinations.length ? "new" : "existing",
    targetKey: target?.key ?? "",
    destinationId: target?.destinations[0]?.id ?? "",
    subject: "",
    priority: "",
    category: "",
    customerAddress: "from",
    query: "",
    recordId: "",
  };
}

export const selectedTarget = (
  targets: readonly ConvertTarget[],
  form: ConvertForm,
) => targets.find((target) => target.key === form.targetKey) ?? null;

export const selectedDestination = (
  target: ConvertTarget | null,
  form: ConvertForm,
): ConvertDestination | null =>
  target?.destinations.find((d) => d.id === form.destinationId) ?? null;

/** Picks another inbox; a priority or category it does not offer is cleared. */
export function withDestination(
  form: ConvertForm,
  target: ConvertTarget | null,
  destinationId: string,
): ConvertForm {
  const destination = target?.destinations.find((d) => d.id === destinationId);
  return {
    ...form,
    destinationId,
    priority: destination?.priorities.includes(form.priority) ? form.priority : "",
    category: destination?.categories.includes(form.category) ? form.category : "",
  };
}

/** Picks another receiving module and starts over within it. */
export function withTarget(
  form: ConvertForm,
  target: ConvertTarget | null,
): ConvertForm {
  return {
    ...form,
    choice: target?.destinations.length ? form.choice : "existing",
    targetKey: target?.key ?? "",
    destinationId: target?.destinations[0]?.id ?? "",
    priority: "",
    category: "",
    query: "",
    recordId: "",
  };
}

/** The request's mode, or null while the form is not complete. */
export function modeOf(form: ConvertForm): ConvertMode | null {
  if (form.choice === "existing")
    return form.recordId ? { kind: "append", recordId: form.recordId } : null;
  if (!form.destinationId) return null;
  const subject = form.subject.trim();
  return {
    kind: "create",
    destinationId: form.destinationId,
    customerAddress: form.customerAddress,
    ...(subject ? { subject } : {}),
    ...(form.priority ? { priority: form.priority } : {}),
    ...(form.category ? { category: form.category } : {}),
  };
}

export type ConvertOutcome =
  | { kind: "done"; result: ConvertDone }
  | { kind: "still_running" }
  | { kind: "error"; error: ConvertErrorKey };

export type ConvertRun = {
  client: Pick<ConvertClient, "convert" | "status">;
  reference: ConvertReference;
  target: string;
  mode: ConvertMode;
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
  onWaiting: () => void;
};

/**
 * Posts once. A 202 means another attempt holds the lease, so the status is
 * read with backoff rather than posting again; only the member's own retry
 * starts a new attempt. Null when the dialog closed meanwhile.
 */
export async function runConvert(run: ConvertRun): Promise<ConvertOutcome | null> {
  try {
    const answer = await run.client.convert(run.reference, run.target, run.mode);
    if (answer.status === "done") return { kind: "done", result: answer };
    run.onWaiting();
    for (const delay of POLL_DELAYS_MS) {
      await run.sleep(delay);
      if (run.isCancelled()) return null;
      const status = await run.client.status(run.reference);
      if (status.converted)
        return {
          kind: "done",
          result: {
            target: status.target,
            recordId: status.recordId,
            number: status.number,
            duplicate: false,
            skippedAttachments: null,
          },
        };
    }
    return { kind: "still_running" };
  } catch (error) {
    return { kind: "error", error: convertErrorKey(error) };
  }
}

/** Refuses a second submit while the first is on its way. */
export function createConvertSubmitter() {
  let running = false;
  return async (run: ConvertRun): Promise<ConvertOutcome | null> => {
    if (running) return null;
    running = true;
    try {
      return await runConvert(run);
    } finally {
      running = false;
    }
  };
}
