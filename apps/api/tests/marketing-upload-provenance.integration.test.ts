import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The project's Drive is a mock: the Drive upload path stores nothing at Google.
const drive = vi.hoisted(() => ({ uploads: [] as Buffer[] }));
vi.mock(
  "../src/platform/connections/google-drive.ts",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    driveStorage: async () => ({ rootFolderId: "synthetic-root" }),
    driveAccessToken: async () => "synthetic-token",
    driveContains: async () => true,
    driveJson: async (_url: string, _token: string, init?: { body?: Buffer }) => {
      if (init?.body) drive.uploads.push(init.body);
      return {
        id: `synthetic-file-${drive.uploads.length}`,
        name: "synthetic.png",
        mimeType: "image/png",
        md5Checksum: "0".repeat(32),
        modifiedTime: new Date().toISOString(),
      };
    },
  }),
);

import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { provenanceXmp } from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { imageProvenance } from "../src/platform/provenance/image-provenance.ts";
import { uploadUserRaster } from "../src/modules/marketing/brand/drive-assets.ts";
import { preflight } from "../src/modules/marketing/policy/policy.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(
  new URL("../../../packages/creative/package.json", import.meta.url),
)("sharp") as Sharp;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const AI_XMP = provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" });

/** A PNG with an embedded C2PA manifest store (a `caBX` chunk) naming an AI source. */
function withC2pa(png: Buffer, payload: Buffer) {
  const type = Buffer.from("caBX", "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0);
  const iend = png.length - 12;
  return Buffer.concat([
    png.subarray(0, iend),
    length,
    type,
    payload,
    crc,
    png.subarray(iend),
  ]);
}

// ADR 0028 §6 in Marketing: an upload whose own XMP/C2PA declares AI is AI
// source material; any other upload is an original and never gets a label.
describe.skipIf(!enabled)("Marketing upload provenance (ADR 0028 §6)", () => {
  type Project = Awaited<ReturnType<typeof createPackageProject>>;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let p: Project;
  let art: Buffer;
  const owner = { id: "", cookie: "" };
  const saved = process.env.ORBIT_AI_IMAGE_LABELS;
  const setLabels = (on: boolean) => {
    process.env.ORBIT_AI_IMAGE_LABELS = on ? "true" : "false";
  };
  const runIn = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(p.owner.workspaceId, p.owner.projectId, work);
  /** Distinct small PNG bytes per step (records follow the exact bytes). */
  const image = (step: number) =>
    sharp(art)
      .resize(320, 320)
      .modulate({ brightness: 1 + step * 0.03 })
      .png();
  const body = (bytes: Buffer) => ({
    name: "Synthetic upload",
    type: "photo",
    mime: "image/png",
    base64: bytes.toString("base64"),
    source: "Synthetic fixture",
    license: "Synthetic rights fixture",
    validUses: ["brand", "social"],
    confirmRightsInformation: true,
  });
  /** Uploads through the asset route, as the owner does; returns the stored asset. */
  const upload = async (bytes: Buffer) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/projects/${p.owner.projectId}/assets/upload`,
      headers: { origin: process.env.APP_ORIGIN!, cookie: owner.cookie },
      payload: body(bytes),
    });
    expect(r.statusCode).toBe(201);
    return runIn((tx) => entity(tx, p.owner, "assets", r.json().id));
  };
  const recordOf = (row: { data: unknown }) =>
    runIn((tx) => imageProvenance(tx, p.owner, String(data(row).sha256)));
  /** Preflight blockers of a post carrying the asset once the owner approved it. */
  const blockersWith = async (row: { id: string }) => {
    const contentId = await runIn(async (tx) => {
      const current = await entity(tx, p.owner, "assets", row.id);
      await update(tx, p.owner, current, {
        ...data(current),
        assetStatus: "approved",
        usageApproved: true,
      });
      const evidence = await create(tx, p.owner, "evidence", {
        status: "ready",
        purpose: "public",
        facts: [],
        items: [],
      });
      const content = await create(tx, p.owner, "content", {
        title: "Evenings feel softer",
        body: `Evenings feel softer in warm light ${randomUUID()}.`,
        type: "social",
        channel: X,
        status: "reviewed",
        evidenceId: evidence.id,
        claims: [],
        assetId: row.id,
      });
      return content.id;
    });
    return (await runIn((tx) => preflight(tx, p.owner, contentId, { test: true })))
      .blockers;
  };

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const email = `${randomUUID()}@example.invalid`;
    const signedUp = await auth.api.signUpEmail({
      body: { email, name: "Synthetic upload owner", password },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: process.env.APP_ORIGIN! },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    const cookies = r.headers["set-cookie"];
    owner.id = signedUp.user.id;
    owner.cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
    p = await createPackageProject({ name: "Synthetic upload provenance" });
    await authDb.workspaceMember.create({
      data: { workspaceId: p.owner.workspaceId, userId: owner.id, role: "viewer" },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        userId: owner.id,
        role: "owner",
      },
    });
    art = (await fixtureArt("good", "lumora")).bytes;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ORBIT_AI_IMAGE_LABELS;
    else process.env.ORBIT_AI_IMAGE_LABELS = saved;
  });
  afterAll(async () => {
    await p?.cleanup();
    await authDb.user.deleteMany({ where: { id: owner.id } });
    await app?.close();
    await closeDatabase();
  });

  it("records an upload whose XMP declares AI as unlabelled AI source and blocks it raw in preflight", async () => {
    setLabels(true);
    const declared = await image(1).withXmp(AI_XMP).toBuffer();
    const row = await upload(declared);
    const d = data(row);
    // The stored bytes are normalized (metadata stripped), yet stay AI.
    expect(d.metadataStripped).toBe(true);
    expect(d.sha256).not.toBe(sha(declared));
    expect(d.aiProvenance).toEqual({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      digitalSourceType: "trainedAlgorithmicMedia",
    });
    expect(d.aiLabel).toBeUndefined();
    const record = await recordOf(row);
    expect(record).toMatchObject({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      subjectModule: "marketing",
      subjectKind: "asset",
      subjectId: row.id,
    });
    // The record keeps what the original bytes declared.
    expect(record!.embedded).toMatchObject({
      sha256: sha(declared),
      declaresAi: true,
      xmp: { digitalSourceType: "trainedAlgorithmicMedia" },
    });
    expect(await blockersWith(row)).toContain("AI_LABEL_MISSING");
  });

  it("keeps the C2PA manifest store of an AI-declaring upload with the record", async () => {
    setLabels(true);
    const payload = Buffer.from(
      "jumbc2pa synthetic manifest store trainedAlgorithmicMedia",
      "latin1",
    );
    const declared = withC2pa(await image(2).toBuffer(), payload);
    const row = await upload(declared);
    expect(data(row).aiProvenance).toMatchObject({
      labelState: "unlabeled_source",
    });
    const record = await recordOf(row);
    expect(record).toMatchObject({ labelState: "unlabeled_source" });
    expect(record!.embedded?.c2pa).toMatchObject({
      present: true,
      declaresAi: true,
      sha256: sha(payload),
    });
    expect(record!.c2paManifest?.equals(payload)).toBe(true);
  });

  it("records a plain upload as original, never labelled, and lets preflight pass it", async () => {
    setLabels(true);
    const row = await upload(await image(3).toBuffer());
    expect(data(row).aiProvenance).toBeUndefined();
    expect(data(row).aiLabel).toBeUndefined();
    expect(await recordOf(row)).toMatchObject({
      origin: "original_upload",
      labelState: "not_required",
      labelBox: null,
      subjectId: row.id,
    });
    const blockers = await blockersWith(row);
    expect(blockers).not.toContain("AI_LABEL_MISSING");
    expect(blockers).not.toContain("AI_LABEL_INVALID");
    expect(blockers).not.toContain("ASSET_NOT_APPROVED_OR_UNSUPPORTED");
  });

  it("changes nothing with the label flag off", async () => {
    setLabels(false);
    const declared = await upload(await image(4).withXmp(AI_XMP).toBuffer());
    const plain = await upload(await image(5).toBuffer());
    for (const row of [declared, plain]) {
      expect(data(row).aiProvenance).toBeUndefined();
      expect(await recordOf(row)).toBeNull();
    }
    expect(await blockersWith(declared)).not.toContain("AI_LABEL_MISSING");
  });

  it("records the bytes a Drive upload stores, by what the original declared", async () => {
    setLabels(true);
    drive.uploads = [];
    const declared = await uploadUserRaster(
      p.owner,
      body(await image(6).withXmp(AI_XMP).toBuffer()),
    );
    const plain = await uploadUserRaster(p.owner, body(await image(7).toBuffer()));
    expect(drive.uploads).toHaveLength(2);
    expect(data(declared).aiProvenance).toMatchObject({
      origin: "ai_generated",
      labelState: "unlabeled_source",
    });
    expect(await recordOf(declared)).toMatchObject({
      origin: "ai_generated",
      labelState: "unlabeled_source",
      subjectId: declared.id,
    });
    expect(data(plain).aiProvenance).toBeUndefined();
    expect(await recordOf(plain)).toMatchObject({
      origin: "original_upload",
      labelState: "not_required",
    });
    // Off: no fields, no record.
    setLabels(false);
    const off = await uploadUserRaster(
      p.owner,
      body(await image(8).withXmp(AI_XMP).toBuffer()),
    );
    expect(data(off).aiProvenance).toBeUndefined();
    expect(await recordOf(off)).toBeNull();
  });
});
