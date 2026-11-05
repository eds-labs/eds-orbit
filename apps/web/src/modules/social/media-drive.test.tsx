import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => ({
      data: path?.includes("/social/media") ? { items: [] } : null,
      error: null,
      loading: false,
      refresh: () => {},
      path,
    }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { MediaView } from "./media";

// "Add from Google Drive" in the Social media library (Drive page design
// 2026-11-05 §5.5): owners and editors, while Drive is set up.

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "editor" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "editor" }],
  projects: [project],
};

function render({ canEdit = true, googleDrive = true } = {}) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={{ features: { googleDrive } } as unknown as ShellContextValue}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale: "en",
          t: (k) => labels.en[k],
          canEdit,
          isOwner: false,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        <MediaView />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

describe("social media library with Google Drive", () => {
  it("offers Drive images to editors while Drive is set up", () => {
    expect(render()).toContain("Add from Google Drive");
  });

  it("does not offer it to viewers or without Drive", () => {
    expect(render({ canEdit: false })).not.toContain("Add from Google Drive");
    expect(render({ googleDrive: false })).not.toContain("Add from Google Drive");
  });
});
