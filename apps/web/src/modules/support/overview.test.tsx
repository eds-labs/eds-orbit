import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The query string of the open page, as the router reports it.
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

// Every resource the page reads, by a part of its path. A path without an
// entry answers 404, as a route of a switched-off module does. `requested`
// records every path asked for.
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
import { SupportOverview, ticketRedirect } from "./overview";

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
const UUID = "0b9a7f6e-3c1d-4e55-8a3b-2f6d9c1e4a77";

const shell = {
  hrefOf: (key: string) =>
    projectHref(
      project.id,
      table.routes.find((r) => r.key === key)!,
    ),
} as ShellContextValue;

const ticket = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `t${n}`,
  number: n,
  subject: `subject-${String(n).padStart(2, "0")}`,
  status: "open",
  priority: "normal",
  category: null,
  tags: [],
  assigneeUserId: null,
  channel: "email",
  inboxId: "i1",
  contactId: "c1",
  firstResponseDueAt: null,
  resolutionDueAt: new Date(NOW + 3 * 3600_000).toISOString(),
  firstRespondedAt: null,
  resolvedAt: null,
  mergedIntoTicketId: null,
  updatedAt: new Date(NOW - 3600_000).toISOString(),
  createdAt: new Date(NOW - 7200_000).toISOString(),
  contact: { id: "c1", name: "Ada", email: "ada@example.invalid" },
  ...extra,
});
const days = (count: number, perDay: (i: number) => number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `2026-10-${String(5 + i).padStart(2, "0")}`,
      perDay(i),
    ]),
  );

function render(locale: Locale = "en") {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: true,
          isOwner: true,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        <SupportOverview />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  search.value = "";
});
afterEach(() => vi.useRealTimers());

describe("ticketRedirect", () => {
  it("redirects ?ticket to the tickets page", () => {
    expect(ticketRedirect(`?ticket=${UUID}`)).toBe(`tickets?ticket=${UUID}`);
    expect(ticketRedirect(`?a=1&ticket=${UUID}`)).toBe(
      `tickets?ticket=${UUID}`,
    );
    expect(ticketRedirect("?ticket=x")).toBeNull();
    expect(ticketRedirect("")).toBeNull();
  });
});

describe("SupportOverview", () => {
  it("shows only a skeleton and asks for nothing while an old ticket link redirects", () => {
    search.value = `?ticket=${UUID}`;
    answers["/summary"] = {
      open: 1,
      unassigned: 0,
      atRisk: 0,
      breached: 0,
      openByInbox: {},
    };
    const html = render();
    expect(html).toBe('<div class="skeleton" aria-hidden="true"></div>');
    expect(requested).toEqual([]);
  });

  it("renders the overview for a link without a valid ticket id", () => {
    search.value = "?ticket=not-a-uuid";
    const html = render();
    expect(html).toContain('class="metric"');
    expect(requested.some((p) => p.includes("/summary"))).toBe(true);
  });

  it("shows five metrics with — for missing stats", () => {
    answers["/summary"] = {
      open: 12,
      unassigned: 4,
      atRisk: 2,
      breached: 1,
      openByInbox: {},
    };
    // No stats answer: the median and the bars stay unknown.
    const html = render();
    expect(html.match(/class="metric"/g)).toHaveLength(5);
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(amounts.slice(0, 5)).toEqual(["12", "4", "2", "1", "—"]);
    expect(html).toContain("First response, 14 days");
  });

  it("shows the median first response as a duration", () => {
    answers["/summary"] = {
      open: 0,
      unassigned: 0,
      atRisk: 0,
      breached: 0,
      openByInbox: {},
    };
    answers["/stats"] = {
      firstResponse: { count: 3, medianMinutes: 150 },
      volume: { total: 0, byChannel: {}, byDay: {} },
    };
    expect(render()).toContain("<strong>2.5 h</strong>");
  });

  it("lists urgent tickets in API order and links them to the tickets page", () => {
    answers["sort=sla"] = {
      items: [ticket(3), ticket(1), ticket(2)],
      nextCursor: null,
    };
    answers["view=mine"] = { items: [], nextCursor: null };
    const html = render();
    const order = [...html.matchAll(/subject-(\d\d)/g)].map((m) => m[1]);
    expect(order).toEqual(["03", "01", "02"]);
    expect(html).toContain('href="/p/p1/support/tickets?ticket=t3"');
  });

  it("lists my open tickets and says so when there are none", () => {
    answers["sort=sla"] = { items: [], nextCursor: null };
    answers["view=mine"] = { items: [ticket(7)], nextCursor: null };
    expect(render()).toContain("subject-07");
    answers["view=mine"] = { items: [], nextCursor: null };
    expect(render()).toContain("No open tickets assigned to you.");
    expect(render("de")).toContain("Meine Tickets");
  });

  it("renders 14 bars from byDay with a text alternative", () => {
    answers["/stats"] = {
      firstResponse: { count: 0, medianMinutes: null },
      volume: {
        total: 0,
        byChannel: {},
        byDay: days(14, (i) => (i === 13 ? 9 : i % 3)),
      },
    };
    const html = render();
    expect(html.match(/class="support-bar"/g)).toHaveLength(14);
    expect(html).toMatch(/role="img" aria-label="[^"]*2026-10-18[^"]*9/);
  });

  it("keeps the last 14 days when the server returns 15", () => {
    answers["/stats"] = {
      firstResponse: { count: 0, medianMinutes: null },
      volume: { total: 0, byChannel: {}, byDay: days(15, () => 1) },
    };
    const html = render();
    expect(html.match(/class="support-bar"/g)).toHaveLength(14);
    expect(html).not.toContain("2026-10-05");
  });

  it("counts open tickets per live inbox", () => {
    answers["/summary"] = {
      open: 5,
      unassigned: 0,
      atRisk: 0,
      breached: 0,
      openByInbox: { i1: 5 },
    };
    answers["/inboxes"] = {
      items: [
        { id: "i1", name: "inbox-main", channels: ["email"], archivedAt: null },
        {
          id: "i2",
          name: "inbox-quiet",
          channels: ["widget"],
          archivedAt: null,
        },
        {
          id: "i3",
          name: "inbox-old",
          channels: ["email"],
          archivedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const html = render();
    expect(html).toContain("inbox-main");
    expect(html).toContain("inbox-quiet");
    expect(html).not.toContain("inbox-old");
    expect(html.indexOf("inbox-main")).toBeLessThan(
      html.indexOf("inbox-quiet"),
    );
  });

  it("heads the page with the module eyebrow and an h1", () => {
    const html = render("de");
    expect(html).toContain("Modul");
    expect(html).toContain("<h1>Support</h1>");
  });
});
