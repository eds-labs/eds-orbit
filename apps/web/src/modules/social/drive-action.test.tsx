import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import type { DriveFile } from "@/platform/drive/api";
import { socialWeb } from "./manifest";
import { AddToSocialAction } from "./drive-action";
import { mediaMessage } from "./labels";

// Social's action on the Drive page (design 2026-11-05 §5.3): owners and
// editors copy a PNG, JPEG or WebP into the Social media library.

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "editor" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "editor" }],
  projects: [project],
};
const file = (mimeType: string): DriveFile => ({ id: "driveFile00001", name: "Banner", mimeType });

function render(f: DriveFile, { canEdit = true, locale = "en" as Locale } = {}) {
  return renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project,
        identity,
        locale,
        t: (k) => labels[locale][k],
        canEdit,
        isOwner: false,
        revision: 0,
        refresh: () => {},
        href: (p) => p,
      }}
    >
      <AddToSocialAction projectId="p1" file={f} folderId="rootFolder0001" onDone={() => {}} />
    </WorkspaceContext.Provider>,
  );
}

describe("Social Drive action", () => {
  it("offers PNG, JPEG and WebP to editors", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp"])
      expect(render(file(mime))).toContain("Add to Social media");
    expect(render(file("image/png"), { locale: "de" })).toContain("In Social-Mediathek übernehmen");
  });

  it("shows nothing to viewers or for other types", () => {
    expect(render(file("image/png"), { canEdit: false })).toBe("");
    for (const mime of ["video/mp4", "application/pdf", "image/gif", "image/svg+xml"])
      expect(render(file(mime))).toBe("");
  });

  it("contributes to the Drive page", () => {
    expect(socialWeb.drive?.fileActions).toContain(AddToSocialAction);
  });

  it("explains Drive errors", () => {
    expect(mediaMessage("GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED", "en")).toBe(
      "Google Drive is not set up for this project.",
    );
    expect(mediaMessage("GOOGLE_DRIVE_RECONNECT_REQUIRED", "de")).toContain("erneut verbinden");
  });
});
