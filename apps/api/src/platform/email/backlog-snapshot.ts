import {
  scoped,
  scopedRead,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { create, data } from "../shared.ts";
import { INBOUND_BACKLOG_KIND } from "./connection.ts";
import type { MailboxReader } from "./transport.ts";

// The backlog of a mailbox a second client works on (ADR 0026). The first scan
// lists the unread UIDs once; later passes work from that list, so a client
// reading a message cannot take it out of the backlog. The list has its own
// row because the state row is copied into the history on every update.

const CAP = 5000;
const RESTART_MARGIN_MS = 48 * 3600_000;

export type BacklogSnapshot = {
  uidValidity: string;
  /** The INBOX's highest UID when the backlog began. */
  until: number;
  /** Ascending, the lowest `CAP` of the list. */
  uids: number[];
  /** How many UIDs above the last listed one did not fit. */
  overflow: number;
};

export type BacklogState = {
  uidValidity?: string;
  lastUid: number;
  backlogUntil?: number;
  checkedAt?: string;
};

async function rowsOf(tx: DbTx, scope: Scope, connectionId: string) {
  return tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: INBOUND_BACKLOG_KIND,
      data: { path: ["connectionId"], equals: connectionId },
    },
  });
}

export async function loadBacklogSnapshot(
  scope: Scope,
  connectionId: string,
): Promise<BacklogSnapshot | null> {
  const [row] = await scopedRead(scope.workspaceId, scope.projectId, (tx) =>
    rowsOf(tx, scope, connectionId),
  );
  if (!row) return null;
  const d = data(row);
  return {
    uidValidity: String(d.uidValidity),
    until: Number(d.until),
    uids: d.uids as number[],
    overflow: Number(d.overflow ?? 0),
  };
}

export async function dropBacklogSnapshot(scope: Scope, connectionId: string) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const rows = await rowsOf(tx, scope, connectionId);
    if (rows.length)
      await tx.entity.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          id: { in: rows.map((row) => row.id) },
        },
      });
  });
}

/**
 * The snapshot of the running backlog; the first scan of a backlog writes it.
 * After a UIDVALIDITY change it also lists what arrived around the last pass,
 * read or not, and the dedupe keys keep that free of duplicates.
 */
export async function ensureBacklogSnapshot(
  scope: Scope,
  connectionId: string,
  reader: MailboxReader,
  scan: { uidValidity: string; top: number; unseen: number[] },
  state: BacklogState,
): Promise<BacklogSnapshot> {
  const existing = await loadBacklogSnapshot(scope, connectionId);
  if (existing?.uidValidity === scan.uidValidity) return existing;
  const restart = scan.uidValidity !== state.uidValidity;
  const until = restart ? scan.top : (state.backlogUntil ?? scan.top);
  const from = restart ? 0 : state.lastUid;
  const checkedAt = state.checkedAt ? Date.parse(state.checkedAt) : Number.NaN;
  const recent =
    restart &&
    state.uidValidity !== undefined &&
    !Number.isNaN(checkedAt) &&
    reader.searchSince
      ? await reader.searchSince(new Date(checkedAt - RESTART_MARGIN_MS))
      : [];
  const listed = [...new Set([...scan.unseen, ...recent])]
    .filter((uid) => uid > from && uid <= until)
    .sort((a, b) => a - b);
  const snapshot: BacklogSnapshot = {
    uidValidity: scan.uidValidity,
    until,
    uids: listed.slice(0, CAP),
    overflow: Math.max(0, listed.length - CAP),
  };
  await dropBacklogSnapshot(scope, connectionId);
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    create(tx, scope, INBOUND_BACKLOG_KIND, { connectionId, ...snapshot }),
  );
  return snapshot;
}
