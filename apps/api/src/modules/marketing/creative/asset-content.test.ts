import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";

const driveContent = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/connections/google-drive.ts", () => ({
  driveContent,
}));

const { assetContent } = await import("./asset-content.ts");

const scope: Scope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  role: "owner",
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("synthetic image bytes");

describe("assetContent", () => {
  beforeEach(() => driveContent.mockReset());

  it("returns the stored copy with its SHA-256", async () => {
    const content = await assetContent(scope, {
      mime: "image/png",
      base64: bytes.toString("base64"),
      sha256: sha(bytes),
    });
    expect(content.bytes.equals(bytes)).toBe(true);
    expect(content).toMatchObject({ mime: "image/png", sha256: sha(bytes) });
    expect(driveContent).not.toHaveBeenCalled();
  });

  it("refuses a stored copy whose bytes changed", async () => {
    await expect(
      assetContent(scope, {
        mime: "image/png",
        base64: bytes.toString("base64"),
        sha256: sha(Buffer.from("other")),
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_FAILED", status: 409 });
  });

  it("reads a Drive asset against what was imported and hashes the fetched bytes", async () => {
    driveContent.mockResolvedValue({ bytes, mime: "image/jpeg" });
    const content = await assetContent(scope, {
      driveFileId: "drive-file",
      md5Checksum: "abc",
      driveModifiedTime: "2026-10-01T00:00:00Z",
    });
    expect(driveContent).toHaveBeenCalledWith(scope, "drive-file", {
      md5Checksum: "abc",
      modifiedTime: "2026-10-01T00:00:00Z",
    });
    expect(content).toMatchObject({ mime: "image/jpeg", sha256: sha(bytes) });
  });

  it("only serves raster images from a stored copy too", async () => {
    // assetBytes alone would answer with a raw validation error for this mime.
    await expect(
      assetContent(scope, {
        mime: "image/svg+xml",
        base64: bytes.toString("base64"),
        sha256: sha(bytes),
      }),
    ).rejects.toMatchObject({
      code: "BRAND_IMAGE_FORMAT_UNSUPPORTED",
      status: 415,
    });
    await expect(
      assetContent(scope, { base64: bytes.toString("base64") }),
    ).rejects.toMatchObject({ code: "BRAND_IMAGE_FORMAT_UNSUPPORTED" });
  });

  it("only serves raster images from Drive", async () => {
    driveContent.mockResolvedValue({ bytes, mime: "application/pdf" });
    await expect(
      assetContent(scope, { driveFileId: "drive-file" }),
    ).rejects.toMatchObject({
      code: "BRAND_IMAGE_FORMAT_UNSUPPORTED",
      status: 415,
    });
  });
});
