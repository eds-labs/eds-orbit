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
const generation = (
  phase: string,
  embeddedChunks: number,
  evaluationRun: unknown = null,
) => ({
  id: `g-${phase}`,
  generation: 2,
  profile: "openai:text-embedding-3-small:1536:chunk-v1",
  state: "building",
  manifest: [],
  chunks: 112,
  embeddedChunks,
  phase,
  evaluationRun,
  evaluationSetEstimateMicros: 120_000,
  createdAt: "2026-10-25T10:00:00.000Z",
});
const render = (locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project,
        identity,
        locale,
        t: (k) => labels[locale][k],
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
  it("shows a complete build as ready for the check, with only that step", () => {
    answer.items = [generation("ready_for_evaluation", 112)];
    const html = render();
    expect(html).toContain("112 of 112 text passages embedded");
    expect(html).toContain("Ready for the check");
    expect(html).toContain(">Check<");
    expect(html).not.toContain("Embed next batch");
    expect(html).not.toContain("JSON");
  });
  it("speaks German when the member's language is German", () => {
    answer.items = [generation("ready_for_evaluation", 112)];
    const html = render("de");
    expect(html).toContain("Suchindex");
    expect(html).toContain("112 von 112 Textabschnitten eingebettet");
    expect(html).toContain("Bereit zur Prüfung");
    expect(html).toContain(">Prüfen<");
  });
  it("offers the review while generated questions wait for it", () => {
    answer.items = [
      generation("ready_for_evaluation", 112, {
        id: "e1",
        origin: "generated",
        status: "review",
        cases: 70,
        items: [],
      }),
    ];
    const html = render("de");
    expect(html).toContain("70 Testfragen warten auf deine Durchsicht.");
    expect(html).toContain(">Fragen durchsehen<");
    expect(html).not.toContain(">Prüfen<");
  });
  it("reports a passed check in words and offers activation", () => {
    answer.items = [
      {
        ...generation("evaluated", 112, {
          id: "e1",
          origin: "generated",
          status: "completed",
          cases: 70,
          evaluation: {
            passed: true,
            answered: 56,
            recallAt10: 54 / 56,
            forbiddenHits: 0,
            found: 54,
          },
        }),
        state: "evaluated",
      },
    ];
    const html = render("de");
    expect(html).toContain(
      "Bestanden: 54 von 56 Fragen fanden den richtigen Abschnitt (96 %), keine unzulässigen Treffer.",
    );
    expect(html).toContain(">Aktivieren<");
  });
  it("names the reason of a stopped question run", () => {
    answer.items = [
      generation("ready_for_evaluation", 112, {
        id: "e1",
        origin: "generated",
        status: "failed",
        errorCode: "EVALUATION_SET_TOO_SMALL",
        cases: 0,
      }),
    ];
    expect(render("de")).toContain(
      "Abgebrochen: Für eine aussagekräftige Prüfung ist zu wenig Wissen vorhanden",
    );
  });
  it("offers no step for a generation whose corpus changed", () => {
    answer.items = [generation("corpus_changed", 112)];
    const html = render();
    expect(html).toContain("Prepare a new generation.");
    expect(html).not.toContain(">Check<");
    expect(html).not.toContain("Embed next batch");
  });
});
