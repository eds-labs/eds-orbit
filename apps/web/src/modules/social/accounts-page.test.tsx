import { describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => ({ value: "" }));
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

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
        error: found === undefined && path ? Object.assign(new Error("Not allowed"), { status: 403 }) : null,
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
import { AccountsSummaryView } from "./accounts";
import { SocialAccountsPage, socialReturnTarget } from "./accounts-page";

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;

function render(node: React.ReactNode, { locale = "en" as Locale, stage = "on" as "off" | "preview" | "on" } = {}) {
  const identity = {
    user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
    workspaces: [{ id: "w1", name: "Org", role: "owner" }],
    projects: [project],
    settingsCenter: stage,
  } as Identity;
  const shell = { hrefOf: () => "/p/p1/social/accounts", modules: [] } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
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

const accounts = {
  items: [
    { id: "a1", platform: "x", handle: "@orbit_hq", displayName: "Orbit HQ", status: "active", capability: "read_verified", connectedAt: "2026-11-02T10:00:00.000Z", disabledAt: null, lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: true }, version: 1 },
    { id: "a2", platform: "instagram", handle: "@orbit_ig", displayName: "Orbit IG", status: "reconnect_required", capability: "read_verified", connectedAt: "2026-11-02T10:00:00.000Z", disabledAt: null, lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: false }, version: 2 },
    { id: "a3", platform: "facebook", handle: "@old_page", displayName: "Old", status: "disabled", capability: "read_verified", connectedAt: "2026-11-02T10:00:00.000Z", disabledAt: "2026-11-05T09:30:00.000Z", lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: false }, version: 3 },
  ],
};
const center = "/manage/p/p1/integrations/social/accounts";

describe("social accounts page with the settings center", () => {
  it("forwards an OAuth result to the center only when the flag is on", () => {
    expect(socialReturnTarget("on", "p1", "?connected=2")).toBe(`${center}?connected=2`);
    expect(socialReturnTarget("on", "p1", "?error=SOCIAL_OAUTH_CANCELLED")).toBe(`${center}?error=SOCIAL_OAUTH_CANCELLED`);
    expect(socialReturnTarget("on", "p1", "")).toBeNull();
    expect(socialReturnTarget("on", "p1", "?other=1")).toBeNull();
    expect(socialReturnTarget("preview", "p1", "?connected=2")).toBeNull();
    expect(socialReturnTarget("off", "p1", "?connected=2")).toBeNull();
    expect(socialReturnTarget(undefined, "p1", "?connected=2")).toBeNull();
  });

  it("lists the live accounts with their state and no action, and links to the center", () => {
    const html = render(<AccountsSummaryView accounts={accounts.items as never} locale="en" manageHref={center} />);
    expect(html).toContain("@orbit_hq");
    expect(html).toContain(" · Orbit HQ");
    expect(html).toContain("Reconnect needed");
    expect(html).not.toContain("@old_page");
    expect(html).toContain("Accounts are connected, checked and disconnected in Administration &amp; settings.");
    expect(html).toContain(`href="${center}"`);
    expect(html).toContain("Manage accounts");
    expect(html).not.toMatch(/<button|<input|>Check<|>Disconnect<|Connect X/);
    const de = render(<AccountsSummaryView accounts={accounts.items as never} locale="de" manageHref={center} />, { locale: "de" });
    expect(de).toContain("Konten verwalten");
    expect(de).toContain("Konten werden in Verwaltung &amp; Einstellungen verbunden, geprüft und getrennt.");
  });

  it("renders the summary page with the flag on, the editor otherwise", () => {
    answers["/social/accounts"] = accounts;
    search.value = "";
    const on = render(<SocialAccountsPage />);
    expect(on).toContain(`href="${center}"`);
    expect(on).not.toMatch(/<button/);
    for (const stage of ["off", "preview"] as const) expect(render(<SocialAccountsPage />, { stage })).toContain("Connect X");
  });

  it("renders nothing while an OAuth result is forwarded, and never forwards with off or preview", () => {
    answers["/social/accounts"] = accounts;
    search.value = "?connected=2";
    expect(render(<SocialAccountsPage />)).toBe("");
    expect(render(<SocialAccountsPage />, { stage: "preview" })).toContain("Connect X");
    search.value = "";
  });

  it("shows the refusal instead of an empty list when the accounts cannot be read", () => {
    delete answers["/social/accounts"];
    const html = render(<SocialAccountsPage />);
    expect(html).toContain("Not allowed");
    expect(html).not.toContain("No account is connected yet.");
    answers["/social/accounts"] = accounts;
  });
});
