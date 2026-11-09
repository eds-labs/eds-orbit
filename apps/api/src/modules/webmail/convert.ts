import { createHash, randomUUID } from "node:crypto";
import PostalMime from "postal-mime";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { connectionVerified } from "../../platform/connections/connections.ts";
import type { EmailImportPrepared } from "../../platform/email/import-contract.ts";
import {
  inboundRowForImport,
  readMailboxMessage,
  type MailboxMessageRef,
} from "../../platform/email/shared-client.ts";
import { maxFileBytes } from "../../platform/files/files.ts";
import { registeredEmailImports } from "../../platform/modules/contributions.ts";
import { assertModuleEnabled } from "../../platform/modules/enforcement.ts";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../platform/tenancy/module-roles.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  effectiveCapabilities,
  operatingState,
  requireCapability,
} from "./access.ts";

// Takeover of one message by another module (ADR 0026): idempotent per
// (project, mailbox, dedupeKey), so a double click or a retry yields one
// record. The client names a folder and uid; everything else is read again
// from the mailbox the route and the grant bind. IMAP and files run outside
// any transaction. Scopes for the receiving module are derived from a fresh
// membership, or a webmail role would become a role in that module.

const LEASE_MS = 120_000;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

const folder = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\u0000-\u001f]+$/, "Invalid folder");
const uid = z.number().int().positive().max(2147483647);
const uidValidity = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,9}$/)])
  .transform(String);

const modeInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      destinationId: z.string().min(1).max(100),
      subject: z.string().trim().min(1).max(300).optional(),
      priority: z.string().min(1).max(40).optional(),
      category: z.string().min(1).max(100).nullable().optional(),
      customerAddress: z.enum(["from", "reply_to"]).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("append"), recordId: z.string().min(1).max(100) })
    .strict(),
]);

export const convertInput = z
  .object({
    folder,
    uid,
    uidValidity,
    target: z.string().min(1).max(100),
    mode: modeInput,
  })
  .strict();
export type ConvertInput = z.infer<typeof convertInput>;

export const statusQuery = z.object({
  folder,
  uid: z.coerce.number().int().positive().max(2147483647),
  uidValidity,
});

export const recordsQuery = z.object({
  target: z.string().min(1).max(100),
  q: z.string().trim().max(200).default(""),
});

/** sha256 of Message-ID, From and Date; of the raw message without a Message-ID. */
export async function dedupeKeyOf(source: Uint8Array) {
  const parsed = await PostalMime.parse(source).catch(() => null);
  const id = parsed?.messageId?.trim();
  const hash = createHash("sha256");
  if (!id) return hash.update(source).digest("hex");
  const from = parsed?.from?.address?.toLowerCase() ?? "";
  return hash
    .update(JSON.stringify([id, from, parsed?.date ?? ""]))
    .digest("hex");
}

const unavailable = () => new DomainError("WEBMAIL_TARGET_UNAVAILABLE", 404);
const undeliverable = () => new DomainError("WEBMAIL_MAILBOX_UNAVAILABLE", 409);

function targetOf(key: string) {
  const target = registeredEmailImports().get(key);
  if (!target) throw unavailable();
  return target;
}

/** The member's own scope in the receiving module, checked against its permission. */
async function targetScope(
  scope: Scope,
  target: ReturnType<typeof targetOf>,
): Promise<Scope> {
  const fresh = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!fresh) throw unavailable();
  let effective: Scope;
  try {
    effective = moduleScope(fresh, target.owner);
  } catch {
    throw unavailable();
  }
  authorize(effective, target.permission);
  return effective;
}

async function targetActive(
  tx: DbTx,
  effective: Scope,
  target: ReturnType<typeof targetOf>,
) {
  try {
    await assertModuleEnabled(tx, effective, target.owner);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
  return target.active(tx, effective);
}

/** The targets this member may hand a message to, active in this project. */
export async function convertOptions(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
) {
  await requireCapability(tx, scope, mailboxId, "convert");
  const targets = [];
  for (const [key, target] of registeredEmailImports()) {
    const effective = await targetScope(scope, target).catch(() => null);
    if (!effective || !(await targetActive(tx, effective, target))) continue;
    targets.push({
      key,
      label: target.label,
      destinations: await target.destinations(tx, effective),
    });
  }
  return { targets };
}

export async function convertRecords(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  query: { target: string; q: string },
) {
  await requireCapability(tx, scope, mailboxId, "convert");
  const target = targetOf(query.target);
  const effective = await targetScope(scope, target);
  if (!(await targetActive(tx, effective, target))) throw unavailable();
  return { records: await target.searchRecords(tx, effective, query.q) };
}

/** A converted message's record number, as far as the receiving module tells. */
async function recordNumber(
  tx: DbTx,
  scope: Scope,
  key: string,
  recordId: string,
) {
  try {
    const target = targetOf(key);
    const effective = await targetScope(scope, target);
    const hits = await target.searchRecords(tx, effective, recordId);
    return hits.find((hit) => hit.id === recordId)?.number ?? null;
  } catch {
    return null;
  }
}

export async function convertStatus(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  query: { folder: string; uid: number; uidValidity: string },
) {
  await requireCapability(tx, scope, mailboxId, "convert");
  const row = await tx.webmailConversion.findFirst({
    where: {
      projectId: scope.projectId,
      mailboxId,
      folder: query.folder,
      uid: query.uid,
      uidValidity: query.uidValidity,
      status: "done",
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!row?.recordId) return { converted: false as const };
  return {
    converted: true as const,
    target: row.target,
    recordId: row.recordId,
    number: await recordNumber(tx, scope, row.target, row.recordId),
  };
}

/** The grant check and connection of POST convert; fails while mail is stopped. */
export async function requireConvertable(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
) {
  const found = await requireCapability(tx, scope, mailboxId, "convert");
  const state = await operatingState(tx, scope);
  if (
    !found.mailbox.enabled ||
    !connectionVerified(found.connection.status) ||
    !effectiveCapabilities(found.capabilities, state).convert
  )
    throw undeliverable();
  return { connectionId: found.mailbox.emailConnectionId };
}

type Claim =
  | { kind: "claimed" }
  | { kind: "busy" }
  | { kind: "done"; target: string; recordId: string };

/** Claims the message for this attempt, under the project's lock. */
function claim(
  scope: Scope,
  mailboxId: string,
  input: ConvertInput,
  dedupeKey: string,
  attemptId: string,
): Promise<Claim> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const now = new Date();
    const fields = {
      status: "pending",
      mode: input.mode.kind,
      target: input.target,
      attemptId,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      folder: input.folder,
      uid: input.uid,
      uidValidity: input.uidValidity,
      actorId: scope.userId,
      errorCode: null,
    };
    const row = await tx.webmailConversion.findUnique({
      where: {
        projectId_mailboxId_dedupeKey: {
          projectId: scope.projectId,
          mailboxId,
          dedupeKey,
        },
      },
    });
    if (!row) {
      await tx.webmailConversion.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          mailboxId,
          dedupeKey,
          ...fields,
        },
      });
      return { kind: "claimed" };
    }
    if (row.status === "done" && row.recordId)
      return { kind: "done", target: row.target, recordId: row.recordId };
    if (row.status === "pending" && row.leaseUntil.getTime() > now.getTime())
      return { kind: "busy" };
    await tx.webmailConversion.update({
      where: { id: row.id },
      data: fields,
    });
    return { kind: "claimed" };
  });
}

class AttemptLost extends Error {}

export type ConvertResult =
  | { status: "pending" }
  | {
      status: "done";
      target: string;
      recordId: string;
      number: number | null;
      duplicate: boolean;
      skippedAttachments: number;
    };

/** The record of a finished conversion, as the answer to a repeated request. */
async function finished(
  scope: Scope,
  done: { target: string; recordId: string },
): Promise<ConvertResult> {
  return {
    status: "done",
    target: done.target,
    recordId: done.recordId,
    number: await scoped(scope.workspaceId, scope.projectId, (tx) =>
      recordNumber(tx, scope, done.target, done.recordId),
    ),
    duplicate: true,
    skippedAttachments: 0,
  };
}

async function readMessage(
  scope: Scope,
  connectionId: string,
  ref: MailboxMessageRef,
) {
  const maxBytes = Math.min(MAX_MESSAGE_BYTES, maxFileBytes());
  let message;
  try {
    message = await readMailboxMessage(scope, connectionId, ref, maxBytes);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw undeliverable();
  }
  if (!message) throw new DomainError("WEBMAIL_MESSAGE_NOT_FOUND", 404);
  if (message.source.byteLength > maxBytes)
    throw new DomainError("WEBMAIL_MESSAGE_TOO_LARGE", 413);
  return message.source;
}

/**
 * Hands one message to the target. The dedupe key comes from the bytes the
 * server read, so the read comes first; it is read-only, and every step with
 * an effect runs under the claim. Another attempt's live lease answers
 * "pending"; a lease that ran out is taken over.
 */
export async function convertMessage(
  scope: Scope,
  mailboxId: string,
  connectionId: string,
  input: ConvertInput,
): Promise<ConvertResult> {
  const target = targetOf(input.target);
  const effective = await targetScope(scope, target);
  const active = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    targetActive(tx, effective, target),
  );
  if (!active) throw unavailable();

  const ref = {
    folder: input.folder,
    uid: input.uid,
    uidValidity: input.uidValidity,
  };
  const source = await readMessage(scope, connectionId, ref);
  const attemptId = randomUUID();
  const dedupeKey = await dedupeKeyOf(source);
  const claimed = await claim(scope, mailboxId, input, dedupeKey, attemptId);
  if (claimed.kind === "busy") return { status: "pending" };
  if (claimed.kind === "done") return finished(scope, claimed);

  const key = {
    projectId_mailboxId_dedupeKey: {
      projectId: scope.projectId,
      mailboxId,
      dedupeKey,
    },
  };
  let prepared: EmailImportPrepared | undefined;
  const discard = async () => {
    if (prepared)
      await target.discard(effective, prepared).catch(() => undefined);
  };
  try {
    const { inboundId } = await inboundRowForImport(
      scope,
      connectionId,
      ref,
      source,
    ).catch((error) => {
      throw error instanceof DomainError ? error : undeliverable();
    });
    const ready = await target.prepare(effective, {
      source,
      connectionId,
      inboundId,
    });
    prepared = ready;
    const result = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        // A slower attempt whose lease ran out must not write next to the
        // attempt that took over.
        const row = await tx.webmailConversion.findUnique({ where: key });
        if (!row || row.status !== "pending" || row.attemptId !== attemptId)
          throw new AttemptLost();
        const committed = await target.commit(tx, effective, ready, input.mode);
        await tx.webmailConversion.update({
          where: { id: row.id },
          data: {
            status: "done",
            recordId: committed.recordId,
            inboundId,
            errorCode: null,
          },
        });
        await audit(tx, scope, "webmail.conversion.done", row.id, {
          mailboxId,
          target: input.target,
          mode: input.mode.kind,
          duplicate: committed.duplicate,
        });
        return committed;
      },
    );
    if (result.duplicate) await discard();
    return {
      status: "done",
      target: input.target,
      recordId: result.recordId,
      number: result.number,
      duplicate: result.duplicate,
      skippedAttachments: ready.skippedAttachments,
    };
  } catch (error) {
    await discard();
    if (error instanceof AttemptLost) {
      const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        tx.webmailConversion.findUnique({ where: key }),
      );
      return row?.status === "done" && row.recordId
        ? finished(scope, { target: row.target, recordId: row.recordId })
        : { status: "pending" };
    }
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.webmailConversion.updateMany({
        where: {
          projectId: scope.projectId,
          mailboxId,
          dedupeKey,
          attemptId,
          status: "pending",
        },
        data: {
          status: "failed",
          errorCode:
            error instanceof DomainError
              ? error.code
              : "WEBMAIL_CONVERT_FAILED",
        },
      }),
    ).catch(() => undefined);
    throw error;
  }
}
