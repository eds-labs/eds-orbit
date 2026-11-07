import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drive stubs keyed by file id: metadata and bytes, as the platform Drive
// connection returns them after its root check (no Google call).
const drive = vi.hoisted(() => ({
  meta: {} as Record<string, { id: string; name: string; mimeType: string }>,
  bytes: Buffer.alloc(0),
  downloads: [] as string[],
  browsed: [] as object[],
}));
vi.mock("../src/platform/connections/google-drive.ts", async (original) => {
  const actual = await original<typeof import("../src/platform/connections/google-drive.ts")>();
  const { DomainError } = await import("../src/shared.ts");
  return {
    ...actual,
    // The Drive page's browse after its root check: one synthetic folder.
    browseDrive: vi.fn(async (_scope: unknown, input: { folderId?: string; query?: string; kind?: string }) => {
      drive.browsed.push(input);
      if (input.folderId === "outsideRoot0001") throw new DomainError("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT", 403);
      return {
        folderId: input.folderId ?? "rootFolder00001",
        path: [{ id: "rootFolder00001", name: "FamilyPlan" }],
        rootName: "FamilyPlan",
        nextPageToken: null,
        files: [
          { id: "subFolder000001", name: "Kampagnen", mimeType: "application/vnd.google-apps.folder" },
          { id: "drivePngFamily01", name: "FamilyPlan_Drive.png", mimeType: "image/png", size: "8593", modifiedTime: "2026-11-06T10:00:00.000Z", imageMediaMetadata: { width: 800, height: 600 } },
        ],
      };
    }),
    driveContent: vi.fn(
      async (_scope: unknown, fileId: string, _expected: unknown, options?: { accept?: (meta: object) => void }) => {
        const meta = drive.meta[fileId];
        if (!meta) throw new DomainError("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT", 403);
        options?.accept?.(meta);
        drive.downloads.push(fileId);
        return { bytes: drive.bytes, mime: meta.mimeType, name: meta.name };
      },
    ),
  };
});

import { authDb, closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { authorizeMcpCall, visibleMcpTools } from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { registeredTools } from "../src/platform/modules/contributions.ts";
import { listActionRequests } from "../src/modules/action-requests.ts";
import { storeFile } from "../src/platform/files/files.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { setMediaUrlFetchForTests } from "../src/modules/social/media/from-url.ts";
import { driveFileIdOf, inlineBytes } from "../src/modules/social/media/mcp-tools.ts";
import { uploadToken, verifyUploadToken } from "../src/modules/social/media/upload-sessions.ts";
import { cleanMediaMcpRows, socialMediaMcpCleanup } from "../src/modules/social/media/mcp-cleanup.ts";
import { buildServer } from "../src/server.ts";
import { createSocialProject } from "./support/social-project.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
const JPEG = readFileSync(new URL("./fixtures/social/photo-800x600.jpg", import.meta.url));
const WEBP = readFileSync(new URL("./fixtures/social/photo-800x600.webp", import.meta.url));
/** A valid semi-transparent PNG of one random colour: a fresh image the library has not seen. */
function freshPng(width = 400, height = 300): Buffer {
  const [r, g, b] = randomBytes(3);
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) row.set([r!, g!, b!, 200], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const ENV = {
  ORBIT_SOCIAL: "true",
  ORBIT_MODULES: "true",
  ORBIT_MCP_PROPOSALS: "true",
  ORBIT_MCP_TASKS: "true",
  ORBIT_FILES: "true",
  FILES_BACKEND: "database",
  ORBIT_PUBLIC_INGRESS: "true",
};
const MEDIA_TOOLS = ["social_drive_files", "social_media_import", "social_media_list", "social_media_upload"];
const WRITE = ["orbit:read", "orbit:propose", "orbit:write", "orbit:social"];
const ours = (names: string[]) => names.filter((n) => MEDIA_TOOLS.includes(n)).sort();

describe("social media tool helpers", () => {
  it("reads a Drive file id from an id or a pasted Drive link only", () => {
    expect(driveFileIdOf("1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(driveFileIdOf("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing")).toBe("1AbCdEfGhIjKlMnOp");
    expect(driveFileIdOf("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(() => driveFileIdOf("https://evil.example/file/d/1AbCdEfGhIjKlMnOp/view")).toThrow("SOCIAL_MEDIA_SOURCE_INVALID");
    expect(() => driveFileIdOf("../../etc")).toThrow("SOCIAL_MEDIA_SOURCE_INVALID");
  });

  it("decodes strict base64 and data URLs of the declared type, within the inline limit", () => {
    expect(inlineBytes(PNG.toString("base64"), "image/png").equals(PNG)).toBe(true);
    expect(inlineBytes(`data:image/png;base64,${PNG.toString("base64")}`, "image/png").equals(PNG)).toBe(true);
    expect(() => inlineBytes("not base64 !!", "image/png")).toThrow("SOCIAL_MEDIA_INLINE_INVALID");
    expect(() => inlineBytes(randomBytes(170_000).toString("base64"), "image/png")).toThrow("SOCIAL_MEDIA_INLINE_TOO_LARGE");
  });

  it("accepts only its own unexpired, untampered upload tokens", () => {
    process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const token = uploadToken(projectId, sessionId, new Date(Date.now() + 60_000));
    expect(verifyUploadToken(token)).toEqual({ projectId, sessionId });
    expect(verifyUploadToken(token, new Date(Date.now() + 120_000))).toBeNull();
    const [ids, expires, mac] = token.split(".");
    expect(verifyUploadToken(`${ids}.${expires}.${mac!.slice(0, -2)}AA`)).toBeNull();
    expect(verifyUploadToken(`${ids}.${(parseInt(expires!, 36) + 600).toString(36)}.${mac}`)).toBeNull();
  });
});

describe.skipIf(!enabled)("social media MCP tools (library, Drive, URL, upload sessions)", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let principal: McpPrincipal;
  let facebook = "";
  let instagram = "";
  const previous: Record<string, string | undefined> = {};
  const owner = () => p.owner;

  async function grantFor(scope: Scope, scopes: string[]): Promise<McpPrincipal> {
    const grant = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://client.test/social-media-${randomUUID()}.json`,
        projectIds: [scope.projectId],
        scopes,
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      clientId: grant.clientId,
      grantId: grant.id,
      projectIds: [scope.projectId],
      scopes: new Set(grant.scopes),
      modules: [],
    };
  }
  async function op(name: string, args: unknown, who = principal, project = owner().projectId): Promise<any> {
    const { tool, scope } = await authorizeMcpCall(who, name, project);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "social"),
        runId: "synthetic-social-media-mcp",
        conversationId: "synthetic-social-media-mcp",
        callIndex: 0,
        channel: { kind: "mcp", clientId: who.clientId, grantId: who.grantId, requestId: "synthetic-social-media-mcp" },
      },
      args,
    );
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result.output;
  }
  const code = (name: string, args: unknown, who = principal) =>
    op(name, args, who).then(
      () => "resolved",
      (e: { code?: string; message: string }) => e.code ?? e.message,
    );
  const names = async (who: McpPrincipal) => ours((await visibleMcpTools(who, owner().projectId)).map((t) => t.name));
  const assets = () => p.run((tx) => tx.socialMediaAsset.count({ where: { projectId: owner().projectId } }));
  const account = (tx: DbTx, platform: string) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: owner().workspaceId,
        projectId: owner().projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_familyplan`,
        displayName: `FamilyPlan ${platform}`,
        capability: "write_verified",
        createdBy: owner().userId,
      },
    });
  /** The upload URL's path, sent to the in-process server without an Origin header. */
  const put = (url: string, body: Buffer, type: string) =>
    app.inject({ method: "PUT", url: new URL(url).pathname, headers: { "content-type": type }, payload: body });

  beforeAll(async () => {
    for (const key of [...Object.keys(ENV), "FILES_ENCRYPTION_KEY"]) previous[key] = process.env[key];
    Object.assign(process.env, ENV, { FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex") });
    app = await buildServer();
    p = await createSocialProject({ name: "Synthetic FamilyPlan" });
    other = await createSocialProject({ name: "Synthetic FamilyPlan B" });
    facebook = (await p.run((tx) => account(tx, "facebook"))).id;
    instagram = (await p.run((tx) => account(tx, "instagram"))).id;
    principal = await grantFor(owner(), WRITE);
  });
  beforeEach(() => {
    drive.bytes = PNG;
    drive.downloads = [];
    setMediaUrlFetchForTests(null);
  });
  afterAll(async () => {
    setMediaUrlFetchForTests(null);
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await app?.close();
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("lists the reading tool with orbit:social and the writes only with orbit:write and compose rights", async () => {
    expect(await names(principal)).toEqual(MEDIA_TOOLS);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:propose", "orbit:social"]))).toEqual(["social_drive_files", "social_media_list"]);
    expect(await names(await grantFor(owner(), ["orbit:read", "orbit:write"]))).toEqual([]);
    expect(await names(await grantFor(p.viewer, WRITE))).toEqual(["social_media_list"]);
    expect(await names(await grantFor(p.editor, WRITE))).toEqual(MEDIA_TOOLS);
    const tools = registeredTools().filter((t) => MEDIA_TOOLS.includes(t.name));
    expect(Object.fromEntries(tools.map((t) => [t.name, t.risk]))).toEqual({
      social_media_list: "R0_read",
      social_drive_files: "R0_read",
      social_media_import: "W0_internal",
      social_media_upload: "W0_internal",
    });
    // Outside clients only; ChatGPT fills `file` with a conversation file.
    expect(tools.find((t) => t.name === "social_media_upload")?.exposure).toEqual({ assistant: false, mcp: true });
    expect(tools.find((t) => t.name === "social_media_upload")?.mcpMeta).toEqual({ "openai/fileParams": ["file"] });
  });

  it("Test A: finds the existing FamilyPlan graphics with their media ids, paged and filtered", async () => {
    const insta = await uploadMedia(owner(), { bytes: PNG, mime: "image/png", name: "FamilyPlan_V2_Instagram.png" });
    const fb = await uploadMedia(owner(), { bytes: JPEG, mime: "image/jpeg", name: "FamilyPlan_V2_Facebook.png" });
    await uploadMedia(other.owner, { bytes: WEBP, mime: "image/webp", name: "FamilyPlan_V2_Foreign.webp" });
    const found = await op("social_media_list", { query: "familyplan_v2" });
    expect(found.result.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([fb.id, insta.id]);
    expect(found.result.items[0]).toMatchObject({
      mediaId: fb.id,
      kind: "image",
      width: 800,
      height: 600,
      size: expect.any(Number),
      previewUrl: expect.stringContaining(`/api/projects/${owner().projectId}/social/media/${fb.id}/content`),
    });
    const one = await op("social_media_list", { query: "Instagram" });
    expect(one.result.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([insta.id]);
    const first = await op("social_media_list", { query: "FamilyPlan_V2", limit: 1, sort: "oldest" });
    expect(first.result.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([insta.id]);
    const second = await op("social_media_list", { query: "FamilyPlan_V2", limit: 1, sort: "oldest", cursor: first.result.nextCursor });
    expect(second.result).toMatchObject({ items: [expect.objectContaining({ mediaId: fb.id })], nextCursor: null });
    expect((await op("social_media_list", { type: "video" })).result.items).toEqual([]);
    expect(await code("social_media_list", { cursor: "bogus" })).toBe("SOCIAL_MEDIA_CURSOR_INVALID");
    // A viewer reads the library too; never another project's images.
    const viewer = await op("social_media_list", { query: "FamilyPlan" }, await grantFor(p.viewer, ["orbit:read", "orbit:social"]));
    expect(viewer.result.items.map((i: { name: string }) => i.name)).not.toContain("FamilyPlan_V2_Foreign.webp");
  });

  it("Test B: imports a PNG from the project's Drive folder through Orbit's connection, once per key", async () => {
    drive.meta["drivePngFamily01"] = { id: "drivePngFamily01", name: "FamilyPlan_Drive.png", mimeType: "image/png" };
    drive.bytes = WEBP; // distinct from Test A's images
    const before = await assets();
    const args = { source: "drive", driveFileId: "https://drive.google.com/file/d/drivePngFamily01/view", idempotencyKey: "drive-1" };
    const out = await op("social_media_import", args);
    expect(out).toMatchObject({ status: "completed", deduplicated: false, duplicate: false, media: { mediaId: expect.any(String), name: expect.stringContaining("FamilyPlan_Drive") } });
    expect(await assets()).toBe(before + 1);
    expect(drive.downloads).toEqual(["drivePngFamily01"]);
    const listed = await op("social_media_list", { query: "FamilyPlan_Drive" });
    expect(listed.result.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([out.media.mediaId]);
    // A retry returns the first result without reading Drive again.
    expect(await op("social_media_import", args)).toMatchObject({ deduplicated: true, media: { mediaId: out.media.mediaId } });
    expect(drive.downloads).toEqual(["drivePngFamily01"]);
    expect(await code("social_media_import", { ...args, name: "Other" })).toBe("IDEMPOTENCY_KEY_CONFLICT");
    // The same image under a new key is recognized, not stored twice.
    expect(await op("social_media_import", { ...args, idempotencyKey: "drive-2" })).toMatchObject({ duplicate: true, media: { mediaId: out.media.mediaId } });
    expect(await assets()).toBe(before + 1);
    // Outside the project's root, videos and mismatched arguments are refused.
    expect(await code("social_media_import", { source: "drive", driveFileId: "notInTheRoot0001", idempotencyKey: "drive-3" })).toBe("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT");
    drive.meta["driveVideo00001"] = { id: "driveVideo00001", name: "clip.mp4", mimeType: "video/mp4" };
    expect(await code("social_media_import", { source: "drive", driveFileId: "driveVideo00001", idempotencyKey: "drive-4" })).toBe("SOCIAL_VIDEO_NOT_AVAILABLE");
    expect(await code("social_media_import", { source: "drive", url: "https://example.com/a.png", idempotencyKey: "drive-5" })).toBe("SOCIAL_MEDIA_SOURCE_INVALID");
    const audits = await p.run((tx) => tx.auditEvent.findMany({ where: { projectId: owner().projectId, resourceId: out.media.mediaId } }));
    expect(audits.map((a) => [a.action, a.metadata])).toContainEqual(["social.media.uploaded", { mime: expect.any(String), size: expect.any(Number), source: "drive" }]);
  });

  it("lists images and folders of the project's Drive folder with ids for the import", async () => {
    drive.browsed = [];
    const out = await op("social_drive_files", { query: "FamilyPlan", sort: "modified" });
    expect(out).toEqual({
      folderId: "rootFolder00001",
      rootName: "FamilyPlan",
      path: [{ id: "rootFolder00001", name: "FamilyPlan" }],
      items: [
        { driveFileId: "subFolder000001", name: "Kampagnen", kind: "folder", mimeType: "application/vnd.google-apps.folder", size: null, width: null, height: null, modifiedTime: null },
        { driveFileId: "drivePngFamily01", name: "FamilyPlan_Drive.png", kind: "image", mimeType: "image/png", size: 8593, width: 800, height: 600, modifiedTime: "2026-11-06T10:00:00.000Z" },
      ],
      nextPageToken: null,
    });
    // Images only, whatever the client asks for.
    expect(drive.browsed).toEqual([{ query: "FamilyPlan", sort: "modified", kind: "image" }]);
    expect(await code("social_drive_files", { folderId: "outsideRoot0001" })).toBe("GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT");
    // Viewers cannot import, so they do not browse Drive here either.
    expect(await code("social_drive_files", {}, await grantFor(p.viewer, WRITE))).toBe("MCP_TOOL_NOT_ALLOWED");
  });

  it("stores one image when identical calls arrive at the same time", async () => {
    const image = freshPng();
    const before = await assets();
    const args = { name: "race.png", mimeType: "image/png", data: image.toString("base64"), idempotencyKey: "race-1" };
    const same = await Promise.all([op("social_media_upload", args), op("social_media_upload", args), op("social_media_upload", args)]);
    expect(new Set(same.map((o) => o.media.mediaId)).size).toBe(1);
    expect(same.filter((o) => !o.deduplicated)).toHaveLength(1);
    const keys = await Promise.all(
      ["race-2", "race-3"].map((idempotencyKey) => op("social_media_upload", { ...args, idempotencyKey })),
    );
    expect(new Set([...same, ...keys].map((o) => o.media.mediaId)).size).toBe(1);
    expect(await assets()).toBe(before + 1);
    const receipts = await p.run((tx) =>
      tx.entity.count({ where: { projectId: owner().projectId, kind: "social_media_receipt", data: { path: ["idempotencyKey"], equals: "race-1" } } }),
    );
    expect(receipts).toBe(1);
    // The losing copies' files are gone: two files (original, rendition) per image.
    const files = await p.run((tx) => tx.file.count({ where: { projectId: owner().projectId, moduleId: "social", deletedAt: null } }));
    expect(files).toBe((await assets()) * 2);
  });

  it("removes stale upload sessions and receipts, never library images", async () => {
    const opened = await op("social_media_upload", { name: "old.png", mimeType: "image/png", idempotencyKey: "old-session" });
    const kept = await op("social_media_upload", { name: "kept.png", mimeType: "image/png", data: freshPng().toString("base64"), idempotencyKey: "old-receipt" });
    const day = 86_400_000;
    await p.run((tx) => tx.entity.update({ where: { id: opened.sessionId }, data: { createdAt: new Date(Date.now() - 2 * day) } }));
    await p.run((tx) =>
      tx.entity.updateMany({
        where: { projectId: owner().projectId, kind: "social_media_receipt", data: { path: ["idempotencyKey"], equals: "old-receipt" } },
        data: { createdAt: new Date(Date.now() - 31 * day) },
      }),
    );
    expect(await p.run((tx) => socialMediaMcpCleanup.nextDueAt!(tx, owner()))).toBeInstanceOf(Date);
    const before = await assets();
    expect(await p.run((tx) => cleanMediaMcpRows(tx, owner()))).toBe(2);
    expect(await assets()).toBe(before);
    expect(await p.run((tx) => tx.entity.count({ where: { id: opened.sessionId } }))).toBe(0);
    expect(await p.run((tx) => socialMediaMcpCleanup.nextDueAt!(tx, owner()))).toBeNull();
    // Fresh rows stay; the image of the removed receipt is still listed.
    expect((await op("social_media_list", { query: "kept" })).result.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([kept.media.mediaId]);
    expect(await code("social_media_upload", { name: "old.png", mimeType: "image/png", sessionId: opened.sessionId })).toBe("NOT_FOUND");
  });

  it("imports by HTTPS URL with every redirect checked, and never from private addresses", async () => {
    const hops: string[] = [];
    setMediaUrlFetchForTests(async (url) => {
      hops.push(String(url));
      if (String(url).endsWith("/start")) return new Response(null, { status: 302, headers: { location: "/final/banner.png" } });
      if (String(url).endsWith("/to-http")) return new Response(null, { status: 302, headers: { location: "http://cdn.example/x.png" } });
      // A fresh image per import (the library recognizes repeats).
      return new Response(new Uint8Array(freshPng()), { status: 200, headers: { "content-type": "image/png" } });
    });
    const out = await op("social_media_import", { source: "url", url: "https://cdn.example/start", altText: "A banner", idempotencyKey: "url-1" });
    expect(out).toMatchObject({ status: "completed", media: { name: expect.stringContaining("banner"), altText: "A banner" } });
    expect(hops).toEqual(["https://cdn.example/start", "https://cdn.example/final/banner.png"]);
    expect(await code("social_media_import", { source: "url", url: "https://cdn.example/to-http", idempotencyKey: "url-2" })).toBe("SOCIAL_MEDIA_URL_NOT_ALLOWED");
    expect(await code("social_media_import", { source: "url", url: "http://cdn.example/a.png", idempotencyKey: "url-3" })).toBe("SOCIAL_MEDIA_URL_NOT_ALLOWED");
    expect(await code("social_media_import", { source: "url", url: "https://cdn.example:8443/a.png", idempotencyKey: "url-4" })).toBe("SOCIAL_MEDIA_URL_NOT_ALLOWED");
    // The real transport refuses loopback and private addresses before sending.
    setMediaUrlFetchForTests(null);
    expect(await code("social_media_import", { source: "url", url: "https://127.0.0.1/a.png", idempotencyKey: "url-5" })).toBe("SOCIAL_MEDIA_URL_NOT_ALLOWED");
    expect(await code("social_media_import", { source: "url", url: "https://[::1]/a.png", idempotencyKey: "url-6" })).toBe("SOCIAL_MEDIA_URL_NOT_ALLOWED");
  });

  it("imports an Orbit file the member may read, never one of a consent-guarded module", async () => {
    const marketing = await storeFile(owner(), { moduleId: "marketing", bytes: PNG, mime: "image/png", name: "brand.png" });
    const out = await op("social_media_import", { source: "orbit_file", fileId: marketing.id, idempotencyKey: "file-1" });
    expect(out).toMatchObject({ status: "completed", media: { mediaId: expect.any(String) } });
    process.env.ORBIT_SUPPORT = "true";
    await p.enable("support");
    const support = await storeFile(owner(), { moduleId: "support", bytes: JPEG, mime: "image/jpeg", name: "ticket.jpg" });
    try {
      expect(await code("social_media_import", { source: "orbit_file", fileId: support.id, idempotencyKey: "file-2" })).toBe("SOCIAL_MEDIA_SOURCE_NOT_ALLOWED");
    } finally {
      delete process.env.ORBIT_SUPPORT;
    }
    const foreign = await storeFile(other.owner, { moduleId: "marketing", bytes: PNG, mime: "image/png", name: "foreign.png" });
    expect(await code("social_media_import", { source: "orbit_file", fileId: foreign.id, idempotencyKey: "file-3" })).toBe("NOT_FOUND");
  });

  it("Test C: uploads inline, as a client file and through a one-time upload session", async () => {
    const inline = await op("social_media_upload", { name: "inline.webp", mimeType: "image/webp", data: WEBP.toString("base64"), idempotencyKey: "up-1" });
    expect(inline).toMatchObject({ status: "completed", media: { mediaId: expect.any(String) } });
    expect(await code("social_media_upload", { name: "bad.png", mimeType: "image/png", data: "%%%", idempotencyKey: "up-2" })).toBe("SOCIAL_MEDIA_INLINE_INVALID");
    expect(await code("social_media_upload", { name: "nokey.png", mimeType: "image/png", data: PNG.toString("base64") })).toBe("IDEMPOTENCY_KEY_REQUIRED");
    // A file the client holds (ChatGPT file params): fetched from its download URL.
    setMediaUrlFetchForTests(async () => new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } }));
    const held = await op("social_media_upload", {
      name: "chatgpt.png",
      mimeType: "image/png",
      file: { download_url: "https://files.example/abc", file_id: "file-123" },
      idempotencyKey: "up-3",
    });
    expect(held).toMatchObject({ status: "completed" });

    const opened = await op("social_media_upload", { name: "large.png", mimeType: "image/png", altText: "Large", idempotencyKey: "up-4" });
    expect(opened).toMatchObject({
      status: "upload_required",
      sessionId: expect.any(String),
      upload: { method: "PUT", headers: { "Content-Type": "image/png" }, maxBytes: expect.any(Number), url: expect.stringContaining("/api/public/social/media-uploads/") },
    });
    expect(await op("social_media_upload", { name: "large.png", mimeType: "image/png", altText: "Large", idempotencyKey: "up-4" })).toMatchObject({
      deduplicated: true,
      sessionId: opened.sessionId,
      upload: { url: opened.upload.url },
    });
    // The wrong image type is refused and leaves the session open.
    expect((await put(opened.upload.url, JPEG, "image/png")).statusCode).toBe(415);
    expect((await put(opened.upload.url, PNG, "text/plain")).statusCode).toBe(415);
    const done = await put(opened.upload.url, freshPng(1600, 900), "image/png");
    expect(done.statusCode).toBe(201);
    const body = done.json();
    expect(body).toMatchObject({ mediaId: expect.any(String), width: 1600, height: 900, duplicate: false });
    // One use only.
    expect((await put(opened.upload.url, freshPng(), "image/png")).statusCode).toBe(404);
    const status = await op("social_media_upload", { name: "large.png", mimeType: "image/png", sessionId: opened.sessionId });
    expect(status).toMatchObject({ status: "completed", media: { mediaId: body.mediaId, altText: "Large" } });
    // A forged token and another member's session are the same 404.
    const forged = opened.upload.url.replace(/.{4}$/, "AAAA");
    expect((await put(forged, freshPng(), "image/png")).statusCode).toBe(404);
    expect(await code("social_media_upload", { name: "x.png", mimeType: "image/png", sessionId: opened.sessionId }, await grantFor(p.editor, WRITE))).toBe("NOT_FOUND");
  });

  it("Test C: re-checks the member's rights when the bytes arrive", async () => {
    const editor = await p.member("editor");
    const grant = await grantFor(editor, WRITE);
    const opened = await op("social_media_upload", { name: "late.webp", mimeType: "image/webp", idempotencyKey: "late-1" }, grant);
    await authDb.projectMember.updateMany({ where: { projectId: owner().projectId, userId: editor.userId }, data: { role: "viewer" } });
    expect((await put(opened.upload.url, WEBP, "image/webp")).statusCode).toBe(403);
  });

  it("Test D: a Facebook and Instagram draft with different images validates and is only proposed", async () => {
    const fb = (await op("social_media_list", { query: "FamilyPlan_V2_Facebook" })).result.items[0].mediaId;
    const ig = (await op("social_media_list", { query: "FamilyPlan_V2_Instagram" })).result.items[0].mediaId;
    const draft = {
      title: "FamilyPlan V2",
      baseText: "FamilyPlan V2 is here.",
      baseMedia: [],
      variants: [
        { accountId: facebook, media: [fb] },
        { accountId: instagram, media: [ig] },
      ],
    };
    const checked = await op("social_validate", draft);
    expect(checked.result.variants).toHaveLength(2);
    for (const variant of checked.result.variants)
      expect(JSON.stringify(variant)).not.toMatch(/SOCIAL_MEDIA_(ASPECT|TOO|TYPE|CAROUSEL)/);
    const proposal = await op("social_draft_create", { ...draft, idempotencyKey: "familyplan-v2" });
    expect(proposal).toMatchObject({ status: "pending", requiresApproval: true });
    const listed = (await p.run((tx) => listActionRequests(tx, owner()))).find((r) => r.id === proposal.actionRequestId);
    expect(listed?.summary).toMatchObject({
      operation: { kind: "social_draft", variants: [expect.objectContaining({ platform: "facebook", images: 1 }), expect.objectContaining({ platform: "instagram", images: 1 })] },
    });
    // Nothing is created or published before the owner decides.
    expect(await p.run((tx) => tx.socialPost.count({ where: { projectId: owner().projectId, title: "FamilyPlan V2" } }))).toBe(0);
    expect(await p.run((tx) => tx.socialPublication.count({ where: { projectId: owner().projectId } }))).toBe(0);
    // Another project's image is not usable here.
    const foreign = await uploadMedia(other.owner, { bytes: PNG, mime: "image/png", name: "foreign.png" });
    expect(await code("social_validate", { ...draft, variants: [{ accountId: facebook, media: [foreign.id] }] })).not.toBe("resolved");
  });

  it("Test E: refuses writes without the project right, the module or the write scope", async () => {
    const viewer = await grantFor(p.viewer, WRITE);
    expect(await code("social_media_upload", { name: "v.png", mimeType: "image/png", data: PNG.toString("base64"), idempotencyKey: "v-1" }, viewer)).toBe("MCP_TOOL_NOT_ALLOWED");
    expect(await code("social_media_import", { source: "drive", driveFileId: "drivePngFamily01", idempotencyKey: "v-2" }, viewer)).toBe("MCP_TOOL_NOT_ALLOWED");
    const noWrite = await grantFor(owner(), ["orbit:read", "orbit:propose", "orbit:social"]);
    expect(await code("social_media_upload", { name: "w.png", mimeType: "image/png", data: PNG.toString("base64"), idempotencyKey: "w-1" }, noWrite)).not.toBe("resolved");
    // Another project's grant cannot reach this project.
    expect(
      await op("social_media_list", {}, await grantFor(other.owner, WRITE), owner().projectId).then(
        () => "resolved",
        (e: { code?: string }) => e.code,
      ),
    ).not.toBe("resolved");
    await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "social" }, data: { enabled: false } }));
    try {
      expect(await names(principal)).toEqual([]);
    } finally {
      await p.run((tx) => tx.projectModule.updateMany({ where: { projectId: owner().projectId, moduleId: "social" }, data: { enabled: true } }));
    }
  });
});
