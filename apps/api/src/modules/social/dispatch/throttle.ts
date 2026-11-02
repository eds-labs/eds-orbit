import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { SocialPlatform } from "../accounts/store.ts";

// Outbound limits per account (ADR 0020 §7 "Rate limits"), conservative
// defaults below the platforms' own: Telegram about 20 posts a minute per
// channel, X 100 posts per 15 minutes per user, Instagram 50 API posts a
// day (the live quota is read as well). Counted in fixed UTC windows; the
// project lock every scoped transaction holds keeps the counts exact.

type Window = "minute" | "hour" | "day";
export const THROTTLE: Record<SocialPlatform, Array<{ window: Window; max: number }>> = {
  telegram: [{ window: "minute", max: 20 }],
  x: [
    { window: "minute", max: 6 },
    { window: "day", max: 300 },
  ],
  instagram: [{ window: "day", max: 50 }],
  facebook: [{ window: "hour", max: 30 }],
};
const LENGTH: Record<Window, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

const windowStart = (window: Window, now: Date) => new Date(Math.floor(now.getTime() / LENGTH[window]) * LENGTH[window]);

/** Counts one send for the account, or says when the next one may go. */
export async function takeThrottle(
  tx: DbTx,
  scope: Scope,
  account: { id: string; platform: SocialPlatform },
  now: Date,
): Promise<{ ok: true } | { ok: false; until: Date }> {
  const rules = THROTTLE[account.platform];
  for (const rule of rules) {
    const start = windowStart(rule.window, now);
    const row = await tx.socialAccountThrottle.findUnique({
      where: { accountId_window_windowStart: { accountId: account.id, window: rule.window, windowStart: start } },
    });
    if ((row?.count ?? 0) >= rule.max) return { ok: false, until: new Date(start.getTime() + LENGTH[rule.window]) };
  }
  for (const rule of rules) {
    const start = windowStart(rule.window, now);
    await tx.socialAccountThrottle.upsert({
      where: { accountId_window_windowStart: { accountId: account.id, window: rule.window, windowStart: start } },
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        accountId: account.id,
        window: rule.window,
        windowStart: start,
        count: 1,
      },
      update: { count: { increment: 1 } },
    });
  }
  return { ok: true };
}
