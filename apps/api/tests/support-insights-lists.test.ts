import { describe, expect, it } from "vitest";
import { OPEN_STATUSES } from "../src/modules/support/common.ts";
import { SUPPORT_PRIORITIES } from "../src/modules/support/settings.ts";
import {
  SUPPORT_INSIGHTS_OPEN_STATUSES,
  SUPPORT_INSIGHTS_PRIORITIES,
  supportInsightsOutput,
} from "../src/modules/support/tools.ts";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../src/modules/support/workspace.ts";

// Track M WP-M5 (D-M5-6): `support_insights` keeps its own literal lists for
// its strict output schema (zod enums). They must equal the module's sources
// of truth, or a new status or priority would make every call fail its
// output schema (REQUEST_FAILED) until someone noticed.

const sorted = (values: readonly string[]) => [...values].sort();

describe("support_insights lists stay in sync with the support module", () => {
  it("open statuses equal OPEN_STATUSES (common.ts)", () => {
    expect(sorted(SUPPORT_INSIGHTS_OPEN_STATUSES)).toEqual(
      sorted(OPEN_STATUSES),
    );
  });

  it("the tool counts every status except resolved and closed, so they are the open ones", () => {
    expect(
      sorted(TICKET_STATUSES.filter((s) => s !== "resolved" && s !== "closed")),
    ).toEqual(sorted(OPEN_STATUSES));
  });

  it("priorities equal the settings' list (and the workspace's)", () => {
    expect(sorted(SUPPORT_INSIGHTS_PRIORITIES)).toEqual(
      sorted(SUPPORT_PRIORITIES),
    );
    expect(sorted(TICKET_PRIORITIES)).toEqual(sorted(SUPPORT_PRIORITIES));
  });

  it("the output schema accepts a count for every open status and priority", () => {
    const parsed = supportInsightsOutput.safeParse({
      available: true,
      open: 0,
      unassigned: 0,
      atRisk: 0,
      breached: 0,
      byStatus: Object.fromEntries(OPEN_STATUSES.map((s) => [s, 1])),
      byPriority: Object.fromEntries(SUPPORT_PRIORITIES.map((p) => [p, 1])),
      byCategory: {},
    });
    expect(parsed.success).toBe(true);
  });
});
