import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { labels, type Locale } from "@/lib/i18n";
import {
  GrantList,
  revokeGrant,
  stopProposals,
  type McpGrant,
} from "./connected-apps";

const t = (locale: Locale) => (key: keyof typeof labels.en) =>
  labels[locale][key];

const grant = (over: Partial<McpGrant> = {}): McpGrant => ({
  id: "3f1c0d1e-0000-4000-8000-000000000001",
  clientId: "https://app.example/client.json",
  clientName: "Synthetic MCP Client",
  userId: "u1",
  userEmail: "user@example.invalid",
  workspaceId: "w1",
  projectIds: ["p1"],
  allCurrentProjects: false,
  scopes: ["openid", "orbit:read", "orbit:propose"],
  createdAt: "2026-10-10T08:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

function render(
  props: Partial<Parameters<typeof GrantList>[0]> = {},
  locale: Locale = "en",
) {
  return renderToStaticMarkup(
    <GrantList
      t={t(locale)}
      locale={locale}
      timezone="Europe/Berlin"
      grants={[grant()]}
      workspaceNames={new Map([["w1", "Synthetic org"]])}
      projectNames={new Map([["p1", "Project A"]])}
      showUser={false}
      confirm={null}
      onConfirm={() => {}}
      onRevoke={() => {}}
      stopConfirm={null}
      onStopConfirm={() => {}}
      onStopProposals={() => {}}
      pending={false}
      error={null}
      {...props}
    />,
  );
}

describe("Connected apps", () => {
  it("lists grants with client, host, workspace, projects, scopes and last use", () => {
    const html = render();
    expect(html).toContain("Synthetic MCP Client");
    expect(html).toContain("app.example");
    expect(html).toContain("Synthetic org");
    expect(html).toContain("Project A");
    expect(html).toContain("orbit:read");
    expect(html).toContain("orbit:propose");
    expect(html).toContain(labels.en.connectedNeverUsed);
    expect(html).toContain("Revoke");
    // Nothing asks for confirmation until Revoke is pressed.
    expect(html).not.toContain("<dialog");
  });

  it("shows the person only in the owner listing, and all-projects grants as such", () => {
    expect(render()).not.toContain("user@example.invalid");
    const owner = render({
      showUser: true,
      grants: [grant({ allCurrentProjects: true, projectIds: [] })],
    });
    expect(owner).toContain("user@example.invalid");
    expect(owner).toContain("All current projects");
  });

  it("says when there are no grants", () => {
    expect(render({ grants: [] })).toContain(labels.en.connectedEmpty);
  });

  it("asks before revoking and names the app", () => {
    const html = render({ confirm: grant() });
    expect(html).toContain("<dialog");
    expect(html).toContain("Revoke access for Synthetic MCP Client?");
    expect(html).toContain("signs the app out");
  });

  it("revokes with DELETE only when called, and not parsing a 204", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    expect(remove).not.toHaveBeenCalled();
    await revokeGrant(remove, grant());
    expect(remove).toHaveBeenCalledWith(
      "/mcp-grants/3f1c0d1e-0000-4000-8000-000000000001",
    );
  });

  it("offers Stop proposals only for a grant that can still propose", () => {
    const withScope = render();
    expect(withScope).toContain("Stop proposals");
    expect(withScope).not.toContain("<dialog");
    const without = render({
      grants: [grant({ scopes: ["openid", "orbit:read"] })],
    });
    expect(without).not.toContain("Stop proposals");
    expect(without).toContain("Revoke");
  });

  it("asks before stopping proposals and names the app", () => {
    const html = render({ stopConfirm: grant() });
    expect(html).toContain("<dialog");
    expect(html).toContain("Stop proposals from Synthetic MCP Client?");
    expect(html).toContain("withdrawn");
  });

  it("stops proposals with PATCH { proposals: false } only when called", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    expect(patch).not.toHaveBeenCalled();
    await stopProposals(patch, grant());
    expect(patch).toHaveBeenCalledWith(
      "/mcp-grants/3f1c0d1e-0000-4000-8000-000000000001",
      { proposals: false },
    );
  });

  it("renders in German", () => {
    expect(render({}, "de")).toContain("Nie genutzt");
    expect(render({}, "de")).toContain("Vorschläge stoppen");
    expect(render({ confirm: grant() }, "de")).toContain(
      "Zugriff widerrufen für Synthetic MCP Client?",
    );
  });

  it("escapes a hostile client name", () => {
    const html = render({
      grants: [grant({ clientName: '<img src=x onerror="alert(1)">' })],
    });
    expect(html).not.toContain("<img");
  });
});
