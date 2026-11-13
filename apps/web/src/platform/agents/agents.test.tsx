import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/p1/agents",
  useSearchParams: () => new URLSearchParams(""),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  AgentChannel,
  MANDATE_MAX_AGENTS,
  mandateChannels,
} from "@/components/agent-mandates";
import { manageHref } from "@/platform/settings-center/routes";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups } from "@/platform/shell/nav-groups";
import {
  locate,
  navigationForFeatures,
  routeTable,
} from "@/platform/shell/routes";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import {
  AgentPermissionsNote,
  ReviewActivate,
  agentPermissionsHref,
} from "./builder";
import { ExecutionView } from "./executions";
import {
  activationBody,
  agentFigures,
  agentPlatformVisible,
  agentsPlace,
  configDiff,
  configProblems,
  defaultConfig,
  setModule,
  usdToMicros,
} from "./logic";
import { ToolCatalog } from "./parts";
import { AGENT_ERROR_CODES, agentErrorText } from "./text";
import type { AgentView, CatalogTool, WorkOrderView } from "./types";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};

function render(
  node: React.ReactNode,
  { locale = "en" as Locale, owner = true } = {},
) {
  const shell = {
    hrefOf: (key: string) => `/p/p1/${key}`,
    modules: [],
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => k,
          canEdit: true,
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

const tool = (name: string, extra: Partial<CatalogTool> = {}): CatalogTool => ({
  name,
  module: "support",
  risk: "R0_read",
  title: { en: `Title ${name}`, de: `Titel ${name}` },
  summary: { en: `Summary ${name}`, de: `Zusammenfassung ${name}` },
  dataClass: "internal",
  cost: "none",
  needsApproval: false,
  mandatable: false,
  grantable: true,
  ...extra,
});

/** The markup of one tool row, from its checkbox to the next row. */
const row = (html: string, name: string) => {
  const start = html.indexOf(`id="agent-tool-${name}"`);
  const end = html.indexOf('class="agents-tool"', start);
  return html.slice(start, end === -1 ? undefined : end);
};

describe("ToolCatalog", () => {
  const tools = [
    tool("ticket_read"),
    tool("reply_propose", {
      risk: "P_proposal",
      needsApproval: true,
      mandatable: true,
      dataClass: "customer_personal",
      cost: "paid",
    }),
    tool("invoice_read", {
      module: "finance",
      grantable: false,
      reason: "ROLE_INSUFFICIENT",
      dataClass: "financial",
    }),
    tool("ticket_close", { risk: "W0_internal" }),
  ];

  it("shows risk, cost, approval, mandate and data-class badges", () => {
    const html = render(
      <ToolCatalog
        tools={tools}
        config={{ modules: ["support"], tools: [] }}
        locale="en"
        onToggle={() => {}}
      />,
    );
    const reply = row(html, "reply_propose");
    for (const text of [
      "Proposal",
      "Paid",
      "Needs approval",
      "Mandatable",
      "Personal customer data",
    ])
      expect(reply, text).toContain(text);
    const read = row(html, "ticket_read");
    expect(read).toContain("Reads");
    expect(read).toContain("No cost");
    expect(read).toContain("Internal data");
    expect(read).not.toContain("Needs approval");
    expect(row(html, "ticket_close")).toContain("Internal change");
    // Grouped by module with readable legends.
    expect(html).toContain("<legend>Support</legend>");
  });

  it("disables tools the member cannot grant and says why", () => {
    const html = render(
      <ToolCatalog
        tools={tools}
        config={{ modules: ["support", "finance"], tools: [] }}
        locale="de"
        onToggle={() => {}}
      />,
    );
    const invoice = row(html, "invoice_read");
    expect(invoice).toMatch(/disabled=""/);
    expect(invoice).toContain("Deine Rolle umfasst dieses Tool nicht");
    expect(invoice).toContain(
      'aria-describedby="agent-tool-invoice_read-summary agent-tool-invoice_read-reason"',
    );
    expect(row(html, "ticket_read")).not.toMatch(/disabled=""/);
  });

  it("disables tools of unchosen modules and those the template forbids", () => {
    const html = render(
      <ToolCatalog
        tools={tools}
        config={{ modules: [], tools: [] }}
        guard={{ forbiddenTools: ["ticket_close"] }}
        locale="en"
        onToggle={() => {}}
      />,
    );
    expect(row(html, "ticket_read")).toContain(
      "Choose the Support module first.",
    );
    expect(row(html, "ticket_read")).toMatch(/disabled=""/);
    expect(row(html, "ticket_close")).toContain(
      "The template forbids this tool.",
    );
  });
});

const config = defaultConfig(null);
const agent = (extra: Partial<AgentView> = {}): AgentView => ({
  id: "a1",
  version: 7,
  name: "Triage",
  status: "active",
  active: {
    ...config,
    name: "Triage",
    modules: ["support"],
    tools: ["ticket_read"],
  },
  draft: {
    ...config,
    name: "Triage",
    modules: ["support"],
    tools: ["ticket_read", "reply_propose"],
    mode: "draft",
  },
  activation: {
    sponsorUserId: "u1",
    activatedAt: "2026-11-01T10:00:00.000Z",
    version: 2,
    configHash: "a".repeat(64),
  },
  draftHash: "b".repeat(64),
  ...extra,
});

describe("review and activation", () => {
  it("activates exactly the version and draft hash shown", () => {
    expect(activationBody(agent())).toEqual({
      version: 7,
      configHash: "b".repeat(64),
    });
    expect(activationBody(agent({ draft: null, draftHash: null }))).toBeNull();
  });

  it("lists only the changed fields, in builder order", () => {
    const rows = configDiff(agent().active, agent().draft, "en");
    expect(rows.map((r) => r.field)).toEqual(["tools", "mode"]);
    expect(rows[0]).toMatchObject({
      before: "ticket_read",
      after: "ticket_read, reply_propose",
    });
    expect(rows[1]).toMatchObject({ before: "Read only", after: "Draft" });
    // Key order is not a change.
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(agent().active) as AgentView["active"];
    expect(configDiff(agent().active, reordered, "en")).toEqual([]);
    // Without an active version every field is new.
    expect(configDiff(null, agent().draft, "en")).toHaveLength(14);
  });

  it("shows the diff, the draft hash and the next version on the button", () => {
    const html = render(
      <ReviewActivate
        agent={agent()}
        locale="de"
        canActivate
        onActivate={() => {}}
      />,
    );
    expect(html).toContain("Tools");
    expect(html).toContain("<ins>ticket_read, reply_propose</ins>");
    expect(html).toContain("b".repeat(64));
    expect(html).toContain("Als Version 3 aktivieren");
  });

  it("hides the activation for non-owners and asks to save first", () => {
    const viewer = render(
      <ReviewActivate
        agent={agent()}
        locale="en"
        canActivate={false}
        onActivate={() => {}}
      />,
    );
    expect(viewer).not.toContain("Activate as version");
    const unsaved = render(
      <ReviewActivate
        agent={agent()}
        locale="en"
        canActivate={false}
        unsaved
        onActivate={() => {}}
      />,
    );
    expect(unsaved).toContain("Save your changes first");
  });
});

describe("error texts", () => {
  const required = [
    "AGENT_NOT_FOUND",
    "AGENT_NOT_ACTIVE",
    "AGENT_VERSION_CHANGED",
    "AGENT_CONFIG_INVALID",
    "AGENT_TOOL_NOT_GRANTABLE",
    "AGENT_TEMPLATE_RULE",
    "AGENT_PRINCIPAL_FORBIDDEN",
    "AGENT_BUDGET_EXHAUSTED",
    "AGENT_BUDGET_EXCEEDS_PROJECT",
    "AGENT_RUN_LIMIT",
    "AGENT_CONCURRENCY_LIMIT",
    "AGENT_DELEGATION_DEPTH",
    "AGENT_DELEGATION_CYCLE",
    "AGENT_DELEGATION_FANOUT",
    "AGENT_ENTITLEMENT",
    "AGENT_ROUTE_UNAVAILABLE",
    "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
    "AGENT_OUTPUT_INVALID",
    "AGENT_LIMIT",
    "AGENT_TRIGGER_DISABLED",
    "AGENT_PLATFORM_DISABLED",
    "AGENT_RUN_CEILING",
    "AGENT_CANCELED",
    "AGENT_NOT_ACTIVE",
    "AGENT_STATUS_INVALID",
  ];

  it("has a readable German and English text for every agent code", () => {
    for (const code of required) {
      expect(AGENT_ERROR_CODES, code).toContain(code);
      for (const locale of ["en", "de"] as const) {
        const text = agentErrorText(code, locale);
        expect(text, `${code} ${locale}`).not.toContain(code);
        expect(text.length, `${code} ${locale}`).toBeGreaterThan(20);
      }
    }
    expect(agentErrorText("AGENT_RUN_CEILING", "de")).toContain(
      "Kostenobergrenze",
    );
  });

  it("keeps the code of an unknown error", () => {
    expect(agentErrorText("AGENT_SOMETHING_NEW", "en")).toBe(
      "The action failed (AGENT_SOMETHING_NEW).",
    );
  });
});

describe("navigation", () => {
  const table = routeTable(webRegistry);

  it("shows the agents entry only for owners and editors while the API answers", () => {
    expect(
      agentPlatformVisible("owner", { data: { items: [] }, error: null }),
    ).toBe(true);
    expect(
      agentPlatformVisible("editor", { data: { items: [] }, error: null }),
    ).toBe(true);
    expect(
      agentPlatformVisible("viewer", { data: { items: [] }, error: null }),
    ).toBe(false);
    expect(
      agentPlatformVisible(undefined, { data: { items: [] }, error: null }),
    ).toBe(false);
    // 404 while ORBIT_AGENT_PLATFORM is off; still loading.
    expect(
      agentPlatformVisible("owner", { data: null, error: { status: 404 } }),
    ).toBe(false);
    expect(agentPlatformVisible("owner", { data: null, error: null })).toBe(
      false,
    );
  });

  it("puts the entry in the top group only with the feature on", () => {
    const keys = (on: boolean) =>
      navigationForFeatures(table.routes, { agentPlatform: on }).map(
        (r) => r.key,
      );
    expect(keys(false)).not.toContain("agents");
    expect(keys(true)).toContain("agents");
    const top = buildNavGroups(
      navigationForFeatures(table.routes, { agentPlatform: true }),
      webRegistry.modules.map((m) => ({ ...m, enabled: true })),
    )[0]!;
    expect(top.id).toBe("top");
    expect(top.entries.map((r) => r.key)).toEqual(["home", "chat", "agents"]);
  });

  it("routes every agents path to the page, which reads the rest itself", () => {
    for (const path of [
      "/p/p1/agents",
      "/p/p1/agents/new",
      "/p/p1/agents/a1",
      "/p/p1/agents/a1/executions/w1",
    ])
      expect(locate(path, table), path).toMatchObject({
        kind: "view",
        projectId: "p1",
        route: { key: "agents" },
      });
    expect(locate("/o/w1/agents", table)).toEqual({
      kind: "organizationAgents",
      organizationId: "w1",
    });
    // Existing deep links are unchanged.
    expect(locate("/p/p1/decisions", table)).toMatchObject({
      route: { key: "decisions" },
    });
    expect(locate("/o/w1/settings", table)).toEqual({
      kind: "organizationSettings",
      organizationId: "w1",
    });
    expect(agentsPlace("/p/p1/agents")).toEqual({ view: "list" });
    expect(agentsPlace("/p/p1/agents/new")).toEqual({ view: "new" });
    expect(agentsPlace("/p/p1/agents/a1")).toEqual({
      view: "agent",
      agentId: "a1",
    });
    expect(agentsPlace("/p/p1/agents/a1/executions/w1")).toEqual({
      view: "execution",
      agentId: "a1",
      workOrderId: "w1",
    });
    expect(agentsPlace("/p/p1/agents/a1/versions")).toEqual({
      view: "notFound",
    });
    expect(agentsPlace("/p/p1/agents/a1/executions/w1/x")).toEqual({
      view: "notFound",
    });
  });
});

describe("builder helpers", () => {
  it("links the agent permissions note to the center's section", () => {
    const href = agentPermissionsHref({
      projectCenterHref: (area, ...rest) =>
        manageHref({ kind: "project", projectId: "p1" }, area, ...rest),
    });
    expect(href).toBe("/manage/p/p1/ai/agents");
    const html = renderToStaticMarkup(
      <AgentPermissionsNote href={href} de={false} />,
    );
    expect(html).toContain('href="/manage/p/p1/ai/agents"');
    expect(html).toContain("Administration &amp; settings → AI → Agent permissions");
  });

  it("drops a module's tools and event triggers when it is switched off", () => {
    const tools = [
      tool("ticket_read"),
      tool("note_add", { module: "platform" }),
    ];
    const next = setModule(
      {
        ...config,
        modules: ["support"],
        tools: ["ticket_read", "note_add"],
        triggers: [
          { kind: "manual" },
          {
            kind: "event",
            type: "support.ticket.created",
            filter: {},
            debounceSeconds: 0,
          },
        ],
      },
      "support",
      false,
      tools,
    );
    expect(next.modules).toEqual([]);
    expect(next.tools).toEqual(["note_add"]);
    expect(next.triggers).toEqual([{ kind: "manual" }]);
  });

  it("flags what the server would refuse before saving", () => {
    expect(configProblems(config, "en")).toEqual([
      "Give the agent a name.",
      "Choose at least one module.",
      "Choose at least one tool.",
    ]);
    const ready = {
      ...config,
      name: "A",
      modules: ["support"],
      tools: ["ticket_read"],
    };
    expect(configProblems(ready, "en")).toEqual([]);
    expect(
      configProblems(
        {
          ...ready,
          budget: { monthlyCeilingMicros: 1, runCeilingMicros: 2 },
          triggers: [
            { kind: "schedule", rhythm: "daily", times: ["09:00", "09:00"] },
          ],
        },
        "de",
      ),
    ).toEqual([
      "Die Obergrenze je Ausführung liegt über der Monatsobergrenze.",
      "Uhrzeiten eines Zeitplans müssen gültig und verschieden sein (HH:MM).",
    ]);
  });

  it("reads USD as micros", () => {
    expect(usdToMicros("2.5")).toBe(2_500_000);
    expect(usdToMicros("0.000001")).toBe(1);
    expect(usdToMicros("-1")).toBeNull();
    expect(usdToMicros("abc")).toBeNull();
  });

  it("takes a template's defaults, module and required tools", () => {
    const made = defaultConfig({
      key: "support.triage",
      module: "support",
      title: { en: "Ticket triage", de: "Ticket-Triage" },
      summary: { en: "", de: "" },
      defaults: { mode: "draft" },
      guard: { requiredTools: ["ticket_read"], maxMode: "draft" },
    });
    expect(made).toMatchObject({
      name: "Ticket triage",
      templateKey: "support.triage",
      modules: ["support"],
      tools: ["ticket_read"],
      mode: "draft",
    });
  });
});

const workOrder = (extra: Partial<WorkOrderView> = {}): WorkOrderView => ({
  id: "w1",
  agentId: "a1",
  agentVersion: 2,
  origin: "manual",
  originRef: null,
  subject: null,
  onBehalfOf: { sponsorUserId: "u1", requesterUserId: "u2-abcdefgh" },
  allow: {},
  parentId: null,
  rootId: "w1",
  depth: 0,
  goal: "Sort the new tickets",
  status: "failed",
  errorCode: "AGENT_BUDGET_EXHAUSTED",
  ceilingMicros: 500_000,
  spentMicros: 120_000,
  costUnknown: false,
  result: { actionRequestIds: ["11111111-2222-3333-4444-555555555555"] },
  steps: [
    { index: 0, tool: "ticket_read", risk: "R0_read", outcome: "succeeded" },
    {
      index: 1,
      tool: "reply_propose",
      risk: "P_proposal",
      outcome: "failed",
      code: "AGENT_TOOL_NOT_ALLOWED",
    },
  ],
  createdAt: "2026-11-04T08:00:00.000Z",
  startedAt: "2026-11-04T08:00:01.000Z",
  finishedAt: "2026-11-04T08:00:09.000Z",
  ...extra,
});

describe("execution detail", () => {
  it("shows the error text, the people it acts for, steps and approvals", () => {
    const html = render(
      <ExecutionView
        item={workOrder()}
        agentId="a1"
        canRun
        onChanged={() => {}}
      />,
      { locale: "de" },
    );
    expect(html).toContain("Monatsbudget des Agenten ist aufgebraucht");
    expect(html).toContain("AGENT_BUDGET_EXHAUSTED");
    expect(html).toContain("Du");
    expect(html).toContain("Mitglied u2-abcde");
    expect(html).toContain("$0.12 von $0.50");
    expect(html).toContain("ticket_read");
    expect(html).toContain("Vorschlag");
    expect(html).toContain("AGENT_TOOL_NOT_ALLOWED");
    expect(html).toContain('href="/p/p1/decisions"');
    expect(html).toContain("11111111");
    // An ended execution offers a retry, not a cancel.
    expect(html).toContain("Erneut ausführen");
    expect(html).not.toContain(">Abbrechen<");
  });

  it("offers cancel for an open execution and nothing to members who may not run", () => {
    const open = render(
      <ExecutionView
        item={workOrder({ status: "running", errorCode: null })}
        agentId="a1"
        canRun
        onChanged={() => {}}
      />,
    );
    expect(open).toContain(">Cancel<");
    expect(open).not.toContain(">Retry<");
    const viewer = render(
      <ExecutionView
        item={workOrder()}
        agentId="a1"
        canRun={false}
        onChanged={() => {}}
      />,
    );
    expect(viewer).not.toContain(">Retry<");
  });
});

describe("overview figures", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  it("derives last run, failures in 24 h and the month's spend from a complete page", () => {
    const { byAgent, completeMonth } = agentFigures(
      {
        items: [
          workOrder({
            id: "w3",
            createdAt: "2026-11-04T11:00:00.000Z",
            finishedAt: "2026-11-04T11:01:00.000Z",
            status: "succeeded",
            spentMicros: 10,
          }),
          workOrder({
            id: "w2",
            createdAt: "2026-11-04T01:00:00.000Z",
            finishedAt: "2026-11-04T01:01:00.000Z",
            status: "failed",
            spentMicros: 20,
          }),
          workOrder({
            id: "w1",
            createdAt: "2026-10-30T01:00:00.000Z",
            finishedAt: "2026-10-30T01:01:00.000Z",
            status: "failed",
            spentMicros: 40,
          }),
        ],
        nextCursor: null,
      },
      now,
    );
    expect(completeMonth).toBe(true);
    expect(byAgent.get("a1")).toMatchObject({
      failures24h: 1,
      monthSpentMicros: 30,
    });
    expect(byAgent.get("a1")!.lastRun!.id).toBe("w3");
  });

  it("shows no month spend when the page may not reach back to the month start", () => {
    const { byAgent, completeMonth } = agentFigures(
      {
        items: [workOrder({ createdAt: "2026-11-04T11:00:00.000Z" })],
        nextCursor: "x",
      },
      now,
    );
    expect(completeMonth).toBe(false);
    expect(byAgent.get("a1")!.monthSpentMicros).toBeNull();
  });
});

describe("mandate agents channel", () => {
  it("sends named agents only, and no ids while the channel is off", () => {
    expect(
      mandateChannels({
        assistant: false,
        mcp: false,
        mcpClientIds: ["c1"],
        agents: true,
        agentIds: ["a1", "a2"],
      }),
    ).toEqual({
      assistant: false,
      mcp: false,
      mcpClientIds: [],
      agents: true,
      agentIds: ["a1", "a2"],
    });
    expect(
      mandateChannels({
        assistant: true,
        mcp: false,
        mcpClientIds: [],
        agents: false,
        agentIds: ["a1"],
      }),
    ).toMatchObject({ agents: false, agentIds: [] });
    // Checked without agents is no channel at all.
    expect(
      mandateChannels({
        assistant: true,
        mcp: false,
        mcpClientIds: [],
        agents: true,
        agentIds: [],
      }),
    ).toMatchObject({ agents: false, agentIds: [] });
    const many = Array.from({ length: 12 }, (_, i) => `a${i}`);
    expect(
      mandateChannels({
        assistant: false,
        mcp: false,
        mcpClientIds: [],
        agents: true,
        agentIds: many,
      }).agentIds,
    ).toHaveLength(MANDATE_MAX_AGENTS);
  });

  it("renders the checkbox and, when on, the agent picker with its limit", () => {
    const choices = [
      { id: "a1", name: "Triage", status: "active" },
      { id: "a2", name: "Digest", status: "paused" },
    ];
    const off = renderToStaticMarkup(
      <AgentChannel
        de
        choices={choices}
        agents={false}
        agentIds={[]}
        onAgents={() => {}}
        onAgentIds={() => {}}
      />,
    );
    expect(off).toContain("Eigene Agenten dieses Projekts");
    expect(off).not.toContain("Triage");
    const on = renderToStaticMarkup(
      <AgentChannel
        de={false}
        choices={choices}
        agents
        agentIds={[]}
        onAgents={() => {}}
        onAgentIds={() => {}}
      />,
    );
    expect(on).toContain("Triage");
    expect(on).toContain("Digest (not active)");
    expect(on).toContain("Choose at least one agent.");
    const full = renderToStaticMarkup(
      <AgentChannel
        de={false}
        choices={[
          ...choices,
          { id: "a11", name: "Eleventh", status: "active" },
        ]}
        agents
        agentIds={Array.from({ length: 10 }, (_, i) => `x${i}`)}
        onAgents={() => {}}
        onAgentIds={() => {}}
      />,
    );
    expect(full).toMatch(/disabled=""[^>]*\/?>\s*Eleventh|Eleventh/);
    expect((full.match(/disabled=""/g) ?? []).length).toBe(3);
  });
});
