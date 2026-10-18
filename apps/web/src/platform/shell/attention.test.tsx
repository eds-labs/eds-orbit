import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem, AttentionResponse } from "@/lib/api";
import { webRegistry } from "@/modules/registry";
import {
  attentionCache,
  attentionKey,
  attentionReducer,
  attentionRenderers,
  attentionView,
  GenericAttentionRow,
  initialAttention,
  navBadges,
  overflowBadge,
  renderAttention,
  useAttention,
  type AttentionState,
} from "./attention";
import { buildNavGroups } from "./nav-groups";
import { projectHref, routeTable, type Route } from "./routes";
import { ShellContext, type ShellContextValue } from "./shell-context";
import { NavBadge, SidebarNav } from "./sidebar-nav";

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

  it("support counts each ticket once: further and other unassigned (R20)", () => {
    const title = (over: Partial<AttentionItem>, locale: "en" | "de") =>
      renderAttention(item(over), renderers, locale, modules).title;
    const breachedMore = {
      kind: "support_sla_breached",
      id: "support:sla:breached:more",
      severity: "critical" as const,
      count: 3,
    };
    expect(title(breachedMore, "en")).toBe("3 more tickets with SLA breached");
    expect(title(breachedMore, "de")).toBe(
      "3 weitere Tickets mit verletztem SLA",
    );
    const atRiskMore = {
      kind: "support_sla_at_risk",
      id: "support:sla:at_risk:more",
      count: 1,
    };
    expect(title(atRiskMore, "en")).toBe("1 more ticket with SLA at risk");
    expect(title(atRiskMore, "de")).toBe(
      "1 weiteres Ticket mit gefährdetem SLA",
    );
    const others = { count: 2, params: { othersListed: true } };
    expect(title(others, "en")).toBe("2 more unassigned");
    expect(title(others, "de")).toBe("2 weitere ohne Zuweisung");
    // Without listed ones the plain text stays.
    expect(title({ count: 2 }, "de")).toBe("2 Tickets nicht zugewiesen");
  });

  it("an exception names what it affects, not a count (R19)", () => {
    const exception = (params: AttentionItem["params"]) =>
      item({
        moduleId: "marketing",
        kind: "marketing_exception",
        navKey: "approvals",
        params,
      });
    const shown = exception({ code: "EMAIL_OUTCOME_UNKNOWN", affected: 3 });
    expect(renderAttention(shown, renderers, "en", modules)).toMatchObject({
      title: "Outcome unclear · EMAIL_OUTCOME_UNKNOWN",
      detail: "affects 3",
    });
    expect(renderAttention(shown, renderers, "de", modules).detail).toBe(
      "betrifft 3",
    );
    // Without affected resources (or an older API) there is no detail.
    expect(
      renderAttention(exception({ code: "X" }), renderers, "en", modules)
        .detail,
    ).toBeUndefined();
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
  const p1 = attentionKey("u1", "p1")!;
  const p2 = attentionKey("u1", "p2")!;

  it("reuses a response for the same project and revision within 30 s", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    expect(cache.peek(p1, 0, 0)).toBeUndefined();
    expect(await cache.load(p1, 0, fetcher, 0)).toBe(ok);
    expect(cache.peek(p1, 0, 29_999)).toBe(ok);
    expect(await cache.load(p1, 0, fetcher, 29_999)).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Another project has its own entry.
    expect(cache.peek(p2, 0, 1)).toBeUndefined();
  });

  it("refetches after a revision bump or once expired", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    await cache.load(p1, 0, fetcher, 0);
    expect(cache.peek(p1, 1, 1)).toBeUndefined();
    await cache.load(p1, 1, fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A remount starts at revision 0 again: that is not the stored one.
    expect(cache.peek(p1, 0, 2)).toBeUndefined();
    expect(cache.peek(p1, 1, 30_001)).toBeUndefined();
    await cache.load(p1, 1, fetcher, 30_001);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shares a request in flight", async () => {
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    const [a, b] = [
      cache.load(p1, 0, fetcher, 0),
      cache.load(p1, 0, fetcher, 5),
    ];
    expect(cache.peek(p1, 0, 5)).toBeUndefined();
    expect(await a).toBe(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors", async () => {
    const cache = attentionCache();
    const failing = vi.fn(async (): Promise<AttentionResponse> => {
      throw new Error("down");
    });
    await expect(cache.load(p1, 0, failing, 0)).rejects.toThrow("down");
    expect(cache.peek(p1, 0, 1)).toBeUndefined();
    const fetcher = vi.fn(async () => ok);
    expect(await cache.load(p1, 0, fetcher, 1)).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keys by user and project, and clears", async () => {
    expect(attentionKey(undefined, "p1")).toBeUndefined();
    expect(attentionKey("u1", undefined)).toBeUndefined();
    const cache = attentionCache();
    const fetcher = vi.fn(async () => ok);
    await cache.load(p1, 0, fetcher, 0);
    // Another member of the same project never sees this response.
    expect(cache.peek(attentionKey("u2", "p1")!, 0, 1)).toBeUndefined();
    await cache.load(attentionKey("u2", "p1")!, 0, fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.clear();
    expect(cache.peek(p1, 0, 2)).toBeUndefined();
    await cache.load(p1, 0, fetcher, 2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a request in flight at clear() does not refill the cache", async () => {
    const cache = attentionCache();
    let resolve!: (r: AttentionResponse) => void;
    const pending = cache.load(
      p1,
      0,
      () => new Promise<AttentionResponse>((r) => (resolve = r)),
      0,
    );
    cache.clear();
    resolve(ok);
    await pending;
    expect(cache.peek(p1, 0, 1)).toBeUndefined();
  });
});

describe("attention state", () => {
  const a = response([], { approvals: 1 });
  const b = response([], { approvals: 2 });
  const u1p1 = attentionKey("u1", "p1")!;
  const u1p2 = attentionKey("u1", "p2")!;
  const u2p1 = attentionKey("u2", "p1")!;

  it("starts from a cached response, else loading", () => {
    expect(attentionView(initialAttention(u1p1, a), u1p1)).toEqual({
      data: a,
      error: undefined,
      loading: false,
    });
    expect(attentionView(initialAttention(u1p1, undefined), u1p1)).toEqual({
      data: undefined,
      error: undefined,
      loading: true,
    });
    expect(
      attentionView(initialAttention(undefined, undefined), undefined),
    ).toEqual({ loading: false });
  });

  it("keeps the last data while reloading the same user and project only", () => {
    const loaded = attentionReducer(initialAttention(u1p1, undefined), {
      type: "loaded",
      key: u1p1,
      data: a,
    });
    const reloading = attentionReducer(loaded, { type: "loading", key: u1p1 });
    expect(attentionView(reloading, u1p1)).toMatchObject({
      data: a,
      loading: true,
    });
    for (const key of [u1p2, u2p1]) {
      const other = attentionReducer(loaded, { type: "loading", key });
      expect(attentionView(other, key)).toMatchObject({
        data: undefined,
        loading: true,
      });
    }
  });

  it("a project or user switch hides the old data at once", () => {
    const loaded = attentionReducer(initialAttention(u1p1, undefined), {
      type: "loaded",
      key: u1p1,
      data: a,
    });
    // Before the effect runs for the new key, the view shows nothing old.
    expect(attentionView(loaded, u1p2)).toEqual({ loading: true });
    expect(attentionView(loaded, u2p1)).toEqual({ loading: true });
    expect(attentionView(loaded, undefined)).toEqual({ loading: false });
  });

  it("an error replaces the data; a cached hit replaces both", () => {
    const loaded = attentionReducer(initialAttention(u1p1, a), {
      type: "loading",
      key: u1p1,
    });
    const error = new Error("down");
    const failed = attentionReducer(loaded, {
      type: "failed",
      key: u1p1,
      error,
    });
    expect(attentionView(failed, u1p1)).toEqual({
      data: undefined,
      error,
      loading: false,
    });
    const hit = attentionReducer(failed, {
      type: "cached",
      key: u1p1,
      data: b,
    });
    expect(attentionView(hit, u1p1)).toEqual({
      data: b,
      error: undefined,
      loading: false,
    });
    // The same cached response again keeps the state object.
    expect(attentionReducer(hit, { type: "cached", key: u1p1, data: b })).toBe(
      hit,
    );
  });

  it("a cached hit of the shown data ends a reload", () => {
    const loaded = attentionReducer(initialAttention(u1p1, undefined), {
      type: "loaded",
      key: u1p1,
      data: a,
    });
    const reloading = attentionReducer(loaded, { type: "loading", key: u1p1 });
    const hit = attentionReducer(reloading, {
      type: "cached",
      key: u1p1,
      data: a,
    });
    expect(attentionView(hit, u1p1)).toEqual({
      data: a,
      error: undefined,
      loading: false,
    });
  });
});

describe("overflowBadge", () => {
  it("sums visible entries that are not on the bottom bar", () => {
    const counts = {
      operations: 1,
      "support-tickets": 2,
      "knowledge-sources": 3,
      gone: 9,
    };
    const visible = ["support-tickets", "operations", "knowledge-sources"];
    const bar = ["home", "support-tickets"];
    expect(
      overflowBadge({ counts, urgent: new Set(["operations"]) }, visible, bar),
    ).toEqual({ count: 4, urgent: true });
    expect(
      overflowBadge(
        { counts, urgent: new Set(["support-tickets"]) },
        visible,
        bar,
      ),
    ).toEqual({ count: 4, urgent: false });
    expect(
      overflowBadge({ counts: {}, urgent: new Set() }, visible, bar),
    ).toEqual({ count: 0, urgent: false });
  });

  it("the More button shows it in the urgent style with a mark", () => {
    const html = renderToStaticMarkup(
      <NavBadge count={4} urgent locale="de" />,
    );
    expect(html).toContain("nav-badge nav-badge-warning");
    expect(html).toContain('aria-hidden="true">!<');
    expect(html).toContain(" zu erledigen, dringend");
    expect(
      renderToStaticMarkup(<NavBadge count={4} urgent={false} locale="en" />),
    ).not.toContain(">!<");
  });
});
