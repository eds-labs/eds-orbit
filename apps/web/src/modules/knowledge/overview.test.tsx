import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

// Every resource the page reads, by a part of its path. A path without an
// entry answers 404, as a route of a switched-off module does; an Error
// answers 403. `requested` records every path asked for.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const requested = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      if (path) requested.push(path);
      const key = Object.keys(answers).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      const failed = found === undefined || found instanceof Error;
      return {
        data: failed ? null : found,
        error: failed
          ? Object.assign(new Error("failed"), {
              status: found instanceof Error ? 403 : 404,
            })
          : null,
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
import { webRegistry } from "@/modules/registry";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import { KnowledgeHomeCard } from "./home";
import { Knowledge, type KnowledgeTab } from "./knowledge";
import { KnowledgeOverview, sourceExpiry } from "./overview";

const table = routeTable(webRegistry);
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
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const shell = {
  hrefOf: (key: string) =>
    projectHref(
      project.id,
      table.routes.find((r) => r.key === key)!,
    ),
} as ShellContextValue;

const entity = (id: string, data: Record<string, unknown>) => ({
  id,
  kind: "x",
  version: 1,
  data,
  createdAt: ago(1000),
  updatedAt: ago(1000),
});

function render(
  node: React.ReactNode,
  { locale = "en", owner = true }: { locale?: Locale; owner?: boolean } = {},
) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: owner,
          isOwner: owner,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("sourceExpiry", () => {
  it("is expiring within 48 h of the end of its maximum age", () => {
    const result = sourceExpiry(
      { lastSuccessfulSyncAt: ago(7 * 24 - 1), maxAgeHours: 168 },
      NOW,
    );
    expect(result.state).toBe("expiring");
    expect(result.expiresAt?.toISOString()).toBe(
      new Date(NOW + HOUR).toISOString(),
    );
  });

  it("is stale past its maximum age", () => {
    expect(
      sourceExpiry({ lastSuccessfulSyncAt: ago(8 * 24), maxAgeHours: 168 }, NOW)
        .state,
    ).toBe("stale");
  });

  it("is stale without a sync, with no expiry", () => {
    expect(
      sourceExpiry({ lastSuccessfulSyncAt: null, maxAgeHours: 168 }, NOW),
    ).toEqual({ expiresAt: null, state: "stale" });
  });

  it("is fresh further away, with the schema default of 168 h", () => {
    expect(sourceExpiry({ lastSuccessfulSyncAt: ago(24) }, NOW).state).toBe(
      "fresh",
    );
  });
});

describe("KnowledgeOverview", () => {
  it("sorts sources by expiry, stale first, and leaves revoked ones out", () => {
    answers["/sources"] = {
      items: [
        entity("s1", {
          name: "src-fresh",
          type: "website",
          lastSuccessfulSyncAt: ago(24),
          maxAgeHours: 168,
        }),
        entity("s2", {
          name: "src-expiring",
          type: "gitbook",
          lastSuccessfulSyncAt: ago(7 * 24 - 1),
          maxAgeHours: 168,
        }),
        entity("s3", {
          name: "src-never",
          type: "manual",
          lastSuccessfulSyncAt: null,
          maxAgeHours: 168,
        }),
        entity("s4", {
          name: "src-stale",
          type: "website",
          lastSuccessfulSyncAt: ago(9 * 24),
          maxAgeHours: 168,
        }),
        entity("s5", {
          name: "src-revoked",
          type: "website",
          status: "revoked",
          lastSuccessfulSyncAt: null,
        }),
      ],
    };
    const html = render(<KnowledgeOverview />);
    const order = [...html.matchAll(/src-([a-z]+)/g)].map((m) => m[1]);
    expect(order).toEqual(["never", "stale", "expiring", "fresh"]);
    expect(html).toContain("Stale");
    expect(html).toContain("Expiring");
  });

  it("shows four metrics from the existing endpoints", () => {
    answers["/sources"] = {
      items: [
        entity("s1", { name: "a", lastSuccessfulSyncAt: ago(1) }),
        entity("s2", { name: "b", lastSuccessfulSyncAt: ago(1) }),
      ],
    };
    // Ruling R13: the exact count from /dashboard, beyond a list page's cap.
    answers["/dashboard"] = { counts: { verifiedFacts: 742 } };
    answers["/knowledge-health"] = {
      conflicts: [entity("f4", { key: "pricing.plan", status: "conflicting" })],
      staleSources: [],
      failedImports: [],
      expiredFacts: [],
    };
    answers["/indexes"] = {
      items: [
        { id: "i2", generation: 2, state: "building", profile: "p" },
        { id: "i1", generation: 1, state: "active", profile: "p" },
      ],
    };
    const html = render(<KnowledgeOverview />);
    expect(html.match(/class="metric"/g)).toHaveLength(4);
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(amounts.slice(0, 4)).toEqual(["2", "742", "1", "1"]);
    expect(html).toContain("pricing.plan");
    // The capped facts collection is not read any more.
    expect(requested.some((p) => p.includes("/facts"))).toBe(false);
  });

  it("shows — and the error when the verified count cannot be read", () => {
    answers["/dashboard"] = new Error("forbidden");
    const html = render(<KnowledgeOverview />);
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(amounts[1]).toBe("—");
    expect(html).toContain('role="alert"');
  });

  it("shows — for a dashboard without the verified count", () => {
    answers["/dashboard"] = { counts: {} };
    const html = render(<KnowledgeOverview />);
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(amounts[1]).toBe("—");
    expect(html).not.toContain('role="alert"');
  });

  it("shows the index quality of the active generation to owners", () => {
    answers["/indexes"] = {
      items: [
        {
          id: "i1",
          generation: 5,
          state: "active",
          profile: "p",
          evaluation: {
            recallAt10: 0.98,
            mrr: 0.83,
            forbiddenHits: 0,
            passed: true,
            cases: 60,
            executedAt: ago(2),
          },
        },
      ],
    };
    const html = render(<KnowledgeOverview />);
    expect(html).toContain("Index quality");
    expect(html).toContain("98%");
    expect(html).toContain("0.83");
  });

  it("asks a non-owner for no index and shows it as unknown", () => {
    const html = render(<KnowledgeOverview />, { owner: false });
    expect(requested.some((p) => p.includes("/indexes"))).toBe(false);
    expect(html).not.toContain("Index quality");
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(amounts[3]).toBe("—");
  });

  it("ignores a 403 from the index route", () => {
    answers["/indexes"] = new Error("forbidden");
    const html = render(<KnowledgeOverview />);
    expect(html).not.toContain("Index quality");
    expect(html).not.toContain('role="alert"');
  });

  it("links to Health, Impact and Inspector", () => {
    const html = render(<KnowledgeOverview />, { locale: "de" });
    expect(html).toContain('href="/p/p1/knowledge/health"');
    expect(html).toContain('href="/p/p1/knowledge/impact"');
    expect(html).toContain('href="/p/p1/knowledge/inspector"');
    expect(html).toContain("<h1>Wissen</h1>");
    expect(html).toContain("Modul");
  });

  it("has no tab bar", () => {
    expect(render(<KnowledgeOverview />)).not.toContain('role="tablist"');
    expect(render(<Knowledge tab="overview" />)).not.toContain(
      'role="tablist"',
    );
  });

  it("has no back link", () => {
    expect(render(<KnowledgeOverview />)).not.toContain("knowledge-back");
  });
});

describe("Knowledge sub-pages", () => {
  const subPages: KnowledgeTab[] = [
    "sources",
    "facts",
    "import",
    "conflicts",
    "library",
    "health",
    "inspector",
    "impact",
  ];

  it("shows the back link to the overview and no tab bar", () => {
    for (const tab of subPages) {
      const html = render(<Knowledge tab={tab} />, { locale: "de" });
      expect(html, tab).not.toContain('role="tablist"');
      expect(html, tab).toMatch(
        /<a[^>]*class="[^"]*knowledge-back[^"]*"[^>]*href="\/p\/p1\/knowledge"[^>]*>.*Wissen<\/a>/,
      );
    }
  });

  it("keeps the index generations on the health page only", () => {
    answers["/indexes"] = { items: [] };
    expect(render(<Knowledge tab="health" />)).toContain(
      "Embedding index generations",
    );
    expect(render(<KnowledgeOverview />)).not.toContain(
      "Embedding index generations",
    );
  });
});

describe("KnowledgeHomeCard", () => {
  it("renders nothing while the module answers 404", () => {
    expect(render(<KnowledgeHomeCard />)).toBe("");
  });

  it("shows sources, verified facts, conflicts and the active generation", () => {
    answers["/knowledge-health"] = {
      conflicts: [entity("f4", { key: "x", status: "conflicting" })],
    };
    answers["/sources"] = { items: [entity("s1", { name: "a" })] };
    answers["/dashboard"] = { counts: { verifiedFacts: 612 } };
    answers["/indexes"] = {
      items: [{ id: "i1", generation: 3, state: "active", profile: "p" }],
    };
    const html = render(<KnowledgeHomeCard />);
    expect(html).toContain("Knowledge");
    expect(html).toContain("<dd>612</dd>");
    expect(html).toContain("<dd>3</dd>");
    expect(html).toContain('href="/p/p1/knowledge"');
  });

  it("leaves the generation out for a non-owner", () => {
    answers["/knowledge-health"] = { conflicts: [] };
    const html = render(<KnowledgeHomeCard />, { owner: false });
    expect(html).not.toContain("Index generation");
  });
});
