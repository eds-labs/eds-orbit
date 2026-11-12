import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Every resource a view reads, by a part of its path; a path without an
// entry answers 404, as a route of a switched-off module does.
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

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { projectHref, routeTable } from "@/platform/shell/routes";
import type { SocialStatus } from "./api";
import { socialText } from "./labels";
import { SocialOverview } from "./overview";
import { SocialPlaceholder } from "./placeholder";

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

const status = (approval: SocialStatus["settings"]["approval"]): SocialStatus => ({
  module: "social",
  version: "0.1.0",
  settings: { approval, mcpOwnerPublishWithoutApproval: false, xMetrics: false },
  settingsVersion: 1,
});

describe("social module web (ADR 0020, S1)", () => {
  it("contributes the accounts page as an integration section for the API's account providers", () => {
    const module = webRegistry.modules.find((m) => m.id === "social")!;
    const accounts = module.views.find((v) => v.key === "social.accounts")!;
    expect(module.integrations).toHaveLength(1);
    const [section] = module.integrations!;
    expect(section).toMatchObject({
      id: "accounts",
      ownHead: true,
      label: { en: "Social accounts", de: "Social-Media-Konten" },
      description: {
        en: "Connect, check and disconnect the project's social media accounts.",
        de: "Social-Media-Konten des Projekts verbinden, prüfen und trennen.",
      },
    });
    // The same component as the module's own accounts page.
    expect(section.component).toBe(accounts.component);
    // The catalog ids are the account providers the API registers, read from its source.
    const api = readFileSync("apps/api/src/modules/social/accounts/providers.ts", "utf8");
    const ids = [...api.matchAll(/^\s*"(social\.account\.[a-z]+)":/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...section.providers!].sort()).toEqual([...ids].sort());
  });

  it("registers the opt-in module with its six views next to Marketing", () => {
    const module = webRegistry.modules.find((m) => m.id === "social")!;
    expect(module).toMatchObject({ optIn: true, groupOrder: 12, displayName: { en: "Social", de: "Social Media" } });
    expect(module.minAccess).toBeUndefined();
    expect(module.views.map((v) => [v.key, v.path])).toEqual([
      ["social", ""],
      ["social.calendar", "calendar"],
      ["social.posts", "posts"],
      ["social.media", "media"],
      ["social.accounts", "accounts"],
      ["social.analytics", "analytics"],
    ]);
  });

  it("names every view in English and German", () => {
    const module = webRegistry.modules.find((m) => m.id === "social")!;
    for (const view of module.views) {
      expect(view.nav?.label.en, view.key).toBeTruthy();
      expect(view.nav?.label.de, view.key).toBeTruthy();
    }
    expect(Object.keys(socialText("de").nav)).toEqual(Object.keys(socialText("en").nav));
  });

  it("shows the approval policy from the server", () => {
    answers["/social/status"] = status("owner_each");
    expect(render(<SocialOverview />)).toContain("The owner approves every post");
    expect(render(<SocialOverview />, { locale: "de" })).toContain("Der Owner gibt jeden Beitrag frei");
    answers["/social/status"] = status("editor_each");
    expect(render(<SocialOverview />)).toContain("Editors with approval rights approve posts");
  });

  it("shows a load error instead of a policy while the status fails", () => {
    for (const key of Object.keys(answers)) delete answers[key];
    const html = render(<SocialOverview />);
    expect(html).not.toContain("approves every post");
  });

  it("marks the views of later phases as not yet available", () => {
    expect(render(<SocialPlaceholder />)).toContain("Coming in a later phase");
    expect(render(<SocialPlaceholder />, { locale: "de" })).toContain("Folgt in einer späteren Phase");
  });
});
