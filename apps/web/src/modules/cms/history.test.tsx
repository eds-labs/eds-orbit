import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const asked = vi.hoisted(() => [] as Array<string | null>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      asked.push(path);
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      return {
        data: key === undefined || !path ? null : answers[key],
        error: null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import type { EntryDetail, RevisionDiff } from "./api";
import { DiffView, fieldValue, HistoryPanel } from "./editor/history";
import { cmsActionRequests } from "./action-requests";
import { cmsText } from "./labels";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "FamilyPlan",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u1", name: "Mario", email: "owner@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const shell = {
  hrefOf: (key: string) => (key === "cms.entries" ? "/p/p1/cms/entries" : "/"),
} as unknown as ShellContextValue;
const render = (
  node: React.ReactNode,
  { locale = "en" as Locale, canEdit = true } = {},
) =>
  renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit,
          isOwner: canEdit,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );

const t = cmsText("en").history;
const diff: RevisionDiff = {
  from: { id: "r1", number: 1 },
  to: { id: "r2", number: 2 },
  fields: [
    { name: "title", from: "Alt", to: "Neu" },
    { name: "termIds", from: [], to: ["t1"] },
  ],
  body: [
    { op: "equal", count: 2 },
    { op: "removed", type: "paragraph", text: "Alter Satz" },
    { op: "added", type: "heading", text: "Neue Überschrift" },
  ],
  changed: true,
};
answers["/sites"] = {
  items: [
    {
      id: "s1",
      name: "FamilyPlan",
      baseUrl: "https://fp.example",
      locales: ["de"],
      defaultLocale: "de",
      verification: "configured",
      archived: false,
      version: 1,
    },
  ],
};

describe("content history and decisions (CH1.14d)", () => {
  it("shows field values briefly", () => {
    expect(fieldValue(t, null)).toBe(t.empty);
    expect(fieldValue(t, [])).toBe(t.empty);
    expect(fieldValue(t, ["a", "b"])).toBe("2 × a, b");
    expect(fieldValue(t, { seoTitle: "x", robots: {} })).toBe(
      "seoTitle, robots",
    );
    expect(fieldValue(t, "Titel")).toBe("Titel");
  });

  it("renders a difference with fields, unchanged runs and changed blocks", () => {
    const html = renderToStaticMarkup(<DiffView diff={diff} t={t} />);
    expect(html).toContain(`<del>Alt</del> → <ins>Neu</ins>`);
    expect(html).toContain(t.fieldNames.termIds);
    expect(html).toContain(t.unchanged(2));
    expect(html).toContain('class="cms-diff-removed"');
    expect(html).toContain("Neue Überschrift");
    expect(
      renderToStaticMarkup(
        <DiffView diff={{ ...diff, changed: false }} t={t} />,
      ),
    ).toContain(t.same);
  });

  it("lists versions and the publication log; restoring needs edit rights", () => {
    answers["/revisions"] = {
      items: [
        {
          id: "r2",
          number: 2,
          slug: "a",
          title: "A",
          contentHash: "h",
          wordCount: 120,
          changeNote: "Tippfehler",
          basedOnRevisionId: "r1",
          live: false,
          scheduled: true,
          createdBy: "u1",
          createdAt: "2026-11-19T10:00:00.000Z",
        },
        {
          id: "r1",
          number: 1,
          slug: "a",
          title: "A",
          contentHash: "g",
          wordCount: 100,
          changeNote: null,
          basedOnRevisionId: null,
          live: true,
          scheduled: false,
          createdBy: "u1",
          createdAt: "2026-11-18T10:00:00.000Z",
        },
      ],
      nextBefore: null,
    };
    answers["/publications"] = {
      items: [
        {
          id: "x",
          revisionId: "r1",
          siteId: "s1",
          action: "publish",
          status: "live_verified",
          approvalRequestId: null,
          scheduledAt: "2026-11-18T10:00:00.000Z",
          visibleAt: "2026-11-18T10:00:05.000Z",
          notifiedAt: null,
          liveVerifiedAt: null,
          errorCode: null,
          attempts: 1,
          createdAt: "2026-11-18T10:00:00.000Z",
        },
      ],
      nextBefore: null,
    };
    const detail = {
      entry: { id: "e1", version: 3, publishedRevisionId: "r1" },
      publishedRevision: { id: "r1", number: 1, slug: "a" },
      latestRevision: { id: "r2", number: 2, createdAt: "" },
    } as unknown as EntryDetail;
    const props = {
      detail,
      sites: (answers["/sites"] as { items: never[] }).items,
      base: "/projects/p1/cms/entries/e1",
      flush: async () => true,
      draftVersion: () => 4,
      onRestored: () => {},
    };
    const html = render(<HistoryPanel {...props} editable />);
    expect(html).toContain("#2");
    expect(html).toContain("Tippfehler");
    expect(html).toContain(t.scheduled);
    expect(html).toContain(t.compareLive);
    expect(html).toContain(t.statuses.live_verified);
    expect(html).toContain("FamilyPlan");
    expect(html).toContain(t.restore);
    expect(render(<HistoryPanel {...props} editable={false} />)).not.toContain(
      t.restore,
    );
    // Strict list queries: no extra parameters.
    expect(asked).toContain("/projects/p1/cms/entries/e1/revisions?limit=20");
    expect(asked).toContain(
      "/projects/p1/cms/entries/e1/publications?limit=20",
    );
  });

  it("renders a publication request with websites, time, changes and a link to the editor", () => {
    answers["/revisions/diff"] = diff;
    const item = {
      id: "q1",
      actionType: "cms.entry.publish",
      summary: {
        operation: {
          kind: "cms_publish",
          entryId: "e1",
          locale: "de",
          title: "Familienkalender",
          slug: "familienkalender",
          revision: 2,
          revisionId: "r2",
          previousRevisionId: "r1",
          update: true,
          siteIds: ["s1"],
          schedule: {
            mode: "at",
            at: "2026-11-20T09:00:00.000Z",
            local: "2026-11-20T10:00",
            timeZone: "Europe/Berlin",
          },
        },
      },
    };
    const view = cmsActionRequests["cms.entry.publish"]!;
    expect(view.accepts(item)).toBe(true);
    expect(
      view.accepts({ summary: { operation: { kind: "social_post" } } }),
    ).toBe(false);
    const d = cmsText("de").decision;
    const html = render(
      <view.component item={item} de pending={false} decide={() => {}} />,
      { locale: "de" },
    );
    expect(html).toContain(d.update("Familienkalender"));
    expect(html).toContain("FamilyPlan");
    expect(html).toContain("2026-11-20 10:00 (Europe/Berlin)");
    expect(html).toContain(d.changes);
    expect(html).toContain('href="/p/p1/cms/entries?entry=e1"');
    expect(asked).toContain(
      "/projects/p1/cms/entries/e1/revisions/diff?from=r1&to=r2",
    );
    const unpublish = cmsActionRequests["cms.entry.unpublish"]!;
    const gone = render(
      <unpublish.component
        item={{
          summary: {
            operation: {
              kind: "cms_unpublish",
              entryId: "e1",
              locale: "de",
              title: "X",
              slug: "x",
              siteIds: ["s1"],
              replacementEntryId: null,
            },
          },
        }}
        de={false}
        pending
        decide={() => {}}
      />,
    );
    expect(gone).toContain(cmsText("en").decision.gone);
    expect(gone).toContain('disabled=""');
  });
});
