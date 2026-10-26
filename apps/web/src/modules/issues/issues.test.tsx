import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Every resource a view reads, by a part of its path; a path without an
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
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import { hours, query, type Issue, type IssueDetail, type Overview } from "./api";
import { issuesAttention } from "./attention";
import { IssueDetailView } from "./detail";
import { issuesText } from "./labels";
import { IssuesHome, IssuesOverview } from "./overview";

const table = routeTable(webRegistry);
const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};

function render(node: React.ReactNode, { locale = "en" as Locale, access = "owner" } = {}) {
  const shell = {
    hrefOf: (key: string) => projectHref(project.id, table.routes.find((r) => r.key === key)!),
    modules: [{ id: "issues", access, enabled: true, nav: [], displayName: { en: "", de: "" }, description: { en: "", de: "" } }],
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

const issue = (extra: Partial<Issue> = {}): Issue => ({
  id: "i1",
  number: 7,
  key: "ISS-7",
  type: "bug",
  title: "Checkout fails",
  summary: "Paying ends with an error.",
  status: "fix_ready",
  severity: "s1_critical",
  priority: "high",
  category: null,
  components: ["checkout"],
  assigneeUserId: null,
  environment: null,
  firstSeenAt: "2026-10-20T10:00:00.000Z",
  lastSeenAt: "2026-10-25T10:00:00.000Z",
  reportCount: 3,
  ticketCount: 2,
  mergedIntoIssueId: null,
  acceptanceCriteria: [],
  shareReviewed: false,
  aiTriage: {},
  version: 4,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  closedAt: null,
  ...extra,
});

describe("issue center web (ADR 0018)", () => {
  it("registers the module with its four views after Support", () => {
    const module = webRegistry.modules.find((m) => m.id === "issues")!;
    expect(module).toMatchObject({ optIn: true, groupOrder: 25 });
    expect(module.views.map((v) => v.key)).toEqual(["issues", "issues-list", "issues-triage", "issues-releases"]);
  });

  it("shows dashes on the dashboard until figures load and never invents lead times", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    const empty = render(<IssuesOverview />);
    expect(empty).toContain("—");
    const overview: Overview = {
      metrics: { open: 4, critical: 1, newLast7Days: 2, awaitingTriage: 1, fixReadyNotReleased: 1, releasedLast30Days: 0, duplicatesPending: 1 },
      critical: [issue()],
      mostReported: [issue()],
      byStatus: { fix_ready: 1 },
      byComponent: [{ component: "checkout", open: 1 }],
      bySource: { support: 2 },
      openAge: { under_7d: 1, under_30d: 0, over_30d: 0 },
      leadTimesHours: { newToConfirmed: 5, confirmedToFixReady: null, fixReadyToReleased: null, newToReleased: null },
    };
    answers["/issues/overview"] = overview;
    const html = render(<IssuesOverview />, { locale: "de" });
    expect(html).toContain("ISS-7 Checkout fails");
    expect(html).toContain("5 h");
    expect(html).toContain("Kritisch");
    expect(render(<IssuesHome />)).toContain("Fix ready");
  });

  it("shows restricted tickets as placeholders and diagnostics only when sent", () => {
    const detail: IssueDetail = {
      issue: issue(),
      reports: [
        {
          id: "r1",
          sourceKind: "support",
          externalSystem: "orbit_support",
          externalId: null,
          externalUrl: null,
          title: "Checkout fails",
          symptoms: "Customer [e-mail removed] cannot pay",
          severityHint: null,
          typeHint: null,
          redaction: { email: 1 },
          occurredAt: "2026-10-25T10:00:00.000Z",
          receivedAt: "2026-10-25T10:00:00.000Z",
          reportedByKind: "user",
          erased: false,
        },
      ],
      duplicateCandidates: [],
      links: [
        { id: "l1", relation: "reported_in", direction: "outgoing", object: { type: "support.ticket", id: "t1", label: { en: "Support ticket", de: "Support-Ticket" }, state: "restricted" } },
        { id: "l2", relation: "implements", direction: "incoming", object: { type: "work.task", id: "w1", label: { en: "Task", de: "Aufgabe" }, state: "ok", title: "#3 Fix checkout", status: "done", statusCategory: "done", href: "/p/p1/work/tasks?task=w1" } },
      ],
      progress: { tasks: 1, done: 1, restricted: 0 },
      deliveries: [],
      externalRefs: [],
      timeline: [],
      permissions: { diagnostics: false },
    };
    answers["/issues/issues/i1"] = detail;
    const html = render(<IssueDetailView issueId="i1" onBack={() => {}} onChanged={() => {}} onOpen={() => {}} />, { access: "viewer" });
    expect(html).toContain("Support ticket (Restricted)");
    expect(html).toContain("#3 Fix checkout");
    expect(html).toContain("1 sensitive value removed");
    expect(html).not.toContain("Diagnostics");
    // Viewers get no triage controls.
    expect(html).not.toContain("Suggest triage");
    expect(html).toContain("Merged does not mean released");
  });

  it("formats lead times, queries and attention texts", () => {
    expect(hours(null, "en")).toBe("—");
    expect(hours(72, "en")).toBe("3 days");
    expect(query({ status: "open", q: "", cursor: null })).toBe("status=open");
    expect(issuesAttention.issues_critical!({ id: "x", moduleId: "issues", kind: "issues_critical", severity: "critical", count: 2, params: {}, navKey: "issues-list", link: "/issues/list" }, "de").title).toBe(
      "2 kritische Issues offen",
    );
    expect(issuesText("de").status.fix_ready).toBe("Fix bereit");
  });
});
