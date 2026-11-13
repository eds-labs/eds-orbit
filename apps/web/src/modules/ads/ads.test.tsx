import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
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
import type { AdsStatus } from "./api";
import { adsText } from "./labels";

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
    modules: [{ id: "ads", access, enabled: true, nav: [], displayName: { en: "", de: "" }, description: { en: "", de: "" } }],
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

const status: AdsStatus = {
  module: "ads",
  version: "0.1.0",
  settings: {
    decider: "owner",
    autoPauseAtLimit: false,
    utmTemplate: null,
    reportDay: "monday",
    backfillDays: 90,
    insightsRetentionMonths: 25,
  },
  settingsVersion: 1,
};

const module = () => webRegistry.modules.find((m) => m.id === "ads")!;
const Overview = () => {
  const C = module().views[0]!.component!;
  return <C />;
};
const BLOCKED = /(^|[-_])(ad|ads|advert|banner|sponsor)([-_]|$)/i;

describe("ads module web (ADR 0025, A1)", () => {
  it("registers the opt-in editor-only module with its six views after Social", () => {
    expect(module()).toMatchObject({
      optIn: true,
      minAccess: "editor",
      groupOrder: 13,
      displayName: { en: "Ads", de: "Werbung" },
    });
    expect(module().views.map((v) => [v.key, v.path])).toEqual([
      ["ads", ""],
      ["ads.campaigns", "campaigns"],
      ["ads.units", "units"],
      ["ads.creatives", "creatives"],
      ["ads.performance", "performance"],
      ["ads.accounts", "accounts"],
    ]);
  });

  it("names every view in English and German", () => {
    for (const view of module().views) {
      expect(view.nav?.label.en, view.key).toBeTruthy();
      expect(view.nav?.label.de, view.key).toBeTruthy();
    }
    expect(Object.keys(adsText("de").nav)).toEqual(Object.keys(adsText("en").nav));
    expect(Object.keys(adsText("de"))).toEqual(Object.keys(adsText("en")));
  });

  it("shows the decider and the empty account state", () => {
    answers["/ads/status"] = status;
    const en = render(<Overview />);
    expect(en).toContain("Spend decisions: owner only");
    expect(en).toContain("No ad account connected yet");
    const de = render(<Overview />, { locale: "de" });
    expect(de).toContain("Ausgaben entscheidet nur der Owner");
    expect(de).toContain("Noch kein Werbekonto verbunden");
  });

  it("shows a load error instead of the overview while the status fails", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    expect(render(<Overview />)).not.toContain("owner only");
  });

  it("renders every view without blocker-prone ids or classes and names interactive elements", () => {
    answers["/ads/status"] = status;
    for (const view of module().views) {
      const View = view.component!;
      for (const locale of ["en", "de"] as const) {
        const html = render(<View />, { locale });
        for (const m of html.matchAll(/\s(id|class)="([^"]*)"/g)) {
          for (const token of m[2]!.split(/\s+/).filter(Boolean)) {
            expect(token, `${view.key} ${token}`).not.toMatch(BLOCKED);
          }
        }
        for (const m of html.matchAll(/<(a|button|input|select|textarea)\b([^>]*)>([\s\S]*?)(?=<\/\1>|$)/g)) {
          const label = /aria-label="[^"]+"/.test(m[2]!) || m[3]!.replace(/<[^>]*>/g, "").trim().length > 0;
          expect(label, `${view.key} <${m[1]}>`).toBe(true);
        }
      }
    }
  });
});
