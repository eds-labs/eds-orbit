import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AttentionItem,
  AttentionResponse,
  Identity,
  Project,
} from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { takeAssistantDraft } from "./assistant-draft";
import { attentionRenderers, type AttentionState } from "./attention";
import { AttentionList, attentionTarget } from "./attention-list";
import {
  greeting,
  ProjectHome,
  StatusStrip,
  submitAssistantPrompt,
} from "./home";
import { attentionWhen } from "./relative-time";
import { homeSections, navOrder, projectHref, routeTable } from "./routes";
import { ShellContext, type ShellContextValue } from "./shell-context";

const table = routeTable(webRegistry);
const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic Owner", email: "u@example.invalid" },
  workspaces: [{ id: "w1", name: "Org one", role: "owner" }],
  projects: [project],
};
const NOW = new Date("2026-10-19T10:00:00Z");

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "x",
  moduleId: "support",
  kind: "support_sla_at_risk",
  severity: "warning",
  params: { number: 1042, subject: "Login fails", channel: "email" },
  navKey: "support-tickets",
  link: "/support/tickets?ticket=t1",
  ...over,
});

const response = (
  items: AttentionItem[],
  status: Partial<AttentionResponse["status"]> = {},
): AttentionResponse => ({
  items,
  counts: {},
  status: {
    paused: false,
    aiMonth: { spentMicros: 6_400_000, limitMicros: 20_000_000 },
    ...status,
  },
});

function shell(
  attention: AttentionState,
  enabled: Record<string, boolean> = {},
): ShellContextValue {
  const nav = navOrder(table.routes.filter((r) => r.nav));
  return {
    table,
    platformNav: nav.filter((r) => !r.moduleId),
    modules: webRegistry.modules.map((m) => ({
      ...m,
      enabled: enabled[m.id] ?? true,
      nav: nav.filter((r) => r.moduleId === m.id),
    })),
    // The module sections fetch data; the test renders a stand-in.
    homeSections: [
      { moduleId: "marketing", component: () => <p>marketing section</p> },
    ],
    hrefOf: (key) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    chat: [],
    actionRequests: {},
    attention,
    attentionRenderers: attentionRenderers(webRegistry),
    settings: [],
    setupLinks: [],
    connectors: { providers: [], extras: [] },
  };
}

function render(
  node: React.ReactNode,
  {
    locale = "en",
    attention = { loading: false },
    enabled = {},
  }: {
    locale?: Locale;
    attention?: AttentionState;
    enabled?: Record<string, boolean>;
  } = {},
) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell(attention, enabled)}>
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
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const rows = (html: string) => html.match(/<li class="attention-row/g) ?? [];

describe("greeting", () => {
  it("greeting by hour", () => {
    const at = (h: number) => new Date(2026, 9, 19, h, 0);
    expect(greeting(at(9), "de")).toBe("Guten Morgen");
    expect(greeting(at(14), "de")).toBe("Guten Tag");
    expect(greeting(at(20), "de")).toBe("Guten Abend");
    expect(greeting(at(9), "en")).toBe("Good morning");
    expect(greeting(at(14), "en")).toBe("Good afternoon");
    expect(greeting(at(20), "en")).toBe("Good evening");
    // The boundaries: 11:00 and 18:00 start the next part of the day.
    expect(greeting(at(11), "de")).toBe("Guten Tag");
    expect(greeting(at(18), "de")).toBe("Guten Abend");
  });
});

describe("attentionWhen", () => {
  const at = (iso: string) => new Date(iso).toISOString();
  it("shows the due time while it lies ahead", () => {
    const due = item({ dueAt: at("2026-10-19T10:45:00Z") });
    expect(attentionWhen(due, NOW, "de")).toEqual({
      text: "in 45 Min.",
      overdue: false,
    });
    expect(attentionWhen(due, NOW, "en")?.text).toBe("in 45 min");
    const later = item({ dueAt: at("2026-10-19T13:20:00Z") });
    expect(attentionWhen(later, NOW, "de")?.text).toBe("in 3 Std.");
    expect(attentionWhen(later, NOW, "en")?.text).toBe("in 3 h");
    const days = item({ dueAt: at("2026-10-21T10:00:00Z") });
    expect(attentionWhen(days, NOW, "de")?.text).toBe("in 2 Tagen");
    expect(attentionWhen(days, NOW, "en")?.text).toBe("in 2 days");
  });

  it("says how long a due time is past", () => {
    const past = item({ dueAt: at("2026-10-19T09:50:00Z") });
    expect(attentionWhen(past, NOW, "de")).toEqual({
      text: "überfällig seit 10 Min.",
      overdue: true,
    });
    expect(attentionWhen(past, NOW, "en")?.text).toBe("overdue by 10 min");
    const day = item({ dueAt: at("2026-10-18T09:00:00Z") });
    expect(attentionWhen(day, NOW, "de")?.text).toBe("überfällig seit 1 Tag");
    expect(attentionWhen(day, NOW, "en")?.text).toBe("overdue by 1 day");
  });

  it("falls back to the age, else nothing", () => {
    const old = item({ since: at("2026-10-19T07:00:00Z") });
    expect(attentionWhen(old, NOW, "de")).toEqual({
      text: "seit 3 Std.",
      overdue: false,
    });
    expect(attentionWhen(old, NOW, "en")?.text).toBe("3 h ago");
    // Rounding to 60 minutes reads as one hour, never "0 h".
    const almost = item({ since: at("2026-10-19T09:00:20Z") });
    expect(attentionWhen(almost, NOW, "en")?.text).toBe("1 h ago");
    const fresh = item({ since: at("2026-10-19T09:59:50Z") });
    expect(attentionWhen(fresh, NOW, "en")?.text).toBe("1 min ago");
    const week = item({ since: at("2026-10-12T10:00:00Z") });
    expect(attentionWhen(week, NOW, "de")?.text).toBe("seit 7 Tagen");
    expect(attentionWhen(item({}), NOW, "en")).toBeNull();
    expect(attentionWhen(item({ since: "nonsense" }), NOW, "en")).toBeNull();
  });
});

describe("AttentionList", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    item({ id: `i${i}`, params: { number: i, subject: `Ticket ${i}` } }),
  );

  it("shows at most 8 rows and 'Alle anzeigen' reveals the rest", () => {
    const html = render(<AttentionList items={many} max={8} now={NOW} />, {
      locale: "de",
    });
    expect(rows(html)).toHaveLength(8);
    expect(html).toContain("Ticket 7");
    expect(html).not.toContain("Ticket 8");
    expect(html).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>Alle anzeigen \(11\)/,
    );
    const open = render(
      <AttentionList items={many} max={8} now={NOW} defaultExpanded />,
      { locale: "de" },
    );
    expect(rows(open)).toHaveLength(11);
    expect(open).toContain("Ticket 10");
    expect(open).toMatch(/aria-expanded="true"[^>]*>Weniger anzeigen/);
    // Up to max items need no button.
    const few = render(
      <AttentionList items={many.slice(0, 8)} max={8} now={NOW} />,
    );
    expect(few).not.toContain("aria-expanded");
  });

  it("each row: module chip, title, detail, pill and one link", () => {
    const html = render(
      <AttentionList
        items={[item({ dueAt: "2026-10-19T10:45:00Z", severity: "critical" })]}
        max={8}
        now={NOW}
      />,
      { locale: "de" },
    );
    expect(html).toContain('data-module="support"');
    expect(html).toContain(">Support<");
    expect(html).toContain("#1042 Login fails");
    expect(html).toContain("in 45 Min.");
    expect(html).toContain('href="/p/p1/support/tickets?ticket=t1"');
    expect(html.match(/<a /g)).toHaveLength(1);
    // The platform's items carry the project's name for the chip.
    const platform = render(
      <AttentionList
        items={[
          item({
            moduleId: "platform",
            kind: "platform_worker_down",
            navKey: "operations",
            link: "/operations",
          }),
        ]}
        max={8}
        now={NOW}
      />,
      { locale: "de" },
    );
    expect(platform).toContain(">Projekt<");
    expect(platform).toContain('href="/p/p1/operations"');
  });

  it("R22: a row whose page is not available has no link", () => {
    const request = item({
      id: "a",
      moduleId: "platform",
      kind: "platform_action_request",
      count: 2,
      navKey: "approvals",
      link: "/approvals",
    });
    const off = render(<AttentionList items={[request]} max={8} now={NOW} />, {
      enabled: { marketing: false },
    });
    expect(rows(off)).toHaveLength(1);
    expect(off).toContain("2 decisions wait for you");
    expect(off).not.toContain("<a ");
    const on = render(<AttentionList items={[request]} max={8} now={NOW} />);
    expect(on).toContain('href="/p/p1/approvals"');
  });
});

describe("attentionTarget", () => {
  const on = () => true;
  it("resolves a link below the project, with its query", () => {
    expect(attentionTarget("/support/tickets?ticket=t1", "p1", table, on)).toBe(
      "/p/p1/support/tickets?ticket=t1",
    );
    expect(attentionTarget("/knowledge", "p1", table, on)).toBe(
      "/p/p1/knowledge",
    );
  });
  it("gives no target for an unknown or disabled page", () => {
    expect(attentionTarget("/nope", "p1", table, on)).toBeNull();
    expect(
      attentionTarget("/approvals", "p1", table, (id) => id !== "marketing"),
    ).toBeNull();
    expect(
      attentionTarget(
        "/support/tickets",
        "p1",
        table,
        (id) => id !== "support",
      ),
    ).toBeNull();
  });
});

describe("StatusStrip", () => {
  it("paused in the warning colours", () => {
    const html = render(
      <StatusStrip
        status={response([], { paused: true, mode: "assisted" }).status}
        now={NOW}
      />,
      { locale: "de" },
    );
    expect(html).toContain('data-paused="true"');
    expect(html).toContain("Pausiert");
    expect(html).not.toContain("Assisted-Modus");
    expect(html).toContain("KI-Budget Oktober: 6,40 von 20,00 USD");
    expect(html).toContain('href="/p/p1/operations"');
    expect(html).toContain("Betrieb ansehen");
  });

  it("the mode and the budget of the month", () => {
    const html = render(
      <StatusStrip
        status={response([], { mode: "assisted" }).status}
        now={NOW}
      />,
    );
    expect(html).toContain('data-paused="false"');
    expect(html).toContain("Assisted mode");
    expect(html).toContain("AI budget October: 6.40 of 20.00 USD");
    expect(html).toContain("View operations");
    expect(
      render(
        <StatusStrip
          status={response([], { mode: "observe" }).status}
          now={NOW}
        />,
        { locale: "de" },
      ),
    ).toContain("Beobachtungsmodus");
  });

  it("without a limit or a mode", () => {
    const status = response([], {
      aiMonth: { spentMicros: 1_234_567, limitMicros: null },
    }).status;
    const en = render(<StatusStrip status={status} now={NOW} />);
    expect(en).toContain("Active");
    expect(en).toContain("AI budget October: 1.23 USD, no limit");
    const de = render(<StatusStrip status={status} now={NOW} />, {
      locale: "de",
    });
    expect(de).toContain("Aktiv");
    expect(de).toContain("KI-Budget Oktober: 1,23 USD, kein Limit");
  });
});

describe("ProjectHome", () => {
  it("no module tiles", () => {
    const html = render(<ProjectHome />, {
      attention: { loading: false, data: response([item({})]) },
    });
    expect(html).not.toContain("module-tile");
    expect(html).not.toContain('href="/p/p1/marketing/missions"');
    expect(html).toMatch(
      /<h1>Good (morning|afternoon|evening), Synthetic<\/h1>/,
    );
    expect(html).toContain("1 thing needs you today");
    expect(html).toContain("Needs your attention");
    expect(html).toContain('for="home-assistant-input"');
    expect(html).toContain('aria-label="Continue in chat"');
    // The module sections follow the list, in the card grid, and the
    // platform's system status card comes last.
    expect(html.indexOf("marketing section")).toBeGreaterThan(
      html.indexOf("attention-row"),
    );
    expect(html.indexOf('class="home-cards"')).toBeLessThan(
      html.indexOf("marketing section"),
    );
    expect(html.indexOf("System status")).toBeGreaterThan(
      html.indexOf("marketing section"),
    );
  });

  it("empty list shows the all-clear text", () => {
    const html = render(<ProjectHome />, {
      locale: "de",
      attention: { loading: false, data: response([]) },
    });
    expect(html).toContain("Nichts offen. Alles erledigt.");
    expect(rows(html)).toHaveLength(0);
    expect(html).not.toContain("Dinge brauchen dich");
  });

  it("error shows ResourceError, modules still render", () => {
    const html = render(<ProjectHome />, {
      attention: { loading: false, error: new Error("Attention unavailable") },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Attention unavailable");
    expect(html).toContain("Try again");
    expect(html).toContain("marketing section");
    expect(html).toContain('for="home-assistant-input"');
    expect(html).not.toContain("status-strip");
  });

  it("loading shows skeleton rows", () => {
    const html = render(<ProjectHome />, { attention: { loading: true } });
    expect(html).toContain('class="skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("marketing section");
  });
});

describe("homeSections", () => {
  const ids = (enabled: (id: string) => boolean) =>
    homeSections(webRegistry.modules, enabled).map((s) => s.moduleId);

  it("knowledge card registered: support, marketing, knowledge by homeOrder", () => {
    expect(ids(() => true)).toEqual(["support", "marketing", "knowledge"]);
    expect(ids((id) => id !== "support")).toEqual(["marketing", "knowledge"]);
  });
});

describe("assistant prompt", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prompt submit stores the draft and opens chat", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    const push = vi.fn();
    expect(
      submitAssistantPrompt("p1", "  Draft a post  ", "/p/p1/assistant", push),
    ).toBe(true);
    expect(push).toHaveBeenCalledWith("/p/p1/assistant");
    expect(takeAssistantDraft("p1")).toBe("Draft a post");
    // An empty prompt neither stores nor navigates.
    expect(submitAssistantPrompt("p1", "   ", "/p/p1/assistant", push)).toBe(
      false,
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(takeAssistantDraft("p1")).toBe("");
  });
});
