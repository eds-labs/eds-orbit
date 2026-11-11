import { describe, expect, it } from "vitest";
import { aiPaths } from "./paths";

describe("aiPaths", () => {
  it("builds the AI paths of each scope with the id encoded", () => {
    expect(aiPaths({ kind: "project", projectId: "p 1" }).effective).toBe(
      "/management/projects/p%201/ai/effective",
    );
    expect(
      aiPaths({ kind: "organization", organizationId: "w1" }).projects,
    ).toBe("/management/organizations/w1/ai/projects");
    expect(aiPaths({ kind: "system" }).profile).toBe("/admin/ai/profile");
  });

  it("names the central AI resources of the organization and the system", () => {
    expect(aiPaths({ kind: "organization", organizationId: "w/1" })).toEqual({
      projects: "/management/organizations/w%2F1/ai/projects",
      defaults: "/organizations/w%2F1/ai/defaults",
      models: "/organizations/w%2F1/ai/models",
      profile: "/organizations/w%2F1/ai/profile",
      base: "/organizations/w%2F1",
    });
    expect(aiPaths({ kind: "system" })).toEqual({
      defaults: "/admin/ai/defaults",
      models: "/admin/ai/models",
      profile: "/admin/ai/profile",
      overview: "/admin/overview",
    });
    expect(aiPaths({ kind: "account" })).toEqual({});
  });
});
