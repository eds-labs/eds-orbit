import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model and image call is a mock; nothing here reaches a provider.
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  generateImage: vi.fn(),
  generateImageWithReferences: vi.fn(),
  saveDraftDocument: vi.fn(),
}));
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    generateImage: provider.generateImage,
    generateImageWithReferences: provider.generateImageWithReferences,
  };
});
vi.mock("../src/modules/google-drive.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/google-drive.ts")>();
  return { ...actual, saveDraftDocument: provider.saveDraftDocument };
});
import { createHash } from "node:crypto";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import { create, data, entity, hash, list, update } from "../src/shared.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import { assignmentHash } from "../src/modules/agents/assignments.ts";
import { sweepProject } from "../src/modules/lifecycle.ts";
import { GenerationOutputError } from "../../../packages/ai/src/index.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import {
  briefKey,
  copywriterStep,
  reviseAssignmentDraft,
  saveDraftToDrive,
} from "../src/modules/agents/specialists/copywriter.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const BLOG = "blog-int";
// 06:00 in Berlin tomorrow: the run for 10:00 and 17:00 is due (lead 360 minutes).
const today = new Date();
const MORNING = new Date(
  Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
    4,
  ),
);
const BODY = "Beta access is open for product teams. Learn more.";

describe.skipIf(!enabled)("Copywriter and visual in an assignment run", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let png: Buffer;
  // Channel whose drafts come back longer than a Telegram caption allows.
  let longFor: string | null = null;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const worker = () => ({
    ...project.owner,
    userId: "worker",
    role: "owner" as const,
  });
  const rows = (kind: string) =>
    run((tx) => list(tx, project.owner, kind)).then((found) =>
      found.map((row): Record<string, any> => ({
        id: row.id,
        version: row.version,
        ...data(row),
      })),
    );
  const task = async (stepKey: string) =>
    (await rows("agent_tasks")).find((t) => t.stepKey === stepKey)!;
  const setPolicy = (changes: Record<string, unknown>) =>
    run(async (tx) => {
      const row = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, row, { ...data(row), ...changes });
    });
  const makeAssignment = (changes: Record<string, unknown> = {}) => {
    const { consent = true, ...rest } = changes;
    const content = {
      name: "Two posts a day",
      kind: "standing",
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00", "17:00"],
        leadMinutes: 360,
      },
      contentType: "social",
      channels: [X, TELEGRAM],
      topicFrame: "Short updates about beta access for product teams",
      image: true,
      styleAssetIds: [],
      vetoMinutes: 180,
      monthlyBudgetMicros: 30_000_000,
      ...rest,
    };
    return run((tx) =>
      create(tx, project.owner, "assignments", {
        ...content,
        status: "active",
        actionRequestId: null,
        confirmation: {
          userId: project.owner.userId,
          at: "2026-10-01T00:00:00.000Z",
          assignmentHash: assignmentHash(content),
          imageRightsConsent: content.image === true && consent === true,
        },
      }),
    );
  };
  const brief = (
    slot: { channel: string; at: string },
    changes: Record<string, unknown> = {},
  ) => ({
    channel: slot.channel,
    slotAt: slot.at,
    topic: `Beta access on ${slot.channel}`,
    angle: "Lead with what teams can do on day one.",
    factKeys: ["beta.access"],
    cta: "Join the beta.",
    imageIdea: "A calm open door made of soft light.",
    notARepeatBecause: "Earlier posts announced the beta, this one shows use.",
    ...changes,
  });
  /** Plans the run and settles every step before the copywriters: strategy with these briefs. */
  const planWithBriefs = async (
    briefsFor: (
      slots: Array<{ channel: string; at: string }>,
    ) => Array<Record<string, unknown>>,
  ) => {
    await run((tx) => planAssignmentRuns(tx, project.owner, MORNING));
    const [runRow] = await rows("assignment_runs");
    const slots = runRow!.slots as Array<{ channel: string; at: string }>;
    const briefs = briefsFor(slots);
    for (const role of ["analytics", "research", "strategy"]) {
      const found = (await rows("agent_tasks")).find((t) => t.role === role);
      if (!found) continue;
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", found.id);
        await update(tx, project.owner, row, {
          ...data(row),
          status: role === "strategy" ? "done" : "failed",
          output:
            role === "strategy" ? { briefs, dropped: [], uncovered: [] } : null,
        });
        await startReadySteps(tx, project.owner, data(row).runId);
      });
    }
    return { runId: runRow!.id as string, slots, briefs };
  };
  const generated = (body: string) => ({
    responseId: "resp_draft",
    output: {
      title: "Beta post",
      body,
      claims: [{ text: "Learn more.", kind: "style" }],
    },
    usage: {
      model: "synthetic-model",
      inputTokens: 40,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      costMicros: 5,
    },
  });
  const image = () => ({
    bytes: png,
    model: IMAGE_MODEL,
    size: "1024x1024",
    quality: "medium",
    background: "opaque",
    usage: null,
  });
  const contracts = () =>
    provider.generate.mock.calls.map((call) => JSON.parse(call[0].goal));

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
  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    longFor = null;
    provider.embed.mockReset().mockResolvedValue({
      vectors: [
        Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      ],
      usage: {
        model: "text-embedding-3-small",
        inputTokens: 20,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costMicros: 1,
      },
    });
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      return generated(
        contract.channel === longFor
          ? `${"Beta access is open. ".repeat(60)}Learn more.`
          : `${BODY} (${contract.brief?.topic ?? "no brief"})`,
      );
    });
    provider.generateImage.mockReset().mockImplementation(async () => image());
    provider.generateImageWithReferences
      .mockReset()
      .mockImplementation(async () => image());
    provider.saveDraftDocument.mockReset().mockResolvedValue({
      id: "driveFileABC123",
      folderId: "driveFolderABC123",
      webViewLink: "https://drive.google.com/file/d/driveFileABC123/view",
    });
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X, TELEGRAM, BLOG],
      contentTypes: ["social", "blog"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_IMAGE_REFERENCES;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("writes one draft per brief with the brief in the contract", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    const xBriefs = briefs.filter((b) => b.channel === X);
    expect(xBriefs).toHaveLength(2);
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);

    const done = await task(`copywriter:${X}`);
    expect(done.status).toBe("done");
    expect(done.output.failed).toEqual([]);
    expect(done.output.contentIds).toHaveLength(2);
    // Only this channel's briefs: one generation per X brief.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(contracts().map((c) => c.brief)).toEqual(
      xBriefs.map((b) => ({
        topic: b.topic,
        angle: b.angle,
        cta: b.cta,
        notARepeatBecause: b.notARepeatBecause,
      })),
    );
    expect(contracts().every((c) => Array.isArray(c.recentChannelPosts))).toBe(
      true,
    );
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions).toHaveLength(2);
    for (const b of xBriefs) {
      const mission = missions.find((m) => m.briefKey === briefKey(b as any))!;
      expect(mission).toMatchObject({
        allowedActions: ["draft"],
        channels: [X],
        factKeys: ["beta.access"],
        plannedSlotAt: b.slotAt,
        budgetRunKey: `assignment-run:${runId}`,
        agentTaskId: copy.id,
        mediaPlanned: false,
      });
    }
    const drafts = (await rows("content")).filter((c) =>
      done.output.contentIds.includes(c.id),
    );
    expect(drafts.map((d) => d.assignmentRunId)).toEqual([runId, runId]);
    expect(drafts.every((d) => d.status === "draft")).toBe(true);
    expect(await rows("publications")).toEqual([]);
    // The drafts' paid calls count toward the task and the run (R37).
    const reservations = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    const own = reservations.filter(
      (r) =>
        r.key.includes(`:agent:${copy.id}:copy:`) ||
        r.key.includes(`:query:mission:agent:${copy.id}:copy:`),
    );
    expect(own).toHaveLength(4);
    expect(done.costMicros).toBe(
      own.reduce((sum, r) => sum + Number(r.settledMicros ?? 0), 0),
    );
    expect(done.costMicros).toBeGreaterThan(0);

    // A second pass of the same task reuses its missions and drafts (R26).
    const again = await copywriterStep(worker(), {
      ...(done as any),
      status: "running",
    });
    expect(again).toEqual(done.output);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(
      (await rows("missions")).filter((m) => m.assignmentRunId === runId),
    ).toHaveLength(2);
  });

  it("keeps writing when one brief fails and never drafts a failed brief later", async () => {
    await makeAssignment({ image: false });
    const { runId, briefs } = await planWithBriefs((slots) =>
      slots.map((slot, index) =>
        brief(slot, index === 0 ? { factKeys: ["launch.deadline"] } : {}),
      ),
    );
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);
    const done = await task(`copywriter:${X}`);
    expect(done.status).toBe("done");
    expect(done.output.contentIds).toHaveLength(1);
    expect(done.output.failed).toEqual([
      { briefKey: briefKey(briefs[0] as any), code: "FACT_NOT_USABLE" },
    ]);

    // An unusable model answer fails its brief; its mission stays ready.
    provider.generate.mockImplementationOnce(async () => {
      throw new GenerationOutputError(
        "MODEL_OUTPUT_NOT_VALID",
        generated(BODY).usage,
        "resp_invalid",
      );
    });
    await runAgentTask(worker(), (await task(`copywriter:${TELEGRAM}`)).id);
    const telegram = await task(`copywriter:${TELEGRAM}`);
    expect(telegram.status).toBe("done");
    expect(telegram.output.failed.map((f: any) => f.code)).toEqual([
      "MODEL_OUTPUT_NOT_VALID",
    ]);
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions.some((m) => m.status === "ready")).toBe(true);
    // The project sweep leaves assignment missions to their copywriter (R37).
    await run((tx) => sweepProject(tx, worker()));
    const jobs = (await rows("jobs")).filter(
      (job) =>
        job.topic === "generation" &&
        missions.some((m) => m.id === job.resourceId),
    );
    expect(jobs).toEqual([]);
  });

  it("revises a draft through the same mission path with the review's instruction", async () => {
    await makeAssignment({ image: false });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const copy = await task(`copywriter:${X}`);
    await runAgentTask(worker(), copy.id);
    const done = await task(`copywriter:${X}`);
    const [draftId] = done.output.contentIds as string[];
    const draft = (await rows("content")).find((c) => c.id === draftId)!;
    provider.generate.mockClear();

    const revised = await reviseAssignmentDraft(worker(), done as any, {
      contentId: draftId!,
      instruction: "Make it shorter.",
    });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const [contract] = contracts();
    expect(contract.revision).toEqual({
      instruction: "Make it shorter.",
      previousBody: draft.body,
    });
    expect(contract.brief.topic).toBe(`Beta access on ${X}`);
    expect(data(revised)).toMatchObject({
      assignmentRunId: draft.assignmentRunId,
      briefKey: draft.briefKey,
    });
    const mission = (await rows("missions")).find(
      (m) => m.id === data(revised).missionId,
    )!;
    expect(mission.revisionOf).toEqual({
      contentId: draftId,
      version: draft.version,
      instruction: "Make it shorter.",
    });
  });

  it("generates one image and attaches it to the run's drafts", async () => {
    await makeAssignment();
    const { runId } = await planWithBriefs((slots) =>
      slots.map((slot) => brief(slot)),
    );
    // Copywriters first, then the visual: the visual attaches to existing drafts.
    longFor = TELEGRAM;
    for (const channel of [X, TELEGRAM])
      await runAgentTask(worker(), (await task(`copywriter:${channel}`)).id);
    const missions = (await rows("missions")).filter(
      (m) => m.assignmentRunId === runId,
    );
    expect(missions.every((m) => m.mediaPlanned === true)).toBe(true);
    await runAgentTask(worker(), (await task("visual")).id);

    const visual = await task("visual");
    expect(visual.status).toBe("done");
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    const [{ prompt }] = provider.generateImage.mock.calls[0]!;
    expect(prompt).toContain("A calm open door made of soft light.");
    expect(prompt).toMatch(/no identifiable persons/i);
    const assets = (await rows("assets")).filter(
      (a) => a.assignmentRunId === runId,
    );
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    const drafts = (await rows("content")).filter(
      (c) => c.assignmentRunId === runId,
    );
    const xDrafts = drafts.filter((d) => d.channel === X);
    const telegram = drafts.filter((d) => d.channel === TELEGRAM);
    expect(xDrafts.every((d) => d.assetId === asset.id)).toBe(true);
    // A Telegram caption holds at most 1,024 characters: that draft stays without it.
    expect(telegram.every((d) => d.assetId === undefined)).toBe(true);
    expect(visual.output).toEqual({
      assetId: asset.id,
      attached: expect.arrayContaining(xDrafts.map((d) => d.id)),
      skipped: expect.arrayContaining(
        telegram.map((d) => ({ contentId: d.id, code: "CAPTION_TOO_LONG" })),
      ),
    });
    // The image's cost counts toward the visual task (R37).
    const reservation = await run((tx) =>
      tx.budgetReservation.findFirst({
        where: {
          projectId: project.owner.projectId,
          key: `${project.owner.projectId}:image:agent:${visual.id}:image`,
        },
      }),
    );
    expect(Number(reservation!.amountMicros)).toBe(IMAGE_MAX);

    // The other order: an image that already exists goes onto a later draft.
    const { runId: secondRun } = await (async () => {
      await project.cleanup();
      project = await createPackageProject();
      await setPolicy({
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2027-12-31T00:00:00.000Z",
        maxPerDay: 2,
        minIntervalMinutes: 120,
      });
      await makeAssignment();
      return planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    })();
    longFor = null;
    await runAgentTask(worker(), (await task("visual")).id);
    expect((await task("visual")).output.attached).toEqual([]);
    await runAgentTask(worker(), (await task(`copywriter:${X}`)).id);
    const [later] = (await rows("assets")).filter(
      (a) => a.assignmentRunId === secondRun,
    );
    const laterDrafts = (await rows("content")).filter(
      (c) => c.assignmentRunId === secondRun,
    );
    expect(laterDrafts).toHaveLength(2);
    expect(laterDrafts.every((d) => d.assetId === later!.id)).toBe(true);
  });

  it("approves the image's rights only through the assignment consent", async () => {
    const assignment = await makeAssignment();
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    const [asset] = await rows("assets");
    expect(asset).toMatchObject({
      usageApproved: true,
      assetStatus: "approved",
      generationId: `agent:${(await task("visual")).id}:image`,
      rightsSource: {
        assignmentId: assignment.id,
        confirmationHash: data(assignment).confirmation.assignmentHash,
      },
    });

    // A changed assignment no longer carries the confirmed consent.
    await project.cleanup();
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    const changed = await makeAssignment();
    await run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", changed.id);
      await update(tx, project.owner, row, {
        ...data(row),
        topicFrame: "A different topic than the one confirmed",
      });
    });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    provider.generateImage.mockClear();
    await runAgentTask(worker(), (await task("visual")).id);
    expect(await task("visual")).toMatchObject({
      status: "failed",
      errorCode: "ASSET_RIGHTS_REQUIRED",
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(await rows("assets")).toEqual([]);
  });

  it("refuses an image without consent with ASSET_RIGHTS_REQUIRED", async () => {
    await makeAssignment({ consent: false });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const visual = await task("visual");
    await runAgentTask(worker(), visual.id);
    expect(await task("visual")).toMatchObject({
      status: "failed",
      errorCode: "ASSET_RIGHTS_REQUIRED",
      costMicros: 0,
    });
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(await rows("assets")).toEqual([]);
    const reservations = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: project.owner.projectId },
      }),
    );
    expect(reservations.filter((r) => r.key.includes(":image:"))).toEqual([]);
  });

  it("sends approved style references, or their stored description when references are off", async () => {
    const reference = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Deep blue gradient with soft geometric light",
        tags: ["banner"],
      }),
    );
    const unapproved = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Unreviewed upload",
        type: "banner",
        mime: "image/png",
        base64: png.toString("base64"),
        usageApproved: false,
        assetStatus: "reference",
      }),
    );
    await makeAssignment({ styleAssetIds: [reference.id, unapproved.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImage).not.toHaveBeenCalled();
    expect(provider.generateImageWithReferences).toHaveBeenCalledTimes(1);
    const sent = provider.generateImageWithReferences.mock.calls[0]![0];
    expect(sent.references).toHaveLength(1);
    expect(sent.references[0].bytes.equals(png)).toBe(true);

    // With references switched off the run uses a style description stored on the assignment.
    process.env.ORBIT_IMAGE_REFERENCES = "false";
    await project.cleanup();
    project = await createPackageProject();
    await setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    const banner = await run((tx) =>
      create(tx, project.owner, "assets", {
        name: "Approved banner",
        type: "generated_artwork",
        mime: "image/png",
        base64: png.toString("base64"),
        sha256: createHash("sha256").update(png).digest("hex"),
        usageApproved: true,
        assetStatus: "approved",
        prompt: "Deep blue gradient with soft geometric light",
        tags: ["banner"],
      }),
    );
    const second = await makeAssignment({ styleAssetIds: [banner.id] });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    provider.generateImageWithReferences.mockClear();
    await runAgentTask(worker(), (await task("visual")).id);
    expect(provider.generateImageWithReferences).not.toHaveBeenCalled();
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
    // Stored once per assignment in its own row: the assignment keeps its confirmed version.
    const [stored] = await rows("assignment_style_descriptions");
    expect(stored).toMatchObject({
      assignmentId: second.id,
      assetIds: [banner.id],
    });
    expect(
      (await run((tx) => entity(tx, project.owner, "assignments", second.id)))
        .version,
    ).toBe(second.version);
    expect(stored.text).toContain(
      "Deep blue gradient with soft geometric light",
    );
    expect(provider.generateImage.mock.calls[0]![0].prompt).toContain(
      stored.text,
    );
  });

  it("saves an approved blog draft to Drive and publishes nothing", async () => {
    await makeAssignment({
      name: "Weekly article",
      contentType: "blog",
      channels: [BLOG],
      image: false,
      schedule: {
        rhythm: "daily",
        weekdays: [],
        times: ["10:00"],
        leadMinutes: 360,
      },
    });
    await planWithBriefs((slots) => slots.map((slot) => brief(slot)));
    const copy = await task("copywriter");
    await runAgentTask(worker(), copy.id);
    const done = await task("copywriter");
    expect(done.status).toBe("done");
    const [contentId] = done.output.contentIds as string[];

    // Without a recorded approval nothing goes to Drive.
    await expect(saveDraftToDrive(worker(), contentId!)).rejects.toMatchObject({
      code: "CONTENT_APPROVAL_REQUIRED",
    });
    expect(provider.saveDraftDocument).not.toHaveBeenCalled();

    await run(async (tx) => {
      const row = await entity(tx, project.owner, "content", contentId!);
      await update(tx, project.owner, row, {
        ...data(row),
        humanReviewedBodyHash: hash(data(row).body),
      });
    });
    const saved = await saveDraftToDrive(worker(), contentId!);
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
    const [, upload] = provider.saveDraftDocument.mock.calls[0]!;
    expect(upload).toMatchObject({
      contentId,
      category: "Blog",
      mime: "text/markdown",
    });
    expect(upload.filename).toMatch(/\.md$/);
    expect(Buffer.from(upload.bytes).toString("utf8")).toContain(BODY);
    expect(data(saved).driveDraft).toMatchObject({
      fileId: "driveFileABC123",
      bodyHash: hash(data(saved).body),
    });
    // Saved once per approved text; nothing is scheduled or published.
    await saveDraftToDrive(worker(), contentId!);
    expect(provider.saveDraftDocument).toHaveBeenCalledTimes(1);
    expect(await rows("publications")).toEqual([]);
    expect(data(saved).status).not.toBe("published");
  });
});
