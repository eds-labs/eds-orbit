import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "./api";
import { translate, type Locale } from "./i18n";
import { fieldLabel } from "./field-text";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";
import { EntityRows } from "@/platform/ui/collection";

// WP5 (2026-11-10): the record table's headers are words in the
// interface language, not split field keys.

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
      workspaces: [],
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

const row = {
  id: "e1",
  workspaceId: "w1",
  projectId: "p1",
  kind: "content",
  version: 1,
  data: { title: "Launch post", type: "social", status: "draft" },
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
} satisfies Entity;

describe("fieldLabel", () => {
  it("names the fields of the record tables", () => {
    expect(fieldLabel("en", "updatedAt")).toBe("Updated");
    expect(fieldLabel("de", "updatedAt")).toBe("Aktualisiert");
    expect(fieldLabel("de", "questionCount")).toBe("Fragen");
    expect(fieldLabel("de", "primaryMetric")).toBe("Hauptkennzahl");
    expect(fieldLabel("de", "resourceId")).toBe("Ressource");
  });

  it("falls back to the key's words in sentence case", () => {
    expect(fieldLabel("de", "lastSeenAt")).toBe("Last seen at");
    expect(fieldLabel("en", "remote_id")).toBe("Remote id");
    expect(fieldLabel("en", "toString")).toBe("To string");
  });
});

describe("EntityRows headers", () => {
  it("prints German headers as written, with column scope", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <EntityRows
          items={[row]}
          fields={["title", "type", "status", "updatedAt"]}
          onSelect={() => {}}
        />
      </WorkspaceContext.Provider>,
    );
    for (const header of ["Titel", "Typ", "Status", "Aktualisiert"])
      expect(html).toContain(`<th scope="col">${header}</th>`);
    expect(html).toContain('class="table-plain-head"');
    expect(html).toContain("Entwurf");
    expect(html).not.toContain("updated At");
  });
});
