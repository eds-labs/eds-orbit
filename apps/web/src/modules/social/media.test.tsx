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
import { mediaHints, MediaView } from "./media";
import { mediaMessage } from "./labels";

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

const item = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "banner.png",
  mime: "image/png",
  width: 1600,
  height: 1200,
  size: 2_000_000,
  jpegWidth: 1440,
  jpegHeight: 1080,
  jpegSize: 400_000,
  altText: "Launch banner",
  version: 1,
  createdAt: "2026-11-02T10:00:00.000Z",
  ...over,
});
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)];

describe("social media library view (ADR 0020, S3)", () => {
  it("shows the images to a viewer without upload or removal", () => {
    answers["/social/media"] = { items: [item()] };
    const html = render(<MediaView />, { access: "viewer" });
    expect(html).toContain("banner.png");
    expect(html).toContain(`src="/api/projects/p1/social/media/m1/content?rendition=jpeg"`);
    expect(html).toContain(`alt="Launch banner"`);
    expect(html).not.toContain("Upload image");
    expect(buttons(html)).toHaveLength(0);
  });

  it("offers editors the upload and the image actions", () => {
    answers["/social/media"] = { items: [item()] };
    const html = render(<MediaView />, { access: "editor" });
    expect(html).toContain("Upload image");
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    // The file input stays reachable by keyboard: visually hidden, not `hidden`.
    const input = html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('class="sr-only"');
    expect(input).not.toMatch(/\shidden(=|\s|>|\/)/);
    expect(html).toContain('class="button button-primary media-upload"');
    for (const text of ["Save description", "Remove"]) expect(html).toContain(text);
    for (const [, inner] of buttons(html)) expect(inner!.replace(/<[^>]+>/g, "").trim()).not.toBe("");
  });

  it("warns about platforms an image does not fit", () => {
    expect(mediaHints(item({ jpegWidth: 720, jpegHeight: 1440 }), "en")).toEqual([
      "Instagram: aspect ratio outside 4:5 to 1.91:1",
    ]);
    expect(mediaHints(item({ size: 6 * 1024 * 1024, jpegSize: 6 * 1024 * 1024 }), "de")).toEqual(["X: größer als 5 MB"]);
    expect(mediaHints(item(), "en")).toEqual([]);
    answers["/social/media"] = { items: [item({ jpegWidth: 720, jpegHeight: 1440 })] };
    expect(render(<MediaView />)).toContain("Instagram: aspect ratio outside 4:5 to 1.91:1");
  });

  it("translates the upload errors", () => {
    for (const code of ["SOCIAL_MEDIA_BUSY", "SOCIAL_MEDIA_INVALID", "SOCIAL_MEDIA_TYPE", "SOCIAL_VIDEO_NOT_AVAILABLE", "FILE_TOO_LARGE", "FILES_QUOTA_EXCEEDED", "FILES_NOT_CONFIGURED"]) {
      expect(mediaMessage(code, "en")).not.toBe(mediaMessage("UNKNOWN", "en"));
      expect(mediaMessage(code, "de")).not.toBe(mediaMessage("UNKNOWN", "de"));
    }
  });

  it("shows an empty library", () => {
    answers["/social/media"] = { items: [] };
    expect(render(<MediaView />)).toContain("No images yet.");
  });
});
