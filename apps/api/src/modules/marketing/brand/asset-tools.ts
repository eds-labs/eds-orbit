import { scoped } from "../../../../../../packages/db/src/index.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { readFile } from "node:fs/promises";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { assetBytes } from "../../assets.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { importDriveFile, saveGeneratedAsset } from "./drive-assets.ts";
import { data, DomainError, publicEntity } from "../../../shared.ts";

/**
 * A composed assignment banner (R78) is bound to its run and draft: its
 * text was reviewed for that post only, so it is never offered or reused.
 */
export const boundAsset = (row: { data: unknown } | null) =>
  Boolean(row && data(row).boundTo);

async function rows(scope: Scope) {
  return (
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "assets",
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
    )
  ).filter((row) => !boundAsset(row));
}

// Agent callers receive project-scoped assets and bytes, never OAuth credentials.
export const assetTools = {
  async list(scope: Scope) {
    return (await rows(scope)).map(publicEntity);
  },
  async search(scope: Scope, query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle || needle.length > 120)
      throw new DomainError("ASSET_SEARCH_INVALID");
    return (await rows(scope))
      .filter((row) =>
        String(data(row).name ?? "")
          .toLowerCase()
          .includes(needle),
      )
      .map(publicEntity);
  },
  async get(scope: Scope, assetId: string) {
    const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.entity.findFirst({
        where: {
          id: assetId,
          kind: "assets",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      }),
    );
    if (!row || boundAsset(row)) throw new DomainError("NOT_FOUND", 404);
    const value = data(row);
    if (value.usageApproved !== true || value.assetStatus !== "approved")
      throw new DomainError("ASSET_NOT_APPROVED", 403);
    const content =
      value.type === "original_logo"
        ? {
            bytes: await readFile(
              new URL(
                "../../../../../../packages/creative/assets/logo-layer-stack-mark.svg",
                import.meta.url,
              ),
            ),
            mime: "image/svg+xml",
          }
        : value.driveFileId && !value.base64
          ? await driveContent(scope, value.driveFileId, {
              md5Checksum: value.md5Checksum,
              modifiedTime: value.driveModifiedTime,
            })
          : assetBytes(value);
    return { asset: publicEntity(row), content };
  },
  async upload(
    scope: Scope,
    driveFileId: string,
    type: "logo" | "photo" | "document" = "photo",
  ) {
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
    return publicEntity(await importDriveFile(scope, driveFileId, type));
  },
  async saveGeneratedImage(scope: Scope, assetId: string) {
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
    return publicEntity(await saveGeneratedAsset(scope, assetId));
  },
  async getBrandAssets(scope: Scope) {
    return (await rows(scope))
      .filter(
        (row) =>
          data(row).usageApproved === true &&
          data(row).assetStatus === "approved" &&
          ["logo", "original_logo", "photo", "background", "icon"].includes(
            String(data(row).type),
          ),
      )
      .map(publicEntity);
  },
  async getCampaignAssets(scope: Scope, campaignId: string) {
    return (await rows(scope))
      .filter((row) => data(row).campaignId === campaignId)
      .map(publicEntity);
  },
};

export async function assertMissionAssets(
  tx: import("../../../../../../packages/db/src/index.ts").DbTx,
  scope: Scope,
  ids: string[],
) {
  for (const id of ids) {
    const row = await tx.entity.findFirst({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assets",
      },
    });
    if (
      !row ||
      data(row).usageApproved !== true ||
      data(row).assetStatus !== "approved"
    )
      throw new DomainError("ASSET_NOT_APPROVED", 409);
    if (boundAsset(row)) throw new DomainError("ASSET_BOUND", 409);
  }
}
