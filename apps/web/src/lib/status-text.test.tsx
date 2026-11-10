import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Status } from "@/components/ui/primitives";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";
import { StandaloneContext } from "@/platform/shell/standalone-context";
import { labels, translate, type Locale } from "./i18n";
import { statusLabel } from "./status-text";

// WP5 (2026-11-10): the generic status badge prints words, not codes.

function workspace(locale: Locale): WorkspaceContextValue {
  const project = {
    id: "p1",
    workspaceId: "w1",
    name: "Synthetic project",
    language: "en",
    timezone: "UTC",
    mode: "observe",
    paused: false,
    generation: 1,
    role: "owner",
  } as WorkspaceContextValue["project"];
  return {
    project,
    identity: {
      user: { id: "u1", name: "Synthetic", email: "u@example.invalid" },
      projects: [project],
      workspaces: [{ id: "w1", name: "Synthetic org", role: "owner" }],
    } as unknown as WorkspaceContextValue["identity"],
    locale,
    t: (key) => translate(locale, key),
    canEdit: true,
    isOwner: true,
    revision: 0,
    refresh: () => {},
    href: (path) => path,
  };
}

describe("statusLabel", () => {
  it("names common codes in English and German", () => {
    expect(statusLabel("en", "not_configured")).toBe("Not configured");
    expect(statusLabel("de", "not_configured")).toBe("Nicht eingerichtet");
    expect(statusLabel("en", "active")).toBe("Active");
    expect(statusLabel("de", "active")).toBe("Aktiv");
    expect(statusLabel("de", "replaced")).toBe("Ersetzt");
    expect(statusLabel("de", "live_ready")).toBe("Bereit für den Live-Betrieb");
    expect(statusLabel("de", "outcome_unknown")).toBe("Ausgang unklar");
  });

  it("reads null as unknown", () => {
    expect(statusLabel("en", null)).toBe("Unknown");
    expect(statusLabel("de", undefined)).toBe("Unbekannt");
  });

  it("falls back to the code with spaces for a code it does not know", () => {
    expect(statusLabel("de", "write_pending_remote")).toBe(
      "write pending remote",
    );
    expect(statusLabel("en", "custom")).toBe("custom");
    // Inherited object keys are not words.
    expect(statusLabel("en", "constructor")).toBe("constructor");
  });
});

describe("Status badge", () => {
  it("prints the project's language inside a workspace", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <Status value="not_configured" />
        <Status value={undefined} />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain("Nicht eingerichtet");
    expect(html).toContain("Unbekannt");
    expect(html).not.toContain("unknown");
  });

  it("prints a standalone page's language outside a project", () => {
    const html = renderToStaticMarkup(
      <StandaloneContext.Provider
        value={{
          locale: "de",
          t: (key) => labels.de[key],
          identity: null,
        }}
      >
        <Status value="paused" />
      </StandaloneContext.Provider>,
    );
    expect(html).toContain("Pausiert");
  });

  it("prints English without any context and keeps the tone", () => {
    const html = renderToStaticMarkup(<Status value="failed" />);
    expect(html).toContain("Failed");
    expect(html).toContain("badge-danger");
  });

  it("prints an explicit label instead of the code's words", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <Status value="verified" label="Bestätigt (Quelle)" />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain("Bestätigt (Quelle)");
    expect(html).not.toContain("Verifiziert");
    expect(html).toContain("badge-success");
  });
});
