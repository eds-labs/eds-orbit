import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drive stubs keyed by file id: metadata and bytes, as the platform Drive
// connection returns them after its root check.
const drive = vi.hoisted(() => ({
  meta: {} as Record<string, { id: string; name: string; mimeType: string; md5Checksum?: string }>,
  downloads: [] as string[],
  error: null as null | { code: string; status: number },
  bytes: Buffer.alloc(0),
}));
vi.mock("../src/platform/connections/google-drive.ts", async (original) => {
  const actual = await original<typeof import("../src/platform/connections/google-drive.ts")>();
  const { DomainError } = await import("../src/shared.ts");
  return {
    ...actual,
    // The import reads Drive once: driveContent checks the type before the download.
    driveContent: vi.fn(
      async (_scope: unknown, fileId: string, _expected: unknown, options?: { accept?: (meta: object) => void }) => {
        if (drive.error) throw new DomainError(drive.error.code, drive.error.status);
        const meta = drive.meta[fileId];
        if (!meta) throw new DomainError("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT", 403);
        options?.accept?.(meta);
        drive.downloads.push(fileId);
        return { bytes: drive.bytes, mime: meta.mimeType, name: meta.name };
      },
    ),
  };
});

import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * Images from Google Drive into the Social media library (Drive page design
 * 2026-11-05 §4.4): owners and editors import PNG, JPEG and WebP; videos
 * and other types are refused before anything is downloaded.
 */
describe.skipIf(!enabled)("social media from Google Drive", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const importDrive = (who: keyof typeof ids, payload: object, project = projectId) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${project}/social/media/from-drive`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      payload,
    });
  const list = (who: keyof typeof ids) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/social/media`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
  const file = (id: string, name: string, mimeType: string) => {
    drive.meta[id] = { id, name, mimeType, md5Checksum: "synthetic-md5" };
    return id;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic social ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic social drive",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social drive" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social drive B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_SOCIAL = "true";
    drive.downloads = [];
    drive.error = null;
    drive.bytes = PNG;
  });
  afterEach(() => {
    delete process.env.ORBIT_SOCIAL;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets an editor import a Drive PNG into the library", async () => {
    const id = file("drivePngFile0001", "Drive Banner.png", "image/png");
    const response = await importDrive("editor", { fileId: id });
    expect(response.statusCode).toBe(201);
    // An opaque PNG is stored as JPEG, like an upload.
    expect(response.json()).toMatchObject({ name: "Drive Banner.jpg", width: 800, height: 600 });
    const items = (await list("viewer")).json().items.map((i: { id: string }) => i.id);
    expect(items).toContain(response.json().id);
    expect(drive.downloads).toEqual([id]);
  });

  it("uses the given name", async () => {
    const id = file("drivePngFile0002", "IMG_0001.png", "image/png");
    const response = await importDrive("owner", { fileId: id, name: "Custom" });
    expect([response.statusCode, response.json().name]).toEqual([201, "Custom.jpg"]);
  });

  it("refuses a viewer", async () => {
    const id = file("drivePngFile0003", "Banner.png", "image/png");
    expect((await importDrive("viewer", { fileId: id })).statusCode).toBe(403);
    expect(drive.downloads).toEqual([]);
  });

  it("refuses a video before downloading it", async () => {
    const id = file("driveVideo000001", "Clip.mp4", "video/mp4");
    const response = await importDrive("editor", { fileId: id });
    expect([response.statusCode, response.json().error?.code]).toEqual([415, "SOCIAL_VIDEO_NOT_AVAILABLE"]);
    expect(drive.downloads).toEqual([]);
  });

  it("refuses GIF, SVG and PDF", async () => {
    for (const [id, mime] of [
      ["driveGifFile0001", "image/gif"],
      ["driveSvgFile0001", "image/svg+xml"],
      ["drivePdfFile0001", "application/pdf"],
    ] as const) {
      file(id, `file-${mime}`, mime);
      const response = await importDrive("editor", { fileId: id });
      expect([response.statusCode, response.json().error?.code]).toEqual([415, "SOCIAL_MEDIA_TYPE"]);
    }
    expect(drive.downloads).toEqual([]);
  });

  it("passes the Drive error on when Drive is not set up", async () => {
    drive.error = { code: "GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED", status: 409 };
    const response = await importDrive("editor", { fileId: "drivePngFile0001" });
    expect([response.statusCode, response.json().error?.code]).toEqual([409, "GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED"]);
  });

  it("refuses a malformed file id", async () => {
    expect((await importDrive("editor", { fileId: "../etc" })).statusCode).toBe(400);
  });

  it("answers 404 where the module is off", async () => {
    const id = file("drivePngFile0004", "Banner.png", "image/png");
    expect((await importDrive("editor", { fileId: id }, otherProjectId)).statusCode).toBe(404);
    delete process.env.ORBIT_SOCIAL;
    const response = await importDrive("editor", { fileId: id });
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "SOCIAL_DISABLED"]);
    expect(drive.downloads).toEqual([]);
  });
});
