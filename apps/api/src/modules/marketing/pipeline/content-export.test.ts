import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { exportAssetContent } from "./content-export.ts";

const scope = {
  workspaceId: "344c4949-08c0-472a-9bd4-8e49e5c76e72",
  projectId: "53f7ca69-4e6b-48ca-b15e-bf95b73ea691",
  userId: "synthetic-user",
  role: "owner" as const,
};
const png = Buffer.from("89504e470d0a1a0a0000", "hex");

describe("content export asset bytes", () => {
  it("reads an approved Drive-imported PNG with its recorded checksum", async () => {
    const readDrive = vi.fn(async () => ({ bytes: png, mime: "image/png" }));
    const content = await exportAssetContent(
      scope,
      {
        usageApproved: true,
        mime: "image/png",
        driveFileId: "logoFileABC123",
        md5Checksum: "known",
        driveModifiedTime: "2026-09-24T00:00:00Z",
      },
      readDrive as any,
    );
    expect(content).toEqual({ bytes: png, mime: "image/png" });
    expect(readDrive).toHaveBeenCalledWith(scope, "logoFileABC123", {
      md5Checksum: "known",
      modifiedTime: "2026-09-24T00:00:00Z",
    });
  });

  it("uses verified inline bytes without contacting Drive", async () => {
    const readDrive = vi.fn();
    const content = await exportAssetContent(
      scope,
      {
        usageApproved: true,
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
      },
      readDrive as any,
    );
    expect(content?.bytes.equals(png)).toBe(true);
    expect(readDrive).not.toHaveBeenCalled();
  });

  it("omits missing, unapproved and non-PNG assets", async () => {
    const readDrive = vi.fn();
    for (const asset of [
      null,
      { usageApproved: false, mime: "image/png", driveFileId: "x" },
      { usageApproved: true, mime: "image/webp", driveFileId: "x" },
    ])
      expect(
        await exportAssetContent(scope, asset, readDrive as any),
      ).toBeNull();
    expect(readDrive).not.toHaveBeenCalled();
  });
});
