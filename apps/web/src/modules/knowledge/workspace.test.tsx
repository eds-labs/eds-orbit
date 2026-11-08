import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  KnowledgeWorkspaceGate,
  WorkspaceError,
  analysisRunning,
} from "./workspace";
import { Knowledge } from "./knowledge";
import { knowledgeWeb } from "./manifest";
import { WorkspaceContext } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import { navigationForFeatures, routeTable } from "@/platform/shell/routes";
import { knowledgeCopy } from "./workspace-text";
const response = vi.hoisted(() => ({
  value: {
    enabled: true,
    profile: {},
    drafts: [],
    runs: [],
    proposals: [],
    sources: [],
    facts: [],
  } as any,
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: () => ({
    data: response.value,
    error: null,
    loading: false,
    refresh: () => {},
  }),
}));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const render = (
  tab: any = "overview",
  owner = true,
  locale: "de" | "en" = "de",
) =>
  renderToStaticMarkup(
    <ShellContext.Provider
      value={
        {
          hrefOf: (key: string) =>
            `/p/p/knowledge/${key.replace("knowledge-", "")}`,
        } as any
      }
    >
      <WorkspaceContext.Provider
        value={
          {
            project: { id: "p", name: "FamilyPlan" },
            locale,
            revision: 0,
            isOwner: owner,
            canEdit: owner,
            refresh: () => {},
            t: () => "",
            href: (x: string) => x,
          } as any
        }
      >
        <KnowledgeWorkspaceGate tab={tab} fallback={<p>Legacy interface</p>} />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
beforeEach(() => {
  nav.search = "";
  response.value = {
    enabled: true,
    profile: {},
    drafts: [],
    runs: [],
    proposals: [],
    sources: [],
    facts: [],
  };
});
describe("understandable knowledge workspace", () => {
  it("shows exactly three primary entries and preserves every legacy route", () => {
    const table = routeTable({
      platform: [{ key: "home", path: "", component: () => null }],
      modules: [knowledgeWeb],
    } as any);
    expect(
      navigationForFeatures(table.routes, { knowledgeWorkspace: true }).map(
        (r) => r.nav?.label.de,
      ),
    ).toEqual(["Projektwissen", "Quellen", "Zu prüfen"]);
    expect(table.routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "facts",
        "library",
        "import",
        "health",
        "inspector",
        "impact",
        "conflicts",
      ]),
    );
    expect(
      navigationForFeatures(table.routes, {}).map((r) => r.nav?.label.de),
    ).toHaveLength(6);
  });
  it("explains the empty project and leads to add knowledge", () => {
    const html = render();
    expect(html).toContain("Projektwissen");
    expect(html).toContain("Wissen hinzufügen");
    expect(html).toContain("Hier entsteht dein Projektwissen");
    expect(html).not.toContain("Import payload");
  });
  it("shows only confirmed findings in project knowledge", () => {
    response.value.proposals = [
      {
        id: "a",
        version: 1,
        data: { statement: "Private pending", status: "pending" },
      },
      {
        id: "b",
        version: 1,
        data: {
          statement: "Shared calendars",
          status: "accepted",
          topic: "features",
          stage: "implemented",
          audiences: ["support"],
        },
      },
    ];
    const html = render();
    expect(html).toContain("Shared calendars");
    expect(html).not.toContain("Private pending");
    expect(html).toContain("nicht automatisch veröffentlicht");
  });
  it("shows review actions only to owners", () => {
    response.value.proposals = [
      {
        id: "a",
        version: 1,
        data: {
          statement: "Shared calendars",
          status: "pending",
          topic: "features",
          stage: "documented",
        },
      },
    ];
    expect(render("review")).toContain("Übernehmen");
    expect(render("review", false)).not.toContain("Übernehmen");
  });
  it("provides the same complete flow in English", () => {
    const html = render("import", true, "en");
    expect(html).toContain("Describe the project");
    expect(html).toContain("Review findings");
    expect(html).toContain("Save and continue");
    expect(Object.keys(knowledgeCopy.en).sort()).toEqual(
      Object.keys(knowledgeCopy.de).sort(),
    );
  });
  it("explains an empty review queue even when legacy facts exist", () => {
    response.value.facts = [
      {
        id: "old",
        data: { status: "verified", key: "product.name", value: "FamilyPlan" },
      },
    ];
    expect(render("review")).toContain("Alles geprüft");
  });
  it("returns to the existing interface while disabled", () => {
    response.value = { enabled: false };
    expect(render()).toContain("Legacy interface");
  });
  it("names the add-knowledge page in the breadcrumb", () => {
    const table = routeTable({
      platform: [{ key: "home", path: "", component: () => null }],
      modules: [knowledgeWeb],
    } as any);
    const route = table.routes.find((r) => r.key === "knowledge-import");
    expect(route?.title?.de).toBeTruthy();
    expect(route?.title?.de).not.toContain("knowledge-");
  });
});

const confirmed = (over: Record<string, unknown> = {}) => ({
  id: "a",
  version: 3,
  data: {
    statement: "Shared calendars",
    status: "accepted",
    topic: "features",
    stage: "documented",
    factId: "f",
    sourceId: "s",
    ...over,
  },
});
const verifiedFact = (over: Record<string, unknown> = {}) => ({
  id: "f",
  data: {
    status: "verified",
    key: "knowledge.features.a",
    value: "Shared calendars",
    sourceId: "s",
    ...over,
  },
});

describe("managing confirmed knowledge", () => {
  it("offers correcting and removing to owners only", () => {
    response.value.proposals = [confirmed()];
    response.value.facts = [verifiedFact()];
    expect(render()).toContain("Bearbeiten");
    expect(render()).toContain("Entfernen");
    expect(render("overview", false)).not.toContain("Bearbeiten");
    expect(render("overview", false)).not.toContain("Entfernen");
  });
  it("does not call a withdrawn statement confirmed", () => {
    response.value.proposals = [confirmed()];
    response.value.facts = [verifiedFact({ status: "revoked" })];
    const html = render();
    expect(html).not.toContain("Shared calendars");
    expect(html).toContain("Entfernt (1)");
  });
  it("does not call a statement of a paused source confirmed", () => {
    response.value.proposals = [confirmed()];
    response.value.facts = [verifiedFact()];
    response.value.sources = [
      { id: "s", data: { name: "Web", status: "paused" } },
    ];
    const html = render();
    expect(html).not.toContain("Shared calendars");
    expect(html).toContain("Entfernt (1)");
  });
  it("counts removed statements without listing them as confirmed", () => {
    response.value.proposals = [confirmed({ status: "removed" })];
    const html = render();
    expect(html).not.toContain("Shared calendars");
    expect(html).toContain("Entfernt (1)");
  });
  it("leaves facts of a paused source out of the confirmed list", () => {
    response.value.sources = [
      { id: "s", data: { name: "Web", status: "paused" } },
    ];
    response.value.facts = [
      verifiedFact({ id: "old", key: "plans.free", value: "Free plan" }),
    ];
    expect(render()).not.toContain("Free plan");
  });
  it("lets the owner decide about changed knowledge", () => {
    response.value.proposals = [confirmed({ status: "needs_review" })];
    const html = render("review");
    expect(html).toContain("Die Quelle hat sich geändert");
    expect(html).toContain("Weiter verwenden");
    expect(html).toContain("Entfernen");
    expect(html).not.toContain("Aktualisieren: Quellen");
    expect(html).not.toContain("Verwerfen");
  });
  it("cannot keep changed knowledge that was never confirmed", () => {
    response.value.proposals = [
      confirmed({ status: "needs_review", factId: undefined }),
    ];
    expect(render("review")).not.toContain("Weiter verwenden");
  });
});

describe("source list", () => {
  const emptySource = {
    id: "g",
    data: { name: "GitBook", type: "gitbook", status: "active" },
  };
  const index = (documents: number) => [{ sourceId: "g", documents }];
  const draft = (over: Record<string, unknown> = {}) => ({
    id: "d",
    version: 1,
    data: {
      status: "ready",
      input: { name: "Website", kind: "website" },
      ...over,
    },
  });
  it("says that an empty source was never read and how to fill or drop it", () => {
    response.value.sources = [emptySource];
    response.value.indexStatus = index(0);
    const html = render("sources");
    expect(html).toContain("Noch nie abgerufen");
    expect(html).toContain("Inhalte einlesen");
    expect(html).toContain("expert=1&amp;source=g");
    expect(html).toContain("Entfernen");
    expect(html).not.toContain("Pausieren");
  });
  it("offers a recoverable pause for a source with content", () => {
    response.value.sources = [emptySource];
    response.value.indexStatus = index(4);
    const html = render("sources");
    expect(html).toContain("Pausieren");
    expect(html).toContain("Inhalte verwalten");
    expect(html).not.toContain("Entfernen");
  });
  it("offers no removal while a fact still hangs on the source", () => {
    response.value.sources = [emptySource];
    response.value.indexStatus = index(0);
    response.value.facts = [verifiedFact({ sourceId: "g" })];
    expect(render("sources")).not.toContain("Entfernen");
  });
  it("offers resuming a paused source", () => {
    response.value.sources = [
      { ...emptySource, data: { ...emptySource.data, status: "paused" } },
    ];
    response.value.indexStatus = index(4);
    const html = render("sources");
    expect(html).toContain("Pausiert");
    expect(html).toContain("Fortsetzen");
    expect(html).not.toContain("Pausieren");
  });
  it("keeps source actions away from readers", () => {
    response.value.sources = [emptySource];
    response.value.indexStatus = index(0);
    const html = render("sources", false);
    expect(html).toContain("Noch nie abgerufen");
    expect(html).not.toContain("Inhalte einlesen");
    expect(html).not.toContain("Entfernen");
  });
  it("highlights the source a warning points to", () => {
    response.value.sources = [emptySource];
    nav.search = "source=g";
    expect(render("sources")).toContain("knowledge-source-focused");
  });
  it("does not call a source unread that was read before", () => {
    response.value.drafts = [
      draft({ status: "draft", lastSuccessfulSyncAt: "2026-10-24T17:39:00Z" }),
    ];
    const html = render("sources");
    expect(html).toContain("Gelesen");
    expect(html).not.toContain("Noch nicht gelesen");
  });
  it("keeps the reason of a failed analysis visible", () => {
    response.value.drafts = [draft({ status: "failed" })];
    response.value.runs = [
      {
        id: "r",
        data: {
          draftId: "d",
          status: "failed",
          error: "KNOWLEDGE_ANALYSIS_FAILED",
        },
      },
    ];
    expect(render("sources")).toContain("Die Analyse konnte nicht");
  });
  it("forgets an older failure after a newer success", () => {
    response.value.drafts = [draft()];
    response.value.runs = [
      { id: "new", data: { draftId: "d", status: "completed" } },
      {
        id: "old",
        data: {
          draftId: "d",
          status: "failed",
          error: "KNOWLEDGE_ANALYSIS_FAILED",
        },
      },
    ];
    expect(render("sources")).not.toContain("Die Analyse konnte nicht");
  });
  it("does not chain one document link per statement", () => {
    response.value.drafts = [draft()];
    response.value.proposals = ["a", "b", "c"].map((id) => ({
      ...confirmed({ draftId: "d", sourceId: `s-${id}` }),
      id,
    }));
    expect(render("sources")).not.toMatch(
      /Dokumente und Versionen<\/a>(<!-- -->)?<a[^>]*>Dokumente und Versionen/,
    );
  });
});

describe("analysis progress", () => {
  it.each([
    ["queued", true],
    ["analyzing", true],
    ["failed", false],
    ["unknown", false],
    ["canceled", false],
  ])("treats %s as running: %s", (status, running) => {
    expect(analysisRunning(status)).toBe(running);
  });
});

describe("expert source view", () => {
  it("opens the source a link names", () => {
    nav.search = "expert=1&source=g";
    response.value.items = [
      { id: "g", version: 1, data: { name: "GitBook", status: "active" } },
    ];
    const html = renderToStaticMarkup(
      <ShellContext.Provider value={{ hrefOf: (k: string) => k } as any}>
        <WorkspaceContext.Provider
          value={
            {
              project: { id: "p", name: "FamilyPlan" },
              locale: "de",
              revision: 0,
              isOwner: true,
              canEdit: true,
              refresh: () => {},
              t: (k: string) => k,
            } as any
          }
        >
          <Knowledge tab="sources" />
        </WorkspaceContext.Provider>
      </ShellContext.Provider>,
    );
    expect(html).toContain("<h2>GitBook</h2>");
  });
});

describe("Knowledge error messages", () => {
  it.each([
    ["MODEL USE FORBIDDEN", "Bestätige die Weitergabe"],
    ["GITHUB_INVALID_PRIVATE_KEY", "SHA256-Fingerabdruck"],
    ["MODEL_CAPABILITY_NOT_VERIFIED", "Standardprovider"],
    ["KNOWLEDGE_OUTPUT_LIMIT", "Antwortlimit"],
    ["KNOWLEDGE_ANALYSIS_FAILED", "Die Analyse konnte nicht"],
    ["KNOWLEDGE_MODEL_REJECTED", "Modellanbieter hat die Anfrage abgelehnt"],
    ["KNOWLEDGE_DEPENDENCY_CHANGED", "während der Analyse geändert"],
    ["KNOWLEDGE_RUN_ACTIVE", "läuft bereits"],
    ["DOCUMENT_TOO_LARGE", "zu groß"],
    ["PROJECT_PAUSED", "Projekt ist pausiert"],
    ["KNOWLEDGE_RESTORE_UNAVAILABLE", "nicht mehr wiederherstellen"],
    ["KNOWLEDGE_EDIT_UNAVAILABLE", "nicht bearbeiten"],
  ])("explains %s without exposing request contents", (code, expected) => {
    const markup = renderToStaticMarkup(
      <WorkspaceContext.Provider value={{ locale: "de" } as any}>
        <WorkspaceError code={code} t={knowledgeCopy.de} />
      </WorkspaceContext.Provider>,
    );
    expect(markup).toContain(expected);
  });
});
