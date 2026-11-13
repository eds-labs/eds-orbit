import { describe, expect, it } from "vitest";
import { integrationPaths } from "./paths";

describe("integration request paths", () => {
  it("builds encoded request paths per scope", () => {
    expect(integrationPaths({ kind: "project", projectId: "p 1" })).toEqual({
      catalog: "/management/integrations/catalog",
      records: "/management/projects/p%201/integrations",
      connections: null,
      overview: null,
    });
    expect(integrationPaths({ kind: "organization", organizationId: "w1" })).toEqual({
      catalog: "/management/integrations/catalog",
      records: "/management/organizations/w1/integrations",
      connections: "/organizations/w1/connections",
      overview: null,
    });
    expect(integrationPaths({ kind: "system" })).toEqual({
      catalog: "/management/integrations/catalog",
      records: null,
      connections: "/admin/connections",
      overview: "/admin/overview",
    });
    expect(integrationPaths({ kind: "account" })).toMatchObject({
      records: null,
      connections: null,
      overview: null,
    });
  });
});
