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
        error:
          found === undefined && path
            ? Object.assign(new Error("failed"), { status: 404 })
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
import type { CalendarItem } from "../api";
import { CalendarView } from "./calendar-view";
import { PostDrawer } from "./drawer";

// The calendar views (S6), rendered statically: month grid, week rows across
// the autumn clock change, list paging, filters from the URL, organization
// scope, and the texts in both languages.

const table = routeTable(webRegistry);
const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const second = {
  id: "p2",
  workspaceId: "w1",
  name: "Second project",
  timezone: "Europe/Berlin",
  role: "viewer",
} as Project;
const identity = (projects: Project[]): Identity => ({
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects,
});

function render(
  node: React.ReactNode,
  { locale = "en" as Locale, access = "owner", projects = [project] } = {},
) {
  const shell = {
    table,
    hrefOf: (key: string) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    modules: [
      {
        id: "social",
        access,
        enabled: true,
        nav: [],
        displayName: { en: "", de: "" },
        description: { en: "", de: "" },
      },
    ],
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity: identity(projects),
          locale,
          t: (k) => labels[locale][k],
          canEdit: access !== "viewer",
          isOwner: access === "owner",
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

const item = (over: Partial<CalendarItem>): CalendarItem => ({
  id: "c1",
  projectId: "p1",
  title: "Launch",
  excerpt: "We are live.",
  status: "scheduled",
  origin: "manual",
  readOnly: false,
  schedule: {
    mode: "at",
    at: "2026-11-10T09:15:00.000Z",
    local: "2026-11-10T10:15",
    timeZone: "Europe/Berlin",
    fold: null,
  },
  approvalState: "approved",
  version: 2,
  accounts: [{ accountId: "a-x", platform: "x", handle: "@orbit_x" }],
  publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
  ...over,
});
const accounts = {
  items: [
    {
      id: "a-x",
      platform: "x",
      handle: "@orbit_x",
      displayName: "X",
      status: "active",
      capability: "write_verified",
      connectedAt: "",
      lastCheckedAt: null,
      lastCheckCode: null,
      settings: { xLongPosts: false },
      version: 1,
    },
  ],
};
const ID = "11111111-1111-4111-8111-111111111111";
const buttons = (html: string) => [
  ...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g),
];

const month = (items: CalendarItem[], extra = "") => {
  search.value = `anchor=2026-11-03${extra}`;
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/social/calendar"] = { items, truncated: false };
  answers["/social/accounts"] = accounts;
};

describe("social calendar views (S6)", () => {
  it("shows a month as a grid of days with the posts, today marked", () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-11-03T10:00:00Z"),
    });
    month([
      item({}),
      item({
        id: "c2",
        title: null,
        excerpt: "Second",
        status: "draft",
        schedule: {
          ...item({}).schedule,
          at: "2026-11-20T17:00:00.000Z",
          local: "2026-11-20T18:00",
        },
      }),
    ]);
    const html = render(<CalendarView />);
    vi.useRealTimers();
    expect(html).toMatch(/role="grid"/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(7);
    expect(html.match(/role="gridcell"/g)).toHaveLength(42);
    expect(html).toMatch(/aria-current="date"[^>]*>[\s\S]*?3/);
    expect(html).toContain("10:15");
    expect(html).toContain("Launch");
    expect(html).toContain("18:00");
    expect(html).toContain("Second");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Draft");
    expect(html).toContain("November 2026");
  });

  it("shows +N more when a day has more than three posts", () => {
    month(["a", "b", "c", "d", "e"].map((id) => item({ id, title: id })));
    const html = render(<CalendarView />);
    expect(html).toContain("+2 more");
  });

  it("shows the autumn week in Berlin with 50 rows and the repeated hour marked", () => {
    search.value = "view=week&anchor=2026-10-25";
    answers["/social/calendar"] = {
      items: [
        item({
          id: "late",
          title: "After the change",
          schedule: {
            mode: "at",
            at: "2026-10-25T01:30:00.000Z",
            local: "2026-10-25T02:30",
            timeZone: "Europe/Berlin",
            fold: "later",
          },
        }),
      ],
      truncated: false,
    };
    const html = render(<CalendarView />);
    // The week's rows: the Sunday has 50 half hours, so the grid has 50 rows.
    expect(html.match(/<tr data-slot=/g)).toHaveLength(50);
    expect(html).toContain("02:30 (2nd)");
    const second = html.slice(html.indexOf("02:30 (2nd)"));
    expect(second.slice(0, second.indexOf("</tr>"))).toContain(
      "After the change",
    );
  });

  it("lists posts with Load more when there are more", () => {
    search.value = "view=list";
    answers["/social/posts"] = {
      items: [
        {
          id: "c1",
          status: "scheduled",
          title: "Launch",
          excerpt: "",
          schedule: item({}).schedule,
          approvalState: "approved",
          origin: "legacy_postiz",
          readOnly: true,
          publications: { total: 1, published: 0, failed: 0, unknown: 1, test: false },
          accounts: [],
          version: 2,
          updatedAt: "",
        },
      ],
      nextCursor: "next",
    };
    const html = render(<CalendarView />);
    expect(html).toContain("Launch");
    expect(html).toContain("Load more");
    // The list shows the same markers as the grids.
    expect(html).toContain("From Postiz");
    expect(html).toContain("Outcome unclear");
  });

  it("offers filters as labelled checkboxes, checked from the URL", () => {
    month([], `&platforms=x&statuses=draft&accounts=a-x`);
    const html = render(<CalendarView />);
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*id="social-calendar-platform-x"[^>]*checked=""/,
    );
    expect(html).toMatch(/<label[^>]*for="social-calendar-platform-x"/);
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*id="social-calendar-status-draft"[^>]*checked=""/,
    );
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*id="social-calendar-status-scheduled"(?![^>]*checked)/,
    );
    expect(html).toMatch(/<label[^>]*for="social-calendar-account-a-x"/);
  });

  it("shows the empty text for an empty month and offers the scope switch only with several projects", () => {
    month([]);
    expect(render(<CalendarView />)).toContain(
      "No posts planned in this period.",
    );
    expect(render(<CalendarView />)).not.toContain("All projects");
    expect(render(<CalendarView />, { projects: [project, second] })).toContain(
      "All projects",
    );
  });

  it("shows the project name on each post in the organization scope", () => {
    search.value = "anchor=2026-11-03&scope=organization";
    answers["/organizations/w1/social/calendar"] = {
      items: [item({ projectId: "p2", projectName: "Second project" })],
      projects: [{ id: "p2", name: "Second project" }],
      truncated: false,
    };
    const html = render(<CalendarView />, { projects: [project, second] });
    expect(html).toContain("Second project");
    expect(html).toMatch(/id="social-calendar-project-p2"/);
  });

  it("names every button and has German texts", () => {
    month([item({})]);
    const html = render(<CalendarView />, { locale: "de" });
    expect(html).toContain("Monat");
    expect(html).toContain("Woche");
    expect(html).toContain("Heute");
    expect(html).toContain("Eingeplant");
    for (const [, attrs, inner] of buttons(html))
      expect(`${attrs}${inner.replace(/<[^>]+>/g, "")}`.trim()).toMatch(
        /aria-label="[^"]+"|\S/,
      );
  });
});

describe("post drawer", () => {
  const drawer = (
    access: string,
    over: Partial<CalendarItem> = {},
    scope: "project" | "organization" = "project",
    loaded: Record<string, unknown> = {},
  ) => {
    answers["/social/posts/c1"] = {
      id: "c1",
      status: "scheduled",
      title: "Launch",
      baseText: "We are live.",
      baseMedia: [],
      schedule: {
        mode: "at",
        at: "2026-11-10T09:15:00.000Z",
        local: "2026-11-10T10:15",
        timeZone: "America/New_York",
        fold: null,
      },
      approval: {
        state: "approved",
        requestId: null,
        approvedAt: null,
        approvedBy: null,
      },
      packageHash: null,
      origin: "manual",
      readOnly: false,
      version: 2,
      createdAt: "",
      updatedAt: "",
      variants: [
        {
          id: "v1",
          accountId: "a-x",
          platform: "x",
          handle: "@orbit_x",
          body: "We are live.",
          inheritsText: true,
          inheritsMedia: true,
          media: [],
          options: {},
          issues: [],
          version: 1,
        },
      ],
      ...loaded,
    };
    return render(
      <PostDrawer
        item={item(over)}
        scope={scope}
        onClose={() => {}}
        onMove={() => {}}
      />,
      { access },
    );
  };

  it("shows the post's time in the project zone and its own, the preview and the editor link", () => {
    const html = drawer("owner");
    expect(html).toContain("2026-11-10 10:15 (Europe/Berlin)");
    expect(html).toContain("America/New_York");
    expect(html).toContain("@orbit_x");
    expect(html).toContain("posts?post=c1");
    expect(html).toContain("Move to…");
  });

  it("offers no move to a viewer, for a read-only post or another project's", () => {
    expect(drawer("viewer")).not.toContain("Move to…");
    // The loaded post decides, not the calendar's copy of it.
    expect(
      drawer("owner", {}, "project", {
        readOnly: true,
        origin: "legacy_postiz",
      }),
    ).not.toContain("Move to…");
    expect(
      drawer("owner", {}, "project", { status: "publishing" }),
    ).not.toContain("Move to…");
    const other = drawer(
      "owner",
      { projectId: "p2", projectName: "Second project" },
      "organization",
    );
    expect(other).not.toContain("Move to…");
    expect(other).toContain("/p/p2/");
  });
});
