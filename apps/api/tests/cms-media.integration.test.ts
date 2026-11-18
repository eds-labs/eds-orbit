import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drive stubs keyed by file id, as the platform Drive connection returns
// them after its root check.
const drive = vi.hoisted(() => ({
  meta: {} as Record<string, { id: string; name: string; mimeType: string }>,
  downloads: [] as string[],
  bytes: Buffer.alloc(0),
}));
vi.mock("../src/platform/connections/google-drive.ts", async (original) => {
  const actual = await original<typeof import("../src/platform/connections/google-drive.ts")>();
  const { DomainError } = await import("../src/shared.ts");
  return {
    ...actual,
    driveContent: vi.fn(async (_scope: unknown, fileId: string, _expected: unknown, options?: { accept?: (meta: object) => void }) => {
      const meta = drive.meta[fileId];
      if (!meta) throw new DomainError("GOOGLE_DRIVE_FILE_OUTSIDE_ROOT", 403);
      options?.accept?.(meta);
      drive.downloads.push(fileId);
      return { bytes: drive.bytes, mime: meta.mimeType, name: meta.name };
    }),
  };
});

import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { provenanceXmp, verifyAiLabel, type RelBox } from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { storeFile } from "../src/platform/files/files.ts";
import { imageProvenance } from "../src/platform/provenance/image-provenance.ts";
import { assetContent, ingestAsset } from "../src/modules/cms/media/assets.ts";
import { cmsMediaUrl } from "../src/modules/cms/media/public-media.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(new URL("../../../packages/creative/package.json", import.meta.url))("sharp") as Sharp;

/** Deterministic noise, so a busy background never makes a label test flaky. */
function noise(width: number, height: number, seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = next();
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/**
 * The content media library (ADR 0029, CH1.9): uploads and imports become a
 * normalized original with WebP variants and an Open Graph card; identical
 * images are stored once; alt text and caption per locale; archive; a
 * private preview; public URLs that serve only images of live content and
 * never an AI image without its label.
 */
describe.skipIf(!enabled)("content media", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const saved = { ...process.env };
  const keys = ["ORBIT_CMS", "ORBIT_FILES", "FILES_BACKEND", "FILES_ENCRYPTION_KEY", "ORBIT_PUBLIC_INGRESS", "ORBIT_AI_IMAGE_LABELS"];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const headers = (who: keyof typeof ids) => ({ origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() });
  const call = (who: keyof typeof ids, method: "GET" | "POST" | "PATCH", url: string, payload?: object, project = projectId) =>
    app.inject({ method, url: `/api/projects/${project}/cms${url}`, headers: headers(who), ...(payload ? { payload } : {}) });
  const upload = (who: keyof typeof ids, bytes: Buffer, name = "Foto Familie.png", type = "application/octet-stream") =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/cms/assets`,
      headers: { ...headers(who), "content-type": type, "x-file-name": encodeURIComponent(name) },
      payload: bytes,
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const ownerScope = (): Scope => ({ workspaceId, projectId, userId: ids.owner, role: "owner" });
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, work);
  const publicGet = (url: string) => app.inject({ method: "GET", url: new URL(url).pathname, headers: { [CLIENT_IP_HEADER]: ip() } });
  /** An entry whose live revision shows the asset as hero image. */
  const liveWithHero = async (assetId: string) => {
    const created = await call("editor", "POST", "/entries", { type: "article", locale: "de", title: `Live ${randomUUID().slice(0, 6)}` });
    const entryId = created.json().entry.id;
    expect((await call("editor", "PATCH", `/entries/${entryId}/draft`, { version: 1, heroAssetId: assetId })).statusCode).toBe(200);
    const revision = (await call("editor", "POST", `/entries/${entryId}/revisions`, {})).json().revision;
    await run((tx) =>
      tx.cmsEntry.update({
        where: { id: entryId },
        data: { status: "published", publishedRevisionId: revision.id, firstPublishedAt: new Date(), lastPublishedAt: new Date() },
      }),
    );
    return entryId;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ORBIT_AI_IMAGE_LABELS: "false",
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic cms media ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic cms media",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms media" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic cms media B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    for (const project of [projectId, otherProjectId])
      await scoped(workspaceId, project, (tx) =>
        tx.projectModule.create({
          data: { workspaceId, projectId: project, moduleId: "cms", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
        }),
      );
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin, [CLIENT_IP_HEADER]: ip() }, payload: accounts[who] });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_CMS = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_CMS;
    delete process.env.ORBIT_PUBLIC_INGRESS;
    process.env.ORBIT_AI_IMAGE_LABELS = "false";
  });
  afterAll(async () => {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("stores an upload with variants once; viewers cannot upload", async () => {
    const first = await upload("editor", PNG);
    expect(first.statusCode, first.body).toBe(201);
    const { asset, duplicate } = first.json();
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({ name: "Foto Familie.jpg", mime: "image/jpeg", width: 800, height: 600, aiLabel: null, version: 1 });
    expect(asset.renditions.map((r: { name: string; width: number; height: number; mime: string }) => [r.name, r.width, r.height, r.mime])).toEqual([
      ["original", 800, 600, "image/jpeg"],
      ["w480", 480, 360, "image/webp"],
      ["w960", 800, 600, "image/webp"],
      ["og", 1200, 630, "image/jpeg"],
    ]);
    // File ids stay internal.
    expect(JSON.stringify(asset)).not.toContain("fileId");
    const again = await upload("editor", PNG, "other.png");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, asset: { id: asset.id } });
    const files = await run((tx) => tx.file.count({ where: { projectId, moduleId: "cms", deletedAt: null } }));
    expect(files).toBe(4);
    const viewer = await upload("viewer", PNG);
    expect([viewer.statusCode, code(viewer)]).toEqual([403, "FORBIDDEN"]);
    const text = await upload("editor", Buffer.from("not an image at all"));
    expect([text.statusCode, code(text)]).toEqual([415, "CMS_MEDIA_TYPE"]);
    const json = await call("editor", "POST", "/assets", { bytes: "x" });
    expect([json.statusCode, code(json)]).toEqual([415, "FILE_BODY_REQUIRED"]);
    const audit = await run((tx) => tx.auditEvent.findFirst({ where: { projectId, resourceId: asset.id, action: "cms.asset.created" } }));
    expect(audit?.metadata).toEqual({ mime: "image/jpeg", bytes: asset.bytes, source: "upload", renditions: 3 });
  });

  it("keeps alt text and caption per locale, archives and lists the library", async () => {
    const bytes = await noise(640, 480, 3).png().toBuffer();
    const { asset } = (await upload("editor", bytes, "Kalender.png")).json();
    const updated = await call("editor", "PATCH", `/assets/${asset.id}`, {
      version: 1,
      alt: { de: "Ein Familienkalender", en: "A family calendar", fr: "" },
      caption: { de: "Unser Kalender" },
      credit: "EDS Labs",
      focalPoint: { x: 0.3, y: 0.6 },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      alt: { de: "Ein Familienkalender", en: "A family calendar" },
      caption: { de: "Unser Kalender" },
      credit: "EDS Labs",
      focalPoint: { x: 0.3, y: 0.6 },
      version: 2,
    });
    expect(updated.json().alt.fr).toBeUndefined();
    const stale = await call("editor", "PATCH", `/assets/${asset.id}`, { version: 1, credit: "x" });
    expect([stale.statusCode, code(stale)]).toEqual([409, "CMS_VERSION_CONFLICT"]);
    const tooLong = await call("editor", "PATCH", `/assets/${asset.id}`, { version: 2, caption: { de: "x".repeat(301) } });
    expect(tooLong.statusCode).toBe(400);
    const found = (await call("viewer", "GET", "/assets?q=kalender")).json();
    expect(found.items.map((a: { id: string }) => a.id)).toEqual([asset.id]);

    const archived = (await call("editor", "POST", `/assets/${asset.id}/archive`, { version: 2 })).json();
    expect(archived).toMatchObject({ archived: true, version: 3 });
    expect((await call("viewer", "GET", "/assets")).json().items.some((a: { id: string }) => a.id === asset.id)).toBe(false);
    expect((await call("viewer", "GET", "/assets?archived=true")).json().items.map((a: { id: string }) => a.id)).toContain(asset.id);
    // An archived image cannot be put on a draft.
    const entry = (await call("editor", "POST", "/entries", { type: "article", locale: "de", title: "Bild" })).json().entry;
    const refused = await call("editor", "PATCH", `/entries/${entry.id}/draft`, { version: 1, heroAssetId: asset.id });
    expect([refused.statusCode, code(refused)]).toEqual([422, "CMS_REFERENCE_UNKNOWN"]);
    expect((await call("editor", "POST", `/assets/${asset.id}/unarchive`, { version: 3 })).json().archived).toBe(false);
    expect((await call("editor", "PATCH", `/entries/${entry.id}/draft`, { version: 1, heroAssetId: asset.id })).statusCode).toBe(200);
    // Another project of the workspace does not see the asset.
    const foreign = await call("owner", "GET", `/assets/${asset.id}`, undefined, otherProjectId);
    expect([foreign.statusCode, code(foreign)]).toEqual([404, "CMS_ASSET_NOT_FOUND"]);
  });

  it("shows members a private preview of each rendition", async () => {
    const { asset } = (await upload("editor", await noise(500, 400, 5).png().toBuffer())).json();
    const preview = await call("viewer", "GET", `/assets/${asset.id}/files/w480.webp`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/webp");
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect((await sharp(preview.rawPayload).metadata()).width).toBe(480);
    for (const bad of ["w480.jpg", "w1600.webp", "../original.jpg", "original"]) {
      const response = await call("viewer", "GET", `/assets/${asset.id}/files/${encodeURIComponent(bad)}`);
      expect(response.statusCode, bad).toBe(404);
    }
  });

  it("imports images from Drive and from Orbit files", async () => {
    drive.bytes = await noise(700, 500, 7).png().toBuffer();
    drive.meta["drive-file-0001"] = { id: "drive-file-0001", name: "Drive Bild.png", mimeType: "image/png" };
    drive.meta["drive-file-pdf1"] = { id: "drive-file-pdf1", name: "Doc.pdf", mimeType: "application/pdf" };
    const fromDrive = await call("editor", "POST", "/assets/import", { source: "drive", driveFileId: "drive-file-0001", alt: { de: "Aus Drive" } });
    expect(fromDrive.statusCode, fromDrive.body).toBe(201);
    expect(fromDrive.json().asset).toMatchObject({ name: "Drive Bild.jpg", alt: { de: "Aus Drive" } });
    const pdf = await call("editor", "POST", "/assets/import", { source: "drive", driveFileId: "drive-file-pdf1" });
    expect([pdf.statusCode, code(pdf)]).toEqual([415, "CMS_MEDIA_TYPE"]);
    expect(drive.downloads).toEqual(["drive-file-0001"]);
    const mixed = await call("editor", "POST", "/assets/import", { source: "drive", driveFileId: "drive-file-0001", fileId: randomUUID() });
    expect([mixed.statusCode, code(mixed)]).toEqual([422, "CMS_MEDIA_SOURCE_INVALID"]);

    // A Marketing file the editor may read becomes an asset; a file of the library is that asset.
    const marketing = await storeFile(ownerScope(), { moduleId: "marketing", bytes: await noise(600, 600, 9).png().toBuffer(), mime: "image/png", name: "banner.png" });
    const fromFile = await call("editor", "POST", "/assets/import", { source: "orbit_file", fileId: marketing.id });
    expect(fromFile.statusCode, fromFile.body).toBe(201);
    const variantFile = await run(async (tx) => {
      const row = await tx.cmsAsset.findFirstOrThrow({ where: { id: fromFile.json().asset.id } });
      return (row.variants as Array<{ name: string; fileId: string }>).find((v) => v.name === "og")!.fileId;
    });
    const own = await call("editor", "POST", "/assets/import", { source: "orbit_file", fileId: variantFile });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ duplicate: true, asset: { id: fromFile.json().asset.id } });
    const missing = await call("editor", "POST", "/assets/import", { source: "orbit_file", fileId: randomUUID() });
    expect(missing.statusCode).toBe(404);
  });

  it("serves public URLs only for images of live content, with public ingress", async () => {
    const { asset } = (await upload("editor", await noise(900, 600, 13).png().toBuffer())).json();
    const row = await run((tx) => tx.cmsAsset.findFirstOrThrow({ where: { id: asset.id } }));
    const url = cmsMediaUrl({ projectId }, row, "w960");
    expect(url).toMatch(/\/api\/public\/cms\/media\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}\/w960\.webp$/);
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    expect((await publicGet(url)).statusCode).toBe(404);

    await liveWithHero(asset.id);
    const served = await publicGet(url);
    expect(served.statusCode).toBe(200);
    expect(served.headers).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    });
    expect((await publicGet(cmsMediaUrl({ projectId }, row, "og"))).headers["content-type"]).toBe("image/jpeg");
    // The wrong extension, a forged token, another project's token: the same 404.
    expect((await publicGet(url.replace("w960.webp", "w960.jpg"))).statusCode).toBe(404);
    const [, , , , , , token] = new URL(url).pathname.split("/");
    const forged = `${token!.slice(0, -2)}${token!.endsWith("A") ? "B" : "A"}A`;
    expect((await publicGet(url.replace(token!, forged))).statusCode).toBe(404);
    expect((await publicGet(cmsMediaUrl({ projectId: otherProjectId }, row, "w960"))).statusCode).toBe(404);
    // Without public ingress or with the module off, nothing is served.
    delete process.env.ORBIT_PUBLIC_INGRESS;
    expect((await publicGet(url)).statusCode).toBe(404);
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    delete process.env.ORBIT_CMS;
    expect((await publicGet(url)).statusCode).toBe(404);
    process.env.ORBIT_CMS = "true";

    // A body image of a live revision is public too; withdrawing it ends that.
    const body = (await upload("editor", await noise(500, 500, 17).png().toBuffer())).json().asset;
    const bodyRow = await run((tx) => tx.cmsAsset.findFirstOrThrow({ where: { id: body.id } }));
    const bodyUrl = cmsMediaUrl({ projectId }, bodyRow, "original");
    const entryId = await liveWithHero(asset.id);
    const draft = (await call("editor", "GET", `/entries/${entryId}`)).json().draft;
    await call("editor", "PATCH", `/entries/${entryId}/draft`, {
      version: draft.version,
      body: { schema: "orbit-doc", version: 1, blocks: [{ type: "image", assetId: body.id }] },
    });
    expect((await publicGet(bodyUrl)).statusCode).toBe(404);
    const revision = (await call("editor", "POST", `/entries/${entryId}/revisions`, {})).json().revision;
    await run((tx) => tx.cmsEntry.update({ where: { id: entryId }, data: { publishedRevisionId: revision.id } }));
    expect((await publicGet(bodyUrl)).statusCode).toBe(200);
    await run((tx) =>
      tx.cmsEntry.update({ where: { id: entryId }, data: { status: "archived", publishedRevisionId: null, archivedAt: new Date() } }),
    );
    expect((await publicGet(bodyUrl)).statusCode).toBe(404);
  });

  it("labels an AI image before its renditions are stored and keeps the label in every stored one", async () => {
    process.env.ORBIT_AI_IMAGE_LABELS = "true";
    const declared = await noise(1200, 900, 23).png().withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" })).toBuffer();
    const { asset } = await ingestAsset(ownerScope(), { bytes: declared }, { source: "upload" });
    expect(asset.aiLabel).toEqual({ origin: "ai_generated", labelState: "labeled" });
    const row = await run((tx) => tx.cmsAsset.findFirstOrThrow({ where: { id: asset.id } }));
    const original = await run((tx) => imageProvenance(tx, ownerScope(), row.sha256));
    const box = original!.labelBox as RelBox;
    expect(asset.renditions.length).toBeGreaterThanOrEqual(3);
    for (const rendition of asset.renditions) {
      const ext = rendition.mime === "image/webp" ? "webp" : "jpg";
      const { bytes } = await assetContent(ownerScope(), asset.id, `${rendition.name}.${ext}`);
      expect((await verifyAiLabel(Buffer.from(bytes), box)).ok, rendition.name).toBe(true);
    }
    // Public only while live, and then with its label.
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    await liveWithHero(asset.id);
    expect((await publicGet(cmsMediaUrl({ projectId }, row, "original"))).statusCode).toBe(200);
  });

  it("refuses raw generated art without a label and records nothing for it", async () => {
    process.env.ORBIT_AI_IMAGE_LABELS = "true";
    const raw = await noise(800, 600, 29).png().toBuffer();
    const { recordUnlabeledSource } = await import("../src/platform/provenance/image-provenance.ts");
    await run((tx) =>
      recordUnlabeledSource(tx, ownerScope(), { bytes: raw, origin: "ai_generated", subject: { module: "marketing", kind: "asset", id: "x" }, createdBy: ids.owner }),
    );
    const before = await run((tx) => tx.cmsAsset.count({ where: { projectId } }));
    await expect(ingestAsset(ownerScope(), { bytes: raw }, { source: "upload" })).rejects.toMatchObject({ code: "AI_LABEL_MISSING", status: 409 });
    expect(await run((tx) => tx.cmsAsset.count({ where: { projectId } }))).toBe(before);
  });
});
