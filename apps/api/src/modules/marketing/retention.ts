import type { RetentionContribution } from "../../platform/governance/types.ts";
import { list, data } from "../../shared.ts";
import { memoryLifecycle } from "./analytics/lifecycle.ts";

/**
 * Marketing memory past the retention period (WP1.8, moved unchanged from
 * `retention`): insights not updated since the cutoff and preferences valid
 * only until before it are deleted with their history.
 */
export const marketingRetention: RetentionContribution = async (
  tx,
  scope,
  { cutoff },
) => {
  const expired = (await list(tx, scope, "insights")).filter(
    (x) =>
      x.updatedAt < cutoff &&
      !["deleted", "invalidated"].includes(data(x).status),
  );
  for (const row of expired)
    await memoryLifecycle(tx, scope, "insights", row.id, row.version, "delete");
  const expiredPrefs = (await list(tx, scope, "preferences")).filter(
    (x) =>
      data(x).validUntil &&
      new Date(data(x).validUntil) < cutoff &&
      data(x).status !== "deleted",
  );
  for (const row of expiredPrefs)
    await memoryLifecycle(
      tx,
      scope,
      "preferences",
      row.id,
      row.version,
      "delete",
    );
  return {
    audit: { insights: expired.length, preferences: expiredPrefs.length },
    result: {
      purgedInsights: expired.length,
      purgedPreferences: expiredPrefs.length,
    },
  };
};
