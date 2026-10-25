import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: true,
  loading: false,
  error: null as Error | null,
  items: [] as any[],
}));
vi.mock("@/components/workspace-context", () => ({
  useWorkspace: () => ({
    locale: "de",
    project: { id: "p1" },
    isOwner: state.owner,
    canEdit: state.owner,
  }),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: () => ({
    data: state.loading ? null : { items: state.items },
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
});
