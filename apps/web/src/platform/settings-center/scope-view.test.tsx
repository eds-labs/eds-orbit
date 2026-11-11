import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "@/lib/api";
import { backLink, scopeTitle, ScopeView } from "./scope-view";
import type { ManagementCapabilities } from "./types";

const caps: ManagementCapabilities = {
  stage: "preview",
  system: ["system.overview"],
  account: ["account.profile"],
  organizations: [],
  projects: [],
};
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  projects: [],
  workspaces: [],
};

describe("scope view", () => {
  it("names each scope", () => {
    expect(scopeTitle({ kind: "system" }, "", "en")).toBe("Whole system");
    expect(scopeTitle({ kind: "account" }, "", "de")).toBe("Mein Konto");
    expect(
      scopeTitle({ kind: "organization", organizationId: "o1" }, "Org", "en"),
    ).toBe("Org");
    expect(
      scopeTitle({ kind: "project", projectId: "p1" }, "Alpha", "en"),
    ).toBe("Alpha");
  });

  it("leads back to where the scope belongs, with encoded ids", () => {
    expect(backLink({ kind: "system" }, "en")).toEqual({
      href: "/",
      label: "Back to Orbit",
    });
    expect(backLink({ kind: "account" }, "en")).toEqual({
      href: "/",
      label: "Back to Orbit",
    });
    expect(
      backLink({ kind: "organization", organizationId: "o 1" }, "en"),
    ).toEqual({ href: "/o/o%201", label: "Back to organization" });
    expect(backLink({ kind: "project", projectId: "p/1" }, "de")).toEqual({
      href: "/p/p%2F1",
      label: "Zurück zum Projekt",
    });
  });

  it("renders the frame of the scope", () => {
    const html = renderToStaticMarkup(
      <ScopeView
        scope={{ kind: "system" }}
        capabilities={caps.system}
        name=""
        target={{ scope: { kind: "system" }, area: null, rest: [] }}
        caps={caps}
        identity={identity}
        locale="en"
        navigate={() => {}}
      />,
    );
    expect(html).toContain("Whole system");
    expect(html).toContain('href="/"');
  });
});
