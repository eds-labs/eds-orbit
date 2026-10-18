import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem, AttentionResponse } from "@/lib/api";
import { webRegistry } from "@/modules/registry";
import {
  attentionCache,
  attentionRenderers,
  GenericAttentionRow,
  navBadges,
  renderAttention,
  useAttention,
  type AttentionState,
} from "./attention";
import { buildNavGroups } from "./nav-groups";
import { projectHref, routeTable, type Route } from "./routes";
import { ShellContext, type ShellContextValue } from "./shell-context";
import { SidebarNav } from "./sidebar-nav";

const table = routeTable(webRegistry);
const modules = webRegistry.modules.map((m) => ({ ...m, enabled: true }));
const groups = buildNavGroups(table.routes, modules);
const hrefOf = (r: Route) => projectHref("p1", r);
const href = (key: string) =>
  `href="${hrefOf(table.routes.find((r) => r.key === key)!)}"`;
const renderers = attentionRenderers(webRegistry);

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "x",
  moduleId: "support",
  kind: "support_unassigned",
  severity: "warning",
  params: {},
  navKey: "support-tickets",
  link: "/support/tickets",
  ...over,
});

const response = (
  items: AttentionItem[],
  counts: Record<string, number>,
): AttentionResponse => ({
  items,
  counts,
  status: { paused: false, aiMonth: { spentMicros: 0, limitMicros: null } },
});

/** The sidebar as the shell feeds it from the attention state. */
function Sidebar({ locale = "en" }: { locale?: "en" | "de" }) {
  const { counts, urgent } = navBadges(useAttention());
  return (
    <SidebarNav
      groups={groups}
      activeKey={undefined}
      hrefOf={hrefOf}
      badges={counts}
      urgent={urgent}
      locale={locale}
      collapsed={new Set()}
      onToggle={() => {}}
    />
  );
}

function withAttention(attention: AttentionState, locale?: "en" | "de") {
  const shell = { attention } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <Sidebar locale={locale} />
    </ShellContext.Provider>,
  );
}

/** The <a> of a route's sidebar entry, with its content. */
const entry = (html: string, key: string) =>
  new RegExp(`<a[^>]*${href(key)}[^>]*>.*?</a>`).exec(html)?.[0];

describe("renderAttention", () => {
  it("an unknown kind uses the generic row", () => {
    const unknown = item({ kind: "support_new_thing", id: "n" });
    expect(renderAttention(unknown, renderers, "de", modules)).toEqual({
      title: "Support",
      detail: "support_new_thing",
      action: { en: "Open", de: "Öffnen" },
    });
    // A module the web does not know shows its id.
    expect(
      renderAttention(
        item({ moduleId: "billing", kind: "billing_due" }),
        renderers,
        "en",
        modules,
      ).title,
    ).toBe("billing");
    const html = renderToStaticMarkup(
      <GenericAttentionRow
        item={unknown}
        href="/p/p1/support/tickets"
        locale="de"
        modules={modules}
      />,
    );
    expect(html).toContain('href="/p/p1/support/tickets"');
    expect(html).toContain("Support");
    expect(html).toContain("support_new_thing");
    expect(html).toContain("Öffnen");
  });

  it("support renderer: breached ticket title 'SLA verletzt · #1042 <subject>'", () => {
    const breached = item({
      kind: "support_sla_breached",
      severity: "critical",
      params: {
        number: 1042,
        subject: "Login klappt nicht",
        channel: "email",
        assigned: false,
      },
    });
    const de = renderAttention(breached, renderers, "de", modules);
    expect(de.title).toBe("SLA verletzt · #1042 Login klappt nicht");
    expect(de.detail).toBe("E-Mail · nicht zugewiesen");
    expect(renderAttention(breached, renderers, "en", modules).title).toBe(
      "SLA breached · #1042 Login klappt nicht",
    );
  });

  it("aggregated items name their count", () => {
    const de = (over: Partial<AttentionItem>) =>
      renderAttention(item(over), renderers, "de", modules).title;
    expect(de({ count: 1 })).toBe("1 Ticket nicht zugewiesen");
    expect(de({ count: 4 })).toBe("4 Tickets nicht zugewiesen");
    expect(
      de({
        moduleId: "knowledge",
        kind: "knowledge_source_stale",
        id: "knowledge:source_stale:more",
        count: 2,
      }),
    ).toBe("2 weitere Quellen veraltet");
    expect(
      de({
        moduleId: "knowledge",
        kind: "knowledge_source_stale",
        params: { name: "Website" },
      }),
    ).toBe("Quelle veraltet · Website");
  });

  // Every kind the API emits (Tasks 10–12) has its own text in both languages.
  it.each([
    ["support", "support_sla_breached", { number: 1, subject: "S" }],
    ["support", "support_sla_at_risk", { number: 1, subject: "S" }],
    ["support", "support_unassigned", {}],
    [
      "marketing",
      "marketing_draft_release",
      { assignmentName: "Beta", channelName: "X", slotAt: "" },
    ],
    ["marketing", "marketing_content_review", {}],
    ["marketing", "marketing_exception", { code: "PUBLISH_OUTCOME_UNKNOWN" }],
    ["marketing", "marketing_paused_posts", {}],
    ["marketing", "marketing_run_problem", { code: "RUN_FAILED" }],
    ["knowledge", "knowledge_source_stale", { name: "Docs" }],
    ["knowledge", "knowledge_source_expiring", { name: "Docs" }],
    ["knowledge", "knowledge_conflicts", {}],
    ["knowledge", "knowledge_import_failed", {}],
    ["platform", "platform_worker_down", {}],
    ["platform", "platform_cost_unknown", { micros: 2_200_000 }],
    ["platform", "platform_action_request", {}],
  ])("%s renders %s in EN and DE", (moduleId, kind, params) => {
    expect(renderers[kind], kind).toBeTypeOf("function");
    const shown = item({ moduleId, kind, params, count: 2 });
    const en = renderAttention(shown, renderers, "en", modules);
    const de = renderAttention(shown, renderers, "de", modules);
    for (const text of [en, de]) {
      expect(text.title).not.toBe("");
      expect(text.title).not.toContain(kind);
      expect(text.action.en).not.toBe("");
      expect(text.action.de).not.toBe("");
    }
    expect(de.title).not.toBe(en.title);
  });
});

describe("navBadges", () => {
  it("badges come from counts by navKey", () => {
    const data = response(
      [
        item({ kind: "support_sla_breached", severity: "critical" }),
        item({ moduleId: "marketing", navKey: "approvals", count: 2 }),
      ],
      { "support-tickets": 3, approvals: 2, "no-such-entry": 4 },
    );
    const badges = navBadges({ data, loading: false });
    expect(badges.counts).toEqual(data.counts);
    expect([...badges.urgent]).toEqual(["support-tickets"]);
    const html = withAttention({ data, loading: false }, "de");
    const tickets = entry(html, "support-tickets")!;
    expect(tickets).toContain("nav-badge nav-badge-warning");
    expect(tickets).toContain(">3<");
    expect(tickets).toContain(" zu erledigen, dringend");
    const approvals = entry(html, "approvals")!;
    expect(approvals).toMatch(/class="nav-badge">2</);
    expect(approvals).toContain(" zu erledigen<");
    // A navKey without a visible entry shows nowhere.
    expect(html).not.toContain(">4<");
  });

  it("a failed load gives no badges and does not throw", () => {
    const failed = { error: new Error("boom"), loading: false };
    expect(navBadges(failed)).toEqual({ counts: {}, urgent: new Set() });
    const html = withAttention(failed);
    expect(html).not.toContain("nav-badge");
    // Navigation still renders.
    expect(html).toContain(href("support-tickets"));
    expect(withAttention({ loading: true })).not.toContain("nav-badge");
  });
});

describe("attentionCache", () => {
  const ok = response([], { approvals: 1 });

  it("reuses a response for the same project and revision within 30 s", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    expect(cache.peek("p1", 0, 0)).toBeUndefined();
    expect(await cache.load("p1", 0, fetcher, 0)).toBe(ok);
    expect(cache.peek("p1", 0, 29_999)).toBe(ok);
    expect(await cache.load("p1", 0, fetcher, 29_999)).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Another project has its own entry.
    expect(cache.peek("p2", 0, 1)).toBeUndefined();
  });

  it("refetches after a revision bump or once expired", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    await cache.load("p1", 0, fetcher, 0);
    expect(cache.peek("p1", 1, 1)).toBeUndefined();
    await cache.load("p1", 1, fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A remount starts at revision 0 again: that is not the stored one.
    expect(cache.peek("p1", 0, 2)).toBeUndefined();
    expect(cache.peek("p1", 1, 30_001)).toBeUndefined();
    await cache.load("p1", 1, fetcher, 30_001);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shares a request in flight", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    const [a, b] = [
      cache.load("p1", 0, fetcher, 0),
      cache.load("p1", 0, fetcher, 5),
    ];
    expect(cache.peek("p1", 0, 5)).toBeUndefined();
    expect(await a).toBe(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors", async () => {
    const cache = attentionCache();
    const failing = vi.fn(async (): Promise<AttentionResponse> => {
      throw new Error("down");
    });
    await expect(cache.load("p1", 0, failing, 0)).rejects.toThrow("down");
    expect(cache.peek("p1", 0, 1)).toBeUndefined();
    const fetcher = vi.fn(async () => ok);
    expect(await cache.load("p1", 0, fetcher, 1)).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
