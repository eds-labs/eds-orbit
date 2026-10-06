import type { Entity } from "@/lib/api";

// Autopilot drafts waiting for the owner, by slot. A draft whose slot has
// passed can no longer be scheduled at that time (INVALID_SCHEDULE).
export function autopilotApprovals(
  content: Entity[],
  missions: Entity[],
  now = Date.now(),
) {
  const autopilot = new Set(
    missions.filter((m) => m.data.autopilot === true).map((m) => m.id),
  );
  const pending = content
    .filter(
      (c) =>
        c.data.status === "needs_review" &&
        autopilot.has(String(c.data.missionId)),
    )
    .sort((a, b) =>
      String(a.data.scheduledAt).localeCompare(String(b.data.scheduledAt)),
    );
  const passed = (c: Entity) =>
    typeof c.data.scheduledAt === "string" &&
    Date.parse(c.data.scheduledAt) < now;
  return {
    due: pending.filter((c) => !passed(c)),
    missed: pending.filter(passed),
  };
}

// One refused draft must not hold back the others.
export async function approveEach(
  items: Entity[],
  approve: (c: Entity) => Promise<unknown>,
) {
  const failures: { id: string; error: string }[] = [];
  for (const c of items)
    try {
      await approve(c);
    } catch (error) {
      failures.push({
        id: c.id,
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  return failures;
}

// Posts a project pause stopped; only those still ahead can be scheduled again.
export function pausedPosts(publications: Entity[], now = Date.now()) {
  return publications
    .filter(
      (p) =>
        p.data.status === "blocked_dependency" &&
        p.data.reason === "PROJECT_PAUSED" &&
        Date.parse(String(p.data.scheduledAt)) > now,
    )
    .sort((a, b) =>
      String(a.data.scheduledAt).localeCompare(String(b.data.scheduledAt)),
    );
}
