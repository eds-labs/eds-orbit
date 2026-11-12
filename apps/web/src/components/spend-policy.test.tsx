import { describe, expect, it } from "vitest";
import { choiceOf, spendPolicyPayload } from "./spend-policy";

// F-8 risk 6: an unchanged monthly authority is not saved again while its
// window is open, because the server would derive day and run anew and
// restart the year. Every other save opens a new window and is sent.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const OPEN = "2027-06-01T00:00:00.000Z";
const EXPIRED = "2026-11-01T00:00:00.000Z";

describe("spending authority form", () => {
  it("sends nothing when an open monthly authority is saved unchanged (risk 6)", () => {
    const record = {
      id: "r",
      version: 1,
      profile: "monthly" as const,
      monthlyBudgetMicros: 25_000_000,
      dailyBudgetMicros: 4_000_000,
      perRunBudgetMicros: 1_000_000,
      endAt: OPEN,
    };
    expect(spendPolicyPayload({ profile: "monthly", amount: "25" }, record, NOW)).toBeNull();
    expect(spendPolicyPayload({ profile: "monthly", amount: "30" }, record, NOW)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 30_000_000,
    });
  });

  it("renews an expired monthly authority with the same amount (C1)", () => {
    const expired = { id: "r", version: 2, profile: "monthly" as const, monthlyBudgetMicros: 10_000_000, endAt: EXPIRED };
    expect(spendPolicyPayload({ profile: "monthly-10" }, expired, NOW)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 10_000_000,
    });
  });

  it("sends a monthly authority whose window end cannot be read", () => {
    const noEnd = { id: "r", version: 2, profile: "monthly" as const, monthlyBudgetMicros: 10_000_000 };
    expect(spendPolicyPayload({ profile: "monthly-10" }, noEnd, NOW)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 10_000_000,
    });
    const badEnd = { ...noEnd, endAt: "not a date" };
    expect(spendPolicyPayload({ profile: "monthly-10" }, badEnd, NOW)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 10_000_000,
    });
  });

  it("sends nothing for an unchanged open preset amount, but always for test, off and custom", () => {
    const monthly10 = { id: "r", version: 2, profile: "monthly" as const, monthlyBudgetMicros: 10_000_000, endAt: OPEN };
    expect(spendPolicyPayload({ profile: "monthly-10" }, monthly10, NOW)).toBeNull();
    expect(spendPolicyPayload({ profile: "monthly-50" }, monthly10, NOW)).toEqual({
      profile: "monthly",
      monthlyBudgetMicros: 50_000_000,
    });
    // "test" and "off" mean "from now": re-saving them opens a new window.
    const test = { id: "r", version: 3, profile: "test" as const, endAt: OPEN };
    expect(spendPolicyPayload({ profile: "test" }, test, NOW)).toEqual({ profile: "test" });
    expect(spendPolicyPayload({ profile: "test" }, { ...test, endAt: EXPIRED }, NOW)).toEqual({ profile: "test" });
    const off = { id: "r", version: 3, profile: "off" as const, endAt: OPEN };
    expect(spendPolicyPayload({ profile: "off" }, off, NOW)).toEqual({ profile: "off" });
    expect(spendPolicyPayload({ profile: "off" }, test, NOW)).toEqual({ profile: "off" });
    expect(spendPolicyPayload({ profile: "off" }, null, NOW)).toEqual({ profile: "off" });
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
        NOW,
      ),
    ).toMatchObject({ profile: "custom", dailyBudgetMicros: 1_000_000 });
  });

  it("preselects no profile without a record", () => {
    expect(choiceOf({ record: null })).toBe("");
    expect(choiceOf({ record: { id: "r", version: 1, profile: "monthly", monthlyBudgetMicros: 50_000_000 } })).toBe("monthly-50");
  });
});
