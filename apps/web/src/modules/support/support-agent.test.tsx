import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/p1/support/tickets",
  useSearchParams: () => new URLSearchParams(""),
}));
// Every resource a view reads, by a part of its path; others answer 404.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return {
        data: found ?? null,
        error: found
          ? null
          : Object.assign(new Error("failed"), { status: 404 }),
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem, Identity, Project } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { GuidedSetup } from "@/platform/agents/builder";
import { defaultConfig } from "@/platform/agents/logic";
import type { AgentTemplate } from "@/platform/agents/types";
import {
  supportTriageRenderer,
  supportActionRequests,
} from "./action-requests";
import {
  InboxStep,
  KnowledgeStep,
  SUPPORT_TICKET_AGENT,
  inboxFilterIds,
  supportAgentSetups,
  withInboxFilter,
} from "./agent-setup";
import { timelineEntries, type TicketAgent, type TicketDetail } from "./api";
import { supportAttention } from "./attention";
import { supportText } from "./labels";
import { AiModeField } from "./settings";
import { TicketAgentPanel, TicketView, TimelineItem } from "./ticket";

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
const shell = {
  hrefOf: (key: string) => `/p/p1/${key}`,
  features: { agentPlatform: true },
  modules: [],
  agentSetups: supportAgentSetups,
} as unknown as ShellContextValue;

function render(
  node: React.ReactNode,
  { locale = "en" as Locale, canEdit = true } = {},
) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => k,
          canEdit,
          isOwner: true,
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

const WO = "11111111-2222-4333-8444-555555555555";
const AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const agent = (extra: Partial<TicketAgent> = {}): TicketAgent => ({
  workOrderId: WO,
  agentId: AGENT,
  status: "running",
  errorCode: null,
  spentMicros: 0,
  createdAt: "2026-11-04T08:00:00Z",
  finishedAt: null,
  actionRequestIds: [],
  handedOff: false,
  ...extra,
});
const panel = (a: TicketAgent, locale: Locale = "en") =>
  render(
    <TicketAgentPanel
      agent={a}
      t={supportText(locale)}
      locale={locale}
      timezone="Europe/Berlin"
      agentsHref="/p/p1/agents"
      approvalsHref="/p/p1/decisions"
    />,
    { locale },
  );

const detail = (a: TicketAgent | null | undefined): TicketDetail => ({
  ticket: {
    id: "t1",
    number: 42,
    subject: "Synthetic subject",
    status: "open",
    priority: "normal",
    category: null,
    tags: [],
    assigneeUserId: null,
    channel: "email",
    inboxId: "i1",
    contactId: "c1",
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    resolvedAt: null,
    mergedIntoTicketId: null,
    updatedAt: "2026-11-04T08:00:00Z",
    createdAt: "2026-11-04T08:00:00Z",
  },
  contact: null,
  inbox: { id: "i1", name: "Desk", channels: ["email"], aiMode: "agent" },
  timeline: [],
  ...(a !== undefined ? { agent: a } : {}),
});

describe("Support agent panel (WP2.6)", () => {
  it("is absent while the ticket has no agent execution", () => {
    answers["/tickets/t1"] = detail(null);
    const html = render(
      <TicketView ticketId="t1" onBack={() => {}} onChanged={() => {}} />,
      { canEdit: false },
    );
    expect(html).toContain("Synthetic subject");
    expect(html).not.toContain("support-agent-panel");
    // A ticket detail from before Phase 2 (no field) shows none either.
    answers["/tickets/t1"] = detail(undefined);
    expect(
      render(
        <TicketView ticketId="t1" onBack={() => {}} onChanged={() => {}} />,
        { canEdit: false },
      ),
    ).not.toContain("support-agent-panel");
  });

  it("shows a running execution with its link and the manual draft in agent mode", () => {
    answers["/tickets/t1"] = detail(agent());
    const html = render(
      <TicketView ticketId="t1" onBack={() => {}} onChanged={() => {}} />,
    );
    expect(html).toContain("support-agent-panel");
    expect(html).toContain("Running");
    expect(html).toContain(`/p/p1/agents/${AGENT}/executions/${WO}`);
    expect(html).toContain("Open execution");
    // The manual "AI draft" button keeps working in agent mode (D-15).
    expect(html).toContain("AI draft");
    expect(html).not.toContain("Error code");
    expect(html).not.toContain("Open approvals");
  });

  it("shows a failed execution with its code and cost", () => {
    const html = panel(
      agent({
        status: "failed",
        errorCode: "AGENT_BUDGET_EXHAUSTED",
        spentMicros: 120_000,
        finishedAt: "2026-11-04T08:01:00Z",
      }),
      "de",
    );
    expect(html).toContain("Fehlgeschlagen");
    expect(html).toContain("Fehlercode");
    expect(html).toContain("<code>AGENT_BUDGET_EXHAUSTED</code>");
    expect(html).toContain("$0.12");
  });

  it("shows a hand-off and links its proposals to the approvals", () => {
    const html = panel(
      agent({
        status: "waiting_approval",
        handedOff: true,
        actionRequestIds: ["r1", "r2"],
      }),
    );
    expect(html).toContain("Handed to the team");
    expect(html).toMatch(/badge-warning">Yes</);
    expect(html).toContain(">2");
    expect(html).toContain('href="/p/p1/decisions"');
    // Without an agent id (agent removed) there is no execution link.
    expect(panel(agent({ agentId: null }))).not.toContain("Open execution");
  });
});

describe("Support agent in the timeline", () => {
  it("labels the agent's notes and events, not people's", () => {
    const [note, human, event, oldAi] = timelineEntries([
      {
        id: "m1",
        kind: "internal_note",
        bodyText: "Likely cause: deposit delay",
        authorUserId: null,
        agentRunId: "run1",
        createdAt: "2026-11-04T08:00:00Z",
      },
      {
        id: "m2",
        kind: "internal_note",
        bodyText: "Checked",
        authorUserId: "u1",
        agentRunId: null,
        createdAt: "2026-11-04T08:00:00Z",
      },
      {
        id: "e1",
        type: "handoff",
        actorKind: "ai",
        actorId: WO,
        createdAt: "2026-11-04T08:00:00Z",
      },
      {
        id: "e2",
        type: "ai_triage",
        actorKind: "ai",
        actorId: null,
        createdAt: "2026-11-04T08:00:00Z",
      },
    ]);
    const item = (entry: typeof note) =>
      render(
        <TimelineItem
          entry={entry!}
          t={supportText("de")}
          locale="de"
          timezone="Europe/Berlin"
          projectId="p1"
        />,
      );
    expect(item(note)).toContain("Support-Agent");
    expect(item(human)).not.toContain("Support-Agent");
    expect(item(event)).toContain("An das Team übergeben");
    expect(item(event)).toContain("Support-Agent");
    // The inbox's own AI pipeline (draft mode) has no work order.
    expect(item(oldAi)).toContain("KI-Triage");
    expect(item(oldAi)).not.toContain("Support-Agent");
  });
});

describe("Apply-triage approval (WP2.6)", () => {
  const View = supportTriageRenderer.component;
  const item = {
    actionType: "support.mcp.support_apply_triage",
    costCeilingMicros: 0,
    summary: {
      operation: {
        kind: "support_apply_triage",
        ticketId: "t1",
        after: { priority: "high", tags: ["billing", "deposit"] },
        before: { priority: "normal", category: "account", tags: [] },
      },
    },
  };

  it("is registered for its action type", () => {
    expect(supportActionRequests["support.mcp.support_apply_triage"]).toBe(
      supportTriageRenderer,
    );
    expect(supportTriageRenderer.accepts(item as never)).toBe(true);
  });

  it("shows each proposed field before and after, without customer text", () => {
    const html = render(
      <View de={false} pending={false} decide={() => {}} item={item} />,
    );
    expect(html).toContain("Apply triage to ticket");
    expect(html).toContain("/p/p1/support/tickets?ticket=t1");
    expect(html).toMatch(/Priority<\/th><td>Normal<\/td><td>High<\/td>/);
    expect(html).toMatch(/Tags<\/th><td>—<\/td><td>billing, deposit<\/td>/);
    // Only proposed fields: the category stays unmentioned.
    expect(html).not.toContain("Category");
    expect(html).not.toContain("account");
    expect(html).toContain("Approve");
    const pending = render(<View de pending decide={() => {}} item={item} />, {
      locale: "de",
    });
    expect(pending).toContain("Triage auf Ticket anwenden");
    expect(pending).toContain("Hoch");
    expect(pending).toContain('disabled=""');
  });
});

describe("Support agent attention text", () => {
  const item: AttentionItem = {
    kind: "support_agent_inactive",
    moduleId: "support",
    severity: "warning",
    params: { inboxId: "i1", inbox: "Desk" },
  } as unknown as AttentionItem;
  it("names the inbox in English and German", () => {
    const render = supportAttention.support_agent_inactive!;
    expect(render(item, "en").title).toBe(
      "Support agent inactive for inbox Desk: tickets are handled by people only",
    );
    expect(render(item, "de").title).toBe(
      "Support-Agent für Posteingang Desk inaktiv: Menschen bearbeiten die Tickets",
    );
  });
});

describe("Inbox AI mode", () => {
  const field = (value: string, agentPlatform = true, locale: Locale = "en") =>
    render(
      <AiModeField
        value={value}
        agentPlatform={agentPlatform}
        agentsHref="/p/p1/agents"
        onChange={() => {}}
        t={supportText(locale)}
      />,
      { locale },
    );

  it("offers Off, Drafts and Agent, with help and a link in agent mode", () => {
    const html = field("draft");
    expect(html).toMatch(
      /<option value="off">Off<\/option><option value="draft"[^>]*>Drafts<\/option><option value="agent">Agent<\/option>/,
    );
    expect(html).not.toContain("never sends a reply");
    const agentMode = field("agent", true, "de");
    expect(agentMode).toContain("Aus");
    expect(agentMode).toContain("Entwürfe");
    expect(agentMode).toContain("sendet nie eine Antwort");
    expect(agentMode).toContain('href="/p/p1/agents"');
  });

  it("hides Agent while the platform is off, unless the inbox already uses it", () => {
    expect(field("off", false)).not.toContain('value="agent"');
    const kept = field("agent", false);
    expect(kept).toContain('value="agent"');
    expect(kept).not.toContain('href="/p/p1/agents"');
  });
});

describe("Support agent guided setup (WP2.6)", () => {
  const template: AgentTemplate = {
    key: SUPPORT_TICKET_AGENT,
    module: "support",
    title: { en: "Support agent", de: "Support-Agent" },
    summary: { en: "Synthetic summary", de: "Synthetische Zusammenfassung" },
    defaults: {
      modules: ["support"],
      tools: ["support_get_ticket"],
      knowledge: { audiences: ["support"] },
      mode: "draft",
      budget: { monthlyCeilingMicros: 5_000_000, runCeilingMicros: 100_000 },
      triggers: [
        { kind: "manual" },
        {
          kind: "event",
          type: "support.ticket.created",
          filter: {},
          debounceSeconds: 0,
        },
        {
          kind: "event",
          type: "support.message.received",
          filter: {},
          debounceSeconds: 120,
        },
      ],
    },
    guard: {},
  };
  const config = defaultConfig(template);
  const I1 = "0b9a7f6e-3c1d-4e55-8a3b-2f6d9c1e4a77";
  const I2 = "1c8b6e5d-2b0c-4d44-9a2a-1e5c8b0d3f66";

  it("writes the chosen inboxes into both Support event triggers", () => {
    const next = withInboxFilter(config, [I1, I2, I1]);
    const events = next.triggers.filter((t) => t.kind === "event");
    expect(events).toHaveLength(2);
    for (const e of events)
      expect(e.kind === "event" && e.filter).toEqual({ inboxIds: [I1, I2] });
    expect(next.triggers[0]).toEqual({ kind: "manual" });
    expect(inboxFilterIds(next)).toEqual([I1, I2]);
    // No inbox: the key goes, so the agent covers every agent-mode inbox.
    const all = withInboxFilter(next, []);
    for (const e of all.triggers)
      if (e.kind === "event") expect(e.filter).toEqual({});
    // At most 20 ids (the server's filter schema).
    const many = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    expect(inboxFilterIds(withInboxFilter(config, many))).toHaveLength(20);
  });

  it("lists the inboxes with their mode and marks the chosen ones", () => {
    answers["/support/inboxes"] = {
      items: [
        { id: I1, name: "Desk", aiMode: "agent", archivedAt: null },
        { id: I2, name: "Billing", aiMode: "draft", archivedAt: null },
        { id: "old", name: "Old", aiMode: "agent", archivedAt: "2026-01-01" },
      ],
    };
    const html = render(
      <InboxStep
        config={withInboxFilter(config, [I1])}
        locale="en"
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(new RegExp(`<input[^>]*checked=""[^>]*value="${I1}"`));
    expect(html).not.toMatch(
      new RegExp(`<input[^>]*checked=""[^>]*value="${I2}"`),
    );
    expect(html).toContain("Billing · AI: Drafts");
    expect(html).toContain("only in Agent mode");
    expect(html).not.toContain("Old");
    expect(html).toContain("1 chosen");
    const none = render(
      <InboxStep config={config} locale="de" onChange={() => {}} />,
      { locale: "de" },
    );
    expect(none).toContain("Keine Auswahl");
  });

  it("confirms the support audience", () => {
    expect(
      render(<KnowledgeStep config={config} locale="en" onChange={() => {}} />),
    ).toContain("Confirmed");
    expect(
      render(
        <KnowledgeStep
          config={{ ...config, knowledge: null }}
          locale="en"
          onChange={() => {}}
        />,
      ),
    ).toContain("Not set");
  });

  it("guides through inboxes, audience, budget and create", () => {
    answers["/support/inboxes"] = { items: [] };
    const html = render(
      <GuidedSetup
        template={template}
        setup={supportAgentSetups[SUPPORT_TICKET_AGENT]!}
        config={config}
        locale="en"
        readOnly={false}
        onChange={() => {}}
        monthly="5"
        perRun="0.1"
        onMonthly={() => {}}
        onPerRun={() => {}}
        problems={[]}
        pending={false}
        code={null}
        onSubmit={() => {}}
        onShowAll={() => {}}
      />,
    );
    const order = [
      "Guided setup: Support agent",
      "1. Choose inboxes",
      "2. Confirm the knowledge audience",
      "3. Choose the budget",
      "4. Create",
      "Create agent as draft",
      "All settings",
    ].map((text) => html.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('value="5"');
    expect(html).toContain('value="0.1"');
  });
});
