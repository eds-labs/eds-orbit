import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/p1/drive",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const answers = vi.hoisted(() => ({ status: null as unknown, files: null as unknown }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  const pick = (value: unknown) => ({
    data: value instanceof Error ? null : (value ?? null),
    error: value instanceof Error ? value : null,
  });
  return {
    ...actual,
    useResource: (path: string | null) => ({
      ...(path?.endsWith("/google-drive")
        ? pick(answers.status)
        : path?.includes("/google-drive/files")
          ? pick(answers.files)
          : pick(undefined)),
      loading: false,
      refresh: () => {},
      path,
    }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { navigationForFeatures, projectHref, routeTable } from "@/platform/shell/routes";
import { shellLinks } from "@/platform/shell/shell-links";
import { GoogleDriveSettings } from "@/components/google-drive";
import { DrivePage } from "./drive-page";
import type { DriveStatus, DriveToolbarProps } from "./api";

const table = routeTable(webRegistry);
const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const status = (over: Partial<DriveStatus> = {}): DriveStatus => ({
  configured: true,
  connected: true,
  reconnectRequired: false,
  lastRefreshFailedAt: null,
  lastRefreshErrorCode: null,
  account: "ada@example.invalid",
  rootFolderId: "rootFolder0001",
  brandLogoFolderId: null,
  brandImagesFolderId: null,
  enabled: true,
  scope: "https://www.googleapis.com/auth/drive",
  ...over,
});
const listing = {
  folderId: "rootFolder0001",
  rootName: "Root",
  path: [{ id: "rootFolder0001", name: "Root" }],
  nextPageToken: null,
  files: [{ id: "imagePng000001", name: "Banner.png", mimeType: "image/png", size: "2048" }],
};
const Upload = (_: DriveToolbarProps) => <span>toolbar-upload</span>;

function render(node: React.ReactNode, { locale = "en" as Locale, owner = true } = {}) {
  const hrefOf = (key: string) => projectHref(project.id, table.routes.find((r) => r.key === key)!);
  const shell = {
    hrefOf,
    ...shellLinks({ stage: undefined, projectId: project.id, hrefOf, map: (h) => h }),
    modules: [],
    drive: { fileActions: [], toolbar: [Upload] },
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: true,
          isOwner: owner,
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

describe("Drive page", () => {
  it("shows the browser and the contributed toolbar when Drive is set up", () => {
    nav.search = "";
    answers.status = status();
    answers.files = listing;
    const html = render(<DrivePage />);
    expect(html).toContain("<h1>Google Drive</h1>");
    expect(html).toContain("Banner.png");
    expect(html).toContain("toolbar-upload");
  });

  it("sends an owner to the Drive settings when Drive is not set up", () => {
    nav.search = "";
    answers.status = status({ enabled: false, connected: false });
    const html = render(<DrivePage />);
    expect(html).toContain("Google Drive is not set up for this project");
    expect(html).toContain('href="/p/p1/settings?section=integrations"');
  });

  it("asks a member without ownership to contact an owner", () => {
    nav.search = "";
    answers.status = status({ enabled: false, connected: false });
    const html = render(<DrivePage />, { owner: false });
    expect(html).toContain("Ask a project owner to connect Google Drive.");
    expect(html).not.toContain("section=integrations");
  });

  it("explains a required reconnect", () => {
    nav.search = "";
    answers.status = status({ reconnectRequired: true, lastRefreshErrorCode: "invalid_grant" });
    answers.files = listing;
    const html = render(<DrivePage />);
    expect(html).toContain("Google rejected the stored Drive access");
    expect(html).toContain("invalid_grant");
  });

  it("falls back to the project folder for a malformed folder link", () => {
    nav.search = "folder=../etc";
    answers.status = status();
    answers.files = listing;
    const html = render(<DrivePage />);
    expect(html).toContain("Folder not found in the project folder");
    expect(html).toContain("Banner.png");
  });
});

describe("Drive page route", () => {
  it("is a project page shown only while Drive is set up", () => {
    const route = table.routes.find((r) => r.key === "drive")!;
    expect([route.moduleId, route.segments, route.navGroup]).toEqual([null, ["drive"], "project"]);
    expect(navigationForFeatures(table.routes, {}).some((r) => r.key === "drive")).toBe(false);
    expect(navigationForFeatures(table.routes, { googleDrive: true }).some((r) => r.key === "drive")).toBe(true);
  });
});

describe("Drive settings card", () => {
  it("links to the Drive page and lists no files", () => {
    nav.search = "";
    answers.status = status();
    answers.files = listing;
    const html = render(<GoogleDriveSettings />);
    expect(html).toContain('href="/p/p1/drive"');
    expect(html).not.toContain("Banner.png");
  });
});
