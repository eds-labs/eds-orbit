import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { workModule } from "../src/modules/work/manifest.ts";
import { workContributions } from "../src/modules/work/contributions.ts";
import { workSwitchedOn } from "../src/modules/work/gate.ts";
import {
  defaultWorkSettings,
  firstStatus,
  workSettingsSchema,
} from "../src/modules/work/settings.ts";

describe("project management module skeleton (ADR 0016)", () => {
  const clear = () => {
    delete process.env.ORBIT_WORK;
  };
  beforeEach(clear);
  afterEach(clear);

  it("registers work as an opt-in module with its permissions", () => {
    expect(modules).toContain(workModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(workModule).toMatchObject({
      id: "work",
      displayName: { en: "Project management", de: "Projektmanagement" },
      dependsOn: [],
      defaultEnabled: false,
    });
    expect(
      workModule.permissions.map((p) => [p.key, [...p.defaultRoles]]),
    ).toEqual([
      ["work.read", ["owner", "editor", "viewer"]],
      ["work.write", ["owner", "editor"]],
      ["work.delete", ["owner"]],
      ["work.settings", ["owner"]],
      ["work.pm.use", ["owner", "editor"]],
      ["work.pm.apply", ["owner", "editor"]],
      ["work.pm.manage", ["owner"]],
      ["work.coding.dispatch", ["owner"]],
    ]);
    // Dispatching to an external coding agent is owner-only and sensitive.
    expect(workModule.permissions.find((p) => p.key === "work.coding.dispatch")?.sensitive).toBe(true);
  });

  it("is unavailable while ORBIT_WORK is off", () => {
    expect(workSwitchedOn()).toBe(false);
    expect(workContributions.available?.()).toBe(false);
    expect(workContributions.unavailableCode).toBe("WORK_DISABLED");
    process.env.ORBIT_WORK = "true";
    expect(workContributions.available?.()).toBe(true);
  });

  it("has one default status per category", () => {
    const settings = workSettingsSchema.parse(defaultWorkSettings());
    expect(settings.workflow.statuses.map((s) => s.category)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "blocked",
      "in_review",
      "done",
      "canceled",
    ]);
    expect(firstStatus(settings, "todo")?.key).toBe("todo");
  });

  it("rejects workflows without done or canceled, duplicates and unknown transitions", () => {
    const base = defaultWorkSettings();
    const without = (category: string) => ({
      ...base,
      workflow: {
        statuses: base.workflow.statuses.filter((s) => s.category !== category),
      },
    });
    expect(workSettingsSchema.safeParse(without("done")).success).toBe(false);
    expect(workSettingsSchema.safeParse(without("canceled")).success).toBe(false);
    const duplicate = {
      ...base,
      workflow: { statuses: [...base.workflow.statuses, base.workflow.statuses[0]] },
    };
    expect(workSettingsSchema.safeParse(duplicate).success).toBe(false);
    const transitions = {
      ...base,
      workflow: { ...base.workflow, transitions: { todo: ["nowhere"] } },
    };
    expect(workSettingsSchema.safeParse(transitions).success).toBe(false);
    expect(workSettingsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
