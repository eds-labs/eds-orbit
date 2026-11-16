import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { cmsModule } from "../src/modules/cms/manifest.ts";
import { cmsContributions } from "../src/modules/cms/contributions.ts";
import { cmsSwitchedOn } from "../src/modules/cms/gate.ts";
import { cmsSettingsSchema, defaultCmsSettings } from "../src/modules/cms/settings.ts";

describe("content module skeleton (ADR 0029, CH1.4)", () => {
  const clear = () => {
    delete process.env.ORBIT_CMS;
  };
  beforeEach(clear);
  afterEach(clear);

  it("ORBIT_CMS defaults to false and accepts only false or true", () => {
    expect(loadConfig().ORBIT_CMS).toBe("false");
    process.env.ORBIT_CMS = "true";
    expect(loadConfig().ORBIT_CMS).toBe("true");
    process.env.ORBIT_CMS = "yes";
    expect(() => loadConfig()).toThrow();
  });

  it("registers cms as an opt-in module; editors may decide publications by permission (E-4)", () => {
    expect(modules).toContain(cmsModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(cmsModule).toMatchObject({
      id: "cms",
      version: "0.1.0",
      displayName: { en: "Content", de: "Inhalte" },
      dependsOn: [],
      defaultEnabled: false,
      entityKinds: [],
    });
    expect(
      cmsModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true]),
    ).toEqual([
      ["cms.read", ["owner", "editor", "viewer"], false],
      ["cms.compose", ["owner", "editor"], false],
      ["cms.publish.request", ["owner", "editor"], false],
      ["cms.publish.decide", ["owner", "editor"], false],
      ["cms.sites.manage", ["owner"], true],
      ["cms.settings", ["owner"], false],
    ]);
  });

  it("is switched off unless ORBIT_CMS=true", () => {
    expect(cmsSwitchedOn()).toBe(false);
    process.env.ORBIT_CMS = "true";
    expect(cmsSwitchedOn()).toBe(true);
    expect(cmsContributions.unavailableCode).toBe("CMS_DISABLED");
  });

  it("defaults to owner-or-editor approval and refuses unknown or out-of-range settings", () => {
    expect(defaultCmsSettings()).toEqual({
      publishApprovers: "owner_or_editor",
      fourEyes: false,
      timeZone: null,
      lateWindowHours: 24,
    });
    expect(cmsSettingsSchema.parse(defaultCmsSettings())).toEqual(defaultCmsSettings());
    expect(cmsSettingsSchema.parse({ ...defaultCmsSettings(), timeZone: "Europe/Vienna" }).timeZone).toBe(
      "Europe/Vienna",
    );
    for (const bad of [
      { publishApprovers: "anyone" },
      { timeZone: "Mars/Olympus" },
      { lateWindowHours: 0 },
      { lateWindowHours: 169 },
      { extra: 1 },
    ]) {
      expect(() => cmsSettingsSchema.parse({ ...defaultCmsSettings(), ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
