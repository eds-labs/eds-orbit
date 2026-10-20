import { describe, expect, it } from "vitest";
import { supportSettingsDefaults, supportSettingsSchema } from "./settings.ts";

describe("support settings (WP5.1)", () => {
  it("accepts the defaults, with the Q-12b retention", () => {
    const parsed = supportSettingsSchema.parse(supportSettingsDefaults());
    expect(parsed.retention).toEqual({
      closedTicketMonths: 24,
      rawEmailDays: 90,
      aiDraftDays: 90,
      widgetSessionDays: 30,
    });
    expect(parsed.sla.normal).toEqual({
      firstResponseMinutes: 1440,
      resolutionMinutes: 4320,
    });
    expect(parsed.autoCloseDays).toBe(7);
    expect(parsed.mcpOwnerRepliesWithoutApproval).toBe(false);
    const { mcpOwnerRepliesWithoutApproval: _new, ...legacy } =
      supportSettingsDefaults();
    expect(
      supportSettingsSchema.parse(legacy).mcpOwnerRepliesWithoutApproval,
    ).toBe(false);
  });

  it("rejects duplicate category keys", () => {
    const value = {
      ...supportSettingsDefaults(),
      categories: [
        { key: "billing", label: "Billing" },
        { key: "billing", label: "Payments" },
      ],
    };
    expect(supportSettingsSchema.safeParse(value).success).toBe(false);
  });

  it("caps closed-ticket retention at 72 months", () => {
    const value = supportSettingsDefaults();
    value.retention.closedTicketMonths = 73;
    expect(supportSettingsSchema.safeParse(value).success).toBe(false);
    value.retention.closedTicketMonths = 72;
    expect(supportSettingsSchema.safeParse(value).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(
      supportSettingsSchema.safeParse({
        ...supportSettingsDefaults(),
        surprise: true,
      }).success,
    ).toBe(false);
  });
});
