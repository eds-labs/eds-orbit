import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: true,
  loading: false,
  error: null as Error | null,
  items: [] as any[],
  // Open decisions per project (`/action-requests/summary`).
  summary: [] as any[],
}));
vi.mock("@/components/workspace-context", async () => ({
  WorkspaceContext: (await import("react")).createContext(null),
  useWorkspace: () => ({
    locale: "de",
    project: { id: "p1" },
    isOwner: state.owner,
    canEdit: state.owner,
  }),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => ({
    data: state.loading
      ? null
      : { items: path === "/action-requests/summary" ? state.summary : state.items },
    loading: state.loading,
    error: state.error,
    refresh: () => {},
  }),
}));
import { Decisions } from "./decisions";

describe("shared decisions page", () => {
  it("renders Support action requests without reading any Marketing collection", () => {
    state.items = [
      {
        id: "a",
        actionType: "support.mcp.support_send_reply",
        costCeilingMicros: 0,
        requestedBy: {
          kind: "mcp",
          userId: "u",
          clientId: "https://client.test/client.json",
        },
        summary: {
          operation: { ticketId: "t", bodyText: "Synthetic exact reply" },
        },
      },
    ];
    const html = renderToStaticMarkup(<Decisions />);
    expect(html).toContain("Synthetic exact reply");
    expect(html).toContain("Support-Nachrichten");
    state.items = [];
  });
  it("shows loading, errors, empty and non-member states", () => {
    state.loading = true;
    expect(renderToStaticMarkup(<Decisions />)).toContain(
      "Freigaben werden geladen",
    );
    state.loading = false;
    state.error = new Error("Synthetic API failure");
    expect(renderToStaticMarkup(<Decisions />)).toContain(
      "Synthetic API failure",
    );
    state.error = null;
    expect(renderToStaticMarkup(<Decisions />)).toContain(
      "Keine offenen App- oder Ticketfreigaben",
    );
    state.owner = false;
    expect(renderToStaticMarkup(<Decisions />)).toContain("nur Inhaber und Bearbeiter");
    state.owner = true;
  });
  it("frames each request with its effect, expiry and collapsed technical details", () => {
    state.items = [
      {
        id: "c",
        version: 1,
        actionType: "knowledge.mcp.knowledge_verify_fact",
        riskClass: "W0",
        packageHash: "f".repeat(64),
        costCeilingMicros: 0,
        expiresAt: new Date(Date.now() + 3 * 3600000).toISOString(),
        requestedBy: { kind: "agent", userId: "u" },
        presentation: {
          module: "knowledge",
          effect: "internal",
          internal: true,
          mandatable: false,
        },
        summary: { operation: { factId: "fact-1", version: 2 } },
      },
    ];
    const html = renderToStaticMarkup(<Decisions />);
    // A readable title and effect, never the raw type as the heading.
    expect(html).toContain("Fakt bestätigen");
    expect(html).toContain("Nur in Orbit");
    expect(html).toContain("in 3 Std.");
    expect(html).toMatch(/<details class="approval-diagnostics">.*knowledge\.mcp\.knowledge_verify_fact/s);
    expect(html).not.toContain("<strong>knowledge.mcp.knowledge_verify_fact</strong>");
    state.items = [];
  });
  it("lists open decisions of the member's other projects as links, not the current one", () => {
    state.summary = [
      { projectId: "p1", projectName: "This project", count: 2, firstExpiresAt: null },
      { projectId: "p2", projectName: "Other project", count: 3, firstExpiresAt: null },
    ];
    const html = renderToStaticMarkup(<Decisions />);
    expect(html).toContain("Freigaben in anderen Projekten");
    expect(html).toContain("Other project");
    expect(html).toContain("3 offen");
    expect(html).toContain("/p/p2/decisions");
    expect(html).not.toContain("This project");
    state.summary = [];
  });
});
