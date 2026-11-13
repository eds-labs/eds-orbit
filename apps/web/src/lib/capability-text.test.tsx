import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, type Locale } from "./i18n";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";

// WP5 (2026-11-10): the settings' capability list named capabilities by
// their key and printed live blockers as upper-case codes
// ("BLOG TARGET NOT CONFIGURED").

const dashboard = {
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
} as unknown as Dashboard;

import { capabilityLabel, liveBlockerText } from "./capability-text";
import { ProjectReadinessPanel } from "@/components/management";
import type { Dashboard } from "@/lib/api";

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

describe("project readiness capability list", () => {
  it("shows German names, states and blocker sentences", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <ProjectReadinessPanel dashboard={dashboard} loading={false} />
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

  it("links the panel's connections and AI notes to their center sections", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={workspace("de")}>
        <ProjectReadinessPanel dashboard={dashboard} loading={false} />
      </WorkspaceContext.Provider>,
    );
    expect(html).toContain('href="/manage/p/p1/integrations/connections"');
    expect(html).toContain('href="/manage/p/p1/ai"');
  });
});
