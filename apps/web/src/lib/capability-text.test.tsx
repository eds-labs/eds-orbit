import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, type Locale } from "./i18n";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";

// WP5 (2026-11-10): the settings' capability list named capabilities by
// their key and printed live blockers as upper-case codes
// ("BLOG TARGET NOT CONFIGURED").

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/p/p1/settings",
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => ({
    data: path?.includes("/dashboard")
      ? {
          project: { mode: "observe", paused: false },
          readiness: {
            state: "draft_ready",
            blockers: [],
            capabilities: {
              knowledge: { state: "test_ready" },
              blog: {
                state: "draft_ready",
                liveBlocker: "BLOG_TARGET_NOT_CONFIGURED",
              },
              ads: {
                state: "draft_ready",
                liveBlocker: "ADS_ACCOUNT_SUSPENDED",
              },
            },
          },
        }
      : null,
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

import { capabilityLabel, liveBlockerText } from "./capability-text";
import { ProjectSettings } from "@/components/management";

function workspace(locale: Locale): WorkspaceContextValue {
  const project = {
    id: "p1",
    workspaceId: "w1",
    name: "Synthetic project",
    language: "de",
    timezone: "Europe/Berlin",
    mode: "observe",
    paused: false,
    generation: 1,
    role: "owner",
  } as WorkspaceContextValue["project"];
  return {
    project,
    identity: {
      user: { id: "u1", name: "Synthetic", email: "u@example.invalid" },
      projects: [project],
      workspaces: [{ id: "w1", name: "Synthetic org", role: "owner" }],
    } as unknown as WorkspaceContextValue["identity"],
    locale,
    t: (key) => translate(locale, key),
    canEdit: true,
    isOwner: true,
    revision: 0,
    refresh: () => {},
    href: (path) => path,
  };
}

describe("capability words", () => {
  it("names the readiness capabilities", () => {
    expect(capabilityLabel("de", "generation")).toBe("Inhaltserstellung");
    expect(capabilityLabel("en", "social")).toBe("Social media publishing");
    expect(capabilityLabel("de", "ads")).toBe("Anzeigen");
    expect(capabilityLabel("en", "video_studio")).toBe("Video studio");
  });

  it("explains a live blocker as a sentence, never in capitals", () => {
    expect(liveBlockerText("de", "BLOG_TARGET_NOT_CONFIGURED")).toBe(
      "Kein Blog-Ziel eingerichtet.",
    );
    expect(liveBlockerText("en", "MAIL_PROVIDER_NOT_CONFIGURED")).toBe(
      "No mail provider is configured.",
    );
    expect(liveBlockerText("en", "ADS_ACCOUNT_SUSPENDED")).toBe(
      "Ads account suspended.",
    );
  });
});

describe("project settings capability list", () => {
  it("shows German names, states and blocker sentences", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <ProjectSettings />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain("<strong>Wissen</strong>");
    expect(html).toContain("<strong>Blog</strong>");
    expect(html).toContain(
      '<p title="BLOG_TARGET_NOT_CONFIGURED">Kein Blog-Ziel eingerichtet.</p>',
    );
    expect(html).toContain(">Ads account suspended.</p>");
    expect(html).toContain("Bereit für Entwürfe");
    expect(html).not.toContain("BLOG TARGET NOT CONFIGURED");
    expect(html).not.toMatch(/>[A-Z]{3,}( [A-Z]+)+</);
  });
});
