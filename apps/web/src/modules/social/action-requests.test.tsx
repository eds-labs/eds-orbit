import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { socialActionRequests } from "./action-requests";

// The owner's view of a social post request in Decisions (ADR 0020, S4):
// exactly the content and time the approval covers.

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const item = (mode: "at" | "now") => ({
  id: "r1",
  actionType: mode === "at" ? "social.post.schedule" : "social.post.publish_now",
  summary: {
    operation: {
      kind: "social_post",
      mode,
      at: mode === "at" ? "2026-12-01T09:00:00.000Z" : null,
      local: mode === "at" ? "2026-12-01T10:00" : null,
      timeZone: "Europe/Berlin",
      variants: [
        { accountId: "a1", platform: "x", handle: "@orbit_x", body: "Live on X.\nSecond line", media: [] },
        { accountId: "a2", platform: "telegram", handle: "Orbit channel", body: "We are live.", media: [{ mediaId: "m1", width: 1440, height: 810, altText: "Launch banner" }] },
      ],
    },
  },
});
function render(type: string, value: ReturnType<typeof item>, de = false) {
  const Renderer = socialActionRequests[type]!.component;
  const locale = de ? "de" : "en";
  return renderToStaticMarkup(
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
      <Renderer item={value} de={de} pending={false} decide={() => {}} />
    </WorkspaceContext.Provider>,
  );
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());

describe("social approval renderers", () => {
  it("shows the time, every account's text and images, and the two decisions", () => {
    const html = render("social.post.schedule", item("at"));
    expect(html).toContain("Schedule a social post");
    expect(html).toContain("2026-12-01 10:00 (Europe/Berlin)");
    expect(html).toContain("@orbit_x");
    expect(html).toContain("Orbit channel");
    expect(html).toContain("Live on X.\nSecond line");
    expect(html).toContain('src="/api/projects/p1/social/media/m1/content?rendition=jpeg"');
    expect(html).toContain('alt="Launch banner"');
    expect(html).toContain("Approval applies exactly this content and time once.");
    expect(buttons(html)).toEqual(["Approve", "Reject"]);
  });

  it("names an immediate publication and speaks German", () => {
    const html = render("social.post.publish_now", item("now"), true);
    expect(html).toContain("Social-Beitrag sofort veröffentlichen");
    expect(html).toContain("Die Freigabe gilt genau für diesen Inhalt und diese Zeit.");
    expect(buttons(html)).toEqual(["Freigeben", "Ablehnen"]);
  });

  it("shows the exact test text of a write verification and that it posts publicly", () => {
    const verify = { id: "r2", actionType: "social.account.verify_write", summary: { operation: { kind: "social_verify_write", platform: "telegram", handle: "@orbit_news", text: "Orbit connection test" } } };
    const html = render("social.account.verify_write", verify as never);
    expect(html).toContain("Test posting on @orbit_news");
    expect(html).toContain("Orbit connection test");
    expect(html).toContain("This posts publicly");
    expect(buttons(html)).toEqual(["Approve", "Reject"]);
    expect(socialActionRequests["social.account.verify_write"]!.accepts(item("at"))).toBe(false);
  });

  it("leaves other requests to the generic view", () => {
    expect(socialActionRequests["social.post.schedule"]!.accepts({ summary: { operation: { kind: "tasks" } } })).toBe(false);
    expect(socialActionRequests["social.post.schedule"]!.accepts(item("at"))).toBe(true);
  });
});
