import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import type { DriveFile } from "@/platform/drive/api";
import { marketingWeb } from "../manifest";
import { AddToLibraryAction, UploadToDriveToolbar } from "./drive-actions";

// Marketing's actions on the Drive page (design 2026-11-05 §5.3): import a
// file as a brand asset and upload an image to Drive, both owner-only.

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const image: DriveFile = { id: "imagePng000001", name: "Logo.png", mimeType: "image/png" };
const folder: DriveFile = { id: "folderAAAA0001", name: "A", mimeType: "application/vnd.google-apps.folder" };

function render(node: React.ReactNode, owner = true) {
  return renderToStaticMarkup(
    <ShellContext.Provider value={{ features: {} } as unknown as ShellContextValue}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale: "en",
          t: (k) => labels.en[k],
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

describe("Marketing Drive actions", () => {
  it("lets an owner add an image to the library with an asset type", () => {
    const html = render(<AddToLibraryAction projectId="p1" file={image} folderId="rootFolder0001" onDone={() => {}} />);
    expect(html).toContain('aria-label="Asset type for Logo.png"');
    expect(html).toContain("Add to library");
  });

  it("shows nothing to an editor or for a folder", () => {
    expect(render(<AddToLibraryAction projectId="p1" file={image} folderId="r" onDone={() => {}} />, false)).toBe("");
    expect(render(<AddToLibraryAction projectId="p1" file={folder} folderId="r" onDone={() => {}} />)).toBe("");
  });

  it("offers the upload to owners only", () => {
    expect(render(<UploadToDriveToolbar projectId="p1" folderId="r" onDone={() => {}} />)).toContain("Upload to Drive");
    expect(render(<UploadToDriveToolbar projectId="p1" folderId="r" onDone={() => {}} />, false)).toBe("");
  });

  it("contributes both to the Drive page", () => {
    expect(marketingWeb.drive?.fileActions).toContain(AddToLibraryAction);
    expect(marketingWeb.drive?.toolbar).toContain(UploadToDriveToolbar);
  });
});
