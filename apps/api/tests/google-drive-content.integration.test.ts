import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, encrypt, entity } from "../src/shared.ts";
import { markSyncFailed } from "../src/modules/marketing/brand/drive-assets.ts";
import {
  driveContent,
  driveThumbnail,
  forgetDriveAncestry,
} from "../src/platform/connections/google-drive.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// Drive reads behind the Drive page and the Social import (design
// 2026-11-05): one metadata read per file, a caller's check before any
// download, and small previews from Google's thumbnail instead of the file.

const ROOT = "rootFolder0001";
const FOLDER = "application/vnd.google-apps.folder";
type Node = { id: string; name: string; mimeType: string; parents?: string[]; size?: string; thumbnailLink?: string };
const nodes: Record<string, Node> = {
  [ROOT]: { id: ROOT, name: "Root", mimeType: FOLDER },
  imagePng000001: {
    id: "imagePng000001",
    name: "Banner.png",
    mimeType: "image/png",
    parents: [ROOT],
    size: "4",
    thumbnailLink: "https://lh3.googleusercontent.com/drive-thumb/abc=s220",
  },
  imageNoThumb01: { id: "imageNoThumb01", name: "Raw.png", mimeType: "image/png", parents: [ROOT], size: "4" },
  imageEvilThumb: {
    id: "imageEvilThumb",
    name: "Evil.png",
    mimeType: "image/png",
    parents: [ROOT],
    size: "4",
    thumbnailLink: "https://attacker.example/steal=s220",
  },
};
let calls: string[] = [];

describe.skipIf(!enabled)("Drive content and thumbnails", () => {
  let scope: Scope;
  let workspaceId = "";
  beforeAll(async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "synthetic-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "synthetic-secret";
    const user = await authDb.user.create({
      data: { id: randomUUID(), name: "Synthetic Drive owner", email: `${randomUUID()}@example.invalid` },
    });
    const w = await authDb.workspace.create({
      data: { name: "Synthetic Drive content", members: { create: { userId: user.id, role: "owner" } } },
    });
    workspaceId = w.id;
    const p = await authDb.project.create({ data: { workspaceId: w.id, name: "Drive content" } });
    scope = { workspaceId: w.id, projectId: p.id, userId: user.id, role: "owner" };
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await create(tx, scope, "drive_connection", {
        account: "owner@example.invalid",
        encryptedRefreshToken: encrypt("synthetic-refresh", loadConfig().CREDENTIAL_KEY),
      });
      await create(tx, scope, "drive_storage", { rootFolderId: ROOT, rootName: "Root", enabled: true });
    });
  });
  beforeEach(() => {
    calls = [];
    forgetDriveAncestry(scope.projectId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
        if (url.host === "oauth2.googleapis.com") {
          calls.push("token");
          return json({ access_token: "synthetic-access" });
        }
        if (url.host === "lh3.googleusercontent.com") {
          calls.push(`thumb:${url.pathname}`);
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        }
        if (url.host !== "www.googleapis.com") throw new Error(`unexpected fetch ${url.host}`);
        const id = url.pathname.split("/").at(-1)!;
        if (url.searchParams.get("alt") === "media") {
          calls.push(`media:${id}`);
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
        }
        calls.push(`meta:${id}`);
        const node = nodes[id];
        return node ? json(node) : new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await closeDatabase();
  });

  it("reads a file's metadata once and downloads it", async () => {
    const content = await driveContent(scope, "imagePng000001");
    expect([content.mime, content.name, content.bytes.length]).toEqual(["image/png", "Banner.png", 4]);
    expect(calls.filter((c) => c === "meta:imagePng000001")).toHaveLength(1);
  });

  it("lets the caller refuse a file before the download", async () => {
    await expect(
      driveContent(scope, "imagePng000001", undefined, {
        accept: (meta) => {
          throw new Error(`refused ${meta.mimeType}`);
        },
      }),
    ).rejects.toThrow("refused image/png");
    expect(calls).not.toContain("media:imagePng000001");
  });

  it("serves Google's thumbnail at preview size, never the file", async () => {
    const thumb = await driveThumbnail(scope, "imagePng000001");
    expect(thumb.mime).toBe("image/jpeg");
    expect(calls).toContain("thumb:/drive-thumb/abc=s400");
    expect(calls).not.toContain("media:imagePng000001");
  });

  it("answers 404 without a thumbnail", async () => {
    await expect(driveThumbnail(scope, "imageNoThumb01")).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_THUMBNAIL_MISSING",
    });
  });

  it("never reads or marks another project's brand asset, even of the same organization", async () => {
    const asset = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      create(tx, scope, "assets", {
        name: "Banner",
        type: "generated_artwork",
        mime: "image/png",
        driveFileId: "imagePng000001",
        driveSyncStatus: "SYNCED",
      }),
    );
    const b = await authDb.project.create({ data: { workspaceId, name: "Drive content B" } });
    const other: Scope = { ...scope, projectId: b.id };
    // The content route reads the asset with the project filter first.
    await expect(
      scoped(other.workspaceId, other.projectId, (tx) => entity(tx, other, "assets", asset.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(markSyncFailed(other, asset.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const unchanged = await scoped(scope.workspaceId, scope.projectId, (tx) => entity(tx, scope, "assets", asset.id));
    expect([unchanged.version, data(unchanged).driveSyncStatus]).toEqual([asset.version, "SYNCED"]);
    expect(calls.filter((c) => c.startsWith("media:"))).toEqual([]);
  });

  it("never fetches a thumbnail link outside Google", async () => {
    await expect(driveThumbnail(scope, "imageEvilThumb")).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_THUMBNAIL_MISSING",
    });
    expect(calls.some((c) => c.includes("attacker"))).toBe(false);
  });
});
