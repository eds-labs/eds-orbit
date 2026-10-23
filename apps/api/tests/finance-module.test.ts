import { afterEach, describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { financeModule } from "../src/modules/finance/manifest.ts";
import { financeContributions } from "../src/modules/finance/contributions.ts";
import { financeSwitchedOn } from "../src/modules/finance/gate.ts";
import { financeSettingsSchema } from "../src/modules/finance/settings.ts";

describe("finance module skeleton", () => {
  afterEach(() => {
    delete process.env.ORBIT_FINANCE;
  });

  it("registers finance with sensitive permissions", () => {
    expect(modules).toContain(financeModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(financeModule).toMatchObject({
      id: "finance",
      version: "1.0.0",
      displayName: { en: "Finance", de: "Finanzen" },
      dependsOn: [],
      defaultEnabled: false,
    });
    expect(
      financeModule.permissions.map((p) => [
        p.key,
        [...p.defaultRoles],
        p.sensitive,
      ]),
    ).toEqual([
      ["finance.read", ["owner", "editor"], true],
      ["finance.write", ["owner", "editor"], true],
      ["finance.export", ["owner", "editor"], true],
      ["finance.settings", ["owner"], true],
    ]);
  });

  it("is unavailable while ORBIT_FINANCE is off", () => {
    expect(financeSwitchedOn()).toBe(false);
    expect(financeContributions.available?.()).toBe(false);
    process.env.ORBIT_FINANCE = "true";
    expect(financeSwitchedOn()).toBe(true);
    expect(financeContributions.available?.()).toBe(true);
  });

  it("settings defaults", () => {
    expect(financeSettingsSchema.parse({})).toEqual({
      baseCurrency: "USD",
      currencies: ["USD", "EUR", "USDC"],
      usdcPeg: "1.000000",
      fxSource: "ecb",
      aiExtraction: "off",
      aiDailyCeilingMicros: 2_000_000,
      archiveAfter: "extracted",
      retentionYears: 10,
      duplicateWindowDays: 3,
      reviewConfidence: 0.85,
    });
  });

  it("rejects unknown currency in settings", () => {
    expect(
      financeSettingsSchema.safeParse({ currencies: ["USD", "XYZ"] }).success,
    ).toBe(false);
    expect(
      financeSettingsSchema.safeParse({ baseCurrency: "XYZ" }).success,
    ).toBe(false);
    // The base currency must be one of the project's currencies.
    expect(
      financeSettingsSchema.safeParse({ baseCurrency: "GBP" }).success,
    ).toBe(false);
    expect(financeSettingsSchema.safeParse({ unknownKey: true }).success).toBe(
      false,
    );
  });
});
