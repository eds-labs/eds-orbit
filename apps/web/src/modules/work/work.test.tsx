import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Every resource the page reads, by a part of its path; a path without an
// entry answers 404, as a route of a switched-off module does.
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
        error: found === undefined && path ? Object.assign(new Error("failed"), { status: 404 }) : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem, Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import { day, overdue, percentDone, taskQuery, type TaskDetail, type TaskItem } from "./api";
import { workAttention } from "./attention";
import { TaskDetailView } from "./task-detail";
import { MyTasksView, WorkHome, WorkOverview } from "./views";
import { defaultSettings } from "./work-fixtures";

const table = routeTable(webRegistry);
const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const NOW = Date.parse("2026-10-25T10:00:00.000Z");

function render(node: React.ReactNode, { locale = "en" as Locale, access = "owner" } = {}) {
  const shell = {
    hrefOf: (key: string) => projectHref(project.id, table.routes.find((r) => r.key === key)!),
    modules: [{ id: "work", access, enabled: true, nav: [], displayName: { en: "", de: "" }, description: { en: "", de: "" } }],
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
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

const task = (n: number, extra: Partial<TaskItem> = {}): TaskItem => ({
  id: `t${n}`,
  number: n,
  initiativeId: null,
  milestoneId: null,
  parentTaskId: null,
  title: `Task ${n}`,
  status: "todo",
  statusCategory: "todo",
  priority: "none",
  category: null,
  labels: [],
  assigneeUserId: "u1",
  assigneeAgentKey: null,
  teamKey: null,
  startDate: null,
  dueDate: null,
  completedAt: null,
  estimate: null,
  rank: "V",
  source: "manual",
  version: 1,
  updatedAt: new Date(NOW).toISOString(),
  archivedAt: null,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const key of Object.keys(answers)) delete answers[key];
  answers["/work/settings"] = { settings: defaultSettings, version: 1 };
  answers["/work/members"] = { items: [{ userId: "u1", name: "Ada", role: "owner" }] };
});
afterEach(() => vi.useRealTimers());

describe("work helpers", () => {
  it("builds queries, dates, overdue and progress", () => {
    expect(taskQuery({ q: "grid", category: "", cursor: null, sort: "rank" })).toBe("q=grid&sort=rank");
    expect(day("2026-12-01", "de")).toBe("01. Dez. 2026");
    expect(day(null, "en")).toBe("—");
    expect(overdue({ dueDate: "2026-10-24", statusCategory: "todo" })).toBe(true);
    expect(overdue({ dueDate: "2026-10-24", statusCategory: "done" })).toBe(false);
    expect(overdue({ dueDate: "2026-10-25", statusCategory: "todo" })).toBe(false);
    const byCategory = { backlog: 0, todo: 1, in_progress: 0, blocked: 0, in_review: 0, done: 2, canceled: 1 };
    expect(percentDone({ byCategory, total: 4, overdue: 0 })).toBe(75);
    expect(percentDone(undefined)).toBe(0);
  });
});

describe("WorkOverview", () => {
  it("shows the figures, active initiatives and my next tasks", () => {
    answers["/work/overview"] = {
      counts: { open: 3, overdue: 1, dueThisWeek: 2, blocked: 0, byCategory: {} },
      initiatives: [
        {
          id: "i1",
          key: "UML",
          title: "Marketplace launch",
          description: null,
          status: "active",
          health: "at_risk",
          ownerUserId: null,
          startDate: null,
          targetDate: "2026-12-01",
          version: 1,
          archivedAt: null,
          progress: { byCategory: { backlog: 0, todo: 1, in_progress: 0, blocked: 0, in_review: 0, done: 1, canceled: 0 }, total: 2, overdue: 1 },
        },
      ],
      myNext: [task(7, { dueDate: "2026-10-20" })],
    };
    const html = render(<WorkOverview />);
    expect(html).toContain("Project management");
    expect(html).toContain("UML · Marketplace launch");
    expect(html).toContain("At risk");
    expect(html).toContain("50%");
    expect(html).toContain("#7 Task 7");
    expect(html).toContain('data-tone="warning"');
  });

  it("shows dashes while nothing loaded", () => {
    const html = render(<WorkOverview />);
    expect(html).toContain("—");
  });
});

describe("WorkHome and MyTasksView", () => {
  it("renders nothing while the module answers 404", () => {
    expect(render(<WorkHome />)).toBe("");
  });

  it("counts my open, overdue and soon-due tasks and groups them", () => {
    answers["/work/my"] = { overdue: [task(1, { dueDate: "2026-10-01" })], today: [task(2)], week: [], later: [task(3)], none: [] };
    const home = render(<WorkHome />, { locale: "de" });
    expect(home).toContain("Meine offenen Aufgaben");
    expect(home).toMatch(/<dd>3<\/dd>/);
    const list = render(<MyTasksView />);
    expect(list).toContain("Overdue (1)");
    expect(list).toContain("Today (1)");
    expect(list).not.toContain("This week");
  });
});

describe("TaskDetailView", () => {
  const detail: TaskDetail = {
    task: { ...task(5, { title: "Fix orders", dueDate: "2026-10-30", labels: ["api"] }), description: "Grid bot", createdBy: "u1", createdAt: new Date(NOW).toISOString() },
    parent: null,
    initiative: null,
    milestone: null,
    subtasks: [],
    checklist: [{ id: "c1", text: "Reproduce", done: true, sortOrder: 0 }],
    dependencies: { waitsFor: [], blocks: [] },
    links: [
      { id: "l1", relation: "relates_to", direction: "outgoing", object: { type: "support.ticket", id: "s1", label: { en: "Support ticket", de: "Support-Ticket" }, state: "restricted" }, createdAt: "" },
    ],
    attachments: [],
    watchers: [],
    watching: false,
    timeline: [
      { kind: "event", id: "e1", type: "status", actorKind: "user", actorId: "u1", before: { status: "todo" }, after: { status: "in_progress" }, at: new Date(NOW).toISOString() },
      { kind: "comment", id: "m1", authorKind: "agent", authorUserId: null, body: "Looked at it", mentions: [], editedAt: null, deletedAt: null, at: new Date(NOW).toISOString() },
    ],
  };

  it("lets owners edit and delete", () => {
    answers["/work/tasks/t5"] = detail;
    const html = render(<TaskDetailView taskId="t5" onBack={() => {}} />);
    expect(html).toContain("#5 Fix orders");
    expect(html).toContain("Restricted object");
    expect(html).toContain("changed the status: To do → In progress");
    expect(html).toContain("Agent");
    expect(html).toContain("Delete");
    expect(html).not.toContain("You can read but not change");
  });

  it("is read-only for viewers", () => {
    answers["/work/tasks/t5"] = detail;
    const html = render(<TaskDetailView taskId="t5" onBack={() => {}} />, { access: "viewer" });
    expect(html).toContain("You can read but not change project management.");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain("Add comment");
    expect(html).toMatch(/<select[^>]*disabled/);
  });
});

describe("attention texts", () => {
  const item = (kind: string, count: number) => ({ id: kind, moduleId: "work", kind, severity: "warning", count, params: {}, navKey: "work-my", link: "/work/my" }) as AttentionItem;
  it("speaks of counts only, in both languages", () => {
    expect(workAttention.work_overdue_mine!(item("work_overdue_mine", 2), "en").title).toBe("2 of your tasks are overdue");
    expect(workAttention.work_overdue_mine!(item("work_overdue_mine", 1), "de").title).toBe("1 deiner Aufgaben ist überfällig");
    expect(workAttention.work_milestone_due!(item("work_milestone_due", 3), "de").title).toBe("3 Meilensteine sind bald fällig");
  });
});
