import { describe, expect, it } from "vitest";
import { publicEntity, encrypt, decrypt } from "../shared.ts";
import { imageGenerationInput } from "./image-generation.ts";
import { assetTools } from "./asset-tools.ts";

const key = "a".repeat(64);
describe("Google Drive credential and generation boundaries", () => {
  it("encrypts refresh tokens and never serializes them in a public entity", () => {
    const encryptedRefreshToken = encrypt("synthetic-refresh-token", key);
    expect(encryptedRefreshToken).not.toContain("synthetic-refresh-token");
    expect(decrypt(encryptedRefreshToken, key)).toBe("synthetic-refresh-token");
    const publicRow = publicEntity({
      kind: "drive_connection",
      data: { encryptedRefreshToken, account: "test@example.invalid" },
    });
    expect(JSON.stringify(publicRow)).not.toContain(encryptedRefreshToken);
    expect(JSON.stringify(publicRow)).not.toContain("synthetic-refresh-token");
  });
  it("keeps a failed upload's local asset bytes out of list responses", () => {
    const result = publicEntity({
      kind: "assets",
      data: { base64: "synthetic-binary", driveSyncStatus: "FAILED" },
    });
    expect(result.data.base64).toBeUndefined();
    expect(result.data.hasContent).toBe(true);
    expect(result.data.driveSyncStatus).toBe("FAILED");
  });
  it("rejects agent or editor writes before contacting Drive", async () => {
    await expect(
      assetTools.upload(
        {
          workspaceId: "773d4557-7850-40ba-87b6-93ecb65d2bd1",
          projectId: "773d4557-7850-40ba-87b6-93ecb65d2bd2",
          userId: "test",
          role: "editor",
        },
        "syntheticDriveId",
        "logo",
      ),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  });
  it("accepts an explicit Drive opt-out without weakening image confirmation", () => {
    const request = {
      requestId: "773d4557-7850-40ba-87b6-93ecb65d2bd1",
      name: "Test",
      prompt: "A plain abstract blue background",
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      validUses: ["social"],
      confirmPromptMayBeSentToOpenAI: true,
      confirmMaximumCostMicros: 10,
      saveToDrive: false,
    };
    expect(imageGenerationInput.parse(request).saveToDrive).toBe(false);
    expect(() =>
      imageGenerationInput.parse({
        ...request,
        confirmPromptMayBeSentToOpenAI: false,
      }),
    ).toThrow();
  });
});
