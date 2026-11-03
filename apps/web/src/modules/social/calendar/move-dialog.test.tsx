import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

const search = vi.hoisted(() => ({ value: "" }));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers).sort((a, b) => b.length - a.length).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return { data: found ?? null, error: null, loading: false, refresh: () => {}, path };
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
import type { CalendarItem } from "../api";
import { CalendarView } from "./calendar-view";
import { MoveDialog, moveError } from "./move-dialog";
import { moveFlow } from "./move";

// Moving posts in the calendar (S6, S-D6): which confirmation a move needs,
// the dialog for "Move to…", drag handles only on movable posts, and what a
// refused move shows.

const table = routeTable(webRegistry);
const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = { user: { id: "u1", name: "Ada", email: "ada@example.invalid" }, workspaces: [{ id: "w1", name: "Org" }], projects: [project] };

function render(node: React.ReactNode, { locale = "en" as Locale, access = "owner" } = {}) {
  const shell = {
    table,
    hrefOf: (key: string) => projectHref(project.id, table.routes.find((r) => r.key === key)!),
    modules: [{ id: "social", access, enabled: true, nav: [], displayName: { en: "", de: "" }, description: { en: "", de: "" } }],
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{ project, identity, locale, t: (k) => labels[locale][k], canEdit: access !== "viewer", isOwner: access === "owner", revision: 0, refresh: () => {}, href: (p) => p }}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const item = (over: Partial<CalendarItem> = {}): CalendarItem => ({
  id: "c1",
  projectId: "p1",
  title: "Launch",
  excerpt: "",
  status: "scheduled",
  origin: "manual",
  readOnly: false,
  schedule: { mode: "at", at: "2026-11-10T09:15:00.000Z", local: "2026-11-10T10:15", timeZone: "Europe/Berlin", fold: null },
  approvalState: "approved",
  version: 2,
  accounts: [{ accountId: "a-x", platform: "x", handle: "@orbit_x" }],
  publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
  ...over,
});
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, inner]) => `${attrs} ${inner!.replace(/<[^>]+>/g, "")}`);

describe("moveFlow", () => {
  it("asks for a confirmation only when the approval changes", () => {
    expect(moveFlow({ kind: "free" })).toBeNull();
    expect(moveFlow({ kind: "reapprove" })).toBe("confirmReapprove");
    expect(moveFlow({ kind: "request" })).toBe("confirmRequest");
    expect(moveFlow({ kind: "forbidden", reason: "status" })).toBeNull();
  });
});

describe("moveError", () => {
  it("offers the two times of the repeated hour and the time after a gap", () => {
    const twice = moveError("SOCIAL_SCHEDULE_TIME_AMBIGUOUS", { earlier: "2026-10-25T00:30:00.000Z", later: "2026-10-25T01:30:00.000Z" }, "2026-10-25T02:30", "en");
    expect(twice.kind).toBe("choices");
    expect(twice.kind === "choices" && twice.view.choices?.map((c) => c.fold)).toEqual(["earlier", "later"]);
    const gap = moveError("SOCIAL_SCHEDULE_TIME_GAP", { suggestedLocal: "2027-03-28T03:00" }, "2027-03-28T02:30", "en");
    expect(gap.kind === "choices" && gap.view.choices?.[0]?.local).toBe("2027-03-28T03:00");
  });

  it("turns a stale calendar into the conflict notice and other codes into their message", () => {
    expect(moveError("SOCIAL_VERSION_CONFLICT", null, "2026-11-20T10:15", "en")).toEqual({ kind: "conflict", message: "Someone changed this post in the meantime. The calendar was reloaded; try again." });
    expect(moveError("SOCIAL_SCHEDULE_TOO_SOON", null, "2026-11-20T10:15", "en")).toEqual({ kind: "message", message: "Choose a time at least two minutes from now." });
  });
});

describe("MoveDialog", () => {
  const dialog = (access: string, over: Partial<CalendarItem> = {}, locale: Locale = "en") =>
    render(<MoveDialog item={item(over)} target={{ local: "2026-11-20T18:30" }} onClose={() => {}} onDone={() => {}} />, { access, locale });

  it("has labelled date and time fields in the project's zone and named buttons", () => {
    const html = dialog("owner", { status: "draft", approvalState: "none" });
    expect(html).toMatch(/<label[^>]*for="social-post-date"/);
    expect(html).toMatch(/<input[^>]*id="social-post-date"[^>]*value="2026-11-20"/);
    expect(html).toMatch(/<input[^>]*id="social-post-time"[^>]*value="18:30"/);
    expect(html).toContain("Europe/Berlin");
    expect(html).not.toContain("approves the new time");
    for (const b of buttons(html)) expect(b).toMatch(/aria-label="[^"]+"|\S\s*$/);
    expect(buttons(html).some((b) => b.endsWith("Move"))).toBe(true);
  });

  it("tells an owner the move approves the new time and an editor that it goes back to approval", () => {
    const owner = dialog("owner");
    expect(owner).toContain("Moving an approved post approves the new time.");
    expect(owner).toContain("Move and approve");
    const editor = dialog("editor");
    expect(editor).toContain("The post goes back to approval");
    expect(editor).toContain("Move and request approval");
    expect(dialog("owner", {}, "de")).toContain("Verschieben und freigeben");
  });
});

describe("drag handles", () => {
  const month = (items: CalendarItem[], access = "owner") => {
    search.value = "anchor=2026-11-03";
    answers["/social/calendar"] = { items, truncated: false };
    answers["/social/accounts"] = { items: [] };
    return render(<CalendarView />, { access });
  };

  it("gives movable posts a described handle and others none", () => {
    const html = month([item(), item({ id: "c2", title: "Done", status: "published" })]);
    expect(html.match(/aria-roledescription="[^"]+"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-roledescription="movable post"[^>]*aria-describedby="[^"]+"[^>]*aria-label="Move Launch"|<button[^>]*aria-label="Move Launch"[^>]*aria-roledescription="movable post"/);
    expect(month([item()], "viewer")).not.toContain("aria-roledescription");
  });
});
