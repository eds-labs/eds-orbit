import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { provenanceXmp } from "../../../packages/creative/src/index.ts";
import type { Sharp } from "../../../packages/creative/src/raster.ts";
import {
  aiImageLabelsEnabled,
  assertAiLabelPublishable,
  imageProvenance,
  labelFinalImage,
  recordDerivedImage,
  recordImageProvenance,
  recordOriginalUpload,
  recordUnlabeledSource,
} from "../src/platform/provenance/image-provenance.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// apps/api has no sharp dependency; the fixtures use the creative package's.
const sharp = createRequire(
  new URL("../../../packages/creative/package.json", import.meta.url),
)("sharp") as Sharp;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic noise (mulberry32), so a busy background never makes a test flaky. */
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

const subject = { module: "marketing", kind: "asset", id: "synthetic" };

// ADR 0028: the central record of each image version and the publish gate.
describe.skipIf(!enabled)("image provenance (ADR 0028)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let a: Scope, b: Scope;
  const flag = process.env.ORBIT_AI_IMAGE_LABELS;
  const run = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, work);
  const setFlag = (value: "true" | "false") => {
    process.env.ORBIT_AI_IMAGE_LABELS = value;
  };

  beforeAll(async () => {
    const owner = await authDb.user.create({
      data: { id: randomUUID(), name: "Owner", email: `${randomUUID()}@example.invalid` },
    });
    users.push(owner.id);
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic provenance", members: { create: { userId: owner.id, role: "owner" } } },
    });
    workspaces.push(workspace.id);
    const [pa, pb] = [
      await authDb.project.create({ data: { workspaceId: workspace.id, name: "A" } }),
      await authDb.project.create({ data: { workspaceId: workspace.id, name: "B" } }),
    ];
    a = { workspaceId: workspace.id, projectId: pa.id, userId: owner.id, role: "owner" };
    b = { ...a, projectId: pb.id };
  });
  afterEach(() => {
    if (flag === undefined) delete process.env.ORBIT_AI_IMAGE_LABELS;
    else process.env.ORBIT_AI_IMAGE_LABELS = flag;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("reads the flag from the configuration on every call", () => {
    setFlag("false");
    expect(aiImageLabelsEnabled()).toBe(false);
    setFlag("true");
    expect(aiImageLabelsEnabled()).toBe(true);
  });

  it("records raw generated art and returns the first record for the same bytes", async () => {
    const raw = await noise(640, 480, 1).png().toBuffer();
    const row = await run(a, (tx) =>
      recordUnlabeledSource(tx, a, { bytes: raw, origin: "ai_generated", subject, createdBy: a.userId }),
    );
    expect(row).toMatchObject({
      sha256: sha(raw),
      origin: "ai_generated",
      labelState: "unlabeled_source",
      labelBox: null,
      digitalSourceType: "trainedAlgorithmicMedia",
      subjectModule: "marketing",
      embedded: { format: "png", width: 640, height: 480, declaresAi: false, c2pa: null },
    });
    expect(await run(a, (tx) => imageProvenance(tx, a, sha(raw)))).toEqual(row);
    // A later, different claim about the same bytes does not replace it.
    const again = await run(a, (tx) =>
      recordImageProvenance(tx, a, {
        sha256: sha(raw),
        origin: "original_upload",
        labelState: "not_required",
        subject,
        createdBy: a.userId,
      }),
    );
    expect(again).toEqual(row);
  });

  it("refuses inconsistent records", async () => {
    await expect(
      run(a, (tx) =>
        recordImageProvenance(tx, a, {
          sha256: "1".repeat(64),
          origin: "ai_generated",
          labelState: "labeled",
          subject,
          createdBy: a.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "IMAGE_PROVENANCE_INVALID", status: 422 });
    await expect(
      run(a, (tx) =>
        recordImageProvenance(tx, a, {
          sha256: "2".repeat(64),
          origin: "ai_generated",
          labelState: "not_required",
          subject,
          createdBy: a.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "IMAGE_PROVENANCE_INVALID", status: 422 });
  });

  it("keeps records inside their project", async () => {
    const raw = await noise(320, 240, 2).png().toBuffer();
    await run(a, (tx) =>
      recordUnlabeledSource(tx, a, { bytes: raw, origin: "ai_generated", subject, createdBy: a.userId }),
    );
    expect(await run(b, (tx) => imageProvenance(tx, b, sha(raw)))).toBeNull();
    // Even asked for project A's id, B's transaction sees no row.
    expect(
      await run(b, (tx) =>
        tx.imageProvenance.count({ where: { projectId: a.projectId } }),
      ),
    ).toBe(0);
    // B may record the same bytes for itself.
    const own = await run(b, (tx) =>
      recordUnlabeledSource(tx, b, { bytes: raw, origin: "ai_substantially_modified", subject, createdBy: b.userId }),
    );
    expect(own).toMatchObject({ projectId: b.projectId, origin: "ai_substantially_modified" });
  });

  it("labels a final image once, and never twice", async () => {
    const raw = await noise(800, 600, 3).png().toBuffer();
    const first = await run(a, (tx) =>
      labelFinalImage(tx, a, {
        bytes: raw,
        origin: "ai_generated",
        composite: true,
        subject,
        createdBy: a.userId,
        componentSha256s: ["3".repeat(64)],
      }),
    );
    expect(first.result.alreadyLabeled).toBe(false);
    expect(first.provenance).toMatchObject({
      sha256: first.result.sha256,
      origin: "ai_generated",
      labelState: "labeled",
      labelVersion: 1,
      labelBox: first.result.label.box,
      digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
      parentSha256: sha(raw),
      componentSha256s: ["3".repeat(64)],
    });
    expect(first.provenance.labelContrast).toBeGreaterThanOrEqual(3);

    // The labelled output again: verified via its XMP and returned unchanged.
    const second = await run(a, (tx) =>
      labelFinalImage(tx, a, { bytes: first.result.bytes, origin: "ai_generated", subject, createdBy: a.userId }),
    );
    expect(second.result.alreadyLabeled).toBe(true);
    expect(second.result.bytes.equals(first.result.bytes)).toBe(true);
    expect(second.provenance.id).toBe(first.provenance.id);

    // A re-encode without metadata: the record of the derived bytes carries
    // the box, so labelling it again verifies instead of drawing a second label.
    const stripped = await sharp(first.result.bytes).png({ compressionLevel: 6 }).toBuffer();
    expect(stripped.equals(first.result.bytes)).toBe(false);
    const derived = await run(a, (tx) =>
      recordDerivedImage(tx, a, {
        sourceSha256: first.result.sha256,
        bytes: stripped,
        subject: { module: "social", kind: "media", id: "synthetic" },
        createdBy: a.userId,
      }),
    );
    expect(derived).toMatchObject({ labelState: "labeled", labelBox: first.result.label.box });
    const third = await run(a, (tx) =>
      labelFinalImage(tx, a, { bytes: stripped, origin: "ai_generated", subject, createdBy: a.userId }),
    );
    expect(third.result.alreadyLabeled).toBe(true);
    expect(third.result.bytes.equals(stripped)).toBe(true);
    expect(third.provenance.id).toBe(derived!.id);
  });

  it("surfaces engine refusals with the engine's code", async () => {
    await expect(
      run(a, (tx) =>
        labelFinalImage(tx, a, { bytes: Buffer.from("not an image"), origin: "ai_generated", subject, createdBy: a.userId }),
      ),
    ).rejects.toMatchObject({ code: "AI_LABEL_INPUT_INVALID", status: 422 });
    // A recorded label that no longer verifies is not covered by a second one.
    const raw = await noise(800, 600, 4).png().toBuffer();
    const labelled = await run(a, (tx) =>
      labelFinalImage(tx, a, { bytes: raw, origin: "ai_generated", subject, createdBy: a.userId }),
    );
    const { x, y, w, h } = labelled.result.label.pixels;
    // Painted over, with the label's XMP kept.
    const xmp = (await sharp(labelled.result.bytes).metadata()).xmp!.toString("utf8");
    const covered = await sharp(labelled.result.bytes)
      .composite([{ input: await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer(), left: x, top: y }])
      .withXmp(xmp)
      .png()
      .toBuffer();
    await expect(
      run(a, (tx) =>
        labelFinalImage(tx, a, { bytes: covered, origin: "ai_generated", subject, createdBy: a.userId }),
      ),
    ).rejects.toMatchObject({ code: "AI_LABEL_INVALID", status: 409 });
  });

  it("records derived renditions with their source's origin", async () => {
    const raw = await noise(1200, 900, 5).jpeg({ quality: 92 }).toBuffer();
    const labelled = await run(a, (tx) =>
      labelFinalImage(tx, a, { bytes: raw, origin: "ai_substantially_modified", subject, createdBy: a.userId }),
    );
    const small = await sharp(labelled.result.bytes).resize({ width: 900 }).jpeg({ quality: 85 }).toBuffer();
    const derived = await run(a, (tx) =>
      recordDerivedImage(tx, a, { sourceSha256: labelled.result.sha256, bytes: small, subject, createdBy: a.userId }),
    );
    expect(derived).toMatchObject({
      sha256: sha(small),
      origin: "ai_substantially_modified",
      labelState: "labeled",
      labelBox: labelled.result.label.box,
      parentSha256: labelled.result.sha256,
    });

    const { x, y, w, h } = labelled.result.label.pixels;
    // The label painted over first, then the same rendition (sharp resizes
    // before it composites, so these are two steps).
    const painted = await sharp(labelled.result.bytes)
      .composite([{ input: await sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), left: x, top: y }])
      .png()
      .toBuffer();
    const broken = await sharp(painted)
      .resize({ width: 900 })
      .jpeg({ quality: 85 })
      .toBuffer();
    await expect(
      run(a, (tx) =>
        recordDerivedImage(tx, a, { sourceSha256: labelled.result.sha256, bytes: broken, subject, createdBy: a.userId }),
      ),
    ).rejects.toMatchObject({ code: "AI_LABEL_INVALID", status: 409 });

    // An original source gives an original rendition; an unknown source none.
    const photo = await noise(640, 480, 6).png().toBuffer();
    const upload = await run(a, (tx) => recordOriginalUpload(tx, a, { bytes: photo, subject, createdBy: a.userId }));
    expect(upload.declaresAi).toBe(false);
    const jpeg = await sharp(photo).jpeg({ quality: 85 }).toBuffer();
    expect(
      await run(a, (tx) =>
        recordDerivedImage(tx, a, { sourceSha256: sha(photo), bytes: jpeg, subject, createdBy: a.userId }),
      ),
    ).toMatchObject({ origin: "original_upload", labelState: "not_required", parentSha256: sha(photo) });
    expect(
      await run(a, (tx) =>
        recordDerivedImage(tx, a, { sourceSha256: "4".repeat(64), bytes: jpeg, subject, createdBy: a.userId }),
      ),
    ).toBeNull();
  });

  it("treats an upload that declares AI as AI, and a plain one as original", async () => {
    const declared = await noise(640, 480, 7)
      .withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" }))
      .jpeg({ quality: 90 })
      .toBuffer();
    const ai = await run(a, (tx) => recordOriginalUpload(tx, a, { bytes: declared, subject, createdBy: a.userId }));
    expect(ai).toMatchObject({ declaresAi: true, provenance: null });
    expect(await run(a, (tx) => imageProvenance(tx, a, sha(declared)))).toBeNull();

    const photo = await noise(640, 480, 8).jpeg({ quality: 90 }).toBuffer();
    const plain = await run(a, (tx) => recordOriginalUpload(tx, a, { bytes: photo, subject, createdBy: a.userId }));
    expect(plain).toMatchObject({
      declaresAi: false,
      provenance: { sha256: sha(photo), origin: "original_upload", labelState: "not_required" },
    });
  });

  describe("the publish gate", () => {
    let labelled: Buffer, raw: Buffer, photo: Buffer, declared: Buffer;
    beforeAll(async () => {
      raw = await noise(800, 600, 9).png().toBuffer();
      await run(a, (tx) =>
        recordUnlabeledSource(tx, a, { bytes: raw, origin: "ai_generated", subject, createdBy: a.userId }),
      );
      labelled = (
        await run(a, (tx) =>
          labelFinalImage(tx, a, { bytes: raw, origin: "ai_generated", subject, createdBy: a.userId }),
        )
      ).result.bytes;
      photo = await noise(800, 600, 10).png().toBuffer();
      declared = await noise(800, 600, 11)
        .withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" }))
        .png()
        .toBuffer();
    });
    const gate = (bytes: Buffer, declaredOrigin?: "ai_generated" | "original_upload" | null) =>
      run(a, (tx) =>
        assertAiLabelPublishable(tx, a, { bytes, declaredOrigin, context: "test.publish" }),
      );

    it("checks nothing while the flag is off", async () => {
      setFlag("false");
      expect(await gate(raw)).toEqual({ checked: false });
      expect(await gate(declared, "ai_generated")).toEqual({ checked: false });
    });

    it("passes a labelled AI image and a plain upload", async () => {
      setFlag("true");
      expect(await gate(labelled)).toEqual({ checked: true, origin: "ai_generated", labelState: "labeled" });
      expect(await gate(photo)).toEqual({ checked: true, origin: null, labelState: "not_declared" });
      expect(await gate(photo, "original_upload")).toEqual({
        checked: true,
        origin: "original_upload",
        labelState: "not_declared",
      });
    });

    it("blocks AI images without a label", async () => {
      setFlag("true");
      // Recorded AI art without a label.
      await expect(gate(raw)).rejects.toMatchObject({
        code: "AI_LABEL_MISSING",
        status: 409,
        detail: { context: "test.publish", sha256: sha(raw) },
      });
      // Unrecorded bytes the caller declares as AI.
      await expect(gate(photo, "ai_generated")).rejects.toMatchObject({ code: "AI_LABEL_MISSING" });
      // Bytes whose own XMP declares AI.
      await expect(gate(declared)).rejects.toMatchObject({ code: "AI_LABEL_MISSING" });
    });

    it("requires the label when the caller declares AI over an original_upload record", async () => {
      setFlag("true");
      const same = await noise(640, 480, 23).png().toBuffer();
      await run(a, (tx) =>
        recordOriginalUpload(tx, a, {
          bytes: same,
          subject: { module: "test", kind: "upload", id: "plain" },
          createdBy: a.userId,
        }),
      );
      expect(await gate(same)).toMatchObject({ checked: true, labelState: "not_declared" });
      // The same pixels uploaded again with an AI declaration (asset aiProvenance).
      await expect(gate(same, "ai_generated")).rejects.toMatchObject({ code: "AI_LABEL_MISSING" });
    });

    it("blocks a recorded label that no longer verifies", async () => {
      setFlag("true");
      // The labelled image's XMP stripped and the label painted over.
      const meta = await sharp(labelled).metadata();
      const covered = await sharp(labelled)
        .composite([
          {
            input: await sharp({ create: { width: meta.width!, height: Math.round(meta.height! / 4), channels: 3, background: { r: 30, g: 30, b: 30 } } }).png().toBuffer(),
            left: 0,
            top: meta.height! - Math.round(meta.height! / 4),
          },
        ])
        .png()
        .toBuffer();
      const derivedFails = run(a, (tx) =>
        recordDerivedImage(tx, a, { sourceSha256: sha(labelled), bytes: covered, subject, createdBy: a.userId }),
      );
      await expect(derivedFails).rejects.toMatchObject({ code: "AI_LABEL_INVALID" });
      // Its record says labelled at a box (written directly, as a forged copy would claim).
      const box = (await run(a, (tx) => imageProvenance(tx, a, sha(labelled))))!.labelBox!;
      await run(a, (tx) =>
        recordImageProvenance(tx, a, {
          sha256: sha(covered),
          origin: "ai_generated",
          labelState: "labeled",
          labelVersion: 1,
          labelBox: box,
          subject,
          createdBy: a.userId,
        }),
      );
      await expect(gate(covered)).rejects.toMatchObject({ code: "AI_LABEL_INVALID", status: 409 });
    });

    it("writes a content-free audit record when the caller keeps its transaction", async () => {
      setFlag("true");
      const audits = await run(a, async (tx) => {
        await assertAiLabelPublishable(tx, a, { bytes: raw, context: "social.deliver" }).catch(
          (error: { code?: string }) => expect(error.code).toBe("AI_LABEL_MISSING"),
        );
        return tx.auditEvent.findMany({
          where: { projectId: a.projectId, action: "image.ai_label.blocked", resourceId: sha(raw) },
        });
      });
      expect(audits.at(-1)?.metadata).toEqual({
        code: "AI_LABEL_MISSING",
        context: "social.deliver",
        origin: "ai_generated",
        recorded: true,
      });
    });
  });
});
