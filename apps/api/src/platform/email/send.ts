import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  exception,
  update,
} from "../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { decryptCredential } from "../connections/connections.ts";
import {
  accountOf,
  emailEnabled,
  liveSending,
  verifiedEmailConnection,
} from "./connection.ts";
import {
  classifySendError,
  mailFactories,
  MailSendError,
} from "./transport.ts";

// Outbound e-mail (WP4.7). One `email_messages` row per message, sent by
// the `email_send` job through the project's verified mailbox. States:
// queued → sending → sent | rejected | retry → failed | outcome_unknown,
// or test_receipt outside live mode. A message that may have left (an
// error after the hand-over, or a crash while "sending") is never sent
// again: it becomes outcome_unknown and an exception for the owner.

export const EMAIL_KIND = "email_messages";
export const EMAIL_QUEUE = "email_send";
/** Received messages (inbound.ts); here for the reply check. */
export const INBOUND_KIND = "inbound_emails";
const MAX_ATTEMPTS = 3;

export const outgoingEmail = z
  .object({
    to: z.array(z.email().max(320)).min(1).max(20),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => !/[\r\n]/.test(s), "One line"),
    text: z.string().min(1).max(100_000),
    moduleId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    /** A notification is marked as automatic, so replies stay away. */
    automatic: z.boolean().default(false),
    inReplyTo: z.string().max(998).optional(),
    references: z.array(z.string().max(998)).max(50).optional(),
  })
  .strict();

/** The Message-ID Orbit gives a message; bounces are matched by it. */
export const orbitMessageId = (id: string, fromAddress: string) =>
  `<orbit.${id}@${fromAddress.split("@")[1] ?? "orbit.invalid"}>`;
/** An Orbit message id anywhere in a text (a bounce report). */
export const ORBIT_MESSAGE_ID =
  /orbit\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/gi;

/** Queues one message in the caller's transaction; sent by the job. */
export async function queueEmail(tx: DbTx, scope: Scope, raw: unknown) {
  if (!emailEnabled()) throw new DomainError("NOT_FOUND", 404);
  const input = outgoingEmail.parse(raw);
  // RFC 3834: automatic mail (auto-replies, lists, bounces) is never
  // answered, or two auto-responders mail each other forever.
  if (input.inReplyTo) {
    const original = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: INBOUND_KIND,
        AND: [
          { data: { path: ["messageId"], equals: input.inReplyTo } },
          { data: { path: ["automatic"], equals: true } },
        ],
      },
    });
    if (original) throw new DomainError("EMAIL_REPLY_TO_AUTOMATIC", 409);
  }
  const row = await create(tx, scope, EMAIL_KIND, {
    ...input,
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  await enqueue(tx, scope, EMAIL_QUEUE, row.id, `email:${row.id}`);
  return row;
}

/** Sends the message of one `email_send` job; see the file comment. */
export async function sendQueuedEmail(scope: Scope, messageId: string) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await entity(tx, scope, EMAIL_KIND, messageId);
      const d = data(row);
      const finish = async (patch: Record<string, unknown>) => {
        await update(tx, scope, row, {
          ...d,
          ...patch,
          finishedAt: new Date().toISOString(),
        });
        return null;
      };
      // A crash while sending: the message may be out.
      if (d.status === "sending") {
        await exception(tx, scope, "EMAIL_OUTCOME_UNKNOWN", row.id);
        return finish({ status: "outcome_unknown", code: "INTERRUPTED" });
      }
      if (!["queued", "retry"].includes(d.status)) return null;
      if (!emailEnabled())
        return finish({ status: "skipped", code: "DISABLED" });
      const connection = await verifiedEmailConnection(tx, scope);
      if (!connection)
        return finish({ status: "failed", code: "EMAIL_NOT_CONNECTED" });
      const account = accountOf(data(connection));
      const mail = {
        from: {
          address: account.fromAddress,
          ...(account.fromName ? { name: account.fromName } : {}),
        },
        to: d.to as string[],
        subject: d.subject as string,
        text: d.text as string,
        messageId: orbitMessageId(row.id, account.fromAddress),
        headers: {
          "X-Orbit-Message": row.id,
          ...(d.automatic ? { "Auto-Submitted": "auto-generated" } : {}),
        },
        ...(d.inReplyTo ? { inReplyTo: d.inReplyTo as string } : {}),
        ...(d.references ? { references: d.references as string[] } : {}),
      };
      // Outside live mode: what would have gone out, delivered nowhere.
      if (!liveSending())
        return finish({
          status: "test_receipt",
          connectionId: connection.id,
          receipt: { from: mail.from.address, messageId: mail.messageId },
        });
      const sending = await update(tx, scope, row, {
        ...d,
        status: "sending",
        attempts: Number(d.attempts ?? 0) + 1,
        connectionId: connection.id,
        messageId: mail.messageId,
      });
      return {
        row: sending,
        mail,
        account,
        password: decryptCredential(data(connection)),
      };
    },
  );
  if (!prepared) return;
  const transport = mailFactories().transport(
    prepared.account,
    prepared.password,
  );
  let outcome: Record<string, unknown>;
  let retry = false;
  try {
    const result = await transport.send(prepared.mail);
    outcome = {
      status: "sent",
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      sentAt: new Date().toISOString(),
    };
  } catch (error) {
    const kind = classifySendError(error);
    const code = error instanceof MailSendError ? error.code : "UNEXPECTED";
    const attempts = Number(data(prepared.row).attempts);
    retry = kind === "failed" && attempts < MAX_ATTEMPTS;
    outcome = {
      status: retry ? "retry" : kind === "failed" ? "failed" : kind,
      code,
      ...(error instanceof MailSendError && error.responseCode
        ? { responseCode: error.responseCode }
        : {}),
    };
  } finally {
    transport.close();
  }
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await entity(tx, scope, EMAIL_KIND, messageId);
    await update(tx, scope, current, {
      ...data(current),
      ...outcome,
      ...(retry ? {} : { finishedAt: new Date().toISOString() }),
    });
    if (outcome.status === "outcome_unknown")
      await exception(tx, scope, "EMAIL_OUTCOME_UNKNOWN", messageId);
    await audit(tx, scope, "email.send", messageId, {
      status: outcome.status as string,
      ...(outcome.code ? { code: outcome.code as string } : {}),
    });
  });
  // The worker runs the job again later; the row says "retry".
  if (retry) throw new Error("EMAIL_SEND_RETRY");
}

/**
 * A paused project blocks the job for good (it is not retried): the
 * message is recorded as skipped, so nothing waits forever.
 */
export async function skipEmailForPause(tx: DbTx, job: Record<string, any>) {
  const row = await tx.entity.findFirst({
    where: { id: String(job.resourceId), kind: EMAIL_KIND },
  });
  if (!row || !["queued", "retry"].includes(data(row).status)) return;
  const scope: Scope = {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    userId: "worker",
    role: "viewer",
  };
  await update(tx, scope, row, {
    ...data(row),
    status: "skipped",
    code: "PROJECT_PAUSED",
    finishedAt: new Date().toISOString(),
  });
}
