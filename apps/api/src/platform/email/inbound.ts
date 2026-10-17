import PostalMime from "postal-mime";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, list, update } from "../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import { decryptCredential } from "../connections/connections.ts";
import {
  ownerEnabled,
  registeredEmailInbound,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { filesConfig, storeFile } from "../files/files.ts";
import {
  accountOf,
  emailEnabled,
  verifiedEmailConnection,
} from "./connection.ts";
import { EMAIL_KIND, INBOUND_KIND, ORBIT_MESSAGE_ID } from "./send.ts";
import { mailFactories, MailSendError } from "./transport.ts";

// Inbound e-mail (WP4.7): every two minutes per project with a verified
// e-mail connection, new INBOX messages are fetched over IMAP (read-only,
// nothing is flagged or deleted). Each is kept twice: the raw MIME as an
// encrypted platform file, and a normalized `inbound_emails` row. Modules
// that registered `emailInbound` get a job per message. Customer mail is
// untrusted data: it is stored and handed over, never interpreted here.
// A message that cannot be parsed is kept (raw file, `unreadable` row), so
// no single message can stop the mailbox from being read.

export { INBOUND_KIND };
export const INBOUND_STATE_KIND = "email_inbound_state";
const INTERVAL_MS = 120_000;
const MAX_PER_PASS = 25;
const MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX = 20_000;
const LINE_MAX = 998;
/** The Message-ID Orbit gives its own messages (send.ts). */
const OWN_MESSAGE_ID =
  /^<orbit\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@[^<>\s]+>$/i;
const lastRun = new Map<string, number>();

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

/**
 * Bounded text without NUL and other control characters (Postgres jsonb
 * refuses \u0000); one line unless `multiline`.
 */
export function cleanText(value: unknown, max: number, multiline = false) {
  if (typeof value !== "string") return "";
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
    : /[\u0000-\u001f\u007f]+/g;
  return value
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(controls, multiline ? "" : " ")
    .slice(0, max);
}

// Half of a UTF-16 pair on its own: jsonb refuses it like NUL.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The parsed message, or null when it cannot be parsed. */
async function parseMessage(source: Buffer): Promise<Parsed | null> {
  try {
    return await PostalMime.parse(source);
  } catch {
    return null;
  }
}

const header = (parsed: Parsed, name: string) =>
  parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? "";

/** Auto-replies, lists and bulk mail: modules must not answer them. */
export function automaticMail(parsed: Parsed) {
  const submitted = header(parsed, "auto-submitted").toLowerCase();
  const precedence = header(parsed, "precedence").toLowerCase();
  const from = (parsed.from?.address ?? "").toLowerCase();
  return (
    (submitted !== "" && submitted !== "no") ||
    ["bulk", "junk", "list", "auto_reply"].includes(precedence) ||
    header(parsed, "x-autoreply") !== "" ||
    header(parsed, "x-autorespond") !== "" ||
    header(parsed, "list-id") !== "" ||
    /^(mailer-daemon|postmaster)@/.test(from)
  );
}

/**
 * A failed-delivery report: an RFC 3464 delivery status notification with
 * "Action: failed", or a classic mailer-daemon bounce. Read receipts (MDN),
 * "delayed" warnings and replies are not. Returns the report text and the
 * Orbit message ids it names; a message counts as bounced only when the
 * report also names one of its recipients (see `fetchInbound`).
 */
export function failedDeliveryReport(parsed: Parsed, raw: Buffer) {
  const type = header(parsed, "content-type").toLowerCase();
  const from = (parsed.from?.address ?? "").toLowerCase();
  const text = raw.toString("latin1");
  const dsn =
    type.includes("multipart/report") &&
    /report-type\s*=\s*"?delivery-status/.test(type);
  const daemon =
    /^(mailer-daemon|postmaster)@/.test(from) &&
    !type.includes("multipart/report");
  if (!(dsn ? /^action:\s*failed/im.test(text) : daemon)) return null;
  const ids = [
    ...new Set(
      [...text.matchAll(ORBIT_MESSAGE_ID)].map((m) => m[1]!.toLowerCase()),
    ),
  ];
  // Every address the report names (Final-Recipient, the bounce text).
  const named = new Set(
    (text.toLowerCase().match(/[^\s<>()[\]:;,"']+@[a-z0-9.-]+/g) ?? []).map(
      (a) => a.replace(/\.+$/, ""),
    ),
  );
  return ids.length ? { ids, named } : null;
}

const addresses = (list?: { address?: string }[]) =>
  (list ?? [])
    .map((a) => cleanText(a.address, 320))
    .filter(Boolean)
    .slice(0, 50);

/** The row fields of a parsed message; bounded, one line except the text. */
function normalized(parsed: Parsed | null) {
  if (!parsed)
    return {
      messageId: "",
      from: null,
      fromName: null,
      to: [],
      cc: [],
      subject: "",
      date: null,
      text: "",
      inReplyTo: null,
      references: [],
      automatic: false,
      attachments: 0,
      unreadable: true,
    };
  return {
    messageId: cleanText(parsed.messageId, LINE_MAX),
    from: cleanText(parsed.from?.address, 320) || null,
    fromName: cleanText(parsed.from?.name, 200) || null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: cleanText(parsed.subject, LINE_MAX),
    date: cleanText(parsed.date, 100) || null,
    text: cleanText(parsed.text, TEXT_MAX, true),
    inReplyTo: cleanText(parsed.inReplyTo, LINE_MAX) || null,
    references: cleanText(parsed.references, 100_000)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 50)
      .map((r: string) => r.slice(0, LINE_MAX)),
    automatic: automaticMail(parsed),
    attachments: parsed.attachments.length,
    unreadable: false,
  };
}

async function stateOf(tx: DbTx, scope: Scope, connectionId: string) {
  return (await list(tx, scope, INBOUND_STATE_KIND)).find(
    (row) => data(row).connectionId === connectionId,
  );
}

/** One pass for one project; returns what it did, for tests and status. */
export async function fetchInbound(scope: Scope) {
  if (!emailEnabled()) return { status: "disabled" as const };
  const setup = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const connection = await verifiedEmailConnection(tx, scope);
    if (!connection) return null;
    const state = await stateOf(tx, scope, connection.id);
    return { connection, state };
  });
  if (!setup) return { status: "not_connected" as const };
  const { connection } = setup;
  const recordState = (patch: Record<string, unknown>) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const current = await stateOf(tx, scope, connection.id);
      const next = {
        connectionId: connection.id,
        ...(current ? data(current) : {}),
        ...patch,
        checkedAt: new Date().toISOString(),
      };
      if (current) await update(tx, scope, current, next);
      else await create(tx, scope, INBOUND_STATE_KIND, next);
    });
  // The raw message must be kept; without files nothing is fetched.
  const files = filesConfig();
  if (!files) {
    await recordState({ lastError: "FILES_NOT_CONFIGURED" });
    return { status: "files_not_configured" as const };
  }
  const d = setup.state ? data(setup.state) : {};
  let batch;
  try {
    batch = await mailFactories()
      .mailbox(accountOf(data(connection)), decryptCredential(data(connection)))
      .fetchNew(
        { uidValidity: d.uidValidity, lastUid: Number(d.lastUid ?? 0) },
        { max: MAX_PER_PASS, maxBytes: Math.min(MAX_BYTES, files.maxBytes) },
      );
  } catch (error) {
    await recordState({
      lastError: error instanceof MailSendError ? error.code : "IMAP_ERROR",
    });
    return { status: "error" as const };
  }
  // A new UIDVALIDITY starts over; the Message-ID check keeps it idempotent.
  let lastUid =
    batch.uidValidity === d.uidValidity ? Number(d.lastUid ?? 0) : 0;
  let stored = 0;
  let bounced = 0;
  for (const message of batch.messages) {
    const parsed = await parseMessage(message.source);
    const fields = normalized(parsed);
    const { messageId } = fields;
    const duplicate = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: INBOUND_KIND,
          AND: [
            { data: { path: ["connectionId"], equals: connection.id } },
            messageId
              ? { data: { path: ["messageId"], equals: messageId } }
              : {
                  AND: [
                    { data: { path: ["uid"], equals: message.uid } },
                    {
                      data: {
                        path: ["uidValidity"],
                        equals: batch.uidValidity,
                      },
                    },
                  ],
                },
          ],
        },
      }),
    );
    if (!duplicate) {
      const file = await storeFile(
        { ...scope, userId: "email-inbound" },
        {
          moduleId: "platform",
          bytes: message.source,
          mime: "message/rfc822",
          name: `${message.uid}.eml`,
        },
      );
      const report = parsed
        ? failedDeliveryReport(parsed, message.source)
        : null;
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const own = (id: string) =>
          tx.entity.findFirst({
            where: {
              id,
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              kind: EMAIL_KIND,
            },
          });
        // A failed-delivery report marks the project's own messages it
        // names, and only for a recipient it names as well.
        const bounceOf: string[] = [];
        for (const id of report?.ids ?? []) {
          const sent = await own(id);
          if (!sent) continue;
          const to = ((data(sent).to as string[] | undefined) ?? []).map((a) =>
            a.toLowerCase(),
          );
          if (!to.some((a) => report!.named.has(a))) continue;
          await update(tx, scope, sent, {
            ...data(sent),
            deliveryState: "bounced",
            bouncedAt: new Date().toISOString(),
          });
          bounceOf.push(id);
          bounced++;
        }
        // Orbit's own message coming back in (sent to the mailbox itself,
        // or copied into the INBOX by the provider): never a new request.
        const ownId = OWN_MESSAGE_ID.exec(messageId)?.[1];
        const copy = ownId ? await own(ownId.toLowerCase()) : null;
        const echo =
          copy !== null &&
          String(data(copy).messageId ?? "").toLowerCase() ===
            messageId.toLowerCase();
        const row = await create(tx, scope, INBOUND_KIND, {
          connectionId: connection.id,
          uid: message.uid,
          uidValidity: batch.uidValidity,
          ...fields,
          bounceOf,
          ...(echo ? { ownMessage: true } : {}),
          fileId: file.id,
          receivedAt: new Date().toISOString(),
        });
        // Bounces and echoes are the platform's; the rest goes to modules.
        if (!bounceOf.length && !echo) {
          const enabled = await enabledModules(tx, scope);
          for (const { owner, queueClass } of registeredEmailInbound())
            if (ownerEnabled(owner, enabled))
              await enqueue(
                tx,
                scope,
                queueClass,
                row.id,
                `email-in:${queueClass}:${row.id}`,
              );
        }
      });
      stored++;
    }
    lastUid = Math.max(lastUid, message.uid);
  }
  for (const uid of batch.skipped) lastUid = Math.max(lastUid, uid);
  await recordState({
    uidValidity: batch.uidValidity,
    lastUid,
    lastError: null,
    ...(batch.skipped.length ? { lastSkipped: batch.skipped.length } : {}),
  });
  if (stored || batch.skipped.length)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "email.inbound", connection.id, {
        stored,
        bounced,
        skipped: batch.skipped.length,
      }),
    );
  return {
    status: "ok" as const,
    stored,
    bounced,
    skipped: batch.skipped.length,
  };
}

/** Every two minutes per project; errors are recorded on the state row. */
export const emailInbound: PeriodicTask = {
  name: "email-inbound",
  async run(scope) {
    if (!emailEnabled()) return;
    const now = Date.now();
    if (now - (lastRun.get(scope.projectId) ?? 0) < INTERVAL_MS) return;
    lastRun.set(scope.projectId, now);
    const result = await fetchInbound(scope);
    // Only a project with a mailbox is woken again for the next pass.
    return result.status === "not_connected" || result.status === "disabled"
      ? undefined
      : { wakeAt: new Date(now + INTERVAL_MS) };
  },
};
