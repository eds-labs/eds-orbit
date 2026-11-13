import { createHash, randomUUID } from "node:crypto";
import PostalMime from "postal-mime";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { connectionVerified } from "../../platform/connections/connections.ts";
import type { EmailImportPrepared } from "../../platform/email/import-contract.ts";
import {
  discardImportedRow,
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

/**
 * What the receiving module knows of a converted message's record. Only an
 * answer without the exact id means it is gone; a target that cannot be asked
 * counts as still having it, so a failed search never creates a second record.
 */
async function lookupRecord(
  tx: DbTx,
  scope: Scope,
  key: string,
  recordId: string,
): Promise<{ gone: true } | { gone: false; number: number | null }> {
  try {
    const target = targetOf(key);
    const effective = await targetScope(scope, target);
    const hits = await target.searchRecords(tx, effective, recordId);
    const hit = hits.find((record) => record.id === recordId);
    return hit ? { gone: false, number: hit.number } : { gone: true };
  } catch {
    return { gone: false, number: null };
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
  const record = await lookupRecord(tx, scope, row.target, row.recordId);
  if (record.gone) return { converted: false as const };
  return {
    converted: true as const,
    target: row.target,
    recordId: row.recordId,
    number: record.number,
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
  | { kind: "done"; target: string; recordId: string; number: number | null };

/**
 * Claims the message for this attempt, under the project's lock. A finished
 * claim whose record has since been deleted is claimed again, or the message
 * would answer "already converted" with a dead record forever.
 */
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
    if (row.status === "done" && row.recordId) {
      const record = await lookupRecord(tx, scope, row.target, row.recordId);
      if (!record.gone)
        return {
          kind: "done",
          target: row.target,
          recordId: row.recordId,
          number: record.number,
        };
    }
    if (row.status === "pending" && row.leaseUntil.getTime() > now.getTime())
      return { kind: "busy" };
    await tx.webmailConversion.update({
      where: { id: row.id },
      data: { ...fields, recordId: null, inboundId: null },
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
const finished = (done: {
  target: string;
  recordId: string;
  number: number | null;
}): ConvertResult => ({
  status: "done",
  target: done.target,
  recordId: done.recordId,
  number: done.number,
  duplicate: true,
  skippedAttachments: 0,
});

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
  if (claimed.kind === "done") return finished(claimed);

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
  // The original of a message from another folder exists only for this
  // takeover; an attempt that does not finish must not leave it behind.
  let imported: { inboundId: string; created: boolean } | undefined;
  const dropImported = async () => {
    if (imported?.created)
      await discardImportedRow(scope, imported.inboundId).catch(
        () => undefined,
      );
  };
  try {
    imported = await inboundRowForImport(
      scope,
      connectionId,
      ref,
      source,
    ).catch((error) => {
      throw error instanceof DomainError ? error : undeliverable();
    });
    const { inboundId, created } = imported;
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
            inboundId: committed.duplicate && created ? null : inboundId,
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
    if (result.duplicate) {
      await discard();
      await dropImported();
    }
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
    // A lost attempt leaves the row: the one that took over may be using it.
    if (error instanceof AttemptLost)
      return scoped(
        scope.workspaceId,
        scope.projectId,
        async (tx): Promise<ConvertResult> => {
          const row = await tx.webmailConversion.findUnique({ where: key });
          if (row?.status !== "done" || !row.recordId)
            return { status: "pending" };
          const record = await lookupRecord(
            tx,
            scope,
            row.target,
            row.recordId,
          );
          return record.gone
            ? { status: "pending" }
            : finished({
                target: row.target,
                recordId: row.recordId,
                number: record.number,
              });
        },
      );
    const ours = {
      projectId: scope.projectId,
      mailboxId,
      dedupeKey,
      attemptId,
      status: "pending",
    };
    // The row goes while the claim is held, so no retry can pick it up.
    const stillHeld = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.webmailConversion.count({ where: ours }),
    ).catch(() => 0);
    if (stillHeld) await dropImported();
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.webmailConversion.updateMany({
        where: ours,
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
