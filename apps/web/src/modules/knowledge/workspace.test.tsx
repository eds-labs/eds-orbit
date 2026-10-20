import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeWorkspaceGate, WorkspaceError } from "./workspace";
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
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
});

describe("Knowledge error messages", () => {
  it.each([
    ["MODEL USE FORBIDDEN", "Bestätige die Weitergabe"],
    ["GITHUB_INVALID_PRIVATE_KEY", "SHA256-Fingerabdruck"],
    ["MODEL_CAPABILITY_NOT_VERIFIED", "Standardprovider"],
    ["KNOWLEDGE_OUTPUT_LIMIT", "Antwortlimit"],
  ])("explains %s without exposing request contents", (code, expected) => {
    const markup = renderToStaticMarkup(
      <WorkspaceContext.Provider value={{ locale: "de" } as any}>
        <WorkspaceError code={code} t={knowledgeCopy.de} />
      </WorkspaceContext.Provider>,
    );
    expect(markup).toContain(expected);
  });
});
