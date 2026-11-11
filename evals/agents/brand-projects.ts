/**
 * The synthetic projects of the review eval, one per brand of the set
 * (review-v3.json), shared by the live harness and the offline replay. A
 * project gets its brand's profile fields and facts, one confirmed
 * assignment with one slot and the brand's brief, and the copywriter's
 * stubbed template draft whose shape (mission, evidence, slot) every case of
 * the brand reuses. A brand with image copy (Creative Studio) posts on a
 * Facebook channel (X cannot carry its long posts) through a creative
 * assignment: the fictional Lumora Home brand kit, and one art asset per run
 * drawn from the offline fixtures (`fixtureArt("good")`), so each case gets a
 * real creative composed and attached for free (`composeRunCreatives`). No
 * image provider is called and the vision review stays off. The caller
 * stubs `generate` and `embed` (stubs.ts).
 */
import { setFact } from "../../apps/api/src/platform/knowledge/engine.ts";
import {
  create,
  data,
  entity,
  list,
  update,
} from "../../apps/api/src/shared.ts";
import { runAgentTask } from "../../apps/api/src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../../apps/api/src/modules/agents/specialists/index.ts";
import { composeRunCreatives } from "../../apps/api/src/modules/marketing/creative/assignment.ts";
import { sha256Hex } from "../../packages/creative/src/index.ts";
import { fixtureArt } from "../../packages/creative/fixtures/demo-brands.ts";
import { sourceSizeFor } from "../../packages/ai/src/index.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  TELEGRAM,
  X,
} from "../../apps/api/tests/support/package-project.ts";
import { addBrandKit } from "../../apps/api/tests/support/package-creative.ts";
import { assignmentRun } from "../../apps/api/tests/support/assignment-review.ts";
import { hookOf } from "./stubs.ts";
import {
  CREATIVE_TEMPLATE,
  type ReviewBrand,
  type ReviewCase,
} from "./review-set.ts";

/** The Facebook channel of a brand with image copy (feed_portrait renditions). */
export const FACEBOOK = "fb-int";
const DAY_MS = 86_400_000;
// The one art unit of a creative assignment with one art per run.
const RUN_UNIT = "run";

// The strategy's art plan of a creative post (fictional; never shown to the
// review model, which sees the image copy, not the image).
const CREATIVE_BRIEF = {
  keyMessage: "Ein gemeinsamer Wochenplan für die Familie",
  imageKind: "scene",
  motif:
    "A bright kitchen table with a ceramic mug and an open notebook by a window",
  setting: "A calm family kitchen in soft morning light",
  template: CREATIVE_TEMPLATE,
  mood: "warm and calm",
};

type Project = Awaited<ReturnType<typeof createPackageProject>>;
export type Harness = ReturnType<typeof assignmentRun>;

/** A brand's prepared project: its run up to the review step and the template draft. */
export type BrandRun = {
  brand: string;
  config: ReviewBrand;
  project: Project;
  h: Harness;
  template: Record<string, any>;
  creative: boolean;
};

/**
 * The brand's profile fields over the project's profile, in place (before any
 * mission, so the profile version stays the one the missions record), and its
 * facts as verified facts of the project's source. A fact the project already
 * has must carry the same value (v2's brand: no change at all).
 */
async function applyBrand(project: Project, h: Harness, config: ReviewBrand) {
  const { owner } = project;
  const now = Date.now();
  await h.run(async (tx) => {
    const where = {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
    };
    const current = await tx.projectMarketingProfile.findFirstOrThrow({
      where,
    });
    await tx.projectMarketingProfile.updateMany({
      where,
      data: {
        data: { ...(current.data as object), ...config.profile } as any,
      },
    });
    const facts = (await list(tx, owner, "facts")).map(data);
    for (const fact of config.facts) {
      const existing = facts.find(
        (row) => row.key === fact.key && row.status === "verified",
      );
      if (existing) {
        if (String(existing.value) !== fact.value)
          throw new Error("EVAL_BRAND_FACT_MISMATCH");
        continue;
      }
      await setFact(tx, owner, {
        key: fact.key,
        value: fact.value,
        valueType: "text",
        language: config.profile.contentLanguage,
        sourceId: project.sourceId,
        validFrom: new Date(now - 3_600_000).toISOString(),
        validUntil: new Date(now + 30 * DAY_MS).toISOString(),
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
    }
  });
}

/** A Facebook channel on the project's Postiz connector, next to X and Telegram. */
async function addFacebook(project: Project, h: Harness) {
  await h.run(async (tx) => {
    const connector = (await list(tx, project.owner, "connectors")).find(
      (row) => data(row).provider === "postiz",
    )!;
    const v = data(connector);
    await update(tx, project.owner, connector, {
      ...v,
      channels: [
        ...v.channels,
        {
          id: FACEBOOK,
          name: "Synthetic Facebook",
          identifier: "facebook",
          disabled: false,
        },
      ],
      assignedIntegrationIds: [...v.assignedIntegrationIds, FACEBOOK],
    });
  });
}

/**
 * The run's art, as the visual step would store it, from the offline fixture
 * instead of an image provider: approved, under the owner's assignment
 * consent, with no failed art check.
 */
async function addRunArt(project: Project, h: Harness, runId: string) {
  const [width, height] = sourceSizeFor(IMAGE_MODEL, 1080 / 1350)
    .split("x")
    .map(Number);
  const art = await fixtureArt("good", "lumora", {
    width: width!,
    height: height!,
  });
  await h.run(async (tx) => {
    const run = data(await entity(tx, project.owner, "assignment_runs", runId));
    await create(tx, project.owner, "assets", {
      name: "Synthetic eval creative art",
      type: "generated_artwork",
      mime: "image/png",
      base64: art.bytes.toString("base64"),
      sha256: sha256Hex(art.bytes),
      width,
      height,
      bytes: art.bytes.length,
      source: "Offline creative fixture",
      validUses: ["social"],
      usageApproved: true,
      assetStatus: "approved",
      license: "Synthetic rights fixture",
      providerUse: true,
      driveSyncStatus: "LOCAL_ONLY",
      assignmentId: run.assignmentId,
      assignmentRunId: runId,
      creativeArt: true,
      creativeUnit: RUN_UNIT,
      creativeArtFailed: [],
    });
  });
}

/**
 * Prepares a brand's project up to its review step: profile and facts, for a
 * creative brand the Facebook channel and brand kit, the policy (`policy`,
 * on the brand's channels), one confirmed assignment with one slot, the
 * plan with the brand's brief, and the copywriter's template draft, which is
 * archived (it only gives the cases their shape); for a creative brand the
 * run's art. `beforeAssignment` runs before the assignment is made.
 */
export async function prepareBrandRun(
  project: Project,
  brand: string,
  config: ReviewBrand,
  options: {
    creative: boolean;
    policy: Record<string, unknown>;
    beforeAssignment?: (h: Harness) => Promise<void>;
  },
): Promise<BrandRun> {
  const h = assignmentRun(project);
  const channel = options.creative ? FACEBOOK : X;
  await applyBrand(project, h, config);
  if (options.creative) {
    await addFacebook(project, h);
    // Only the eval's template, in Facebook's feed_portrait format.
    await addBrandKit(project, {
      templates: {
        product_showcase: { enabled: false },
        feature_highlight: { enabled: false },
        problem_solution: { enabled: false },
      },
    });
  }
  await h.setPolicy({ ...options.policy, channels: [channel, TELEGRAM] });
  registerAgentSpecialists();
  await options.beforeAssignment?.(h);
  await h.makeAssignment({
    schedule: {
      rhythm: "daily",
      weekdays: [],
      times: ["10:00"],
      leadMinutes: 360,
    },
    ...(config.assignment ?? {}),
    ...(options.creative
      ? {
          channels: [FACEBOOK],
          image: true,
          creative: { artPer: "run", imageKind: "auto" },
          delivery: "publish",
        }
      : {}),
  });
  // The brand's brief and facts, so the cases are judged against the brief they answer.
  const { topic, ...brief } = config.brief;
  await h.planWithBriefs((slots) =>
    slots.map((slot) =>
      h.brief(slot, {
        ...brief,
        ...(topic ? { topic } : {}),
        factKeys: config.facts.map((fact) => fact.key),
        ...(options.creative ? { creative: CREATIVE_BRIEF } : {}),
      }),
    ),
  );
  await runAgentTask(h.worker(), (await h.task(`copywriter:${channel}`)).id);
  const [template] = await h.rows("content");
  if (!template) throw new Error("EVAL_TEMPLATE_MISSING");
  await archive(h, project, template.id);
  if (options.creative)
    await addRunArt(project, h, String(template.assignmentRunId));
  return {
    brand,
    config,
    project,
    h,
    template,
    creative: options.creative,
  };
}

async function archive(h: Harness, project: Project, contentId: string) {
  await h.run(async (tx) => {
    const row = await entity(tx, project.owner, "content", contentId);
    await update(tx, project.owner, row, { ...data(row), status: "archived" });
  });
}

/**
 * One case in its brand's run: its draft from the template's shape with the
 * case's body (and image copy, core message and hook for a creative case),
 * its channel history, a creative composed and attached when its image copy
 * is clean, and its own review task with `ceilingMicros`.
 */
export async function caseDraft(
  run: BrandRun,
  c: ReviewCase,
  ceilingMicros: number,
) {
  const { owner } = run.project;
  const {
    id: _id,
    version: _version,
    assetId: _asset,
    creativeId: _creative,
    creativeFailure: _failure,
    ...shape
  } = run.template;
  const cta = run.config.profile.primaryCtas[0]!;
  const setup = await run.h.run(async (tx) => {
    const content = await create(tx, owner, "content", {
      ...shape,
      title: c.id,
      body: c.body,
      claims: [{ text: cta, kind: "style" }],
      // Copy craft: the template's core message, the case body's own hook.
      ...(shape.copyCraft === true ? { hook: hookOf(c.body) } : {}),
      ...(c.creativeCopy !== undefined ? { creativeCopy: c.creativeCopy } : {}),
      jobId: `eval:${c.id}`,
      status: "draft",
    });
    const posts = [];
    for (const [index, text] of (c.channelHistory ?? []).entries())
      posts.push(
        await create(tx, owner, "channel_posts", {
          channel: shape.channel,
          remoteId: `eval-${c.id}-${index}`,
          publishedAt: new Date(Date.now() - DAY_MS).toISOString(),
          state: "PUBLISHED",
          text,
          source: "external",
          syncedAt: new Date().toISOString(),
        }),
      );
    return { contentId: content.id, posts };
  });
  // Free: the fixture art, the brand kit and the studio's composition only.
  if (run.creative && c.creativeCopy !== undefined) {
    const composed = await composeRunCreatives(
      owner,
      String(run.template.assignmentRunId),
    );
    if (composed.error) throw new Error(`EVAL_CREATIVE_${composed.error}`);
  }
  const task = await run.h.run((tx) =>
    create(tx, owner, "agent_tasks", {
      runId: run.template.assignmentRunId,
      stepKey: "review",
      role: "review",
      assignmentId: run.template.assignmentId,
      assignmentVersion: 1,
      ceilingMicros,
      input: {
        inputs: {
          [`copywriter:${shape.channel}`]: {
            contentIds: [setup.contentId],
            failed: [],
          },
        },
      },
      output: null,
      status: "running",
      errorCode: null,
      costMicros: 0,
    }),
  );
  return { ...setup, task };
}

/** Ends a case: its drafts leave the run, its history the channel. */
export async function endCase(
  run: BrandRun,
  setup: { posts: Array<{ id: string }> },
  contentIds: Array<string | null | undefined>,
) {
  const { owner } = run.project;
  await run.h.run(async (tx) => {
    for (const id of contentIds) {
      if (!id) continue;
      const row = await entity(tx, owner, "content", id);
      await update(tx, owner, row, { ...data(row), status: "archived" });
    }
    for (const post of setup.posts)
      await tx.entity.delete({ where: { id: post.id } });
  });
}
