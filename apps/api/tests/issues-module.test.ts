import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../src/platform/modules/platform-declaration.ts";
import { modules } from "../src/modules/registry.ts";
import { issuesModule } from "../src/modules/issues/manifest.ts";
import { issuesContributions } from "../src/modules/issues/contributions.ts";
import { issuesSwitchedOn } from "../src/modules/issues/gate.ts";
import {
  defaultIssuesSettings,
  issuesSettingsSchema,
} from "../src/modules/issues/settings.ts";

describe("issue center module skeleton (ADR 0018)", () => {
  const clear = () => {
    delete process.env.ORBIT_ISSUES;
  };
  beforeEach(clear);
  afterEach(clear);

  it("registers issues as an opt-in module with its permissions", () => {
    expect(modules).toContain(issuesModule);
    expect(() => validateRegistry(modules, platformDeclaration)).not.toThrow();
    expect(issuesModule).toMatchObject({
      id: "issues",
      displayName: { en: "Issues", de: "Issues" },
      dependsOn: [],
      defaultEnabled: false,
    });
    expect(
      issuesModule.permissions.map((p) => [p.key, [...p.defaultRoles], p.sensitive === true]),
    ).toEqual([
      ["issues.read", ["owner", "editor", "viewer"], false],
      ["issues.report", ["owner", "editor"], false],
      ["issues.triage", ["owner", "editor"], false],
      ["issues.diagnostics.read", ["owner", "editor"], true],
      ["issues.github", ["owner"], true],
      ["issues.settings", ["owner"], false],
    ]);
  });

  it("is unavailable while ORBIT_ISSUES is off", () => {
    expect(issuesSwitchedOn()).toBe(false);
    expect(issuesContributions.available?.()).toBe(false);
    expect(issuesContributions.unavailableCode).toBe("ISSUES_DISABLED");
    process.env.ORBIT_ISSUES = "true";
    expect(issuesContributions.available?.()).toBe(true);
  });

  it("defaults to Mario's retention and sync decisions (Q-P3-5, Q-P3-6)", () => {
    const settings = issuesSettingsSchema.parse(defaultIssuesSettings());
    expect(settings.retention).toEqual({ closedIssueMonths: 36, diagnosticsMonths: 12 });
    expect(settings.sync).toEqual({ autoFixReady: true, autoRelease: false });
    expect(settings.dedupe.autoAttachFingerprint).toBe(true);
    expect(settings.triage.aiEnabled).toBe(false);
  });

  it("rejects unknown keys, duplicate components and the opt-in AI stages", () => {
    const base = defaultIssuesSettings();
    const component = { key: "checkout", label: { en: "Checkout", de: "Checkout" } };
    expect(issuesSettingsSchema.safeParse({ ...base, components: [component] }).success).toBe(true);
    expect(issuesSettingsSchema.safeParse({ ...base, components: [component, component] }).success).toBe(false);
    expect(issuesSettingsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      issuesSettingsSchema.safeParse({ ...base, dedupe: { ...base.dedupe, vectorEnabled: true } }).success,
    ).toBe(false);
    expect(
      issuesSettingsSchema.safeParse({
        ...base,
        retention: { closedIssueMonths: 6, diagnosticsMonths: 12 },
      }).success,
    ).toBe(false);
  });
});

describe("no automatic merge (ADR 0018 I-3)", () => {
  // Merging two issues is a person's act: a route, a confirmed duplicate
  // candidate or an approved proposal. Intake, jobs and sync rules must
  // never reach it.
  it("calls mergeIssue only from the merge service, person-driven routes and approved proposals", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      );
    const callers = files("apps/api/src")
      .filter((f) => /\bmergeIssue\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual([
      "apps/api/src/modules/issues/duplicates.ts",
      "apps/api/src/modules/issues/merge.ts",
      "apps/api/src/modules/issues/routes.ts",
      "apps/api/src/modules/issues/tools.ts",
    ]);
    const confirm = readFileSync("apps/api/src/modules/issues/duplicates.ts", "utf8");
    // The only caller there is a person's confirmation.
    expect(confirm.match(/mergeIssue\(/g)).toHaveLength(1);
    expect(confirm).toMatch(/export async function confirmCandidate[\s\S]*mergeIssue\(/);
  });
});
