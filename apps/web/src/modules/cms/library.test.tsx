import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      return {
        data: key === undefined ? null : answers[key],
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
import { assetSrc, projectLocales, type CmsTerm } from "./api";
import { MediaView, missingAlt } from "./media";
import { TaxonomiesView, termTree } from "./taxonomies";
import { AuthorsView, bioOf, parseLinks } from "./authors";
import { cmsText } from "./labels";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "FamilyPlan",
  timezone: "Europe/Berlin",
  language: "de",
  contentLanguages: ["de"],
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u1", name: "Mario", email: "owner@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const render = (
  node: React.ReactNode,
  { locale = "de" as Locale, canEdit = true } = {},
) =>
  renderToStaticMarkup(
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

const term = (over: Partial<CmsTerm>): CmsTerm => ({
  id: "t",
  kind: "category",
  locale: "de",
  slug: "s",
  name: "N",
  archived: false,
  version: 1,
  parentId: null,
  ...over,
});
const asset = {
  id: "a1",
  name: "kalender.png",
  mime: "image/png",
  width: 1200,
  height: 800,
  alt: { de: "Kalender" },
  caption: {},
  renditions: [
    { name: "original", mime: "image/png", width: 1200, height: 800 },
    { name: "w480", mime: "image/webp", width: 480, height: 320 },
  ],
  aiLabel: { origin: "ai_generated", labelState: "labelled" },
  archived: false,
  version: 2,
};
answers["/sites"] = {
  items: [
    {
      id: "s1",
      name: "FP",
      baseUrl: "https://fp.example",
      locales: ["de", "en"],
      defaultLocale: "de",
      verification: "configured",
      archived: false,
      version: 1,
    },
  ],
};

describe("content library (CH1.14c)", () => {
  it("orders categories as a tree and keeps orphans at the top", () => {
    const rows = termTree([
      term({ id: "c", name: "Child", parentId: "p" }),
      term({ id: "p", name: "Parent" }),
      term({ id: "o", name: "Orphan", parentId: "gone" }),
      term({ id: "g", name: "Grandchild", parentId: "c" }),
    ]);
    expect(rows.map((r) => `${r.depth}:${r.term.name}`)).toEqual([
      "0:Orphan",
      "0:Parent",
      "1:Child",
      "2:Grandchild",
    ]);
  });

  it("reads profile links, missing alt texts and the project's languages", () => {
    expect(parseLinks(" https://a.example \n\n https://b.example\r\n")).toEqual(
      ["https://a.example", "https://b.example"],
    );
    expect(
      parseLinks(
        Array.from({ length: 12 }, (_, i) => `https://${i}.example`).join("\n"),
      ),
    ).toHaveLength(10);
    expect(missingAlt({ alt: { de: "x", en: " " } }, ["de", "en"])).toEqual([
      "en",
    ]);
    expect(
      projectLocales(
        [
          { locales: ["en", "de"], archived: false },
          { locales: ["fr"], archived: true },
        ],
        ["it"],
      ),
    ).toEqual(["de", "en"]);
    expect(projectLocales([], ["it"])).toEqual(["it"]);
    expect(assetSrc("p1", asset)).toBe(
      "/api/projects/p1/cms/assets/a1/files/w480.webp",
    );
  });

  it("lists images with alt text state and AI label; only editors upload", () => {
    answers["/assets"] = { items: [asset], nextCursor: null };
    const t = cmsText("de").library.media;
    const html = render(<MediaView />);
    expect(html).toContain("kalender.png");
    expect(html).toContain(t.altMissing("en"));
    expect(html).toContain(t.ai);
    expect(html).toContain(
      'src="/api/projects/p1/cms/assets/a1/files/w480.webp"',
    );
    expect(html).toContain(t.upload);
    expect(render(<MediaView />, { canEdit: false })).not.toContain(t.upload);
  });

  it("shows categories of a language as a tree; viewers cannot edit", () => {
    answers["/terms"] = {
      items: [
        term({ id: "p", name: "Familie", slug: "familie" }),
        term({
          id: "c",
          name: "Kalender",
          slug: "kalender",
          parentId: "p",
          archived: true,
        }),
        term({ id: "x", name: "Englisch", locale: "en" }),
        term({ id: "y", name: "Tipps", kind: "tag" }),
      ],
    };
    const t = cmsText("de").library.terms;
    const html = render(<TaxonomiesView />);
    expect(html).toContain("Familie");
    expect(html).toContain("↳ Kalender");
    expect(html).toContain(t.archivedBadge);
    expect(html).not.toContain("Englisch");
    expect(html).not.toContain("Tipps");
    expect(html).toContain(t.new);
    const viewer = render(<TaxonomiesView />, { canEdit: false });
    expect(viewer).not.toContain(t.new);
    // The edit column header stays (screen readers); the buttons do not.
    expect(viewer).not.toContain(`>${t.archive}<`);
    expect(viewer).not.toContain(`>${t.unarchive}<`);
  });

  it("lists authors with their bio in the interface language", () => {
    answers["/authors"] = {
      items: [
        {
          id: "a",
          name: "Mario E.",
          slug: "mario",
          bio: { de: "Gründer", en: "Founder" },
          sameAs: [],
          archived: false,
          version: 1,
        },
      ],
    };
    const html = render(<AuthorsView />, { locale: "en" });
    expect(html).toContain("Mario E.");
    expect(html).toContain("Founder");
    expect(html).toContain(cmsText("en").library.authors.new);
    expect(bioOf({ bio: { de: "Gründerin" } }, "en")).toBe("Gründerin");
    expect(bioOf({ bio: {} }, "en")).toBeNull();
  });
});
