import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

// Every resource the page reads, by a part of its path. A path without an
// entry answers 404, as a route of a switched-off module does.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
// Every path the page asked for, in order.
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
import type { AttentionState } from "@/platform/shell/attention";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import {
  MarketingOverview,
  monthStart,
  nextPosts,
  publishedInLastDays,
} from "./overview";

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
const iso = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();

const entity = (id: string, data: Record<string, unknown>) =>
  ({ id, version: 1, data }) as never;
const dashboard = (
  overrides: Partial<{
    mode: string;
    paused: boolean;
    monthlyLimitMicros: number | null;
    publications: unknown[];
    exceptions: unknown[];
    jobs: unknown[];
  }> = {},
) => ({
  project: {
    ...project,
    mode: overrides.mode ?? "observe",
    paused: overrides.paused ?? false,
  },
  counts: { verifiedFacts: 2, connectedConnectors: 1 },
  exceptions: overrides.exceptions ?? [],
  publications: overrides.publications ?? [],
  jobs: overrides.jobs ?? [],
  budget: {
    reservedMicros: 0,
    spentMicros: 0,
    dailyLimitMicros: null,
    monthlyLimitMicros: overrides.monthlyLimitMicros ?? null,
  },
  readiness: { state: "ready", blockers: [] },
});
const post = (id: string, at: string, excerpt: string) => ({
  id,
  version: 1,
  status: "queued",
  reason: null,
  channel: "x",
  channelName: "X",
  scheduledAt: at,
  vetoDeadline: null,
  excerpt,
  assignmentId: null,
  assignmentName: null,
  ownerReleased: false,
});

/** The shell's attention with these badge counts. */
const attentionWith = (counts: Record<string, number>): AttentionState => ({
  loading: false,
  data: { items: [], counts, status: { paused: false } },
});

function render(
  locale: Locale = "en",
  canEdit = true,
  attention: AttentionState = attentionWith({}),
) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={{ attention } as ShellContextValue}>
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
        <MarketingOverview />
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

describe("MarketingOverview", () => {
  it("renders four metrics with — for an unknown budget", () => {
    answers["/dashboard"] = dashboard();
    answers["/missions"] = {
      items: [
        entity("m1", { status: "active", title: "One" }),
        entity("m2", { status: "completed", title: "Two" }),
      ],
    };
    answers["/ai-cost"] = new Error("forbidden");
    const html = render("en", true, attentionWith({ approvals: 3 }));
    expect(html.match(/class="metric"/g)).toHaveLength(4);
    for (const label of [
      "Active missions",
      "Open approvals",
      "Published, 7 days",
      "AI budget, month",
    ])
      expect(html).toContain(label);
    const amounts = [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(
      (m) => m[1],
    );
    // Missions, approvals, published, budget — in the order of the strip.
    expect(amounts.slice(0, 4)).toEqual(["1", "3", "0", "—"]);
  });

  it("R27: open approvals are the attention count of the badge, — while unknown", () => {
    answers["/dashboard"] = dashboard({
      exceptions: [entity("e1", { status: "open", lastSeenAt: iso(-1) })],
    });
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    const amounts = (attention: AttentionState) =>
      [
        ...render("en", true, attention).matchAll(/<strong>([^<]*)<\/strong>/g),
      ].map((m) => m[1]);
    expect(amounts(attentionWith({ approvals: 7 }))[1]).toBe("7");
    // No approvals item: nothing waits.
    expect(amounts(attentionWith({ "support-tickets": 2 }))[1]).toBe("0");
    expect(amounts({ loading: true })[1]).toBe("—");
    expect(
      amounts({ loading: false, error: new Error("failed") })[1],
    ).toBe("—");
    // The overview no longer reads the content to count them.
    expect(requested.some((p) => p.includes("/content"))).toBe(false);
  });

  it("R25: the mode band names the project's mode like the home strip", () => {
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    answers["/dashboard"] = dashboard({ mode: "assisted" });
    expect(render()).toContain("<h2>Assisted mode</h2>");
    expect(render("de")).toContain("<h2>Assisted-Modus</h2>");
    answers["/dashboard"] = dashboard({ mode: "autopilot" });
    expect(render("de")).toContain("<h2>Autopilot-Modus</h2>");
    answers["/dashboard"] = dashboard({ mode: "observe" });
    expect(render("de")).toContain("<h2>Beobachtungsmodus</h2>");
    answers["/dashboard"] = dashboard({ mode: "custom" });
    expect(render()).toContain("<h2>custom</h2>");
    answers["/dashboard"] = dashboard({ mode: "assisted", paused: true });
    expect(render()).toContain("<h2>Paused</h2>");
  });

  it("shows what the limit counts against it", () => {
    answers["/dashboard"] = dashboard({ monthlyLimitMicros: 10_000_000 });
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = {
      rows: [
        {
          key: "2026-10-02",
          settledMicros: "1000000",
          reservedMicros: "0",
          unknownMicros: "0",
        },
        {
          key: "2026-10-17",
          settledMicros: "500000",
          reservedMicros: "250000",
          unknownMicros: "250000",
        },
      ],
    };
    const html = render();
    // Settled, reserved (incl. in flight) and unclear reservations all count
    // against the monthly limit, as the server enforces it.
    expect(html).toContain("<strong>$2.00</strong>");
    expect(html).toContain("of $10.00 · incl. $0.50 reserved");
    expect(render("de")).toContain("von $10.00 · inkl. $0.50 reserviert");
  });

  it("asks for the spend of the UTC calendar month the limit counts", () => {
    answers["/dashboard"] = dashboard();
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    render();
    const path = requested.find((p) => p.includes("/ai-cost"));
    expect(path).toContain(
      `from=${encodeURIComponent("2026-10-01T00:00:00.000Z")}`,
    );
  });

  it("shows the spend when no monthly limit is set", () => {
    answers["/dashboard"] = dashboard({ monthlyLimitMicros: null });
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = {
      rows: [
        {
          key: "2026-10-02",
          settledMicros: "1200000",
          reservedMicros: "300000",
          unknownMicros: "0",
        },
      ],
    };
    const html = render();
    expect(html).toContain("<strong>$1.50</strong>");
    expect(html).toContain("No monthly limit set · incl. $0.30 reserved");
    expect(html).not.toContain(">—<");
  });

  it("lists at most six next posts sorted by time", () => {
    answers["/dashboard"] = dashboard();
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    answers["/assignment-posts"] = {
      items: [8, 3, 30, 1, 100, 5, 2, 20].map((h) =>
        post(`p${h}`, iso(h), `post-in-${String(h).padStart(3, "0")}h`),
      ),
    };
    const html = render();
    const order = [...html.matchAll(/post-in-(\d{3})h/g)].map((m) =>
      Number(m[1]),
    );
    expect(order).toEqual([1, 2, 3, 5, 8, 20]);
    expect(html).toContain("Next 7 days");
  });

  it("falls back to the publications of the next seven days when Orbit Agents is off", () => {
    answers["/dashboard"] = dashboard({
      publications: [
        entity("a", { status: "queued", scheduledAt: iso(30), channel: "far" }),
        entity("b", { status: "queued", scheduledAt: iso(2), channel: "soon" }),
        entity("c", {
          status: "published",
          scheduledAt: iso(-3),
          channel: "old",
        }),
        entity("d", {
          status: "queued",
          scheduledAt: iso(24 * 9),
          channel: "late",
        }),
        entity("e", {
          status: "canceled",
          scheduledAt: iso(5),
          channel: "gone",
        }),
      ],
    });
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    const html = render();
    expect(html.indexOf(">soon<")).toBeGreaterThan(-1);
    expect(html.indexOf(">far<")).toBeGreaterThan(html.indexOf(">soon<"));
    for (const hidden of ["old", "late", "gone"])
      expect(html, hidden).not.toContain(`>${hidden}<`);
  });

  it("has no recent-jobs panel", () => {
    answers["/dashboard"] = dashboard({
      jobs: [entity("j1", { topic: "Job topic xyz", status: "done" })],
    });
    answers["/missions"] = { items: [] };
    answers["/ai-cost"] = { rows: [] };
    const html = render();
    expect(html).not.toContain("Job topic xyz");
    expect(html).not.toContain("Recent activity");
  });

  it("heads the page with the module eyebrow, an h1 and both actions", () => {
    answers["/dashboard"] = dashboard();
    answers["/missions"] = { items: [] };
    const html = render("de");
    expect(html).toContain("Modul");
    expect(html).toContain("<h1>Marketing</h1>");
    expect(html).toContain("Content erstellen");
    expect(html).toContain('href="/content"');
    expect(html).toContain("Neue Mission");
    expect(render("de", false)).not.toContain("Neue Mission");
  });
});

describe("overview helpers", () => {
  it("starts the month at 00:00 UTC on the first, as the budget does", () => {
    expect(monthStart(Date.parse("2026-10-18T10:00:00Z"))).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    // Late on the 31st in UTC is still October, whatever the project's zone.
    expect(monthStart(Date.parse("2026-10-31T23:30:00Z"))).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(monthStart(Date.parse("2026-11-01T00:00:00Z"))).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("counts published posts of the last days only", () => {
    const items = [
      entity("a", { status: "published", scheduledAt: iso(-24) }),
      entity("b", { status: "published", scheduledAt: iso(-24 * 8) }),
      entity("c", { status: "published", scheduledAt: iso(24) }),
      entity("d", { status: "scheduled_remote", scheduledAt: iso(-2) }),
    ];
    expect(publishedInLastDays(items, 7, NOW)).toBe(1);
  });

  it("keeps the next posts in time order and drops finished ones", () => {
    const items = [
      entity("late", { status: "queued", scheduledAt: iso(40) }),
      entity("done", { status: "published", scheduledAt: iso(1) }),
      entity("soon", { status: "queued", scheduledAt: iso(3) }),
    ];
    expect(nextPosts(items, 7, NOW).map((e) => e.id)).toEqual(["soon", "late"]);
  });
});
