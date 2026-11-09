import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeWorkspaceGate } from "./workspace";
import { WorkspaceError, analysisRunning } from "./workspace-parts";
import {
  AnalysisStart,
  ResultStep,
  outcomeRun,
  SitePagePicker,
  WayPicker,
  canUseStatement,
  canUseWhole,
  initialFlow,
  normalWay,
  siteDefaults,
  type Check,
} from "./add-flow";
import { KnowledgeHomeCard } from "./home";
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
    expect(html).toContain("What do you want to add?");
    expect(html).toContain("Content");
    expect(html).toContain("Use");
    expect(html).toContain("Result");
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
    response.value.sources = [
      { ...emptySource, data: { ...emptySource.data, type: "document" } },
    ];
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
    ["MODEL USE FORBIDDEN", "KI-Funktionen dürfen"],
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
    ["KNOWLEDGE_NO_PAGES", "keine Seite"],
    ["KNOWLEDGE_SITE_ROOT_CHANGED", "Adresse"],
    ["KNOWLEDGE_NO_AUDIENCE", "Marketing oder Support"],
    ["KNOWLEDGE_TEXT_TOO_LONG", "1.000 Zeichen"],
    ["KNOWLEDGE_SENSITIVE_TEXT_EXCLUDED", "Zugangsdaten"],
  ])("explains %s without exposing request contents", (code, expected) => {
    const markup = renderToStaticMarkup(
      <WorkspaceContext.Provider value={{ locale: "de" } as any}>
        <WorkspaceError code={code} t={knowledgeCopy.de} />
      </WorkspaceContext.Provider>,
    );
    expect(markup).toContain(expected);
  });
});

const inContext = (node: React.ReactNode, locale: "de" | "en" = "de") =>
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
        value={{ project: { id: "p", name: "FamilyPlan" }, locale } as any}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );

describe("add flow", () => {
  const de = knowledgeCopy.de;
  const textDraft = (over: Record<string, unknown> = {}) => ({
    id: "d",
    version: 2,
    data: {
      status: "draft",
      input: {
        name: "Preise",
        kind: "manual",
        text: "Der Basisplan kostet 5 Euro.",
        description: "",
        audience: "",
        paths: ["README.md"],
        modelUse: false,
        language: "de",
        ...over,
      },
    },
  });
  const previewOf = {
    id: "p",
    commit: null,
    partial: false,
    skipped: 0,
    files: [{ path: "README.md", characters: 120 }],
    characters: 120,
    modelRequired: true,
  };
  const way = (kind: any, text = "", pages?: number) =>
    inContext(
      <WayPicker
        kind={kind}
        text={text}
        pages={pages}
        value="ai"
        onChange={() => {}}
        disabled={false}
        t={de}
      />,
    );
  const site = (over: Record<string, unknown> = {}) => ({
    rootUrl: "https://x.gitbook.io/hilfe",
    discovery: "sitemap" as const,
    pages: [
      { url: "https://x.gitbook.io/hilfe/de/start", language: "de" },
      { url: "https://x.gitbook.io/hilfe/de/kalender", language: "de" },
      { url: "https://x.gitbook.io/hilfe/en/start", language: "en" },
    ],
    capped: false,
    complete: true,
    ...over,
  });
  const picker = (found = site(), excluded = new Set<string>(), locale?: any) =>
    inContext(
      <SitePagePicker
        site={found}
        excluded={excluded}
        onChange={() => {}}
        disabled={false}
        t={knowledgeCopy[(locale ?? "de") as "de"]}
      />,
      locale,
    );
  const start = (
    check: Check,
    locale: "de" | "en" = "de",
    back?: ReactNode,
  ) =>
    inContext(
      <AnalysisStart
        check={check}
        busy={false}
        onStart={() => {}}
        onRetry={() => {}}
        onNewPreview={() => {}}
        back={back}
        t={knowledgeCopy[locale]}
      />,
      locale,
    );
  const ready = {
    ready: true,
    blockers: [],
    estimateMicros: 430_000,
    model: "gpt-5.5-mini",
    provider: "openai",
    proposalLimit: 13,
  };
  const blocked = (...blockers: string[]): Check => ({
    state: "done",
    result: {
      ...ready,
      ready: false,
      blockers,
      estimateMicros: 0,
      model: "",
      proposalLimit: 0,
    },
  });
  const startButton = (html: string) =>
    /<button[^>]*knowledge-start[^>]*>.*?<\/button>/.exec(html)?.[0] ?? "";

  it("keeps the way back in the start button's row", () => {
    const html = start({ state: "preparing" }, "de", <a href="#back">Zurück</a>);
    expect(html).toMatch(
      /<div class="form-actions"><a href="#back">Zurück<\/a><button[^>]*knowledge-start/,
    );
  });

  it("asks what to add first", () => {
    const html = render("import");
    expect(html).toContain("Was möchtest du hinzufügen?");
    for (const label of [
      de.whatManual,
      de.whatFile,
      de.whatSite,
      de.whatGithub,
    ])
      expect(html).toContain(label);
    for (const step of ["Inhalt", "Verwendung", "Ergebnis"])
      expect(html).toContain(step);
  });
  it("no longer requires a project description", () => {
    const html = render("import");
    expect(html).not.toContain("Was ist das Projekt?");
    expect(html).not.toContain("Projekt beschreiben");
    expect(html).toContain("Projektbeschreibung bearbeiten");
    expect(html).toContain("import?profile=1");
  });
  it("edit project description opens its own form at ?profile=1", () => {
    response.value.profile = { description: "Familienkalender" };
    nav.search = "profile=1";
    const html = render("import");
    expect(html).toContain("Was ist das Projekt?");
    expect(html).toContain("Familienkalender");
    expect(html).not.toContain("Was möchtest du hinzufügen?");
  });
  it("links project description editing to its form from the overview", () => {
    response.value.profile = { description: "Familienkalender" };
    expect(render()).toContain("import?profile=1");
  });

  it("offers take-over, AI and one statement for a short text", () => {
    const html = way("manual", "Kurzer Text");
    expect(html).toContain(de.wayWhole);
    expect(html).toContain(de.wayAi);
    expect(html).toContain(de.wayStatement);
  });
  it("hides one statement above 1000 characters", () => {
    expect(way("manual", "x".repeat(1000))).toContain(de.wayStatement);
    const html = way("file", "x".repeat(1001));
    expect(html).not.toContain(de.wayStatement);
    expect(html).toContain(de.wayWhole);
  });
  it("offers no take-over for GitHub", () => {
    const html = way("github");
    expect(html).not.toContain(de.wayWhole);
    expect(html).not.toContain(de.wayStatement);
    expect(html).not.toContain('type="radio"');
    expect(html).toContain(de.wayAiHint);
  });
  it("recommends take-over for a site and offers no single statement", () => {
    const html = way("website", "", 12);
    expect(html).toContain(de.recommended);
    expect(html).not.toContain(de.wayStatement);
    expect(html).toContain("30 Seiten");
  });
  it("does not offer AI with more than 30 selected pages and says why", () => {
    expect(way("website", "", 30)).not.toMatch(/disabled=""[^>]*value="ai"/);
    const html = way("website", "", 31);
    expect(html).toMatch(
      /value="ai"[^>]*disabled=""|disabled=""[^>]*value="ai"/,
    );
    expect(html).toContain("31");
    expect(html).toContain("höchstens 30");
  });
  it("defines which content can be used how", () => {
    expect(
      ["manual", "file", "website"].every((k: any) => canUseWhole(k)),
    ).toBe(true);
    expect(canUseWhole("github")).toBe(false);
    expect(canUseStatement("manual", "x".repeat(1000))).toBe(true);
    expect(canUseStatement("manual", "x".repeat(1001))).toBe(false);
    expect(canUseStatement("manual", "   ")).toBe(false);
    expect(canUseStatement("website", "short")).toBe(false);
    expect(canUseStatement("github", "short")).toBe(false);
  });

  it("lists discovered pages by language, all preselected", () => {
    const html = picker();
    expect(html).toContain("Deutsch");
    expect(html).toContain("Englisch");
    expect(html.indexOf("Deutsch")).toBeLessThan(html.indexOf("Englisch"));
    expect(html).toContain("kalender");
    // Three pages and the two "whole language" boxes.
    expect(html.match(/checked=""/g)).toHaveLength(5);
    expect(html).toContain("3 von 3 Seiten ausgewählt");
  });
  it("keeps an excluded page unticked and counts it", () => {
    const html = picker(
      site(),
      new Set(["https://x.gitbook.io/hilfe/de/kalender"]),
    );
    // Two pages and the English group; German is only partly selected.
    expect(html.match(/checked=""/g)).toHaveLength(3);
    expect(html).toContain("2 von 3 Seiten ausgewählt");
  });
  it("says that only the first 200 pages are shown when capped", () => {
    expect(picker(site({ capped: true }))).toContain("ersten 200 Seiten");
    expect(picker(site({ capped: true }), new Set(), "en")).toContain(
      "first 200 pages",
    );
    expect(picker()).not.toContain("ersten 200 Seiten");
  });
  it("says so plainly when only the root page was found", () => {
    const single = site({
      discovery: "single",
      pages: [{ url: "https://x.gitbook.io/hilfe", language: "de" }],
    });
    expect(picker(single)).toContain("nur diese eine Seite");
    expect(picker(single, new Set(), "en")).toContain("only this one page");
    expect(picker()).not.toContain("nur diese eine Seite");
  });
  it("warns when the page list may be incomplete", () => {
    expect(picker(site({ complete: false }))).toContain("nicht vollständig");
  });

  it("shows cost and model on the start button when ready", () => {
    const button = startButton(start({ state: "done", result: ready }));
    expect(button).toContain("$0.43");
    expect(button).toContain("gpt-5.5-mini");
    expect(button).not.toContain("disabled");
  });
  it("names a cost below one cent instead of rounding it to nothing", () => {
    const button = startButton(
      start({ state: "done", result: { ...ready, estimateMicros: 1800 } }),
    );
    expect(button).toContain("unter $0.01");
    expect(button).not.toContain("$0.00");
  });
  it("disables the start button and links to AI settings on a blocker", () => {
    const html = start(blocked("POLICY_REQUIRED"));
    expect(startButton(html)).toContain("disabled");
    expect(html).toContain("KI-Ausgabenfreigabe");
    expect(html).toContain('href="/p/p/knowledge/settings?section=ai"');
  });
  it.each([
    "POLICY_REQUIRED",
    "POLICY_INTERVAL_INVALID",
    "MODEL_CAPABILITY_NOT_VERIFIED",
    "VERIFIED_PRICE_CONFIGURATION_REQUIRED",
    "CURRENT_PRICE_REQUIRED",
    "ROUTE_EFFORT_UNSUPPORTED",
    "KNOWLEDGE_MODEL_NOT_CONFIGURED",
    "PAID_MANDATE_EXPIRED",
    "BUDGET_NOT_APPROVED",
    "BUDGET_EXCEEDED",
    "PROVIDER_BUDGET_STOP",
  ])("links %s to Settings → AI with its own sentence", (code) => {
    for (const locale of ["de", "en"] as const) {
      const html = start(blocked(code), locale);
      expect(html).toContain('href="/p/p/knowledge/settings?section=ai"');
      expect(html).not.toContain(knowledgeCopy[locale].errorPrefix);
    }
  });
  it("links a source that forbids AI to the Sources page", () => {
    for (const locale of ["de", "en"] as const) {
      const html = start(blocked("MODEL_USE_FORBIDDEN"), locale);
      expect(html).toContain('href="/p/p/knowledge/sources"');
      expect(html).not.toContain("section=ai");
      expect(html).not.toContain(knowledgeCopy[locale].errorPrefix);
    }
  });
  it.each([
    "KNOWLEDGE_PREVIEW_EXPIRED",
    "KNOWLEDGE_ANALYSIS_IN_PROGRESS",
    "KNOWLEDGE_COST_UNKNOWN",
    "KNOWLEDGE_NO_READABLE_FILES",
    "KNOWLEDGE_TEXT_TOO_LONG",
    "PROJECT_PAUSED",
  ])("explains %s without a settings link", (code) => {
    for (const locale of ["de", "en"] as const) {
      const html = start(blocked(code), locale);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain(knowledgeCopy[locale].errorPrefix);
      expect(startButton(html)).toContain("disabled");
    }
  });
  it("offers a new preview when the preview expired", () => {
    expect(start(blocked("KNOWLEDGE_PREVIEW_EXPIRED"))).toContain(
      de.newPreview,
    );
  });
  it("disables the start button and says so while checking", () => {
    for (const [state, label] of [
      ["checking", de.checkingCost],
      ["preparing", de.preparing],
    ] as const) {
      const button = startButton(start({ state }));
      expect(button).toContain("disabled");
      expect(button).toContain(label);
    }
  });
  it("shows an error and a retry when the check failed", () => {
    const html = start({ state: "failed", code: "REQUEST_FAILED" });
    expect(html).toContain('role="alert"');
    expect(html).toContain(de.retry);
    expect(startButton(html)).toContain("disabled");
  });
  it("names no cost or model for a run that calls no model", () => {
    const button = startButton(
      start({
        state: "done",
        result: { ...ready, estimateMicros: 0, model: "", proposalLimit: 1 },
      }),
    );
    expect(button).toContain(de.start);
    expect(button).not.toContain("$");
  });
  it("shows no model-use checkbox", () => {
    response.value.drafts = [textDraft({ modelUse: true })];
    Object.assign(response.value, previewOf);
    nav.search = "draft=d&preview=p";
    const html = render("import");
    expect(html).toContain(de.useTitle);
    expect(html).toContain(de.checkingCost);
    expect(html).not.toContain("an den konfigurierten Modellanbieter senden");
    // Consent is the button; the boxes on the step are the content's rights.
    expect(start({ state: "done", result: ready })).not.toContain(
      'type="checkbox"',
    );
  });

  describe("rights on the use step", () => {
    const useStep = (over: Record<string, unknown>) => {
      response.value.drafts = [textDraft(over)];
      Object.assign(response.value, previewOf);
      nav.search = "draft=d&preview=p";
      return render("import");
    };
    const boxes = (html: string) =>
      (html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []).length;
    it.each([
      ["AI", { modelUse: true }, de.checkingCost],
      ["one statement", { modelUse: false }, de.submitStatement],
      ["take-over", { modelUse: false, text: "x".repeat(1001) }, de.takeOver],
    ])("shows them on the %s way", (_way, over, marker) => {
      const html = useStep(over);
      expect(html).toContain(marker);
      expect(boxes(html)).toBe(4);
      for (const label of [
        de.marketing,
        de.support,
        de.modelRead,
        de.publicUse,
      ])
        expect(html).toContain(label);
    });
    it("starts from the rights stored on the draft", () => {
      const html = useStep({
        modelUse: true,
        rights: {
          marketing: false,
          support: true,
          publicUse: true,
          modelUse: false,
        },
      });
      expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    });
    it("offers no rights where nothing could store them", () => {
      Object.assign(response.value, previewOf);
      nav.search = "preview=p";
      expect(boxes(render("import"))).toBe(0);
    });
    it("uses the draft's rights as the review form's starting point", () => {
      response.value.drafts = [
        textDraft({
          modelUse: true,
          rights: {
            marketing: false,
            support: true,
            publicUse: true,
            modelUse: false,
          },
        }),
      ];
      response.value.proposals = [
        {
          id: "a",
          version: 1,
          data: {
            statement: "Shared calendars",
            status: "pending",
            topic: "features",
            stage: "documented",
            draftId: "d",
          },
        },
      ];
      const html = render("review");
      const box = (label: string) =>
        new RegExp(
          `<label><input type="checkbox"([^>]*)/>${label}</label>`,
        ).exec(html)?.[1];
      expect(box(de.marketing)).not.toContain("checked");
      expect(box(de.support)).toContain("checked");
      expect(box(de.publicUse)).toContain("checked");
    });
    it("starts the review form with the usual rights for an older draft", () => {
      response.value.drafts = [textDraft()];
      response.value.proposals = [
        {
          id: "a",
          version: 1,
          data: {
            statement: "Shared calendars",
            status: "pending",
            topic: "features",
            stage: "documented",
            draftId: "d",
          },
        },
      ];
      const html = render("review");
      expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    });
  });

  describe("drafts replaced by a take-over", () => {
    const replaced = () => ({
      ...textDraft(),
      data: { ...textDraft().data, status: "replaced" },
    });
    it("are hidden from Sources", () => {
      response.value.drafts = [replaced()];
      const html = render("sources");
      expect(html).not.toContain("Preise");
      expect(html).toContain(de.noSources);
    });
    it("cannot be reopened through a link", () => {
      response.value.drafts = [replaced()];
      nav.search = "draft=d";
      expect(render("import")).toContain(de.whatTitle);
    });
    it("do not count on the Home card, while real sources do", () => {
      response.value.drafts = [replaced(), textDraft()];
      response.value.sources = [
        { id: "g", data: { name: "Hilfe", status: "active" } },
        { id: "o", data: { name: "Weg", status: "revoked" } },
        { id: "v", data: { name: "Aus Aussage", proposalId: "a" } },
      ];
      const html = renderToStaticMarkup(
        <ShellContext.Provider
          value={
            {
              hrefOf: (k: string) => k,
              features: { knowledgeWorkspace: true },
            } as any
          }
        >
          <WorkspaceContext.Provider
            value={
              {
                project: { id: "p", name: "FamilyPlan" },
                locale: "de",
                revision: 0,
                isOwner: true,
                t: () => "",
              } as any
            }
          >
            <KnowledgeHomeCard />
          </WorkspaceContext.Provider>
        </ShellContext.Provider>,
      );
      expect(html).toContain(`<dt>${de.sources}</dt><dd>2</dd>`);
    });
  });

  describe("dead ends", () => {
    it("never keeps a way that the content does not offer", () => {
      expect(normalWay("whole", "website", "", undefined)).toBe("ai");
      expect(normalWay("whole", "website", "", 3)).toBe("whole");
      expect(normalWay("ai", "website", "", 31)).toBe("whole");
      expect(normalWay("statement", "manual", "x".repeat(1001))).toBe("whole");
      expect(normalWay("whole", "github", "")).toBe("ai");
    });
    it("continues a website draft with a run as AI, as no page list is known", () => {
      const row = {
        id: "d",
        version: 3,
        data: {
          status: "draft",
          activeRunId: "r",
          input: {
            name: "Web",
            kind: "website",
            url: "https://example.com",
            text: "",
            description: "",
            audience: "",
            paths: ["README.md"],
            modelUse: true,
            language: "de",
          },
        },
      };
      const flow = initialFlow(
        new URLSearchParams("draft=d"),
        { ...response.value, drafts: [row] },
        "de",
      );
      expect(flow.step).toBe("result");
      expect(flow.way).toBe("ai");
    });
  });

  describe("result of a site read", () => {
    const result = (started: boolean, locale: "de" | "en" = "de") =>
      inContext(
        <ResultStep
          outcome={{
            kind: "site",
            sourceId: "g",
            runId: "r",
            pages: 7,
            started,
          }}
          run={undefined}
          onNewPreview={() => {}}
          refresh={() => {}}
          t={knowledgeCopy[locale]}
        />,
        locale,
      );
    it("reports a started read", () => {
      expect(result(true)).toContain("Orbit liest jetzt 7 Seiten");
    });
    it("says when a read was already running and nothing changed", () => {
      const html = result(false);
      expect(html).not.toContain("Orbit liest jetzt");
      expect(html).toContain("läuft bereits");
      expect(html).toContain("nichts geändert");
      expect(html).toContain('href="/p/p/knowledge/sources?source=g"');
      const en = result(false, "en");
      expect(en).toContain("already running");
      expect(en).toContain("Nothing was changed");
    });
  });

  it("keeps the draft, preview and github deep links", () => {
    response.value.drafts = [textDraft()];
    response.value.items = [];
    nav.search = "draft=d";
    let html = render("import");
    expect(html).toContain('value="Preise"');
    expect(html).toContain("Der Basisplan kostet 5 Euro.");
    expect(html).not.toContain(de.whatTitle);

    Object.assign(response.value, previewOf);
    nav.search = "draft=d&preview=p";
    html = render("import");
    expect(html).toContain(de.useTitle);
    expect(html).toContain('aria-current="step"');

    nav.search = "preview=p";
    html = render("import");
    expect(html).toContain(de.useTitle);
    expect(html).not.toContain(de.wayWhole);

    nav.search = "github=connected";
    html = render("import");
    expect(html).toContain(de.connection);
    expect(html).not.toContain(de.whatTitle);
  });
  it("continues a short document as one statement from its preview link", () => {
    response.value.drafts = [textDraft({ kind: "file" })];
    Object.assign(response.value, previewOf);
    nav.search = "draft=d&preview=p";
    const html = render("import");
    expect(html).toContain(de.submitStatement);
    expect(html).not.toContain(de.checkingCost);
  });
  it("shows the result of a draft whose analysis is running", () => {
    response.value.drafts = [
      {
        id: "d",
        version: 3,
        data: { ...textDraft().data, activeRunId: "r" },
      },
    ];
    response.value.runs = [
      { id: "r", data: { draftId: "d", status: "analyzing" } },
    ];
    nav.search = "draft=d";
    const html = render("import");
    expect(html).toContain(de.result);
    expect(html).toContain(de.analyzing);
  });
  it("starts over when a deep link names nothing that exists", () => {
    nav.search = "draft=gone";
    expect(render("import")).toContain(de.whatTitle);
    nav.search = "site=gone";
    expect(render("import")).toContain(de.whatTitle);
  });
  it("opens the page selection for an existing site source", () => {
    const source = {
      id: "g",
      version: 4,
      data: {
        name: "FamilyPlan Hilfe",
        type: "gitbook",
        status: "active",
        audiences: ["support"],
        publicUse: true,
        modelUse: false,
        language: "de",
        site: {
          rootUrl: "https://x.gitbook.io/hilfe",
          excludedPages: ["https://x.gitbook.io/hilfe/de/alt"],
        },
      },
    };
    response.value.sources = [source];
    nav.search = "site=g";
    const html = render("import");
    expect(html).not.toContain(de.whatTitle);
    expect(html).toContain('value="FamilyPlan Hilfe"');
    expect(html).toMatch(
      /readOnly=""[^>]*value="https:\/\/x\.gitbook\.io\/hilfe"|value="https:\/\/x\.gitbook\.io\/hilfe"[^>]*readOnly=""/,
    );
    expect(siteDefaults(source)).toEqual({
      marketing: false,
      support: true,
      publicUse: true,
      modelUse: false,
      autoUpdate: false,
      excluded: ["https://x.gitbook.io/hilfe/de/alt"],
    });
  });
  it("reads a source without site settings with the usual defaults", () => {
    expect(
      siteDefaults({ id: "g", data: { name: "Alt", type: "gitbook" } } as any),
    ).toEqual({
      marketing: true,
      support: true,
      publicUse: false,
      modelUse: true,
      autoUpdate: true,
      excluded: [],
    });
  });
  it("links GitHub setup instead of showing credential fields", () => {
    response.value.items = [];
    nav.search = "github=connected";
    const html = render("import");
    expect(html).toContain('href="/p/p/knowledge/github"');
    expect(html).not.toContain(de.clientSecret);
    expect(html).not.toContain(de.privateKey);
  });
  it("keeps the credential fields on the GitHub page, for owners only", () => {
    const html = render("github");
    expect(html).toContain(de.clientSecret);
    expect(html).toContain(de.privateKey);
    const reader = render("github", false);
    expect(reader).not.toContain(de.clientSecret);
    expect(reader).toContain(de.readOnly);
  });
  it("lists the GitHub page under Advanced for owners", () => {
    expect(render()).toContain('href="/p/p/knowledge/github"');
    expect(render("overview", false)).not.toContain(
      'href="/p/p/knowledge/github"',
    );
  });
  it("registers the GitHub page as its own route", () => {
    const table = routeTable({
      platform: [{ key: "home", path: "", component: () => null }],
      modules: [knowledgeWeb],
    } as any);
    const route = table.routes.find((r) => r.key === "knowledge-github");
    expect(route?.path).toBe("github");
    expect(route?.title?.de).toBeTruthy();
  });
  it("gives readers no controls of the flow, whatever the link says", () => {
    response.value.drafts = [textDraft()];
    response.value.sources = [
      { id: "g", data: { name: "Hilfe", type: "gitbook", status: "active" } },
    ];
    for (const search of [
      "",
      "profile=1",
      "draft=d",
      "site=g",
      "github=connected",
    ]) {
      nav.search = search;
      const html = render("import", false);
      expect(html).toContain(de.readOnly);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<input");
    }
  });
});

describe("site runs and analysis outcomes", () => {
  const site = (over: Record<string, unknown> = {}) => ({
    id: "g",
    data: {
      name: "Docs",
      type: "gitbook",
      status: "active",
      syncEveryHours: 168,
      site: { rootUrl: "https://docs.test/", lastRunId: "r" },
      ...over,
    },
  });
  const siteRun = (over: Record<string, unknown> = {}) => ({
    id: "r",
    data: {
      sourceId: "g",
      status: "completed",
      pageCount: 58,
      cursor: 58,
      unchanged: 50,
      changed: 4,
      added: 3,
      removed: 1,
      failed: [],
      skippedSensitive: 0,
      warning: null,
      errorCode: null,
      ...over,
    },
  });
  const setup = (run: Record<string, unknown> = {}, src = site()) => {
    response.value.sources = [src];
    response.value.siteRuns = [siteRun(run)];
    response.value.indexStatus = [{ sourceId: "g", documents: 58 }];
  };
  it("shows page count and progress of an active run", () => {
    setup({ status: "running", cursor: 20, pageCount: 58 });
    const html = render("sources");
    expect(html).toContain("20 von 58 Seiten gelesen");
    expect(html).toContain("<progress");
  });
  it("says it is finding pages before the first batch knows any", () => {
    setup({ status: "queued", cursor: 0, pageCount: 0 });
    expect(render("sources")).toContain("Orbit sucht die Seiten");
  });
  it("shows the last summary", () => {
    setup();
    const html = render("sources");
    expect(html).toContain("Zuletzt gelesen: 58 Seiten");
    expect(html).toContain("Neu: 3, geändert: 4, entfernt: 1, unverändert: 50");
  });
  it("counts one page in the singular", () => {
    setup({ pageCount: 1 });
    expect(render("sources")).toContain("Zuletzt gelesen: 1 Seite.");
    expect(render("sources", true, "en")).toContain("Last read: 1 page.");
  });
  it("offers read now and the weekly switch to owners only", () => {
    setup();
    const owner = render("sources");
    expect(owner).toContain("Jetzt lesen");
    expect(owner).toContain("Jede Woche automatisch aktualisieren");
    expect(owner).toMatch(/type="checkbox"[^>]*checked/);
    const reader = render("sources", false);
    expect(reader).not.toContain("Jetzt lesen");
    expect(reader).not.toContain("Jede Woche automatisch aktualisieren");
    expect(reader).not.toContain('type="checkbox"');
    expect(reader).toContain("Wird jede Woche automatisch aktualisiert.");
    expect(reader).not.toContain("?site=g");
  });
  it("shows the weekly switch off when weekly updates were switched off", () => {
    const { syncEveryHours: _off, ...rest } = site().data;
    setup({}, { id: "g", data: rest } as any);
    const html = render("sources");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain("Wird nicht automatisch aktualisiert.");
  });
  it("disables read now and offers no way in while a run is active", () => {
    setup({ status: "running", cursor: 5 });
    const html = render("sources");
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>(<svg.*?<\/svg>)?Wird gelesen/,
    );
    expect(html).not.toContain("?site=g");
  });
  it("read in content opens the page selection for gitbook and website sources", () => {
    setup();
    expect(render("sources")).toContain("/knowledge/import?site=g");
    setup({}, site({ type: "website" }));
    expect(render("sources")).toContain("/knowledge/import?site=g");
  });
  it("keeps the expert link for other source types", () => {
    response.value.sources = [
      { id: "g", data: { name: "Doc", type: "document", status: "active" } },
    ];
    response.value.indexStatus = [{ sourceId: "g", documents: 0 }];
    const html = render("sources");
    expect(html).toContain("expert=1&amp;source=g");
    expect(html).not.toContain("import?site=");
    expect(html).not.toContain("Jetzt lesen");
  });
  it("explains a shrunk site and failed pages in plain words", () => {
    setup({
      warning: "site_shrank",
      failed: [
        { url: "https://docs.test/a", code: "SOURCE_TIMEOUT" },
        { url: "https://docs.test/b", code: "SOMETHING_NEW" },
      ],
    });
    const html = render("sources");
    expect(html).toContain("nichts entfernt");
    expect(html).toContain("2 Seiten konnten nicht gelesen werden");
    expect(html).toContain("Die Seite hat zu lange nicht geantwortet.");
    expect(html).toContain("Die Seite ließ sich nicht lesen.");
    expect(html).not.toContain("SOURCE_TIMEOUT");
    expect(html).not.toContain("site_shrank");
    const en = render("sources", true, "en");
    expect(en).toContain("removed nothing");
    expect(en).toContain("The page took too long to respond.");
  });
  it("says a paused source stopped the run", () => {
    setup({ status: "failed", errorCode: "SOURCE_INACTIVE" });
    expect(render("sources")).toContain("pausiert wurde");
  });
  it("shows progress and outcome of the run on the result step", () => {
    const result = (run: Record<string, unknown>, pages = 7) =>
      inContext(
        <ResultStep
          outcome={{
            kind: "site",
            sourceId: "g",
            runId: "r",
            pages,
            started: true,
          }}
          run={siteRun(run) as any}
          onNewPreview={() => {}}
          refresh={() => {}}
          t={knowledgeCopy.de}
        />,
        "de",
      );
    const active = result({ status: "running", cursor: 3, pageCount: 10 });
    expect(active).toContain("3 von 10 Seiten gelesen");
    expect(active).toContain("Orbit liest jetzt 7 Seiten");
    const done = result({ warning: "site_shrank" });
    expect(done).toContain("Zuletzt gelesen: 58 Seiten");
    expect(done).toContain("nichts entfernt");
    expect(done).not.toContain("Orbit liest jetzt");
    expect(result({}, 1)).not.toContain("1 Seiten");
  });
  it("passes only the started run to the result step, never an earlier one", () => {
    const old = siteRun({ warning: "site_shrank" });
    old.id = "old";
    const started = siteRun({ status: "queued" });
    const outcome = {
      kind: "site" as const,
      sourceId: "g",
      runId: "r",
      pages: 7,
      started: true,
    };
    // Before the refresh brings the new run, the earlier completed one is hidden.
    expect(
      outcomeRun({ runs: [], siteRuns: [old] } as any, outcome),
    ).toBeUndefined();
    expect(
      outcomeRun({ runs: [], siteRuns: [old] } as any, outcome),
    ).toBeUndefined();
    expect(
      outcomeRun({ runs: [], siteRuns: [started] } as any, outcome)?.id,
    ).toBe("r");
    // Without a run, the start's own sentence shows and nothing old does.
    const html = inContext(
      <ResultStep
        outcome={outcome}
        run={outcomeRun({ runs: [], siteRuns: [old] } as any, outcome) as any}
        onNewPreview={() => {}}
        refresh={() => {}}
        t={knowledgeCopy.de}
      />,
      "de",
    );
    expect(html).toContain("Orbit liest jetzt 7 Seiten");
    expect(html).not.toContain("Zuletzt gelesen");
    expect(html).not.toContain("nichts entfernt");
  });
  it("shows proposals, cost and dropped proposals of the last analysis", () => {
    response.value.drafts = [
      {
        id: "d",
        version: 1,
        data: { status: "ready", input: { name: "Repo", kind: "github" } },
      },
    ];
    response.value.runs = [
      {
        id: "r1",
        data: {
          draftId: "d",
          status: "completed",
          proposalCount: 7,
          droppedProposals: 2,
          costMicros: 430000,
        },
      },
    ];
    const html = render("sources");
    expect(html).toContain("7 Vorschläge");
    expect(html).toContain("Kosten $0.43");
    expect(html).toContain("2 weitere Vorschläge wurden verworfen");
    response.value.runs[0].data.droppedProposals = 0;
    expect(render("sources")).not.toContain("verworfen,");
  });
  it("calls a previously read draft's action Edit, an unread one's Resume", () => {
    const draft = (data: Record<string, unknown>) => ({
      id: "d",
      version: 1,
      data: {
        status: "draft",
        input: { name: "Repo", kind: "github" },
        ...data,
      },
    });
    response.value.drafts = [draft({})];
    expect(render("sources")).toContain("Fortsetzen");
    response.value.drafts = [
      draft({ lastSuccessfulSyncAt: "2026-11-01T10:00:00Z" }),
    ];
    let html = render("sources");
    expect(html).toContain("Bearbeiten");
    expect(html).not.toContain("Fortsetzen");
    response.value.drafts = [draft({})];
    response.value.runs = [
      { id: "r", data: { draftId: "d", status: "completed" } },
    ];
    html = render("sources");
    expect(html).toContain("Bearbeiten");
  });
});
