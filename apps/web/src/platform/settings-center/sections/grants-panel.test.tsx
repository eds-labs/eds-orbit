import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { labels } from "@/lib/i18n";
import type { McpGrant } from "@/platform/connect/connected-apps";
import { GrantsPanelView, grantsPath } from "./grants-panel";

const grant: McpGrant = {
  id: "g1",
  clientId: "https://app.example/client.json",
  clientName: "Synthetic MCP Client",
  userId: "u1",
  userEmail: "user@example.invalid",
  workspaceId: "w1",
  projectIds: [],
  allCurrentProjects: true,
  scopes: ["orbit:read"],
  createdAt: "2026-10-10T08:00:00.000Z",
  lastUsedAt: null,
};

const view = (over: Partial<Parameters<typeof GrantsPanelView>[0]> = {}) =>
  renderToStaticMarkup(
    <GrantsPanelView
      t={(k) => labels.en[k]}
      locale="en"
      timezone="Europe/Berlin"
      grants={[grant]}
      loading={false}
      loadError={null}
      retry={() => {}}
      workspaceNames={new Map()}
      projectNames={new Map()}
      showUser={false}
      confirm={null}
      onConfirm={() => {}}
      onRevoke={() => {}}
      stopConfirm={null}
      onStopConfirm={() => {}}
      onStopProposals={() => {}}
      pending={false}
      error={null}
      {...over}
    />,
  );

describe("grants panel", () => {
  it("shows the loading state while the list loads", () => {
    const html = view({ grants: undefined, loading: true });
    expect(html).not.toContain("Synthetic MCP Client");
    expect(html).toContain("Loading");
  });

  it("shows the error with a retry", () => {
    const html = view({ grants: undefined, loadError: new Error("Boom") });
    expect(html).toContain("Boom");
    expect(html).toContain("Try again");
  });

  it("lists the grant with its revoke control", () => {
    const html = view();
    expect(html).toContain("Synthetic MCP Client");
    expect(html).toContain(`${labels.en.connectedRevoke}: Synthetic MCP Client`);
  });

  it("builds the grants path of each scope", () => {
    expect(grantsPath({ kind: "account" })).toBe("/mcp-grants");
    expect(
      grantsPath({ kind: "organization", organizationId: "w 1/x" }),
    ).toBe("/workspaces/w%201%2Fx/mcp-grants");
  });
});
