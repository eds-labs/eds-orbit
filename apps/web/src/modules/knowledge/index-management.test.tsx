import { describe, expect, it, vi } from "vitest";

// The index generations as GET /indexes reports them.
const answer = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: () => ({
      data: answer,
      error: null,
      loading: false,
      refresh: () => {},
    }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { IndexManagement } from "./index-management";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [{ id: "w1", name: "Org one", role: "owner" }],
  projects: [project],
};
const generation = (phase: string, embeddedChunks: number) => ({
  id: `g-${phase}`,
  generation: 2,
  profile: "openai:text-embedding-3-small:1536:chunk-v1",
  state: "building",
  manifest: [],
  chunks: 112,
  embeddedChunks,
  phase,
  createdAt: "2026-10-25T10:00:00.000Z",
});
const render = () =>
  renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project,
        identity,
        locale: "en",
        t: (k) => labels.en[k],
        canEdit: true,
        isOwner: true,
        revision: 0,
        refresh: () => {},
        href: (p) => p,
      }}
    >
      <IndexManagement />
    </WorkspaceContext.Provider>,
  );

describe("IndexManagement", () => {
  it("shows a complete build as waiting for its evaluation, with only that step", () => {
    answer.items = [generation("ready_for_evaluation", 112)];
    const html = render();
    expect(html).toContain("112 of 112 corpus chunks embedded");
    expect(html).toContain("ready for evaluation");
    expect(html).toContain("Run the live evaluation next.");
    expect(html).toContain("Evaluate");
    expect(html).not.toContain("Build next batch");
  });
  it("offers no step for a generation whose corpus changed", () => {
    answer.items = [generation("corpus_changed", 112)];
    const html = render();
    expect(html).toContain("Prepare a new generation.");
    expect(html).not.toContain(">Evaluate<");
    expect(html).not.toContain("Build next batch");
  });
});
