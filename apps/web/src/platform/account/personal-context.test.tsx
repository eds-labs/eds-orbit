import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/account/assistant",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@/lib/api";
import {
  assistantPaths,
  contextApiFor,
  type ContextEntry,
} from "@/platform/assistant/api";
import {
  ContextProposalCard,
  NoticeBody,
  undoContextSave,
  useConversationWorkspace,
} from "@/platform/assistant/context-cards";
import {
  AssistantContext,
  type AssistantContextValue,
} from "@/platform/assistant/assistant-context";
import { AssistantLinkContext } from "@/platform/assistant/links";
import { PersonalContextContent } from "./personal-context";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const entry = (over: Partial<ContextEntry> = {}): ContextEntry => ({
  id: "e1",
  version: 2,
  category: "preference",
  text: "Reports as short bullet lists",
  projectId: null,
  status: "active",
  createdBy: "assistant",
  createdAt: "2026-11-04T10:00:00Z",
  ...over,
});
const projects = [{ id: "p1", name: "Alpha", workspaceId: "w1" } as Project];
const links = {
  hrefFor: (id: string, href: string) => `/p/${id}${href}`,
  projectName: (id: string) => projects.find((p) => p.id === id)?.name,
};
const page = (
  props: Partial<Parameters<typeof PersonalContextContent>[0]> = {},
) =>
  renderToStaticMarkup(
    <AssistantLinkContext.Provider value={links}>
      <PersonalContextContent
        de
        items={[
          entry(),
          entry({
            id: "e2",
            category: "project_note",
            text: "Alpha launches in December",
            projectId: "p1",
            status: "archived",
            createdBy: "user",
          }),
        ]}
        autoMemory
        projects={projects}
        bubbleHidden={false}
        onBubbleHidden={() => {}}
        onChanged={() => {}}
        workspaceId="w2"
        {...props}
      />
    </AssistantLinkContext.Provider>,
  );

describe("My context (WP3.7)", () => {
  it("lists active and archived entries with their kind, project and actions", () => {
    const html = page();
    expect(html).toContain("Reports as short bullet lists");
    expect(html).toContain("Vorliebe");
    expect(html).toContain("Alpha launches in December");
    expect(html).toContain("Projektnotiz");
    expect(html).toContain("Alpha");
    expect(html).toContain("Archiviert");
    expect(html).toContain("vom Assistenten");
    expect(html).toContain(
      'aria-label="Bearbeiten: Reports as short bullet lists"',
    );
    expect(html).toContain(
      'aria-label="Archivieren: Reports as short bullet lists"',
    );
    expect(html).toContain(
      'aria-label="Wiederherstellen: Alpha launches in December"',
    );
    expect(html).toContain(
      'aria-label="Löschen: Reports as short bullet lists"',
    );
  });

  it("exports as a JSON download and shows both switches", () => {
    const html = page({ autoMemory: false, bubbleHidden: true });
    expect(html).toContain(
      'href="/api/assistant/context/export?workspaceId=w2"',
    );
    expect(html).toContain('download="orbit-personal-context.json"');
    expect(html).toContain("Automatisch merken");
    expect(html).toContain("gespeichert wird erst nach deinem Klick");
    expect(html).toContain("Assistent-Schaltfläche anzeigen");
    // Both switches off: no checked attribute on any switch.
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).not.toMatch(/role="switch"[^>]*checked/);
    expect(page()).toMatch(
      /checked=""[^>]*role="switch"|role="switch"[^>]*checked=""/,
    );
  });

  it("edits an entry in place with its text, kind and project", () => {
    const html = page({ initialEditing: "e2" });
    expect(html).toContain('id="context-e2-text"');
    expect(html).toContain(">Alpha launches in December</textarea>");
    expect(html).toContain('<option value="project_note" selected="">');
    expect(html).toContain('<option value="p1" selected="">Alpha</option>');
    expect(html).toContain(">Abbrechen<");
  });

  it("shows an empty state", () => {
    expect(page({ items: [] })).toContain("Noch keine Einträge");
  });

  it("sends the version-bound requests of the page, in its organization", async () => {
    const contextApi = contextApiFor("w2");
    await contextApi.list();
    await contextApi.create({
      category: "workflow",
      text: "Weekly on Mondays",
    });
    await contextApi.create({
      category: "project_note",
      text: "x",
      projectId: "p1",
    });
    await contextApi.update(entry(), { text: "Shorter", category: "decision" });
    await contextApi.update(entry(), { status: "archived" });
    await contextApi.remove("e1");
    await contextApi.settings(false);
    expect(calls).toEqual([
      {
        url: "/api/assistant/context?workspaceId=w2",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/assistant/context?workspaceId=w2",
        method: "POST",
        body: { category: "workflow", text: "Weekly on Mondays" },
      },
      {
        url: "/api/assistant/context?workspaceId=w2",
        method: "POST",
        body: { category: "project_note", text: "x", projectId: "p1" },
      },
      {
        url: "/api/assistant/context/e1?workspaceId=w2",
        method: "PATCH",
        body: { version: 2, text: "Shorter", category: "decision" },
      },
      {
        url: "/api/assistant/context/e1?workspaceId=w2",
        method: "PATCH",
        body: { version: 2, status: "archived" },
      },
      {
        url: "/api/assistant/context/e1?workspaceId=w2",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "/api/assistant/context/settings?workspaceId=w2",
        method: "PUT",
        body: { autoMemory: false },
      },
    ]);
  });

  it("names the organization on every path, the status's and the export", () => {
    expect(assistantPaths.status("w 2")).toBe("/assistant?workspaceId=w%202");
    expect(assistantPaths.context("w2")).toBe(
      "/assistant/context?workspaceId=w2",
    );
    expect(assistantPaths.contextEntry("e1", "w2")).toBe(
      "/assistant/context/e1?workspaceId=w2",
    );
    expect(assistantPaths.contextSettings("w2")).toBe(
      "/assistant/context/settings?workspaceId=w2",
    );
    expect(assistantPaths.contextExport("w2")).toBe(
      "/api/assistant/context/export?workspaceId=w2",
    );
  });
});

describe("personal context in the conversation (D-17)", () => {
  it("shows Remembered with Undo, and Undo deletes the entry", async () => {
    const html = renderToStaticMarkup(
      <NoticeBody
        de={false}
        text=""
        notice={{
          kind: "context_saved",
          entryId: "e9",
          text: "Prefers German",
        }}
      />,
    );
    expect(html).toContain("Remembered: Prefers German");
    expect(html).toContain(">Undo<");
    await undoContextSave("e9", "w2");
    expect(calls).toEqual([
      {
        url: "/api/assistant/context/e9?workspaceId=w2",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("saves and undoes in the conversation's organization", () => {
    let seen: string | undefined = "unset";
    function Probe() {
      seen = useConversationWorkspace();
      return null;
    }
    renderToStaticMarkup(
      <AssistantContext.Provider
        value={
          {
            status: {
              enabled: true,
              workspaceId: "w2",
              personalSpaceId: "s2",
              capMicros: null,
              autoMemory: true,
            },
          } as AssistantContextValue
        }
      >
        <Probe />
      </AssistantContext.Provider>,
    );
    expect(seen).toBe("w2");
    renderToStaticMarkup(<Probe />);
    expect(seen).toBeUndefined();
  });

  it("offers Save, Edit and Dismiss for a proposal, saving nothing by itself", () => {
    const card = {
      kind: "context_proposal",
      label: "Remember",
      contextProposal: {
        text: "Prefers German",
        category: "preference" as const,
        projectId: "p1",
      },
    };
    const html = renderToStaticMarkup(
      <AssistantLinkContext.Provider value={links}>
        <ContextProposalCard de card={card} />
      </AssistantLinkContext.Provider>,
    );
    expect(html).toContain("Merken: Prefers German?");
    expect(html).toContain(">Speichern<");
    expect(html).toContain(">Bearbeiten<");
    expect(html).toContain(">Verwerfen<");
    expect(html).toContain("Alpha");
    expect(calls).toEqual([]);
    expect(
      renderToStaticMarkup(
        <ContextProposalCard de card={card} initial="dismissed" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ContextProposalCard de={false} card={card} initial="editing" />,
      ),
    ).toContain(">Prefers German</textarea>");
  });
});
