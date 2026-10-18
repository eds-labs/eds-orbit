import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups } from "./nav-groups";
import { projectHref, routeTable, type Route } from "./routes";
import { SidebarNav } from "./sidebar-nav";

const table = routeTable(webRegistry);
const groups = buildNavGroups(
  table.routes,
  webRegistry.modules.map((m) => ({ ...m, enabled: true })),
);
const hrefOf = (r: Route) => projectHref("p1", r);
const href = (key: string) =>
  `href="${hrefOf(table.routes.find((r) => r.key === key)!)}"`;

function render(
  options: {
    collapsed?: string[];
    activeKey?: string;
    badges?: Record<string, number>;
    locale?: "en" | "de";
  } = {},
) {
  return renderToStaticMarkup(
    <SidebarNav
      groups={groups}
      activeKey={options.activeKey}
      hrefOf={hrefOf}
      badges={options.badges}
      locale={options.locale ?? "en"}
      collapsed={new Set(options.collapsed ?? [])}
      onToggle={() => {}}
    />,
  );
}

/** The header button of a group, with its content. */
function head(html: string, id: string) {
  return new RegExp(
    `<button[^>]*aria-controls="nav-group-${id}"[^>]*>.*?</button>`,
  ).exec(html)?.[0];
}

describe("SidebarNav", () => {
  it("renders every group open, top without a header, with section labels", () => {
    const html = render({ locale: "de" });
    expect(head(html, "top")).toBeUndefined();
    for (const id of ["marketing", "support", "knowledge", "project"]) {
      expect(head(html, id), id).toContain('aria-expanded="true"');
      expect(head(html, id), id).toContain('type="button"');
      expect(html, id).toContain(`id="nav-group-${id}"`);
    }
    for (const route of groups.flatMap((g) => g.entries))
      expect(html, route.key).toContain(href(route.key));
    // "Module" before the first module group, "Projekt" before project.
    const modules = html.indexOf(">Module<");
    const project = html.indexOf(">Projekt<");
    expect(modules).toBeGreaterThan(html.indexOf(href("chat")));
    expect(modules).toBeLessThan(
      html.indexOf('aria-controls="nav-group-marketing"'),
    );
    expect(project).toBeGreaterThan(html.indexOf(href("knowledge")));
    expect(project).toBeLessThan(
      html.indexOf('aria-controls="nav-group-project"'),
    );
  });

  it("does not render the entries of a collapsed group", () => {
    const html = render({ collapsed: ["support"] });
    expect(head(html, "support")).toContain('aria-expanded="false"');
    expect(html).not.toContain(href("support-contacts"));
    expect(html).toContain(href("missions"));
  });

  it("marks the active entry and lets its group collapse", () => {
    const open = render({ activeKey: "missions", locale: "de" });
    expect(open).toContain(">Missionen<");
    expect(
      new RegExp(`<a[^>]*${href("missions")}[^>]*>`).exec(open)?.[0],
    ).toContain('aria-current="page"');
    // The shell reopens it on navigation (revealGroup); a click may close it.
    const closed = render({ collapsed: ["marketing"], activeKey: "missions" });
    expect(head(closed, "marketing")).toContain('aria-expanded="false"');
    expect(closed).not.toContain(href("missions"));
  });

  it("toggles a group from its header", () => {
    const onToggle = vi.fn();
    const tree = SidebarNav({
      groups,
      activeKey: "support",
      hrefOf,
      locale: "en",
      collapsed: new Set(),
      onToggle,
    });
    const buttons: Array<{ props: Record<string, any> }> = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement<Record<string, any>>(node)) return;
      if (node.type === "button") buttons.push(node);
      walk(node.props.children);
    };
    walk(tree);
    const support = buttons.find(
      (b) => b.props["aria-controls"] === "nav-group-support",
    )!;
    support.props.onClick();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("support");
  });

  it("sums badges of a collapsed group", () => {
    const badges = { approvals: 3, content: 2 };
    const collapsed = render({
      collapsed: ["marketing"],
      badges,
      locale: "de",
    });
    const header = head(collapsed, "marketing")!;
    expect(header).toContain(">5<");
    expect(header).toContain(" offen");
    expect(collapsed).not.toContain(href("approvals"));
    // Open, the header has no sum and every entry shows its own badge.
    const open = render({ badges });
    expect(head(open, "marketing")).not.toContain("nav-badge");
    expect(open).toMatch(
      new RegExp(`${href("approvals")}.*?nav-badge[^>]*>3<.*? open`),
    );
  });

  it("an unknown stored id is harmless", () => {
    const html = render({ collapsed: ["gone"] });
    for (const id of ["marketing", "support", "knowledge", "project"])
      expect(head(html, id), id).toContain('aria-expanded="true"');
  });
});
