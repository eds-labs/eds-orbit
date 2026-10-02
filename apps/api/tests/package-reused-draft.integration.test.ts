import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  reviseDeliverable,
} from "../src/modules/agents/content-packages.ts";
import { proposeSchedule } from "../src/modules/agents/package-schedule.ts";
import { attachPackageImage } from "../src/modules/agents/package-image.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Two packages with the same fact and channel: the second draft is identical,
 * so generation reuses the first package's draft. The second package must not
 * schedule, attach to or supersede a draft that belongs to the first.
 */
describe.skipIf(!enabled)("A reused draft from another package", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let first: {
    packageId: string;
    threadId: string;
    contentId: string;
    publicationId: string;
  };
  let second: { packageId: string; threadId: string };
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
  // An owner's started X package with an image and drafted copy.
  const startPackage = async (png: Buffer) => {
    const { owner } = project;
    const thread = await createConversation(owner);
    const { package: pkg, actionRequest } = await requestContentPackage(
      owner,
      thread.id,
      {
        goal: "Announce that beta access is open",
        channels: [X],
        factKeys: ["beta.access"],
        imageBrief:
          "A calm abstract artwork of an open door made of soft light, no text.",
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
    const copy = steps.find((s) => s.kind === "copy")!;
    await run((tx) =>
      deterministicDraft(tx, owner, copy.missionId, copy.jobId),
    );
    const imageRequestId = steps.find((s) => s.kind === "image")!
      .actionRequestId as string;
    const imageJob = (await run((tx) => list(tx, owner, "jobs"))).find(
      (job) => data(job).resourceId === imageRequestId,
    )!;
    const asset = await runImageJob(
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
    await run(async (tx) => {
      const row = await entity(
        tx,
        owner,
        "assets",
        (asset as { id: string }).id,
      );
      await update(tx, owner, row, {
        ...data(row),
        assetStatus: "approved",
        usageApproved: true,
      });
    });
    await run((tx) => sweepProject(tx, worker()));
    return { pkg, thread };
  };

  beforeAll(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    project = await createPackageProject();
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    // The first package's post is scheduled by its owner.
    const a = await startPackage(rendered.bytes);
    const proposed = await proposeSchedule(project.owner, a.thread.id, {
      deliverableKey: X,
    });
    const item = (
      await run((tx) => listActionRequests(tx, project.owner))
    ).find((candidate) => candidate.id === proposed.actionRequestId)!;
    await run((tx) =>
      decideActionRequest(tx, project.owner, item.id, {
        version: item.version,
        packageHash: item.packageHash,
        decision: "approve",
      }),
    );
    const firstDraft = (await snapshot(a.pkg.id)).deliverables[0]!.content!;
    first = {
      packageId: a.pkg.id,
      threadId: a.thread.id,
      contentId: firstDraft.id as string,
      publicationId: (
        await run((tx) => list(tx, project.owner, "publications"))
      )[0]!.id,
    };
    const b = await startPackage(rendered.bytes);
    second = { packageId: b.pkg.id, threadId: b.thread.id };
  });
  afterAll(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    await project.cleanup();
    await closeDatabase();
  });

  it("shows the second package's draft as the reused one", async () => {
    expect(
      (await snapshot(second.packageId)).deliverables[0]!.content,
    ).toMatchObject({ id: first.contentId, reused: true });
  });

  it("refuses to schedule it with a clear code", async () => {
    await expect(
      proposeSchedule(project.owner, second.threadId, { deliverableKey: X }),
    ).rejects.toThrow("DRAFT_REUSED");
  });

  it("refuses to attach the image to it and leaves the other package's post unchanged", async () => {
    const before = await run((tx) =>
      entity(tx, project.owner, "content", first.contentId),
    );
    await expect(
      attachPackageImage(project.owner, second.packageId, {
        deliverableKeys: [X],
      }),
    ).rejects.toThrow("DRAFT_REUSED");
    const after = await run((tx) =>
      entity(tx, project.owner, "content", first.contentId),
    );
    expect(after.version).toBe(before.version);
  });

  it("revises it into an own draft without superseding the other package's post", async () => {
    await reviseDeliverable(project.owner, second.threadId, {
      deliverableKey: X,
      instruction: "Make it shorter",
    });
    // The revision's generated draft, as the worker would write it.
    const revision = (
      data(
        await run((tx) =>
          entity(tx, project.owner, "content_packages", second.packageId),
        ),
      ).steps as Array<Record<string, any>>
    ).find((s) => s.kind === "copy")!.revisions[0];
    await run(async (tx) => {
      const original = await entity(
        tx,
        project.owner,
        "content",
        first.contentId,
      );
      await create(tx, project.owner, "content", {
        ...data(original),
        body: "Beta access is open.",
        missionId: revision.missionId,
        status: "draft",
        review: undefined,
        scheduledAt: undefined,
      });
    });
    await run((tx) => sweepProject(tx, worker()));
    const firstContent = await run((tx) =>
      entity(tx, project.owner, "content", first.contentId),
    );
    expect(data(firstContent).supersededBy).toBeUndefined();
    const publication = await run((tx) =>
      entity(tx, project.owner, "publications", first.publicationId),
    );
    expect(data(publication).status).toBe("intent_created");
    // The second package now shows its own revised draft.
    const current = (await snapshot(second.packageId)).deliverables[0]!
      .content!;
    expect(current.id).not.toBe(first.contentId);
    expect(current.reused).toBe(false);
  });

  it("supersedes a package's own draft when it is revised and blocks its publication", async () => {
    await reviseDeliverable(project.owner, first.threadId, {
      deliverableKey: X,
      instruction: "Make it more formal",
    });
    const revision = (
      data(
        await run((tx) =>
          entity(tx, project.owner, "content_packages", first.packageId),
        ),
      ).steps as Array<Record<string, any>>
    ).find((s) => s.kind === "copy")!.revisions[0];
    const revised = await run(async (tx) => {
      const original = await entity(
        tx,
        project.owner,
        "content",
        first.contentId,
      );
      return create(tx, project.owner, "content", {
        ...data(original),
        body: "Beta access is now open.",
        missionId: revision.missionId,
        status: "draft",
        review: undefined,
        scheduledAt: undefined,
      });
    });
    await run((tx) => sweepProject(tx, worker()));
    expect(
      data(
        await run((tx) =>
          entity(tx, project.owner, "content", first.contentId),
        ),
      ).supersededBy,
    ).toBe(revised.id);
    expect(
      data(
        await run((tx) =>
          entity(tx, project.owner, "publications", first.publicationId),
        ),
      ).status,
    ).toBe("blocked_dependency");
  });
});
