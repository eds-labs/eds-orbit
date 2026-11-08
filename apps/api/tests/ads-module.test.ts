import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { adsModule } from "../src/modules/ads/manifest.ts";
import { adsContributions } from "../src/modules/ads/contributions.ts";
import { adsSwitchedOn } from "../src/modules/ads/gate.ts";
import { adsSettingsSchema, defaultAdsSettings } from "../src/modules/ads/settings.ts";

describe("ads module skeleton (ADR 0025)", () => {
  const clear = () => {
    delete process.env.ORBIT_ADS;
  };
  beforeEach(clear);
  afterEach(clear);

  it("ORBIT_ADS defaults to false and accepts only false or true", () => {
    expect(loadConfig().ORBIT_ADS).toBe("false");
    process.env.ORBIT_ADS = "true";
    expect(loadConfig().ORBIT_ADS).toBe("true");
    process.env.ORBIT_ADS = "yes";
    expect(() => loadConfig()).toThrow();
  });

  it("registers ads as an opt-in module with sensitive read permissions", () => {
    expect(modules).toContain(adsModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(adsModule).toMatchObject({
      id: "ads",
      version: "0.1.0",
      displayName: { en: "Ads", de: "Werbung" },
      dependsOn: [],
      defaultEnabled: false,
      entityKinds: [],
    });
    expect(
      adsModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true]),
    ).toEqual([
      ["ads.read", ["owner", "editor"], true],
      ["ads.analytics.read", ["owner", "editor"], true],
      ["ads.compose", ["owner", "editor"], false],
      ["ads.manage", ["owner", "editor"], false],
      ["ads.approve", ["owner"], true],
      ["ads.accounts.manage", ["owner"], true],
      ["ads.budget.manage", ["owner"], true],
      ["ads.settings", ["owner"], false],
    ]);
  });

  it("is switched off unless ORBIT_ADS=true", () => {
    expect(adsSwitchedOn()).toBe(false);
    process.env.ORBIT_ADS = "true";
    expect(adsSwitchedOn()).toBe(true);
    expect(adsContributions.unavailableCode).toBe("ADS_DISABLED");
  });

  it("defaults to owner decisions and refuses unknown or out-of-range settings", () => {
    expect(adsSettingsSchema.parse(defaultAdsSettings())).toEqual(defaultAdsSettings());
    expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), decider: "editor" })).toThrow();
    expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), backfillDays: 0 })).toThrow();
    expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), insightsRetentionMonths: 12 })).toThrow();
    expect(() => adsSettingsSchema.parse({ ...defaultAdsSettings(), extra: 1 })).toThrow();
  });

  it("lists every Ad* table in the manifest", () => {
    const schema = readFileSync(
      new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
      "utf8",
    );
    const models = [...schema.matchAll(/^model (Ad[A-Z]\w*) \{/gm)].map((m) => m[1]).sort();
    expect([...adsModule.tables].sort()).toEqual(models);
  });
});
