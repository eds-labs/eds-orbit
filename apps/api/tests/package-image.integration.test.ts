import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  CREATIVE_FORMATS,
  renderRasterTemplate,
} from "../../../packages/creative/src/index.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import {
  decideActionRequest,
  listActionRequests,
} from "../src/modules/action-requests.ts";
import { deterministicDraft } from "../src/modules/workflow.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { runImageJob } from "../src/modules/image-requests.ts";
import {
  packageSnapshot,
  requestContentPackage,
} from "../src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../src/modules/agents/package-schedule.ts";
import { attachPackageImage } from "../src/modules/agents/package-image.ts";
import {
  CREATIVES,
  findCreative,
  type CreativeRecord,
} from "../src/modules/marketing/creative/store.ts";
import {
  addBrandKit,
  PACKAGE_CREATIVE_COPY,
} from "./support/package-creative.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const IMAGE_BRIEF =
  "A calm abstract artwork of an open door made of soft light, no text.";

describe.skipIf(!enabled)("Package image in a post (J3.3)", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let png: Buffer;
  const studioFlag = process.env.ORBIT_CREATIVE_STUDIO;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const snapshot = (packageId: string) =>
    run(async (tx) =>
      packageSnapshot(
        tx,
        project.owner,
        await entity(tx, project.owner, "content_packages", packageId),
      ),
    );
  const deliverable = async (packageId: string, key: string) =>
    (await snapshot(packageId)).deliverables.find((d) => d.key === key)!;
  // The owner's existing "approve rights & use" decision on the asset.
  const approveRights = (assetId: string) =>
    run(async (tx) => {
      const asset = await entity(tx, project.owner, "assets", assetId);
      await update(tx, project.owner, asset, {
        ...data(asset),
        assetStatus: "approved",
        usageApproved: true,
      });
    });
  // An owner's started X and Telegram package with drafts and a generated image.
  const packageWithImage = async (bytes = png) => {
    const { owner } = project;
    const thread = await createConversation(owner);
    const { package: pkg, actionRequest } = await requestContentPackage(
      owner,
      thread.id,
      {
        goal: "Announce that beta access is open",
        channels: [X, TELEGRAM],
        factKeys: ["beta.access"],
        imageBrief: IMAGE_BRIEF,
      },
    );
    await run((tx) =>
      decideActionRequest(tx, owner, actionRequest.id, {
        version: actionRequest.version,
        packageHash: data(actionRequest).packageHash,
        decision: "approve",
      }),
    );
    const steps = data(
      await run((tx) => entity(tx, owner, "content_packages", pkg.id)),
    ).steps as Array<Record<string, any>>;
    await run(async (tx) => {
      for (const step of steps.filter((s) => s.kind === "copy"))
        await deterministicDraft(tx, owner, step.missionId, step.jobId);
    });
    const imageRequestId = steps.find((s) => s.kind === "image")!
      .actionRequestId as string;
    const imageJob = (await run((tx) => list(tx, owner, "jobs"))).find(
      (job) => data(job).resourceId === imageRequestId,
    )!;
    await runImageJob(
      worker(),
      owner.userId,
      imageRequestId,
      imageJob.id,
      (async () => ({
        bytes,
        model: IMAGE_MODEL,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        usage: null,
      })) as never,
    );
    await run((tx) => sweepProject(tx, worker()));
    const image = (await snapshot(pkg.id)).image!;
    return { thread, pkg, assetId: image.assetId! };
  };

  beforeAll(async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    png = rendered.bytes;
  });
  // A fresh project per case: equal drafts in one project would block as duplicates.
  beforeEach(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    project = await createPackageProject();
  });
  afterEach(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    if (studioFlag === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
    else process.env.ORBIT_CREATIVE_STUDIO = studioFlag;
    await project.cleanup();
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("attaches nothing before the owner approved the image's usage rights", async () => {
    const { pkg, assetId } = await packageWithImage();
    expect((await snapshot(pkg.id)).image).toMatchObject({
      status: "generated",
      rightsApproved: false,
    });
    await expect(
      attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] }),
    ).rejects.toThrow("ASSET_RIGHTS_REQUIRED");
    expect((await deliverable(pkg.id, X)).content!.assetId).toBeNull();
    await approveRights(assetId);
    expect((await snapshot(pkg.id)).image!.rightsApproved).toBe(true);
  });

  it("attaches the approved image to the chosen draft and reviews it again", async () => {
    const { pkg, assetId } = await packageWithImage();
    await approveRights(assetId);
    const before = (await deliverable(pkg.id, X)).content!;
    await attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] });
    const after = await deliverable(pkg.id, X);
    expect(after.content).toMatchObject({ id: before.id, assetId });
    expect(after.content!.version).toBeGreaterThan(before.version as number);
    // A fresh automatic review of the draft with its image.
    expect(after.review).toMatchObject({ valid: expect.any(Boolean) });
    expect(after.content!.status).not.toBe("draft");
    // Other drafts stay without the image.
    expect((await deliverable(pkg.id, TELEGRAM)).content!.assetId).toBeNull();
    // Attaching the same image again changes nothing.
    await attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] });
    expect((await deliverable(pkg.id, X)).content!.version).toBe(
      after.content!.version,
    );
  });

  it("refuses a Telegram draft longer than the caption limit and keeps it unchanged", async () => {
    const { pkg, assetId } = await packageWithImage();
    await approveRights(assetId);
    const telegram = (await deliverable(pkg.id, TELEGRAM)).content!;
    await run(async (tx) => {
      const row = await entity(
        tx,
        project.owner,
        "content",
        telegram.id as string,
      );
      await update(tx, project.owner, row, {
        ...data(row),
        body: `${data(row).body} ${"More detail. ".repeat(90)}`,
      });
    });
    await expect(
      attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: [X, TELEGRAM],
      }),
    ).rejects.toThrow("CAPTION_TOO_LONG");
    // All or nothing: the X draft did not get the image either.
    expect((await deliverable(pkg.id, X)).content!.assetId).toBeNull();
    expect((await deliverable(pkg.id, TELEGRAM)).content!.assetId).toBeNull();
  });

  it("makes an open schedule proposal and earlier approvals stale", async () => {
    const { thread, pkg, assetId } = await packageWithImage();
    await approveRights(assetId);
    const proposed = await proposeSchedule(project.owner, thread.id, {
      deliverableKey: X,
    });
    const contentId = (await deliverable(pkg.id, X)).content!.id as string;
    const approval = await run((tx) =>
      create(tx, project.owner, "approvals", {
        contentId,
        packageHash: "f".repeat(64),
        status: "approved",
        userId: project.owner.userId,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    );
    await attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] });
    expect((await deliverable(pkg.id, X)).schedule).toMatchObject({
      status: "stale",
    });
    expect(
      data(
        await run((tx) => entity(tx, project.owner, "approvals", approval.id)),
      ).status,
    ).toBe("blocked_dependency");
    const item = (
      await run((tx) => listActionRequests(tx, project.owner))
    ).find((candidate) => candidate.id === proposed.actionRequestId)!;
    await expect(
      run((tx) =>
        decideActionRequest(tx, project.owner, item.id, {
          version: item.version,
          packageHash: item.packageHash,
          decision: "approve",
        }),
      ),
    ).rejects.toThrow("SCHEDULE_STALE");
  });

  it("schedules a post with its image, and refuses a change once it is scheduled", async () => {
    const { thread, pkg, assetId } = await packageWithImage();
    await approveRights(assetId);
    await attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] });
    const proposed = await proposeSchedule(project.owner, thread.id, {
      deliverableKey: X,
    });
    const item = (
      await run((tx) => listActionRequests(tx, project.owner))
    ).find((candidate) => candidate.id === proposed.actionRequestId)!;
    expect(item.summary).toMatchObject({ assetId });
    await run((tx) =>
      decideActionRequest(tx, project.owner, item.id, {
        version: item.version,
        packageHash: item.packageHash,
        decision: "approve",
      }),
    );
    expect((await deliverable(pkg.id, X)).schedule).toMatchObject({
      status: "scheduled",
    });
    await expect(
      attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: [X, TELEGRAM],
      }),
    ).rejects.toThrow("ALREADY_SCHEDULED");
  });

  it("is only for the package's requester", async () => {
    const { pkg, assetId } = await packageWithImage();
    await approveRights(assetId);
    await expect(
      attachPackageImage(project.editor, pkg.id, { deliverableKeys: [X] }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      attachPackageImage(project.viewer, pkg.id, { deliverableKeys: [X] }),
    ).rejects.toThrow("EDITOR_REQUIRED");
  });

  // With the Creative Studio on and a primary logo, a draft with image copy
  // gets its composed creative instead of the raw package image.
  describe("with the Creative Studio", () => {
    let good: Buffer;
    let flat: Buffer;
    let logo: { id: string };
    const both = [X, TELEGRAM];
    const copies: Record<string, Record<string, unknown>> = {
      [X]: PACKAGE_CREATIVE_COPY,
      [TELEGRAM]: PACKAGE_CREATIVE_COPY,
    };

    const setCopy = (
      contentId: string,
      creativeCopy: Record<string, unknown> | undefined,
    ) =>
      run(async (tx) => {
        const row = await entity(tx, project.owner, "content", contentId);
        const { creativeCopy: _old, ...rest } = data(row);
        await update(
          tx,
          project.owner,
          row,
          creativeCopy ? { ...rest, creativeCopy } : rest,
        );
      });
    const contentRow = (id: string) =>
      run((tx) => entity(tx, project.owner, "content", id));
    /** An approved package whose drafts carry the given image copy (none: no copy). */
    const readyPackage = async (
      options: {
        bytes?: Buffer;
        copy?: Partial<Record<string, Record<string, unknown>>>;
      } = {},
    ) => {
      const made = await packageWithImage(options.bytes ?? good);
      await approveRights(made.assetId);
      const ids: Record<string, string> = {};
      for (const key of both) {
        ids[key] = (await deliverable(made.pkg.id, key)).content!.id as string;
        await setCopy(ids[key]!, (options.copy ?? copies)[key]);
      }
      return { ...made, ids };
    };
    /** What a refused attach must leave unchanged: creatives and their renditions. */
    const stored = () =>
      run(async (tx) => ({
        creatives: (await list(tx, project.owner, CREATIVES)).length,
        renditions: (await list(tx, project.owner, "assets")).filter(
          (row) => data(row).boundTo?.creativeId,
        ).length,
      }));
    const profileUpdate = (change: Record<string, unknown>) =>
      run((tx) =>
        tx.projectMarketingProfile.updateMany({
          where: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
          },
          data: change as any,
        }),
      );

    beforeAll(async () => {
      good = (await fixtureArt("good", "lumora")).bytes;
      flat = (await fixtureArt("flat", "lumora")).bytes;
    });
    beforeEach(async () => {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
      logo = await addBrandKit(project, {
        // Lifestyle is the first template left enabled; Telegram takes a square.
        templates: {
          product_showcase: { enabled: false },
          feature_highlight: { enabled: false },
          problem_solution: { enabled: false },
        },
        formatsByChannel: { telegram: ["square"] },
      });
    });

    it("attaches each draft's composed creative in its channel's format", async () => {
      const { pkg, assetId, ids } = await readyPackage();
      const result = await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      expect(result.creative).toEqual({
        composed: [ids[X], ids[TELEGRAM]],
        skipped: [],
      });
      for (const [key, format] of [
        [X, "landscape"],
        [TELEGRAM, "square"],
      ] as const) {
        const content = await contentRow(ids[key]!);
        const rendition = await run((tx) =>
          entity(tx, project.owner, "assets", data(content).assetId),
        );
        expect(rendition.id).not.toBe(assetId);
        expect(data(rendition)).toMatchObject({
          assetStatus: "approved",
          usageApproved: true,
          creativeFormat: format,
          width: CREATIVE_FORMATS[format].width,
          height: CREATIVE_FORMATS[format].height,
          boundTo: {
            creativeId: data(content).creativeId,
            contentId: content.id,
            packageId: pkg.id,
          },
        });
        const creative = data(
          await run((tx) =>
            findCreative(tx, project.owner, data(content).creativeId),
          ),
        ) as CreativeRecord;
        expect(creative).toMatchObject({
          status: "attached",
          contentId: content.id,
          packageId: pkg.id,
          template: "lifestyle",
          copy: PACKAGE_CREATIVE_COPY,
          components: { artAssetId: assetId },
        });
        expect(creative.renditions.map((r) => r.assetId)).toContain(
          rendition.id,
        );
      }
      expect(await stored()).toEqual({ creatives: 2, renditions: 2 });
      // Reviewed again with its image, like the raw attach.
      const after = await deliverable(pkg.id, X);
      expect(after.review).toMatchObject({ valid: expect.any(Boolean) });
      expect(after.content!.status).not.toBe("draft");
    });

    it("attaches the raw image with the Creative Studio off, as before", async () => {
      const { pkg, assetId, ids } = await readyPackage();
      process.env.ORBIT_CREATIVE_STUDIO = "false";
      const result = await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      expect(result).not.toHaveProperty("creative");
      for (const key of both) {
        const row = await contentRow(ids[key]!);
        expect(data(row)).toMatchObject({ assetId });
        expect(data(row).creativeId).toBeUndefined();
      }
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("keeps the raw image for a draft without image copy and reports it", async () => {
      const { pkg, assetId, ids } = await readyPackage({
        copy: { [X]: PACKAGE_CREATIVE_COPY },
      });
      const result = await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      expect(result.creative).toEqual({
        composed: [ids[X]],
        skipped: [{ contentId: ids[TELEGRAM], code: "CREATIVE_COPY_MISSING" }],
      });
      expect(data(await contentRow(ids[TELEGRAM]!))).toMatchObject({ assetId });
      expect(data(await contentRow(ids[X]!)).assetId).not.toBe(assetId);
      expect(await stored()).toEqual({ creatives: 1, renditions: 1 });
    });

    it("keeps the raw image without a primary logo", async () => {
      const kit = await run((tx) =>
        tx.projectMarketingProfile.findFirstOrThrow({
          where: { projectId: project.owner.projectId },
        }),
      );
      const { visualIdentity, ...rest } = kit.data as Record<string, any>;
      const { logoAssetId: _logo, ...identity } = visualIdentity;
      await profileUpdate({
        data: { ...rest, visualIdentity: identity },
        version: { increment: 1 },
      });
      const { pkg, assetId, ids } = await readyPackage();
      const result = await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      expect(result).not.toHaveProperty("creative");
      expect(data(await contentRow(ids[X]!))).toMatchObject({ assetId });
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("attaches nothing when one draft cannot take its creative", async () => {
      const { pkg, ids } = await readyPackage();
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "content", ids[TELEGRAM]!);
        await update(tx, project.owner, row, {
          ...data(row),
          body: `${data(row).body} ${"More detail. ".repeat(90)}`,
        });
      });
      await expect(
        attachPackageImage(project.owner, pkg.id, { deliverableKeys: both }),
      ).rejects.toThrow("CAPTION_TOO_LONG");
      // Not even the X draft, composed first, was stored or attached.
      expect(data(await contentRow(ids[X]!)).assetId).toBeUndefined();
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("refuses a creative whose checks fail and changes nothing", async () => {
      const { pkg, ids } = await readyPackage({ bytes: flat });
      await expect(
        attachPackageImage(project.owner, pkg.id, { deliverableKeys: both }),
      ).rejects.toThrow("CREATIVE_QA_FAILED");
      expect(data(await contentRow(ids[X]!)).assetId).toBeUndefined();
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("refuses image copy over the template's limits", async () => {
      const { pkg, ids } = await readyPackage({
        copy: {
          [X]: { ...PACKAGE_CREATIVE_COPY, headline: "Long ".repeat(40) },
          [TELEGRAM]: PACKAGE_CREATIVE_COPY,
        },
      });
      await expect(
        attachPackageImage(project.owner, pkg.id, { deliverableKeys: both }),
      ).rejects.toThrow("CREATIVE_TEXT_TOO_LONG");
      expect(data(await contentRow(ids[TELEGRAM]!)).assetId).toBeUndefined();
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("stores nothing when a logo changed while composing", async () => {
      const { pkg, ids } = await readyPackage();
      await expect(
        attachPackageImage(
          project.owner,
          pkg.id,
          { deliverableKeys: both },
          {
            afterCompose: () =>
              run(async (tx) => {
                const row = await entity(tx, project.owner, "assets", logo.id);
                await update(tx, project.owner, row, {
                  ...data(row),
                  name: "Renamed logo",
                });
              }),
          },
        ),
      ).rejects.toThrow("BRAND_ASSET_CHANGED");
      expect(data(await contentRow(ids[X]!)).assetId).toBeUndefined();
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("stores nothing when the profile changed while composing", async () => {
      const { pkg, ids } = await readyPackage();
      await expect(
        attachPackageImage(
          project.owner,
          pkg.id,
          { deliverableKeys: both },
          {
            afterCompose: () =>
              profileUpdate({ version: { increment: 1 } }).then(
                () => undefined,
              ),
          },
        ),
      ).rejects.toThrow("MARKETING_PROFILE_CHANGED");
      expect(data(await contentRow(ids[X]!)).assetId).toBeUndefined();
      expect(await stored()).toEqual({ creatives: 0, renditions: 0 });
    });

    it("attaching again changes nothing", async () => {
      const { pkg, ids } = await readyPackage();
      await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      const before = await contentRow(ids[X]!);
      const again = await attachPackageImage(project.owner, pkg.id, {
        deliverableKeys: both,
      });
      expect(again.creative).toEqual({ composed: [], skipped: [] });
      expect((await contentRow(ids[X]!)).version).toBe(before.version);
      expect(await stored()).toEqual({ creatives: 2, renditions: 2 });
    });

    it("schedules a post with its composed creative", async () => {
      const { thread, pkg, ids } = await readyPackage();
      await attachPackageImage(project.owner, pkg.id, { deliverableKeys: [X] });
      const renditionId = data(await contentRow(ids[X]!)).assetId;
      const proposed = await proposeSchedule(project.owner, thread.id, {
        deliverableKey: X,
      });
      const item = (
        await run((tx) => listActionRequests(tx, project.owner))
      ).find((candidate) => candidate.id === proposed.actionRequestId)!;
      expect(item.summary).toMatchObject({ assetId: renditionId });
      await run((tx) =>
        decideActionRequest(tx, project.owner, item.id, {
          version: item.version,
          packageHash: item.packageHash,
          decision: "approve",
        }),
      );
      expect((await deliverable(pkg.id, X)).schedule).toMatchObject({
        status: "scheduled",
      });
    });
  });
});
