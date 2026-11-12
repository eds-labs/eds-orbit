import { describe, expect, it } from "vitest";
import {
  defaultScope,
  manageHref,
  parseManagePath,
  scopeKey,
} from "./routes";
import type { Capability, ManagementCapabilities } from "./types";

const caps = (over: Partial<ManagementCapabilities> = {}): ManagementCapabilities => ({
  stage: "on",
  system: [],
  account: [],
  organizations: [],
  projects: [],
  ...over,
});
const project = (id: string) => ({
  id,
  name: id,
  workspaceId: "w1",
  role: "owner" as const,
  capabilities: ["project.overview"] as Capability[],
});

describe("settings center addresses", () => {
  it("parses the four scopes", () => {
    expect(parseManagePath([])).toEqual({ scope: null, area: null, rest: [] });
    expect(parseManagePath(["system"])).toEqual({
      scope: { kind: "system" },
      area: null,
      rest: [],
    });
    expect(parseManagePath(["system", "users", "u1"])).toEqual({
      scope: { kind: "system" },
      area: "users",
      rest: ["u1"],
    });
    expect(parseManagePath(["o", "w1", "ai", "budget"])).toEqual({
      scope: { kind: "organization", organizationId: "w1" },
      area: "ai",
      rest: ["budget"],
    });
    expect(
      parseManagePath(["p", "p1", "modules", "finance", "accounts"]),
    ).toEqual({
      scope: { kind: "project", projectId: "p1" },
      area: "modules",
      rest: ["finance", "accounts"],
    });
    expect(parseManagePath(["me", "profile"])).toEqual({
      scope: { kind: "account" },
      area: "profile",
      rest: [],
    });
  });

  it("refuses what is not a scope", () => {
    for (const parts of [["o"], ["p"], ["admin"], ["x", "y"]])
      expect(parseManagePath(parts)).toBeNull();
  });

  it("builds encoded addresses that parse back", () => {
    expect(manageHref({ kind: "system" })).toBe("/manage/system");
    expect(
      manageHref({ kind: "organization", organizationId: "w 1" }, "ai", "budget"),
    ).toBe("/manage/o/w%201/ai/budget");
    expect(manageHref({ kind: "account" }, "profile")).toBe("/manage/me/profile");
    expect(manageHref({ kind: "project", projectId: "a/b" }, "modules", "x y")).toBe(
      "/manage/p/a%2Fb/modules/x%20y",
    );
  });

  it("keys scopes", () => {
    expect(scopeKey({ kind: "system" })).toBe("system");
    expect(scopeKey({ kind: "organization", organizationId: "w1" })).toBe("o:w1");
    expect(scopeKey({ kind: "project", projectId: "p1" })).toBe("p:p1");
    expect(scopeKey({ kind: "account" })).toBe("me");
  });

  it("opens the last project, else the first scope the member has", () => {
    const withProjects = caps({
      projects: [project("p1"), project("p2")],
      account: ["account.profile"],
    });
    expect(defaultScope(withProjects, "p2")).toEqual({ kind: "project", projectId: "p2" });
    expect(defaultScope(withProjects, null)).toEqual({ kind: "project", projectId: "p1" });
    expect(defaultScope(withProjects, "gone")).toEqual({ kind: "project", projectId: "p1" });
    expect(defaultScope(caps({ account: ["account.profile"], system: ["system.users"] }), null)).toEqual({ kind: "account" });
    expect(defaultScope(caps({ system: ["system.users"] }), null)).toEqual({ kind: "system" });
    expect(
      defaultScope(
        caps({ organizations: [{ id: "w1", name: "W", capabilities: ["organization.overview"] }] }),
        null,
      ),
    ).toEqual({ kind: "organization", organizationId: "w1" });
    expect(defaultScope(caps(), null)).toBeNull();
  });
});
