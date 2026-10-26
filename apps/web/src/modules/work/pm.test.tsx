import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Every resource the views read, by a part of its path; a path without an
// entry answers 404, as a route of a switched-off PM does.
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
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { workActionRequests } from "./action-requests";
import { workAttention } from "./attention";
import { PlanReview, PmPanel, type Proposal } from "./pm";
import { TaskAgents } from "./pm-task";
import { defaultSettings } from "./work-fixtures";

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};

function render(node: React.ReactNode, { locale = "en" as Locale, access = "owner" } = {}) {
  const shell = {
    hrefOf: () => "/",
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

const plan: Proposal = {
  id: "plan-1",
  initiativeId: null,
  kind: "new_plan",
  status: "proposed",
  revision: 2,
  plan: {
    goal: "Launch the marketplace",
    scope: { in: ["Listings"], out: ["Payments"] },
    initiative: { title: "Marketplace launch", key: null, startDate: "2026-11-01", targetDate: "2027-01-31" },
    workstreams: [{ ref: "ws1", title: "Product", summary: "" }],
    milestones: [{ ref: "m1", title: "Beta", dueDate: "2026-12-15", criteria: "Ten listings" }],
    tasks: [
      {
        ref: "t1",
        title: "Listing model",
        description: "",
        workstreamRef: "ws1",
        milestoneRef: "m1",
        parentRef: null,
        priority: "high",
        estimate: 8,
        dueDate: null,
        suggestedRole: null,
        suggestedAssigneeUserId: null,
        acceptanceCriteria: ["Listings can be created"],
        dependsOn: [],
      },
      {
        ref: "t2",
        title: "Fee rules",
        description: "",
        workstreamRef: "ws1",
        milestoneRef: "m1",
        parentRef: null,
        priority: "medium",
        estimate: null,
        dueDate: null,
        suggestedRole: null,
        suggestedAssigneeUserId: null,
        acceptanceCriteria: [],
        dependsOn: ["t1"],
      },
    ],
    risks: [{ title: "Late partner", impact: "medium", mitigation: "Start early" }],
    openDecisions: [{ question: "Which region first?", options: ["EU", "US"], recommendation: null }],
    assumptions: ["Two developers"],
  },
  validation: { errors: [], warnings: ["no_acceptance_criteria:t2"] },
  actionRequestId: "ar-1",
  costMicros: 120_000,
  errorCode: null,
  version: 3,
  createdAt: "2026-10-25T10:00:00.000Z",
};

describe("AI project manager views (ADR 0017)", () => {
  it("stays hidden while the PM is off", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    answers["/pm/status"] = { available: false };
    expect(render(<PmPanel initiativeId="i1" onOpenPlan={() => {}} />)).toBe("");
    expect(render(<TaskAgents taskId="t1" onChanged={() => {}} />)).toBe("");
  });

  it("shows budget, findings, the labelled AI report and open plans of an initiative", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    Object.assign(answers, {
      "/pm/status": { available: true, budget: { spentMicros: 500_000, ceilingMicros: 2_000_000 } },
      "/pm/initiatives/i1/state": {
        initiativeId: "i1",
        enabled: true,
        settings: { reportSchedule: "weekly", research: "knowledge", escalateTo: [] },
        lastScanAt: null,
        lastReportAt: null,
        version: 1,
      },
      "/pm/findings": { items: [{ id: "f1", rule: "overdue", severity: "critical", taskIds: ["t1"], data: { number: 7 }, firstSeenAt: "2026-10-25T08:00:00.000Z" }] },
      "/pm/reports": { items: [{ id: "r1", body: "**At risk**\n\nTwo tasks are late.", createdAt: "2026-10-25T08:00:00.000Z", costMicros: 9000 }] },
      "/pm/plans": { items: [plan] },
    });
    const html = render(<PmPanel initiativeId="i1" onOpenPlan={() => {}} />, { locale: "de" });
    expect(html).toContain("KI-Projektleiter");
    expect(html).toContain("Budget heute: $0.50 von $2.00");
    expect(html).toContain("Kritisch");
    expect(html).toContain("Überfällig");
    expect(html).toContain("#7");
    expect(html).toContain("KI-erstellt");
    expect(html).toContain("Two tasks are late.");
    expect(html).toContain("Wartet auf Freigabe");
    // Viewers read, but cannot ask the PM.
    expect(render(<PmPanel initiativeId="i1" onOpenPlan={() => {}} />, { access: "viewer" })).not.toContain("Create status report");
  });

  it("reviews a plan: tree, warnings, edits for writers and the way to its approval", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    Object.assign(answers, {
      "/pm/plans/plan-1": plan,
      "/work/settings": { settings: defaultSettings, version: 1 },
      "/work/members": { items: [{ userId: "u2", name: "Bo", role: "editor" }] },
    });
    const html = render(<PlanReview planId="plan-1" onClose={() => {}} onOpen={() => {}} />);
    expect(html).toContain("Marketplace launch");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("no_acceptance_criteria:t2");
    expect(html).toContain("Beta");
    expect(html).toContain("after t1");
    expect(html).toContain("Which region first?");
    expect(html).toContain('href="/decisions"');
    expect(html).toContain("Save as new revision");
    expect(render(<PlanReview planId="plan-1" onClose={() => {}} onOpen={() => {}} />, { access: "viewer" })).not.toContain("Save as new revision");
  });

  it("renders the PM's approvals and attention items", () => {
    const renderer = workActionRequests["work.coding.dispatch"]!;
    const item = {
      costCeilingMicros: 1_500_000,
      summary: { operation: { kind: "coding_dispatch", repository: "orbit", provider: "automation", task: 12 } },
    };
    expect(renderer.accepts(item)).toBe(true);
    const Component = renderer.component;
    const html = render(<Component item={item} de={false} pending={false} decide={() => {}} />);
    expect(html).toContain("Dispatch a coding work order");
    expect(html).toContain("Spends at most $1.50");
    expect(workActionRequests["work.plan.apply"]!.accepts({ summary: { operation: { kind: "new_plan" } } })).toBe(true);
    // An MCP plan request carries the raw arguments: constraints are a text,
    // not a list (production crash of 2026-10-26).
    const plan = workActionRequests["work.mcp.work_pm_propose_plan"]!;
    const request = {
      costCeilingMicros: 1_000_000,
      summary: {
        operation: {
          kind: "pm_plan",
          goal: "Plan the EOP initiative",
          constraints: "No deploys. Keep the core generic.",
          initiativeKey: "EOP",
          extra: { nested: true },
        },
      },
    };
    expect(plan.accepts(request)).toBe(true);
    const Plan = plan.component;
    const planHtml = render(<Plan item={request} de={true} pending={false} decide={() => {}} />);
    expect(planHtml).toContain("KI-Projektleiter planen lassen");
    expect(planHtml).toContain("No deploys. Keep the core generic.");
    expect(planHtml).toContain("Kostet höchstens $1.00");
    expect(workAttention.work_pm_critical!({ count: 2 } as never, "en").title).toBe("2 critical findings in initiatives");
    expect(workAttention.work_coding_unknown!({ count: 1 } as never, "de").title).toBe("1 Coding-Auftrag mit unklarem Ausgang");
  });
});
