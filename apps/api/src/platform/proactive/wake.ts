import { findPersonalSpace } from "../assistant/personal-space.ts";
import { publishChange, realtimeEnabled } from "../realtime/fanout.ts";

// The badge's real-time wake-up (ADR 0023 item 9, plan §2.4): after a
// notification row committed, the writer publishes an empty message on the
// recipient's personal-space channel. It carries no content, not even the
// project: the client reads the summary again. The personal space id is
// resolved without opening its transaction. Without a personal space (or
// with Redis down) the client polls once a minute instead.

/** The stream name of a user's notification wake-ups in their personal space. */
export const notificationStream = (personalSpaceId: string) =>
  `notifications:${personalSpaceId}`;

/** Best effort and never throws: a lost wake-up costs up to a minute of latency. */
export async function publishNotificationWake(workspaceId: string, userId: string) {
  if (!realtimeEnabled()) return;
  try {
    const space = await findPersonalSpace(workspaceId, userId);
    if (!space) return;
    await publishChange(space.id, notificationStream(space.id));
  } catch {
    // The database holds the notice; the next poll shows it.
  }
}
