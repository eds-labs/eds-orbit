import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { socialModule } from "../src/modules/social/manifest.ts";
import { socialContributions } from "../src/modules/social/contributions.ts";
import { socialSwitchedOn } from "../src/modules/social/gate.ts";
import {
  defaultSocialSettings,
  socialSettingsSchema,
} from "../src/modules/social/settings.ts";

describe("social module skeleton (ADR 0020)", () => {
  const clear = () => {
    delete process.env.ORBIT_SOCIAL;
  };
  beforeEach(clear);
  afterEach(clear);

  it("ORBIT_SOCIAL defaults to false and accepts only false or true", () => {
    expect(loadConfig().ORBIT_SOCIAL).toBe("false");
    process.env.ORBIT_SOCIAL = "true";
    expect(loadConfig().ORBIT_SOCIAL).toBe("true");
    process.env.ORBIT_SOCIAL = "yes";
    expect(() => loadConfig()).toThrow();
  });

  it("registers social as an opt-in module with its permissions", () => {
    expect(modules).toContain(socialModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(socialModule).toMatchObject({
      id: "social",
      version: "0.1.0",
      displayName: { en: "Social", de: "Social Media" },
      dependsOn: [],
      defaultEnabled: false,
      entityKinds: [],
    });
    expect(
      socialModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true]),
    ).toEqual([
      ["social.read", ["owner", "editor", "viewer"], false],
      ["social.compose", ["owner", "editor"], false],
      ["social.publish", ["owner", "editor"], false],
      ["social.approve", ["owner"], false],
      ["social.accounts.manage", ["owner"], true],
      ["social.analytics.read", ["owner", "editor", "viewer"], false],
      ["social.settings", ["owner"], false],
    ]);
  });

  it("is unavailable while ORBIT_SOCIAL is off", () => {
    expect(socialSwitchedOn()).toBe(false);
    expect(socialContributions.available?.()).toBe(false);
    expect(socialContributions.unavailableCode).toBe("SOCIAL_DISABLED");
    process.env.ORBIT_SOCIAL = "true";
    expect(socialSwitchedOn()).toBe(true);
    expect(socialContributions.available?.()).toBe(true);
  });

  it("keeps its files away from the generic file routes", () => {
    expect(socialContributions.files).toEqual({ privateToModule: true });
  });

  it("defaults to owner approval for each post (S-D9)", () => {
    expect(socialSettingsSchema.parse(defaultSocialSettings())).toEqual({
      approval: "owner_each",
      mcpOwnerPublishWithoutApproval: false,
    });
  });

  it("rejects unknown approval policies and unknown keys", () => {
    const base = defaultSocialSettings();
    expect(socialSettingsSchema.safeParse({ ...base, approval: "editor_each" }).success).toBe(true);
    expect(socialSettingsSchema.safeParse({ ...base, approval: "nobody" }).success).toBe(false);
    expect(socialSettingsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("lists exactly the Social* tables of the schema", () => {
    const schema = readFileSync(
      new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
      "utf8",
    );
    const models = [...schema.matchAll(/^model (Social\w+) \{/gm)].map((m) => m[1]).sort();
    expect([...socialModule.tables].sort()).toEqual(models);
  });
});
