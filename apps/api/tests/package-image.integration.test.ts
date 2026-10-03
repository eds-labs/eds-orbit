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
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
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
  const packageWithImage = async () => {
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
        bytes: png,
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
});
