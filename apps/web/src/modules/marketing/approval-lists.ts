import type { Entity } from "@/lib/api";

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

// A resolved exception is history; an open one shows when it was last seen.
export function openExceptions(exceptions: Entity[]) {
  return exceptions
    .filter((e) => e.data.status === "open")
    .sort((a, b) =>
      String(b.data.lastSeenAt).localeCompare(String(a.data.lastSeenAt)),
    );
}
