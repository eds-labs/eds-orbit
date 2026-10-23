import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { FinanceUpload } from "./upload";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "viewer",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [{ id: "w1", name: "Org one", role: "owner" }],
  projects: [project],
};

function render(access: string | undefined, canEdit: boolean) {
  const shell = {
    modules: [{ id: "finance", access }],
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
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
        <FinanceUpload onUploaded={() => {}} />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

describe("FinanceUpload access", () => {
  it("is hidden for viewers", () => {
    expect(render("viewer", false)).toBe("");
    expect(render(undefined, false)).toBe("");
  });
  it("is shown for editors", () => {
    expect(render("editor", true)).toContain('type="file"');
  });
});
