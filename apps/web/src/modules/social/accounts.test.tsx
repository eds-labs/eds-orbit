import { describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

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
import { webRegistry } from "@/modules/registry";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import { AccountsView, TelegramChannelForm } from "./accounts";
import { accountMessage } from "./labels";
import { socialAttention } from "./attention";

const table = routeTable(webRegistry);
const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};

function render(node: React.ReactNode, { locale = "en" as Locale, access = "owner" } = {}) {
  const shell = {
    hrefOf: (key: string) => projectHref(project.id, table.routes.find((r) => r.key === key)!),
    modules: [{ id: "social", access, enabled: true, nav: [], displayName: { en: "", de: "" }, description: { en: "", de: "" } }],
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

const accounts = {
  items: [
    { id: "a1", platform: "x", handle: "@orbit_hq", displayName: "Orbit HQ", status: "active", capability: "read_verified", connectedAt: "2026-11-02T10:00:00.000Z", lastCheckedAt: null, lastCheckCode: null, version: 1 },
    { id: "a2", platform: "instagram", handle: "@orbit_ig", displayName: "Orbit IG", status: "reconnect_required", capability: "read_verified", connectedAt: "2026-11-02T10:00:00.000Z", lastCheckedAt: "2026-11-02T11:00:00.000Z", lastCheckCode: "SOCIAL_META_TOKEN_INVALID", version: 2 },
  ],
};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)];

describe("social accounts view (ADR 0020, S2)", () => {
  it("shows the accounts with their status to a viewer, without any action", () => {
    answers["/social/accounts"] = accounts;
    search.value = "";
    const html = render(<AccountsView />, { access: "viewer" });
    expect(html).toContain("@orbit_hq");
    expect(html).toContain("@orbit_ig");
    expect(html).toContain("Reconnect needed");
    expect(buttons(html)).toHaveLength(0);
  });

  it("offers the owner the three ways to connect and the account actions", () => {
    answers["/social/accounts"] = accounts;
    const html = render(<AccountsView />);
    for (const text of ["Connect X", "Connect Facebook and Instagram", "Add Telegram channel", "Check", "Disconnect"])
      expect(html).toContain(text);
  });

  it("names every button", () => {
    answers["/social/accounts"] = accounts;
    for (const [, inner] of buttons(render(<AccountsView />))) expect(inner!.replace(/<[^>]+>/g, "").trim()).not.toBe("");
  });

  it("explains that Meta posts stay private until the Meta app is live", () => {
    answers["/social/accounts"] = accounts;
    expect(render(<AccountsView />)).toContain("only members of the Meta app see posts");
    expect(render(<AccountsView />, { locale: "de" })).toContain("nur Mitglieder der Meta-App");
  });

  it("shows the outcome of a connection from the callback", () => {
    answers["/social/accounts"] = accounts;
    search.value = "connected=3";
    expect(render(<AccountsView />)).toContain("3 accounts connected");
    search.value = "error=SOCIAL_OAUTH_CANCELLED";
    expect(render(<AccountsView />)).toContain("The connection was cancelled");
    search.value = "error=SOMETHING_ELSE";
    expect(render(<AccountsView />)).toContain("The account could not be connected");
    search.value = "";
  });

  it("translates the error codes in English and German", () => {
    for (const code of [
      "SOCIAL_OAUTH_STATE_INVALID",
      "SOCIAL_OAUTH_CANCELLED",
      "SOCIAL_APP_NOT_GRANTED",
      "SOCIAL_META_NO_PAGES",
      "SOCIAL_TELEGRAM_OWNER_BOT",
      "SOCIAL_TELEGRAM_BOT_CANNOT_POST",
      "SOCIAL_TELEGRAM_NOT_A_CHANNEL",
      "SOCIAL_PROVIDER_REJECTED",
      "SOCIAL_PROVIDER_UNAVAILABLE",
    ]) {
      expect(accountMessage(code, "en")).not.toBe(accountMessage("UNKNOWN", "en"));
      expect(accountMessage(code, "de")).not.toBe(accountMessage("UNKNOWN", "de"));
    }
  });

  it("asks for the bot token as a password that is never autofilled", () => {
    const html = render(<TelegramChannelForm onDone={() => {}} />);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="off"|<input[^>]*autoComplete="off"[^>]*type="password"/i);
    expect(html).toContain("Channel (@name or id)");
  });

  it("renders the reconnect attention item", () => {
    const text = socialAttention.social_account_reconnect!({ count: 2 } as never, "en");
    expect(text.title).toBe("2 social accounts need to be reconnected");
  });
});
