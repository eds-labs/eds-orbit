import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

const search = vi.hoisted(() => ({ value: "" }));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return {
        data: found ?? null,
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
import { cmsWeb } from "./manifest";
import { cmsAttention } from "./attention";
import { CmsOverview } from "./overview";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { EntriesView, listQuery } from "./entries";
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

function render(
  node: React.ReactNode,
  { locale = "de" as Locale, canEdit = true } = {},
) {
  return renderToStaticMarkup(
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
    </WorkspaceContext.Provider>,
  );
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  type: "article",
  locale: "de",
  translationGroupId: "g1",
  slug: "familienplanung",
  status: "draft",
  publishedRevisionId: null,
  scheduledRevisionId: null,
  scheduledAt: null,
  firstPublishedAt: null,
  lastPublishedAt: null,
  archivedAt: null,
  origin: "manual",
  version: 1,
  createdAt: "2026-11-19T10:00:00.000Z",
  updatedAt: "2026-11-19T10:00:00.000Z",
  ...over,
});
const site = {
  id: "s1",
  name: "FamilyPlan",
  baseUrl: "https://familyplan.example",
  locales: ["de", "en"],
  defaultLocale: "de",
  verification: "configured",
  archived: false,
  version: 1,
};

describe("content entries (CH1.14a)", () => {
  it("registers the entries view under the content module", () => {
    const cms = cmsWeb;
    expect(cms.views.map((v) => v.key)).toEqual([
      "cms",
      "cms.entries",
      "cms.calendar",
      "cms.media",
      "cms.taxonomies",
      "cms.authors",
    ]);
    expect(Object.keys(cms.attention ?? {})).toEqual([
      "cms_publication_stopped",
      "cms_live_check_failed",
    ]);
  });

  it("builds the list query from the filters", () => {
    expect(listQuery({ status: "", locale: "", q: " " })).toBe("");
    expect(
      listQuery({ status: "published", locale: "de", q: "Plan" }, "c1"),
    ).toBe("?status=published&locale=de&q=Plan&cursor=c1");
  });

  it("lists entries with status and an open decision; editors get the new-article form", () => {
    search.value = "";
    answers["/entries"] = {
      items: [
        {
          ...entry(),
          title: "Familienplanung",
          excerpt: "Kurz.",
          pendingRequest: { id: "r1" },
        },
        {
          ...entry({ id: "e2", status: "published" }),
          title: "",
          excerpt: "",
          pendingRequest: null,
        },
      ],
      nextCursor: null,
    };
    answers["/sites"] = { items: [site] };
    const html = render(<EntriesView />);
    const t = cmsText("de");
    expect(html).toContain("Familienplanung");
    expect(html).toContain(t.entries.waiting);
    expect(html).toContain(t.status.published);
    expect(html).toContain(t.entries.untitled);
    expect(html).toContain(t.entries.newArticle);
    expect(html).toContain('href="?entry=e1"');
    expect(render(<EntriesView />, { canEdit: false })).not.toContain(
      t.entries.newArticle,
    );
  });

  it("shows an entry's state and what stops its publication", () => {
    search.value = "entry=e1";
    answers["/entries/e1"] = {
      entry: entry({
        status: "published",
        publishedRevisionId: "r2",
        lastPublishedAt: "2026-11-19T11:00:00.000Z",
      }),
      draft: {
        title: "Familienplanung",
        excerpt: "",
        version: 3,
        updatedAt: "2026-11-19T11:00:00.000Z",
        heroAssetId: null,
      },
      siteIds: ["s1"],
      translations: [
        {
          id: "e3",
          locale: "en",
          slug: "family-planning",
          status: "draft",
          updatedAt: "2026-11-19T11:00:00.000Z",
        },
      ],
      latestRevision: {
        id: "r2",
        number: 2,
        createdAt: "2026-11-19T11:00:00.000Z",
      },
      publishedRevision: { id: "r2", number: 2, slug: "familienplanung" },
      pendingRequest: null,
      unsavedChanges: true,
    };
    answers["/entries/e1/preflight"] = {
      ok: false,
      issues: [
        { code: "CMS_ALT_TEXT_MISSING", assetIds: ["a1"] },
        { code: "CMS_CONTENT_RULE", siteId: "s1" },
        { code: "NEW_CODE" },
      ],
    };
    const html = render(<EntriesView />, { locale: "en" });
    const t = cmsText("en");
    expect(html).toContain("#2");
    expect(html).toContain(t.entries.unsaved);
    expect(html).toContain(t.entries.issue.CMS_ALT_TEXT_MISSING);
    expect(html).toContain(
      `${t.entries.issue.CMS_CONTENT_RULE}<span class="field-hint"> · FamilyPlan</span>`,
    );
    expect(html).toContain(`${t.entries.issueOther} (NEW_CODE)`);
    // The editor (CH1.14b): title, save state, a lazily loaded canvas and a
    // publish button that waits while something stops the publication.
    expect(html).toContain('value="Familienplanung"');
    expect(html).toContain(`>${t.editor.save.saved}<`);
    expect(html).toContain('class="cms-canvas cms-canvas-loading"');
    expect(html).toContain(`disabled="">${t.editor.update}</button>`);
    expect(html).toContain(`>${t.editor.unpublish}</button>`);

    const viewer = render(<EntriesView />, { locale: "en", canEdit: false });
    expect(viewer).toContain(t.editor.readOnly);
    expect(viewer).toContain('readOnly=""');
    expect(viewer).not.toContain(t.editor.update);
    expect(viewer).not.toContain(t.editor.save.saved);
    search.value = "";
  });

  it("words attention counts in both languages", () => {
    expect(
      cmsAttention.cms_publication_stopped!({ count: 2 } as never, "de").title,
    ).toBe(cmsText("de").attention.stopped(2));
    expect(
      cmsAttention.cms_live_check_failed!({ count: 1 } as never, "en").title,
    ).toBe(cmsText("en").attention.liveCheck(1));
  });

  it("the overview counts entries, open decisions and sites and links the latest", () => {
    answers["/status"] = {
      module: "cms",
      version: "0.1.0",
      settings: {
        publishApprovers: "owner_or_editor",
        fourEyes: true,
        timeZone: null,
        lateWindowHours: 24,
      },
      settingsVersion: 1,
    };
    answers["/summary"] = {
      entries: { draft: 3, scheduled: 1, published: 7, archived: 0 },
      waiting: 2,
      sites: 1,
      recent: [
        {
          id: "e9",
          status: "draft",
          locale: "de",
          title: "Neu",
          updatedAt: "2026-11-19T10:00:00.000Z",
        },
      ],
    };
    const shell = {
      hrefOf: (key: string) =>
        key === "cms.entries" ? "/p/p1/cms/entries" : "/",
    } as unknown as ShellContextValue;
    const html = render(
      <ShellContext.Provider value={shell}>
        <CmsOverview />
      </ShellContext.Provider>,
    );
    const t = cmsText("de");
    expect(html).toContain(t.overview.waiting);
    expect(html).toContain(">7<");
    expect(html).toContain(t.fourEyes);
    expect(html).toContain('href="/p/p1/cms/entries?entry=e9"');
  });
});
