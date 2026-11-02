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
import { PostsView } from "./posts-view";
import { postMessage } from "../labels";

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
    { id: "a-x", platform: "x", handle: "@orbit_x", displayName: "X", status: "active", capability: "write_verified", connectedAt: "", lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: false }, version: 1 },
    { id: "a-tg", platform: "telegram", handle: "Orbit channel", displayName: "TG", status: "active", capability: "write_verified", connectedAt: "", lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: false }, version: 1 },
    { id: "a-ig", platform: "instagram", handle: "@orbit_ig", displayName: "IG", status: "reconnect_required", capability: "read_verified", connectedAt: "", lastCheckedAt: null, lastCheckCode: null, settings: { xLongPosts: false }, version: 1 },
  ],
};
const media = { items: [{ id: "m1", name: "banner.jpg", mime: "image/jpeg", width: 1600, height: 900, size: 1, jpegWidth: 1440, jpegHeight: 810, jpegSize: 1, altText: "Launch banner", version: 1, createdAt: "" }] };
const post = {
  id: "p1",
  status: "draft",
  title: "Launch",
  baseText: "We are live.",
  baseMedia: [{ mediaId: "m1", width: 1440, height: 810, altText: "Launch banner" }],
  schedule: { mode: "at", at: "2026-12-01T09:00:00.000Z", local: "2026-12-01T10:00", timeZone: "Europe/Berlin", fold: null },
  approval: { state: "none", requestId: null, approvedAt: null, approvedBy: null },
  packageHash: null,
  origin: "manual",
  readOnly: false,
  version: 3,
  createdAt: "",
  updatedAt: "",
  variants: [
    { id: "v1", accountId: "a-x", platform: "x", handle: "@orbit_x", body: "x".repeat(300), inheritsText: false, inheritsMedia: true, media: [{ mediaId: "m1", width: 1440, height: 810, altText: "Launch banner" }], options: {}, issues: [{ code: "SOCIAL_TEXT_TOO_LONG", severity: "error", path: "body" }], version: 1 },
    { id: "v2", accountId: "a-tg", platform: "telegram", handle: "Orbit channel", body: "We are live.", inheritsText: true, inheritsMedia: true, media: [{ mediaId: "m1", width: 1440, height: 810, altText: "Launch banner" }], options: {}, issues: [], version: 1 },
  ],
};
const list = {
  items: [
    { id: "p1", status: "needs_approval", title: "Launch", excerpt: "We are live.", schedule: post.schedule, approvalState: "pending", accounts: [{ accountId: "a-x", platform: "x", handle: "@orbit_x" }], version: 3, updatedAt: "" },
  ],
  nextCursor: null,
};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)];
const ids = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
const labelled = (html: string) => new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]));

describe("social posts view (ADR 0020, S4)", () => {
  const editor = (access: string, locale: Locale = "en") => {
    search.value = "post=p1";
    answers["/social/posts/p1"] = post;
    answers["/social/accounts"] = accounts;
    answers["/social/media"] = media;
    return render(<PostsView />, { access, locale });
  };

  it("lists posts with their status, approval and time, and offers a new post to writers", () => {
    search.value = "";
    answers["/social/posts"] = list;
    const html = render(<PostsView />, { access: "editor" });
    expect(html).toContain("Launch");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("@orbit_x");
    expect(html).toContain("Europe/Berlin");
    expect(html).toContain("New post");
    expect(html).toContain('href="?post=p1"');
    expect(render(<PostsView />, { access: "viewer" })).not.toContain("New post");
  });

  it("offers an owner to schedule and an editor to ask for approval", () => {
    const owner = editor("owner");
    expect(owner).toContain("Schedule");
    expect(owner).toContain("Publish now");
    expect(owner).not.toContain("Request approval");
    const writer = editor("editor");
    expect(writer).toContain("Request approval");
    expect(writer).toContain("Request publication");
    expect(writer).not.toMatch(/>Schedule</);
  });

  it("shows the accounts, a tab per selected account and the platform's issues", () => {
    const html = editor("editor");
    expect(html).toMatch(/role="tablist"/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"/);
    expect(html).toMatch(/role="tabpanel"/);
    expect(html).toContain("@orbit_x");
    expect(html).toContain("Orbit channel");
    // An account that needs reconnecting is listed but cannot be chosen.
    expect(html).toMatch(/<input[^>]*id="social-post-account-a-ig"[^>]*disabled=""/);
    expect(html).toContain("Reconnect needed");
    expect(html).toContain("X: 300 / 280");
    expect(html).toContain("The text is too long for this platform.");
    expect(html).toContain('alt="Launch banner"');
  });

  it("labels every control and names every button", () => {
    for (const html of [editor("editor"), editor("owner", "de")]) {
      for (const [, inner] of buttons(html)) expect(inner!.replace(/<[^>]+>/g, "").trim()).not.toBe("");
      const fields = [...html.matchAll(/<(input|textarea)[^>]*>/g)].map((m) => m[0]);
      const labels = labelled(html);
      for (const field of fields) {
        const id = / id="([^"]+)"/.exec(field)?.[1];
        const ok = Boolean(id && labels.has(id)) || /aria-label="/.test(field) || /type="checkbox"/.test(field);
        expect(ok, field).toBe(true);
      }
      expect(ids(html).size).toBeGreaterThan(0);
      expect(html).not.toMatch(/<input[^>]*\shidden[\s=>/]/);
    }
  });

  it("shows the planned time in the post's zone and speaks German", () => {
    const html = editor("editor", "de");
    expect(html).toContain('value="2026-12-01"');
    expect(html).toContain('value="10:00"');
    expect(html).toContain("Europe/Berlin");
    expect(html).toContain("Freigabe anfordern");
  });

  it("translates the post errors", () => {
    for (const code of ["SOCIAL_VALIDATION_FAILED", "SOCIAL_VERSION_CONFLICT", "SOCIAL_REAPPROVAL_REQUIRED", "SOCIAL_POST_NOT_EDITABLE", "SOCIAL_SCHEDULE_TOO_SOON"]) {
      expect(postMessage(code, "en")).not.toBe(postMessage("UNKNOWN", "en"));
      expect(postMessage(code, "de")).not.toBe(postMessage("UNKNOWN", "de"));
    }
  });
});
