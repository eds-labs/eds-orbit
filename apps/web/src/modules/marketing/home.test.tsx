import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

// Every resource the card reads, by a part of its path. A path without an
// entry answers 404, as a route of a switched-off module or flag does.
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
              status: found instanceof Error ? 500 : 404,
            })
          : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionResponse, Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import type { AttentionState } from "@/platform/shell/attention";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import type { ActivityRun, AgentActivity } from "./agent-activity";
import { MarketingHomeCard } from "./home";

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
const NOW = Date.parse("2026-10-19T08:00:00.000Z");
const HOUR = 3600_000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

const attentionWith = (counts: Record<string, number>): AttentionState => ({
  loading: false,
  data: {
    items: [],
    counts,
    status: { paused: false, aiMonth: { spentMicros: 0, limitMicros: null } },
  } satisfies AttentionResponse,
});

function render(
  locale: Locale = "en",
  attention: AttentionState = { loading: false },
) {
  const shell = {
    hrefOf: (key: string) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    attention,
  } as ShellContextValue;
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
        <MarketingHomeCard />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const run = (over: Partial<ActivityRun> = {}): ActivityRun => ({
  id: "r1",
  assignmentId: "a1",
  assignmentName: "Beta daily",
  date: "2026-10-19",
  status: "running",
  plannedAt: "2026-10-19T02:00:00.000Z",
  updatedAt: "2026-10-19T02:30:00.000Z",
  firstSlotAt: null,
  costMicros: 180_000,
  ceilingMicros: 1_000_000,
  delivery: "postiz_draft",
  steps: ["done", "done", "done", "running"].map((status, i) => ({
    key: `s${i}`,
    role: "analytics",
    status,
    dependsOn: [],
    optionalDependsOn: [],
    errorCode: null,
    channel: null,
    channelName: null,
  })),
  ...over,
});
const activity = (runs: ActivityRun[]): AgentActivity => ({
  timezone: "Europe/Berlin",
  paused: false,
  activeAssignments: 1,
  health: { state: "ok", issues: [] },
  runs,
  next: [],
});
const post = (id: string, hours: number, channelName: string) => ({
  id,
  version: 1,
  status: "scheduled",
  reason: null,
  channel: "x",
  channelName,
  scheduledAt: at(hours),
  vetoDeadline: null,
  excerpt: `excerpt ${id}`,
  assignmentId: "a1",
  assignmentName: "Beta daily",
  ownerReleased: false,
});
const publication = (id: string, hours: number, status = "scheduled") => ({
  id,
  version: 1,
  kind: "publications",
  data: { channel: `channel-${id}`, scheduledAt: at(hours), status },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  answers["/missions"] = { items: [] };
});
afterEach(() => vi.useRealTimers());

describe("MarketingHomeCard", () => {
  it("marketing card hides the run without agents (404)", () => {
    // No agent-activity and no assignment-posts answer: Orbit Agents is off.
    answers["/publications"] = { items: [] };
    const html = render();
    expect(html).toContain("Marketing");
    expect(html).not.toContain("home-run");
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('href="/p/p1/marketing"');
  });

  it("shows today's run with its steps and cost", () => {
    answers["agent-activity"] = activity([run()]);
    answers["assignment-posts"] = { items: [] };
    const en = render();
    expect(en).toContain("home-run");
    expect(en).toContain("Beta daily");
    expect(en).toContain("Today’s run");
    expect(en).toContain("3 of 4 steps done");
    expect(en).toContain("$0.18");
    expect(render("de")).toContain("3 von 4 Schritten fertig");
  });

  it("marketing card lists three posts by time", () => {
    answers["agent-activity"] = activity([]);
    answers["assignment-posts"] = {
      items: [
        post("p4", 30, "chan-four"),
        post("p2", 5, "chan-two"),
        post("p0", -2, "chan-past"),
        post("p1", 2, "chan-one"),
        post("p3", 9, "chan-three"),
      ],
    };
    const html = render();
    const order = [...html.matchAll(/chan-(\w+)/g)].map((m) => m[1]);
    expect(order).toEqual(["one", "two", "three"]);
    expect(html).not.toContain("chan-past");
    expect(html).not.toContain("chan-four");
  });

  it("falls back to the publications without agents", () => {
    answers["/publications"] = {
      items: [
        publication("b", 6),
        publication("a", 1),
        publication("done", 2, "published"),
      ],
    };
    const html = render();
    const order = [...html.matchAll(/channel-(\w+)/g)].map((m) => m[1]);
    expect(order).toEqual(["a", "b"]);
  });

  it("says so when nothing is scheduled", () => {
    answers["/publications"] = { items: [] };
    expect(render()).toContain("Nothing scheduled");
  });

  it("shows approvals count from attention counts and active missions", () => {
    answers["/publications"] = { items: [] };
    answers["/missions"] = {
      items: [
        { id: "m1", data: { status: "active" } },
        { id: "m2", data: { status: "running" } },
        { id: "m3", data: { status: "completed" } },
      ],
    };
    const html = render("en", attentionWith({ approvals: 4, support: 9 }));
    expect(html).toMatch(/<strong>2<\/strong>\s*active missions/);
    expect(html).toMatch(/<strong>4<\/strong>\s*open approvals/);
    // Unknown while attention failed: no number is invented.
    const failed = render("de", { loading: false, error: new Error("x") });
    expect(failed).toMatch(/<strong>—<\/strong>\s*offene Freigaben/);
  });

  it("renders nothing while the module answers 404", () => {
    delete answers["/missions"];
    expect(render()).toBe("");
  });
});
