import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { SchedulerContribution } from "../jobs/types.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { personalAssistantEnabled } from "../assistant/personal-space.ts";
import {
  proactiveEnabled,
  readPreferences,
  readState,
  slotsAround,
  writeState,
  type Preferences,
} from "./preferences.ts";
import { DIGEST_QUEUE } from "./digest.ts";
import { BRIEFING_QUEUE } from "./briefing.ts";

// The personal space's part of the per-project sweep (ADR 0023 items 6 and
// 8): it queues the digest and the briefing of the slot that just passed in
// the user's time zone and moves the due marker to the next slot. No cron
// and no loop: the existing pump revisits the space at `nextDueAt`. The
// first sweep after the feature (or a briefing) is switched on only records
// the current slot, so nothing is sent for the past.

/** Whether anything can end up in a digest: a digest mode, or quiet hours deferring. */
export function digestUsed(prefs: Preferences) {
  const modes = [
    ...Object.values(prefs.notifications.email),
    ...Object.values(prefs.notifications.telegram),
  ];
  return modes.includes("digest") || (prefs.quietHours.enabled && modes.includes("immediate"));
}

async function personalOwner(tx: DbTx, scope: Scope): Promise<Scope | null> {
  if (!proactiveEnabled() || !personalAssistantEnabled()) return null;
  const project = await tx.project.findFirst({
    where: { id: scope.projectId, kind: "personal" },
    select: { personalUserId: true },
  });
  if (!project?.personalUserId) return null;
  return { workspaceId: scope.workspaceId, projectId: scope.projectId, userId: project.personalUserId, role: "owner" };
}

export const proactiveScheduler: SchedulerContribution = {
  async sweep(tx, scope, at) {
    const personal = await personalOwner(tx, scope);
    if (!personal) return { queued: 0 };
    const { preferences: prefs } = await readPreferences(tx, personal);
    const { state } = await readState(tx, personal);
    const patch: Parameters<typeof writeState>[2] = {};
    let queued = 0;
    const digest = slotsAround(at, prefs.digest.time, prefs.timeZone).previous;
    if (digest) {
      const slot = digest.toISOString();
      if (!state.digestSlot) {
        patch.digestSlot = slot;
        patch.lastDigestAt = state.lastDigestAt ?? at.toISOString();
      } else if (digest > new Date(state.digestSlot)) {
        patch.digestSlot = slot;
        if (digestUsed(prefs)) {
          await enqueue(tx, personal, DIGEST_QUEUE, personal.projectId, `digest:${slot}`, at, { slot });
          queued++;
        }
      }
    }
    if (prefs.briefing.enabled) {
      const briefing = slotsAround(at, prefs.briefing.time, prefs.timeZone, prefs.briefing.rhythm).previous;
      if (briefing) {
        const slot = briefing.toISOString();
        if (!state.briefingSlot) patch.briefingSlot = slot;
        else if (briefing > new Date(state.briefingSlot)) {
          patch.briefingSlot = slot;
          await enqueue(tx, personal, BRIEFING_QUEUE, personal.projectId, `briefing:${slot}`, at, { slot });
          queued++;
        }
      }
    } else if (state.briefingSlot) patch.briefingSlot = "";
    if (Object.keys(patch).length) await writeState(tx, personal, patch);
    return { queued };
  },
  async nextDueAt(tx, scope, at) {
    const personal = await personalOwner(tx, scope);
    if (!personal) return null;
    const { preferences: prefs } = await readPreferences(tx, personal);
    const candidates = [
      slotsAround(at, prefs.digest.time, prefs.timeZone).next,
      prefs.briefing.enabled
        ? slotsAround(at, prefs.briefing.time, prefs.timeZone, prefs.briefing.rhythm).next
        : null,
    ].filter((d): d is Date => Boolean(d));
    return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  },
};
