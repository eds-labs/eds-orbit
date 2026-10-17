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
import { EMAIL_KIND, ORBIT_MESSAGE_ID } from "./send.ts";
import { mailFactories, MailSendError } from "./transport.ts";

// Inbound e-mail (WP4.7): every two minutes per project with a verified
// e-mail connection, new INBOX messages are fetched over IMAP (read-only,
// nothing is flagged or deleted). Each is kept twice: the raw MIME as an
// encrypted platform file, and a normalized `inbound_emails` row. Modules
// that registered `emailInbound` get a job per message. Customer mail is
// untrusted data: it is stored and handed over, never interpreted here.

export const INBOUND_KIND = "inbound_emails";
export const INBOUND_STATE_KIND = "email_inbound_state";
const INTERVAL_MS = 120_000;
const MAX_PER_PASS = 25;
const MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX = 20_000;
const lastRun = new Map<string, number>();

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

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

/** A delivery status notification: the Orbit messages it reports. */
export function bouncedMessageIds(parsed: Parsed, raw: Buffer): string[] {
  const type = header(parsed, "content-type").toLowerCase();
  const from = (parsed.from?.address ?? "").toLowerCase();
  const report =
    type.includes("multipart/report") ||
    /^(mailer-daemon|postmaster)@/.test(from);
  if (!report) return [];
  return [
    ...new Set(
      [...raw.toString("latin1").matchAll(ORBIT_MESSAGE_ID)].map((m) =>
        m[1]!.toLowerCase(),
      ),
    ),
  ];
}

const addresses = (list?: { address?: string }[]) =>
  (list ?? [])
    .map((a) => a.address)
    .filter((a): a is string => Boolean(a))
    .slice(0, 50);

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
    const parsed = await PostalMime.parse(message.source);
    const messageId = (parsed.messageId ?? "").slice(0, 998);
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
      const bounces = bouncedMessageIds(parsed, message.source);
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const row = await create(tx, scope, INBOUND_KIND, {
          connectionId: connection.id,
          uid: message.uid,
          uidValidity: batch.uidValidity,
          messageId,
          from: parsed.from?.address ?? null,
          fromName: parsed.from?.name?.slice(0, 200) ?? null,
          to: addresses(parsed.to),
          cc: addresses(parsed.cc),
          subject: (parsed.subject ?? "").slice(0, 998),
          date: parsed.date ?? null,
          text: (parsed.text ?? "").slice(0, TEXT_MAX),
          inReplyTo: parsed.inReplyTo ?? null,
          references: (parsed.references ?? "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 50),
          automatic: automaticMail(parsed),
          bounceOf: bounces,
          attachments: parsed.attachments.length,
          fileId: file.id,
          receivedAt: new Date().toISOString(),
        });
        // A bounce marks the project's own messages it names.
        for (const id of bounces) {
          const sent = await tx.entity.findFirst({
            where: {
              id,
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              kind: EMAIL_KIND,
            },
          });
          if (sent) {
            await update(tx, scope, sent, {
              ...data(sent),
              deliveryState: "bounced",
              bouncedAt: new Date().toISOString(),
            });
            bounced++;
          }
        }
        // Bounces are the platform's; everything else goes to the modules.
        if (!bounces.length) {
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
