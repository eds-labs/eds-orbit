import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, update } from "../../../shared.ts";

export const BOOKING_KNOWLEDGE_REVIEW = "BOOKING_KNOWLEDGE_REVIEW";
export const BOOKING_PROFILE_REVIEW = "BOOKING_PROFILE_REVIEW";

export type BookingReview = {
  reasons: string[];
  evidenceVersion?: number;
  profileVersion?: number;
};

type Row = Awaited<ReturnType<DbTx["entity"]["findMany"]>>[number];

/** The approval itself is verified again against the exact package at dispatch. */
export function reviewableBookings(rows: Row[]) {
  const approvals = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "approvals" &&
          ["approved", "consumed"].includes(data(row).status),
      )
      .map((row) => `${data(row).contentId}:${data(row).packageHash}`),
  );
  const contents = new Map(
    rows.filter((row) => row.kind === "content").map((row) => [row.id, row]),
  );
  return rows.filter((row) => {
    if (row.kind !== "publications") return false;
    const booking = data(row);
    const content = contents.get(booking.contentId);
    const beforeHandoff =
      ["intent_created", "sending"].includes(booking.status) && !booking.remoteId;
    const inSocial =
      booking.status === "scheduled_remote" &&
      booking.publishingBackend === "social" &&
      typeof booking.remoteId === "string" &&
      Boolean(booking.handoffCompletedAt);
    return (
      booking.test === false &&
      (beforeHandoff || inSocial) &&
      !booking.vetoedAt &&
      booking.reconciliationStatus !== "required" &&
      !!content &&
      content.version === booking.contentVersion &&
      data(content).type === "social" &&
      data(content).status === "reviewed" &&
      row.createdAt.valueOf() < Date.parse(booking.scheduledAt) &&
      (typeof booking.ownerReleasedBy === "string" ||
        approvals.has(`${content.id}:${booking.packageHash}`))
    );
  });
}

export async function adviseBookingReview(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  booking: Row,
  reason: string,
  versions: Omit<BookingReview, "reasons">,
) {
  const previous = data(booking).reviewAdvised as BookingReview | undefined;
  const next = {
    ...versions,
    ...previous,
    reasons: [...new Set([...(previous?.reasons ?? []), reason])],
  };
  if (previous && next.reasons.length === previous.reasons.length) return;
  await update(tx, scope, booking, { ...data(booking), reviewAdvised: next });
}
