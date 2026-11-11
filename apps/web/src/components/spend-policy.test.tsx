import { describe, expect, it } from "vitest";
import { choiceOf, spendPolicyPayload } from "./spend-policy";

// F-8 risk 6: an unchanged monthly authority is not saved again, because the
// server would derive day and run anew and restart the year.
describe("spending authority form", () => {
  it("sends nothing when a monthly authority is saved unchanged (risk 6)", () => {
    const record = {
      id: "r",
      version: 1,
      profile: "monthly" as const,
      monthlyBudgetMicros: 25_000_000,
      dailyBudgetMicros: 4_000_000,
      perRunBudgetMicros: 1_000_000,
    };
    expect(spendPolicyPayload({ profile: "monthly", amount: "25" }, record)).toBeNull();
    expect(spendPolicyPayload({ profile: "monthly", amount: "30" }, record)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 30_000_000,
    });
  });

  it("sends nothing for an unchanged preset amount or profile, but always for custom", () => {
    const monthly10 = { id: "r", version: 2, profile: "monthly" as const, monthlyBudgetMicros: 10_000_000 };
    expect(spendPolicyPayload({ profile: "monthly-10" }, monthly10)).toBeNull();
    expect(spendPolicyPayload({ profile: "monthly-50" }, monthly10)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 50_000_000,
    });
    const test = { id: "r", version: 3, profile: "test" as const };
    expect(spendPolicyPayload({ profile: "test" }, test)).toBeNull();
    expect(spendPolicyPayload({ profile: "off" }, test)).toEqual({ profile: "off" });
    expect(spendPolicyPayload({ profile: "off" }, null)).toEqual({ profile: "off" });
    const custom = { id: "r", version: 4, profile: "custom" as const };
    expect(
      spendPolicyPayload(
        {
          profile: "custom",
          startAt: "2026-11-01T00:00",
          endAt: "2026-12-01T00:00",
          approvedPaidUse: true,
          daily: "1",
          monthly: "10",
          perRun: "0.5",
        },
        custom,
      ),
    ).toMatchObject({ profile: "custom", dailyBudgetMicros: 1_000_000 });
  });

  it("preselects no profile without a record", () => {
    expect(choiceOf({ record: null })).toBe("");
    expect(choiceOf({ record: { id: "r", version: 1, profile: "monthly", monthlyBudgetMicros: 50_000_000 } })).toBe("monthly-50");
  });
});
