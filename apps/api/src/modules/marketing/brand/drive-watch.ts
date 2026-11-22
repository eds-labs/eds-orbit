import { createHash } from "node:crypto";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import {
  driveAccessToken,
  driveContent,
  driveReconnectRequired,
  projectDriveRow,
} from "../../../platform/connections/google-drive.ts";
import { notifyMembers } from "../../../platform/notifications/members.ts";
import { resolveRecipients } from "../../../platform/signals/deliver.ts";
import { registeredUserNotification } from "../../../platform/modules/contributions.ts";
import { projectCenterLink } from "../../../platform/management/links.ts";
import { audit, create, data, DomainError, list, update } from "../../../shared.ts";
import { notify } from "../agents/notifications.ts";
import { isApprovedAsset, isRasterMime } from "./asset-rules.ts";

/**
 * Drive connection watch: Google's refresh grant can end without any Orbit
 * activity (seven days for an OAuth app in "Testing", a revoked grant, a
 * changed password). Without a watch the owner learns it only when an
 * assignment fails to read a brand image. This task refreshes the project's
 * Drive access a few times a day, warns the owners once per outage (member
 * notice and Telegram) and says so when Drive works again. While Drive works
 * it also keeps a verified local copy of approved Drive-only images, so a
 * later outage no longer stops banners, creatives or posts that use them.
 * It never changes a connection, a folder or a Drive file.
 */

/** Installation flag of the Drive watch (default off). */
export const driveWatchEnabled = () =>
  loadConfig().ORBIT_DRIVE_WATCH === "true";

/** A live refresh at most this often per project. */
export const DRIVE_WATCH_INTERVAL_MS = 6 * 3600_000;
/** The recorded state is read at most this often per project and worker. */
const READ_THROTTLE_MS = 5 * 60_000;
/** Local copies are kept for images up to this size. */
export const LOCAL_COPY_MAX_BYTES = 5_000_000;
/** At most this many local copies are made per pass. */
export const LOCAL_COPIES_PER_PASS = 5;
/** A copy that failed is tried again after this long. */
export const LOCAL_COPY_RETRY_MS = 24 * 3600_000;

/** The watch's memory of one project (kind `drive_watch`). */
export type DriveWatchState = {
  lastCheckedAt: string | null;
  broken: boolean;
  /** The recorded OAuth error code while broken (`invalid_grant`, `HTTP_401`, ...). */
  errorCode: string | null;
  brokenSince: string | null;
  recoveredAt: string | null;
  /** The notice (ref) that last reported a change. */
  lastNoticeRef: string | null;
};

/** What changed since the last pass: a new outage, a recovery, or nothing. */
export function driveWatchTransition(
  prev: Pick<DriveWatchState, "broken"> | null,
  broken: boolean,
): "broken" | "recovered" | null {
  if (broken && !prev?.broken) return "broken";
  if (!broken && prev?.broken) return "recovered";
  return null;
}

/** Whether a live refresh is due (never checked, or the interval has passed). */
export function driveCheckDue(
  prev: Pick<DriveWatchState, "lastCheckedAt"> | null,
  now: Date,
): boolean {
  const last = Date.parse(prev?.lastCheckedAt ?? "");
  return !Number.isFinite(last) || now.valueOf() - last >= DRIVE_WATCH_INTERVAL_MS;
}

/**
 * Whether an asset should get a local copy: an approved raster image whose
 * bytes exist only in Drive, pinned to one Drive version (`md5Checksum`),
 * small enough, and not failed within the retry time.
 */
export function needsLocalCopy(d: Record<string, any>, now: Date): boolean {
  if (typeof d.driveFileId !== "string" || !d.driveFileId || d.base64) return false;
  if (typeof d.md5Checksum !== "string" || !d.md5Checksum) return false;
  if (!isRasterMime(d.mime) || !isApprovedAsset(d)) return false;
  if (Number(d.bytes ?? 0) > LOCAL_COPY_MAX_BYTES) return false;
  const failed = Date.parse(d.localCopyFailedAt ?? "");
  return !Number.isFinite(failed) || now.valueOf() - failed >= LOCAL_COPY_RETRY_MS;
}

const reads = new Map<string, number>();
/** Test hook: forget the per-project read throttle. */
export function resetDriveWatchThrottle() {
  reads.clear();
}

const connected = (row: { data: unknown } | null | undefined) =>
  Boolean(row && data(row).encryptedRefreshToken);

const NOTICE = {
  broken: {
    de: (code: string | null) =>
      `Google hat den Drive-Zugriff abgelehnt${code ? ` (${code})` : ""}. Aufträge können Bilder, die nur in Drive liegen, nicht mehr laden. Bitte Google Drive in den Integrationen neu verbinden. Läuft die Verbindung regelmäßig nach etwa sieben Tagen ab, steht die OAuth-App in der Google Cloud Console noch im Status „Testing“.`,
    en: (code: string | null) =>
      `Google rejected Drive access${code ? ` (${code})` : ""}. Assignments can no longer load images that exist only in Drive. Please reconnect Google Drive in the integrations. If the connection drops about every seven days, the OAuth app in the Google Cloud Console is still in the “Testing” publishing status.`,
  },
  recovered: {
    de: () => "Google Drive ist wieder verbunden. Es ist nichts mehr zu tun.",
    en: () => "Google Drive is connected again. Nothing else to do.",
  },
} as const;

const KINDS = {
  broken: "marketing_drive_reconnect_required",
  recovered: "marketing_drive_reconnected",
} as const;

async function writeState(
  tx: DbTx,
  scope: Scope,
  next: DriveWatchState,
): Promise<void> {
  const row = (await list(tx, scope, "drive_watch"))[0];
  // Single-flight comes from the project lease of the worker's project pass
  // (apps/worker/src/due-marker.ts), as for the released-post watch.
  if (row) await update(tx, scope, row, next);
  else await create(tx, scope, "drive_watch", next);
}

async function announce(
  tx: DbTx,
  scope: Scope,
  change: "broken" | "recovered",
  state: DriveWatchState,
) {
  await audit(
    tx,
    scope,
    change === "broken" ? "drive.reconnect_required" : "drive.reconnected",
    scope.projectId,
    { errorCode: state.errorCode },
  );
  const owners = await resolveRecipients(scope, { roles: ["owner"] }, "marketing");
  if (owners.length) {
    const project = await tx.project.findFirstOrThrow({
      where: { id: scope.projectId },
      select: { language: true },
    });
    const language = project.language === "de" ? "de" : "en";
    await notifyMembers(tx, scope, {
      kind: KINDS[change],
      userIds: owners.slice(0, 200),
      title: registeredUserNotification(KINDS[change])!.label[language],
      body: NOTICE[change][language](state.errorCode),
      link: projectCenterLink(scope.projectId, "integrations", "google-drive"),
    });
  }
  await notify(
    tx,
    scope,
    change === "broken" ? "drive_reconnect" : "drive_reconnected",
    state.lastNoticeRef!,
  );
}

/**
 * Keeps a verified local copy of up to `limit` approved Drive-only images:
 * the Drive bytes must match the pinned `md5Checksum` (the version the owner
 * approved) and the asset must still be unchanged when the copy is written.
 * A failed copy is noted and tried again a day later. Returns the number of
 * copies made.
 */
export async function keepLocalCopies(
  scope: Scope,
  now = new Date(),
  limit = LOCAL_COPIES_PER_PASS,
): Promise<number> {
  // Only approved assets are loaded (most stored images are not approved
  // references or drafts); eligibility is decided on each row.
  const due = await scoped(scope.workspaceId, scope.projectId, async (tx) =>
    (
      await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "assets",
          data: { path: ["usageApproved"], equals: true },
        },
        orderBy: { updatedAt: "asc" },
      })
    )
      .filter((row) => needsLocalCopy(data(row), now))
      .slice(0, limit)
      .map((row) => ({ id: row.id, d: data(row) })),
  );
  let copied = 0;
  for (const { id, d } of due) {
    let copy: { base64: string; sha256: string } | null = null;
    try {
      const content = await driveContent(scope, d.driveFileId, {
        md5Checksum: d.md5Checksum,
      });
      if (content.mime !== d.mime) throw new DomainError("DRIVE_ASSET_CHANGED", 409);
      if (createHash("md5").update(content.bytes).digest("hex") !== d.md5Checksum)
        throw new DomainError("DRIVE_ASSET_CHANGED", 409);
      if (content.bytes.length > LOCAL_COPY_MAX_BYTES)
        throw new DomainError("GOOGLE_DRIVE_PREVIEW_TOO_LARGE", 413);
      copy = {
        base64: content.bytes.toString("base64"),
        sha256: createHash("sha256").update(content.bytes).digest("hex"),
      };
    } catch (error) {
      // A failed access (broken or briefly unavailable) ends the pass
      // without marking the asset; the watch reports an outage.
      if (
        error instanceof DomainError &&
        ["GOOGLE_DRIVE_OAUTH_FAILED", "GOOGLE_DRIVE_RECONNECT_REQUIRED"].includes(error.code)
      )
        break;
      if (!(error instanceof DomainError)) throw error;
    }
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await tx.entity.findFirst({
        where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId, kind: "assets" },
      });
      if (!row) return;
      const current = data(row);
      // Written only over the exact version that was read.
      if (
        current.base64 ||
        current.driveFileId !== d.driveFileId ||
        current.md5Checksum !== d.md5Checksum
      )
        return;
      await update(
        tx,
        scope,
        row,
        copy
          ? {
              ...current,
              base64: copy.base64,
              sha256: copy.sha256,
              localCopySource: "drive",
              localCopyAt: now.toISOString(),
              localCopyFailedAt: undefined,
            }
          : { ...current, localCopyFailedAt: now.toISOString() },
      );
      if (copy) copied += 1;
    });
  }
  return copied;
}

/**
 * One pass for a project: reads the recorded Drive state, refreshes the
 * access when due, reports a new outage or a recovery once, and keeps local
 * copies while Drive works. With the flag off, or without a Drive
 * connection, it does nothing.
 */
export async function runDriveWatch(
  scope: Scope,
  now = new Date(),
): Promise<{ status?: string; wakeAt?: Date } | void> {
  if (!driveWatchEnabled()) return;
  const lastRead = reads.get(scope.projectId);
  if (lastRead !== undefined && now.valueOf() - lastRead < READ_THROTTLE_MS) return;
  reads.set(scope.projectId, now.valueOf());

  const read = () =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const connection = await projectDriveRow(tx, scope, "drive_connection");
      const watch = (await list(tx, scope, "drive_watch"))[0];
      return { connection, prev: watch ? (data(watch) as DriveWatchState) : null };
    });
  let { connection, prev } = await read();
  if (!connected(connection)) return;

  let checkedAt = prev?.lastCheckedAt ?? null;
  let liveChecked = false;
  // A failure recorded by any other Drive call already says enough.
  if (!driveReconnectRequired(connection) && driveCheckDue(prev, now)) {
    try {
      // A rejected refresh (400/401/403) is recorded on the connection.
      await driveAccessToken(scope);
    } catch {
      // Transient errors (rate limit, timeout) are not an outage.
    }
    checkedAt = now.toISOString();
    liveChecked = true;
    ({ connection } = await read());
    if (!connected(connection)) return;
  }

  const broken = driveReconnectRequired(connection);
  const change = driveWatchTransition(prev, broken);
  const stamp = now.toISOString();
  const next: DriveWatchState = {
    lastCheckedAt: checkedAt,
    broken,
    errorCode: broken ? (data(connection).lastRefreshErrorCode ?? null) : null,
    brokenSince: broken ? (prev?.broken ? (prev.brokenSince ?? stamp) : stamp) : null,
    recoveredAt: change === "recovered" ? stamp : (prev?.recoveredAt ?? null),
    // The pass time makes the ref specific to this episode: job keys are permanent.
    lastNoticeRef: change ? `${scope.projectId}:${stamp}` : (prev?.lastNoticeRef ?? null),
  };
  const unchanged =
    prev &&
    !change &&
    prev.lastCheckedAt === next.lastCheckedAt &&
    prev.errorCode === next.errorCode;
  if (!unchanged)
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await writeState(tx, scope, next);
      if (change) await announce(tx, scope, change, next);
    });

  // Copies are made with a live check (at most every six hours) or right
  // after a recovery, never on every pass.
  if (!broken && (liveChecked || change === "recovered")) {
    try {
      await keepLocalCopies(scope, now);
    } catch (error) {
      console.warn(
        `drive-watch: local copies of project ${scope.projectId} failed (${error instanceof Error ? error.name : "error"})`,
      );
    }
  }
  const last = Date.parse(next.lastCheckedAt ?? "");
  return Number.isFinite(last)
    ? { wakeAt: new Date(last + DRIVE_WATCH_INTERVAL_MS) }
    : undefined;
}

/** When the watch is next due: the next live refresh; null without a connection or with the flag off. */
export async function nextDriveWatchAt(
  tx: DbTx,
  scope: Scope,
): Promise<Date | null> {
  if (!driveWatchEnabled()) return null;
  const connection = await projectDriveRow(tx, scope, "drive_connection");
  if (!connected(connection) || driveReconnectRequired(connection)) return null;
  const watch = (await list(tx, scope, "drive_watch"))[0];
  const last = Date.parse(watch ? (data(watch).lastCheckedAt ?? "") : "");
  return new Date(Number.isFinite(last) ? last + DRIVE_WATCH_INTERVAL_MS : Date.now());
}

export const driveConnectionWatch: PeriodicTask = {
  name: "drive-watch",
  nextDueAt: nextDriveWatchAt,
  run: (scope) => runDriveWatch(scope),
};
