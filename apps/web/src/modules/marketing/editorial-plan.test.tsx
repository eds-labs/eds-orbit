import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "@/lib/api";
import { translate, type Locale } from "@/lib/i18n";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";

// WP5 (2026-11-10): Marketing's "Calendar" is an editorial plan next to the
// Social calendar that publishes. Only its words change: the route key, its
// path and the legacy path stay, so stored links keep working.

const state = vi.hoisted(() => ({ blocks: [] as unknown[] }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => ({
    data: { items: path?.includes("calendar_blocks") ? state.blocks : [] },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

import { webRegistry } from "@/modules/registry";
import { locate, projectHref, routeTable } from "@/platform/shell/routes";
import { shellLinks } from "@/platform/shell/shell-links";
import { CalendarView } from "./work";

const P = "11111111-2222-4333-8444-555555555555";
const table = routeTable(webRegistry);

function workspace(locale: Locale): WorkspaceContextValue {
  const project = {
    id: P,
    workspaceId: "w1",
    name: "Synthetic project",
    language: "de",
    timezone: "Europe/Berlin",
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

function shell(social: boolean): ShellContextValue {
  const hrefOf = (key: string) =>
    projectHref(
      P,
      table.routes.find((r) => r.key === key)!,
    );
  return {
    features: {},
    modules: [
      {
        id: "social",
        enabled: social,
        access: "owner",
        displayName: { en: "Social", de: "Social Media" },
        description: { en: "Synthetic", de: "Synthetic" },
        nav: [],
      },
    ],
    table,
    platformNav: [],
    homeSections: [],
    hrefOf,
    ...shellLinks({ hrefOf, map: (h) => h }),
    chat: [],
    actionRequests: {},
    attention: { loading: false },
    attentionRenderers: {},
    settings: [],
    setupLinks: [],
    connectors: { providers: [], extras: [] },
  };
}

function render(locale: Locale, social: boolean) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell(social)}>
      <WorkspaceContext.Provider value={workspace(locale)}>
        <CalendarView />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const block = {
  id: "block-1",
  workspaceId: "w1",
  projectId: P,
  kind: "calendar_blocks",
  version: 1,
  data: {
    status: "active",
    title: "Messe",
    reason: "Team on site",
    startAt: "2026-11-20T08:00:00.000Z",
    endAt: "2026-11-21T08:00:00.000Z",
    channels: [],
  },
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
} satisfies Entity;

beforeEach(() => {
  state.blocks = [];
});

describe("editorial plan route", () => {
  it("keeps the key, path and legacy path and renames the entry", () => {
    const route = table.routes.find((r) => r.key === "calendar")!;
    expect(route.moduleId).toBe("marketing");
    expect(projectHref(P, route)).toBe(`/p/${P}/marketing/calendar`);
    expect(route.nav!.label).toEqual({
      en: "Editorial plan",
      de: "Redaktionsplan",
    });
    const legacy = locate("/calendar", table);
    expect(legacy.kind).toBe("legacy");
    if (legacy.kind === "legacy") expect(legacy.route.key).toBe("calendar");
    // The Social module's calendar keeps its own name.
    const social = table.routes.find((r) => r.key === "social.calendar")!;
    expect(social.nav!.label.en).toBe("Calendar");
  });
});

describe("editorial plan page", () => {
  it("says in German that it plans and links the Social calendar", () => {
    const html = render("de", true);
    expect(html).toContain("<h1>Redaktionsplan</h1>");
    expect(html).toContain("Von hier wird nichts veröffentlicht");
    expect(html).toContain('aria-label="Monat"');
    expect(html).toContain(`href="/p/${P}/social/calendar"`);
    expect(html).toContain("Veröffentlichungen im Social-Kalender");
    expect(html).toContain("Sperrzeiten");
    expect(html).toContain("Sperrzeit hinzufügen");
    expect(html).toContain("Keine Sperrzeiten.");
    expect(html).not.toContain("Manual calendar blocks");
    expect(html).not.toContain("Calendar month");
  });

  it("leaves the Social link out while Social is off", () => {
    const html = render("en", false);
    expect(html).toContain("<h1>Editorial plan</h1>");
    expect(html).toContain("Blocked periods");
    expect(html).not.toContain("/social/calendar");
    expect(html).not.toContain("Social calendar");
  });

  it("names each blocked period's release button after it", () => {
    state.blocks = [block];
    const html = render("de", false);
    expect(html).toContain("Gesperrt");
    expect(html).toContain("Alle Kanäle");
    expect(html).toContain('aria-label="Sperrzeit Messe aufheben"');
    expect(html).toContain(">Aufheben</button>");
  });
});
