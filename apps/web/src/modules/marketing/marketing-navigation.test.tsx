import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketingPlanView } from "../../../../../packages/schemas/src/marketing-plan";
import type { WorkspaceContextValue } from "@/components/workspace-context";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { labels } from "@/lib/i18n";
const state = vi.hoisted(() => ({
  paths: [] as string[],
  loading: false,
  error: null as Error | null,
  query: "",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => {
    if (path) state.paths.push(path);
    return {
      data:
        path && !state.error && !state.loading
          ? path.includes("marketing-plans/")
            ? plan
            : { items: [], truncated: false }
          : null,
      loading: !!path && state.loading,
      error: path ? state.error : null,
      refresh: () => {},
    };
  },
}));
import {
  MarketingStart,
  MarketingAssistantNavigation,
} from "./marketing-entry";
import { marketingTemplates } from "./chat-templates";
import { planNextStep, SavedPlanList } from "./plan-navigation";
import { MarketingPlansPage } from "./plans-page";
import { webRegistry } from "@/modules/registry";
import {
  navigationForFeatures,
  routeTable,
  routeEnabled,
  locate,
} from "@/platform/shell/routes";
const spec: MarketingPlanView["spec"] = {
  title: "Organic strategy",
  goal: "Useful product education",
  audience: "Product teams",
  productScope: "Beta",
  campaignType: "product",
  channels: ["x-int"],
  language: "en",
  timezone: "Europe/Berlin",
  profileVersion: 1,
  policy: { id: "policy-id", version: 2 },
  pillars: [{ title: "Evidence", angle: "Reviewed claims only" }],
  cta: {
    label: "Learn more",
    url: "https://example.invalid",
    factId: "link-fact",
  },
  facts: [{ id: "link-fact", version: 1 }],
  sourceRefs: [],
  horizon: { startAt: "2026-10-21T08:00:00Z", endAt: "2026-10-28T08:00:00Z" },
  cadence: { rhythm: "weekly", weekdays: [1], times: ["10:00"] },
  contentTypes: ["social"],
  kpis: [
    {
      name: "Reach",
      unit: "impressions",
      baselineState: "no_data",
      metricRefs: [],
    },
  ],
  existingWork: [],
  approvalMode: "human_each",
  delivery: "postiz_draft",
  creative: { image: true, styleAssetIds: [] },
  monthlyBudgetMicros: 20_000_000,
  assumptions: ["A hypothesis"],
  unknowns: ["No traffic data"],
};

const plan: MarketingPlanView = {
  id: "11111111-2222-4333-8444-555555555555",
  version: 1,
  revision: 2,
  specHash: "a".repeat(64),
  spec,
  sourceSnapshot: [],
  status: "proposed",
  blockers: [],
  strategicallyReviewed: false,
  reviewedAt: null,
  activationAvailable: false,
  activation: null,
  activationRequest: null,
  linkedWork: [],
  actionRequest: {
    id: "request",
    version: 1,
    packageHash: "a".repeat(64),
    status: "pending",
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
function render(
  node: React.ReactNode,
  options: {
    de?: boolean;
    agents?: boolean;
    enabled?: boolean;
    access?: string;
    projectEdit?: boolean;
  } = {},
) {
  const locale = options.de ? "de" : "en";
  const project: WorkspaceContextValue["project"] = {
    id: "p1",
    workspaceId: "w1",
    name: "Synthetic project",
    language: "en",
    timezone: "UTC",
    mode: "observe",
    paused: false,
    generation: 1,
    role: "owner",
  };
  const workspace: WorkspaceContextValue = {
    project,
    identity: {
      user: { id: "u1", name: "Synthetic", email: "u@example.invalid" },
      projects: [project],
      workspaces: [{ id: "w1", name: "Synthetic org", role: "owner" }],
    },
    locale,
    t: (k) => labels[locale][k],
    canEdit: options.projectEdit ?? true,
    isOwner: true,
    revision: 0,
    refresh: () => {},
    href: (p) => p,
  };
  const shell: ShellContextValue = {
    features: { agents: options.agents ?? true },
    modules: [
      {
        id: "marketing",
        enabled: options.enabled ?? true,
        access: options.access ?? "owner",
        displayName: { en: "Marketing", de: "Marketing" },
        description: { en: "Synthetic", de: "Synthetic" },
        nav: [],
      },
    ],
    table: routeTable(webRegistry),
    platformNav: [],
    homeSections: [],
    hrefOf: (key) => `/p/p1/${key}`,
    chat: [],
    actionRequests: {},
    attention: { loading: false },
    attentionRenderers: {},
    settings: [],
    setupLinks: [],
    connectors: { providers: [], extras: [] },
  };
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider value={workspace}>
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}
beforeEach(() => {
  state.paths = [];
  state.error = null;
  state.loading = false;
  state.query = "";
});
describe("MA-08 Marketing navigation", () => {
  it("connects the assistant, saved plans and content review with direct manual links", () => {
    const html = render(<MarketingStart />);
    for (const path of [
      "assistant",
      "marketing/plans",
      "approvals",
      "marketing/content",
      "marketing/missions",
      "marketing/assignments",
    ])
      expect(html).toContain(`href="/p/p1/${path}"`);
    expect(html).toContain("No saved plan yet");
    expect(html).toContain("Strategy approval alone starts no assignments");
    expect(html).toContain("Plan with assistant");
    expect(render(<MarketingStart />, { de: true })).toContain(
      "Mit Assistant planen",
    );
  });
  it("does not fetch or offer the v2 entry for disabled, hidden or feature-off Marketing", () => {
    for (const options of [
      { enabled: false },
      { access: "none" },
      { agents: false },
    ]) {
      state.paths = [];
      expect(render(<MarketingStart />, options)).toBe("");
      expect(render(<MarketingAssistantNavigation />, options)).toBe("");
      expect(state.paths).toEqual([]);
    }
  });
  it("keeps bookmarked plan URLs understandable when the advertised feature is off", () => {
    const html = render(<MarketingPlansPage />, { agents: false });
    expect(html).toContain("Marketing plans are currently unavailable");
    expect(html).toContain("Creator / Content");
    expect(html).not.toContain("/marketing/assignments");
    expect(state.paths).toEqual([]);
  });
  it("shows read navigation to a module viewer and uses an editor override from the server", () => {
    const viewer = render(<MarketingStart />, { access: "viewer" });
    expect(viewer).toContain("Open assistant");
    expect(viewer).not.toContain("Plan with assistant");
    expect(
      render(<MarketingStart />, { projectEdit: false, access: "editor" }),
    ).toContain("Plan with assistant");
  });
  it("has explicit loading/error states without inventing saved plans", () => {
    state.loading = true;
    expect(render(<MarketingStart />)).not.toContain("No saved plan yet");
    state.loading = false;
    state.error = new Error("Synthetic report access error");
    const html = render(<MarketingStart />);
    expect(html).toContain("Synthetic report access error");
    expect(html).not.toContain("No saved plan yet");
  });
  it("does not fetch plans on the compact project-home entry", () => {
    expect(render(<MarketingStart compact />)).toContain("Review saved plan");
    expect(state.paths).toEqual([]);
  });
  it("keeps strategy, exact assignment activation and per-post review distinct", () => {
    expect(planNextStep(plan, false)).toBe("Strategy awaits approval");
    const reviewed = {
      ...plan,
      strategicallyReviewed: true,
      actionRequest: null,
    };
    expect(planNextStep(reviewed, false)).toBe(
      "Prepare assignments in the assistant",
    );
    expect(
      planNextStep(
        {
          ...reviewed,
          activationRequest: { ...plan.actionRequest!, payload: {} },
        },
        false,
      ),
    ).toBe("Exact assignments await approval");
    expect(planNextStep({ ...reviewed, status: "active" }, false)).toBe(
      "Active — review posts separately",
    );
    expect(planNextStep({ ...plan, blockers: ["SOURCE_STALE"] }, true)).toBe(
      "Voraussetzungen prüfen",
    );
    const html = render(
      <SavedPlanList
        plans={[
          { ...plan, spec: { ...spec, title: "<script>unsafe</script>" } },
        ]}
        projectId="p1"
        de={false}
      />,
    );
    expect(html).toContain(`?plan=${plan.id}`);
    expect(html).not.toContain("<script>unsafe");
  });
  it("keeps exact selected-plan review read-only for a Marketing viewer", () => {
    state.query = `plan=${plan.id}`;
    const owner = render(<MarketingPlansPage />);
    expect(owner).toContain("Approve strategy only");
    const viewer = render(<MarketingPlansPage />, { access: "viewer" });
    expect(viewer).not.toContain("Approve strategy only");
    expect(viewer).not.toContain("Continue planning in assistant");
    expect(viewer).toContain("All app approvals");
  });
  it("contributes an editable human-each proposal template, with a read-only viewer alternative", () => {
    const ctx = {
      projectName: "Synthetic",
      de: false,
      canEdit: true,
      features: { agents: true },
    };
    const template = marketingTemplates(ctx)[0]!;
    expect(template.label).toBe("Plan marketing");
    expect(template.prompt).toContain("human_each");
    expect(template.prompt).toContain("Start no assignments");
    expect(marketingTemplates({ ...ctx, canEdit: false })[0]!.prompt).toContain(
      "Read stored data only",
    );
    expect(marketingTemplates({ ...ctx, features: {} })[0]!.label).toBe(
      "Plan next week",
    );
  });
  it("retains expert/legacy URLs but hides agent-only navigation when the flag is off", () => {
    const table = routeTable(webRegistry);
    const off = navigationForFeatures(table.routes, {});
    expect(off.map((r) => r.key)).not.toContain("marketing-plans");
    expect(off.map((r) => r.key)).not.toContain("assignments");
    expect(
      navigationForFeatures(table.routes, { agents: true }).map((r) => r.key),
    ).toContain("marketing-plans");
    expect(locate("/p/p1/marketing/plans", table).kind).toBe("view");
    expect(locate("/content", table).kind).toBe("legacy");
    const visible = off.filter((r) =>
      routeEnabled(r, (id) => id !== "marketing"),
    );
    expect(visible.map((r) => r.key)).toContain("decisions");
    expect(visible.map((r) => r.key)).not.toContain("approvals");
    expect(visible.map((r) => r.key)).toContain("chat");
  });
});
