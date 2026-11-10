import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DriveFile } from "@/platform/drive/api";
import { drivePickBlock, MediaPicker } from "./media-picker";

// Drive images in the composer (Drive page design 2026-11-05 §5.5): a
// "Google Drive" tab next to the library while Drive is set up.

const file = (mimeType: string): DriveFile => ({ id: "driveFile00001", name: "Banner", mimeType });
const picker = (driveEnabled: boolean) =>
  renderToStaticMarkup(
    <MediaPicker
      projectId="p1"
      target="base"
      legend="Images"
      library={[]}
      selected={[]}
      locale="en"
      onChange={() => {}}
      driveEnabled={driveEnabled}
      onImported={() => {}}
    />,
  );

describe("media picker with Google Drive", () => {
  it("shows library and Drive tabs while Drive is set up", () => {
    const html = picker(true);
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Library<");
    expect(html).toContain(">Google Drive<");
  });

  it("shows no tabs without Drive", () => {
    expect(picker(false)).not.toContain('role="tablist"');
  });

  it("holds back what Social cannot take", () => {
    expect(drivePickBlock(file("video/mp4"), 0, "en")).toBe("Videos later");
    expect(drivePickBlock(file("image/gif"), 0, "en")).toBe("PNG, JPEG or WebP only");
    expect(drivePickBlock(file("application/pdf"), 0, "de")).toBe("Nur PNG, JPEG oder WebP");
    expect(drivePickBlock(file("image/png"), 10, "en")).toBe("At most ten images");
    expect(drivePickBlock(file("image/webp"), 9, "en")).toBeNull();
  });
});
