import { describe, expect, it } from "vitest";
import { centerState } from "./capabilities";
import type { ManageTarget, ManagementCapabilities } from "./types";

const caps: ManagementCapabilities = {
  stage: "preview",
  system: [],
  account: ["account.profile"],
  organizations: [
    { id: "o1", name: "Org One", capabilities: ["organization.overview"] },
  ],
  projects: [
    {
      id: "p1",
      name: "Alpha",
      workspaceId: "o1",
      role: "owner",
      capabilities: ["project.overview"],
    },
    {
      id: "p2",
      name: "Beta",
      workspaceId: "o1",
      role: "viewer",
      capabilities: ["project.overview", "project.profile"],
    },
  ],
};
const target = (scope: ManageTarget["scope"]): ManageTarget => ({
  scope,
  area: null,
  rest: [],
});
const input = (
  extra: Partial<Parameters<typeof centerState>[0]> = {},
): Parameters<typeof centerState>[0] => ({
  stage: "preview",
  target: target({ kind: "account" }),
  caps,
  loading: false,
  error: null,
  lastProjectId: null,
  ...extra,
});

describe("settings center state", () => {
  it("is off without the flag", () => {
    expect(centerState(input({ stage: undefined }))).toEqual({ kind: "off" });
    expect(centerState(input({ stage: "off" }))).toEqual({ kind: "off" });
  });

  it("waits, then reports an error with its message", () => {
    expect(centerState(input({ caps: null, loading: true }))).toEqual({
      kind: "loading",
    });
    // No data and no error yet (the request has not started): still waiting.
    expect(centerState(input({ caps: null }))).toEqual({ kind: "loading" });
    expect(
      centerState(input({ caps: null, error: { message: "NOT FOUND" } })),
    ).toEqual({ kind: "error", message: "NOT FOUND" });
  });

  it("redirects the bare address to the last project", () => {
    expect(
      centerState(input({ target: target(null), lastProjectId: "p2" })),
    ).toEqual({ kind: "redirect", href: "/manage/p/p2" });
    expect(
      centerState(
        input({
          target: target(null),
          caps: { ...caps, projects: [], account: [], organizations: [] },
        }),
      ),
    ).toEqual({ kind: "notFound" });
  });

  it("refuses a project the member does not belong to and an organization they do not own", () => {
    expect(
      centerState(
        input({ target: target({ kind: "project", projectId: "p9" }) }),
      ),
    ).toEqual({ kind: "notFound" });
    expect(
      centerState(
        input({
          target: target({ kind: "organization", organizationId: "o9" }),
        }),
      ),
    ).toEqual({ kind: "notFound" });
    expect(
      centerState(
        input({
          target: target({ kind: "account" }),
          caps: { ...caps, account: [] },
        }),
      ),
    ).toEqual({ kind: "notFound" });
  });

  it("refuses the system scope to a non-administrator", () => {
    expect(centerState(input({ target: target({ kind: "system" }) }))).toEqual({
      kind: "notFound",
    });
    expect(
      centerState(
        input({
          target: target({ kind: "system" }),
          caps: { ...caps, system: ["system.overview"] },
        }),
      ),
    ).toEqual({
      kind: "scope",
      scope: { kind: "system" },
      capabilities: ["system.overview"],
      name: "",
    });
  });

  it("names the open organization and project", () => {
    expect(
      centerState(
        input({
          target: target({ kind: "organization", organizationId: "o1" }),
        }),
      ),
    ).toEqual({
      kind: "scope",
      scope: { kind: "organization", organizationId: "o1" },
      capabilities: ["organization.overview"],
      name: "Org One",
    });
    expect(
      centerState(
        input({ target: target({ kind: "project", projectId: "p2" }) }),
      ),
    ).toEqual({
      kind: "scope",
      scope: { kind: "project", projectId: "p2" },
      capabilities: ["project.overview", "project.profile"],
      name: "Beta",
    });
    expect(centerState(input())).toEqual({
      kind: "scope",
      scope: { kind: "account" },
      capabilities: ["account.profile"],
      name: "",
    });
  });
});
