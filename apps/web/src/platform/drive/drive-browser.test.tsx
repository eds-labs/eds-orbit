import { describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return {
        data: found instanceof Error ? null : (found ?? null),
        error: found instanceof Error ? found : null,
        loading: false,
        refresh: () => {},
        path,
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api";
import { DriveBrowser } from "./drive-browser";
import { driveFolderParam, formatDriveSize, type DriveFileActionProps } from "./api";

const listing = {
  folderId: "folderBBBB0001",
  rootName: "Root",
  path: [
    { id: "rootFolder0001", name: "Root" },
    { id: "folderAAAA0001", name: "A" },
    { id: "folderBBBB0001", name: "B" },
  ],
  nextPageToken: null,
  files: [
    { id: "folderCCCC0001", name: "Campaign", mimeType: "application/vnd.google-apps.folder" },
    { id: "imagePng000001", name: "Banner.png", mimeType: "image/png", size: "2048", modifiedTime: "2026-11-01T10:00:00.000Z" },
    { id: "videoMp4000001", name: "Clip.mp4", mimeType: "video/mp4", size: "5000000" },
  ],
};

const render = (props: Partial<Parameters<typeof DriveBrowser>[0]> = {}) =>
  renderToStaticMarkup(
    <DriveBrowser
      projectId="p1"
      folderId="folderBBBB0001"
      onFolderChange={() => {}}
      mode="browse"
      locale="en"
      {...props}
    />,
  );

describe("Drive browser", () => {
  it("shows the breadcrumb from the root to the open folder", () => {
    answers["/google-drive/files"] = listing;
    const html = render();
    expect(html).toContain('aria-label="Folder path"');
    expect(html).toMatch(/<button[^>]*>Root<\/button>/);
    expect(html).toMatch(/<button[^>]*>A<\/button>/);
    expect(html).toContain('aria-current="page">B<');
  });

  it("lists the folder as a table with name, type, size and date", () => {
    answers["/google-drive/files"] = listing;
    const html = render();
    expect(html).toContain("<table");
    expect(html).toContain("Banner.png");
    expect(html).toContain("PNG image");
    expect(html).toContain("2 KB");
    expect(html).toContain("Folder");
  });

  it("offers a choice for images and holds videos back in pick mode", () => {
    answers["/google-drive/files"] = listing;
    const html = render({ mode: "pick", onPick: () => {} });
    expect(html).toContain("Choose");
    expect(html).toContain("Videos later");
    expect(render({ mode: "pick", onPick: () => {}, locale: "de" })).toContain(
      "Videos folgen später",
    );
  });

  it("uses the caller's reason to hold an image back", () => {
    answers["/google-drive/files"] = listing;
    const html = render({
      mode: "pick",
      onPick: () => {},
      pickDisabled: (f) => (f.mimeType === "image/png" ? "At most ten images" : null),
    });
    expect(html).toContain("At most ten images");
  });

  it("renders contributed file actions for each file", () => {
    answers["/google-drive/files"] = listing;
    const Action = ({ file }: DriveFileActionProps) => <span>action:{file.name}</span>;
    const html = render({ fileActions: [Action] });
    expect(html).toContain("action:Banner.png");
    expect(html).toContain("action:Clip.mp4");
    expect(html).toContain("Open in Drive");
  });

  it("explains a folder outside the project folder", () => {
    answers["/google-drive/files"] = new ApiError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
    expect(render()).toContain("Folder not found in the project folder");
  });

  it("keeps the folder tree while the next folder loads", () => {
    delete answers["/google-drive/files"];
    const html = render({ root: { id: "rootFolder0001", name: "Root" } });
    expect(html).toContain('role="tree"');
    expect(html).toContain(">Root<");
  });

  it("explains a required reconnect while browsing", () => {
    answers["/google-drive/files"] = new ApiError("GOOGLE_DRIVE_RECONNECT_REQUIRED", 409);
    const html = render({ settingsHref: "/p/p1/settings?section=integrations" });
    expect(html).toContain("Google rejected the stored Drive access");
    expect(html).toContain('href="/p/p1/settings?section=integrations"');
    expect(html).not.toContain("GOOGLE DRIVE RECONNECT REQUIRED");
  });

  it("says in words when Google does not answer", () => {
    answers["/google-drive/files"] = new ApiError("GOOGLE_DRIVE_REQUEST_FAILED", 502);
    const html = render();
    expect(html).toContain("Google Drive did not answer. Try again.");
    expect(html).not.toContain("GOOGLE DRIVE REQUEST FAILED");
  });

  it("accepts only Drive ids as folder parameter", () => {
    expect(driveFolderParam("../x")).toBeNull();
    expect(driveFolderParam(null)).toBeNull();
    expect(driveFolderParam("folderAAAA0001")).toBe("folderAAAA0001");
  });

  it("formats sizes", () => {
    expect(formatDriveSize(undefined)).toBe("");
    expect(formatDriveSize("900")).toBe("900 B");
    expect(formatDriveSize("2048")).toBe("2 KB");
    expect(formatDriveSize("5000000")).toBe("4.8 MB");
  });
});
