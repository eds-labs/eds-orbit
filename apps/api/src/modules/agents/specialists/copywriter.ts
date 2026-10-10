import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import { validateDraftMission } from "../../chat.ts";
import { resolveChannelRules } from "../../channel-rules.ts";
import { exportContentBundle } from "../../content-export.ts";
import { generateMissionLive } from "../../generation.ts";
import { saveDraftDocument } from "../../google-drive.ts";
import {
  currentMarketingProfile,
  officialTargetLink,
} from "../../marketing-profile.ts";
import { activePolicy } from "../../policy.ts";
import { errorCode } from "../../telemetry.ts";
import { listUsableFacts } from "../content-packages.ts";
import { confirmedDelivery, deliveryOf } from "../assignments.ts";
import {
  ASSIGNMENT_BUDGET_EXHAUSTED,
  runBudgetKey,
  taskBudgetLeft,
  taskReservations,
} from "./runner.ts";
import type { AgentTask, StepHandler } from "./types.ts";
import { attachRunImage } from "./visual.ts";

/**
 * Copywriter step of an assignment run (Orbit Agents, spec §5): an executor,
 * not a model specialist. For every strategy brief of its channel (R18; the
 * single copywriter of a blog or newsletter run takes all briefs) it creates
 * one draft-only mission in the shape content packages use and drafts it
 * through Orbit's generation (claims ledger, fact placeholders, channel
 * rules), with the brief in the generation contract. Paid calls are
 * attributed to the task (R37): job `agent:<taskId>:copy:<briefKey>`, budget
 * run `assignment-run:<runId>`; each mission's cost ceiling is what the run's
 * pool (R75) and the assignment's month have left. A failed brief does not stop the
 * others. Re-running a task reuses its missions and drafts (R26).
 */
const SLOT_WINDOW_MS = 2 * 3600000;

export type Brief = {
  channel: string;
  slotAt: string;
  topic: string;
  angle: string;
  factKeys: string[];
  cta: string;
  imageIdea: string | null;
  notARepeatBecause: string;
};

/** A brief's key within a run: its channel and slot. */
export const briefKey = (brief: { channel: string; slotAt: string }) =>
  `${brief.channel}@${new Date(brief.slotAt).toISOString()}`;

/** The briefs this copywriter writes: its channel's (`copywriter:<channel>`) or all of them. */
function taskBriefs(task: AgentTask): Brief[] {
  const briefs = (task.input as any)?.inputs?.strategy?.briefs;
  if (!Array.isArray(briefs)) throw new DomainError("AGENT_BRIEFS_MISSING");
  const channel = task.stepKey.startsWith("copywriter:")
    ? task.stepKey.slice("copywriter:".length)
    : null;
  return (briefs as Brief[]).filter(
    (brief) => channel === null || brief.channel === channel,
  );
}

/** The mission a job of this task already created, if any. */
function missionOfJob(tx: DbTx, scope: Scope, jobId: string) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "missions",
      data: { path: ["agentJobId"], equals: jobId },
    },
  });
}

/**
 * Cost ceiling of one mission: what the step may still take from its run's
 * pool (R75) and what the assignment's month has left. The generation checks
 * the pool again at its reservation (`generation.ts`), since other steps of
 * the run reserve meanwhile.
 */
async function missionCeiling(tx: DbTx, scope: Scope, task: AgentTask) {
  const left = await taskBudgetLeft(tx, scope, task);
  if (left.monthMicros <= 0) throw new DomainError(ASSIGNMENT_BUDGET_EXHAUSTED);
  if (left.taskMicros <= 0) throw new DomainError("AGENT_LIMIT");
  return {
    ceilingMicros: Math.min(left.taskMicros, left.monthMicros),
    monthBound: left.monthMicros < left.taskMicros,
  };
}

/**
 * A draft-only mission for one brief, checked like a content package
 * deliverable: usable Verified Facts of the brief, the profile's CTA and
 * official link, the policy's channel and period, a window from now to two
 * hours after the slot.
 */
async function briefMission(
  tx: DbTx,
  scope: Scope,
  task: AgentTask,
  brief: Brief,
  jobId: string,
  extra: Record<string, unknown> = {},
) {
  const now = new Date();
  const assignment = data(
    await entity(tx, scope, "assignments", task.assignmentId),
  );
  if (!brief.factKeys?.length) throw new DomainError("FACTS_REQUIRED", 409);
  const usable = await listUsableFacts(tx, scope, now);
  const facts = [...new Set(brief.factKeys)].map((key) => {
    const fact = usable.find((row) => data(row).key === key);
    if (!fact) throw new DomainError("FACT_NOT_USABLE", 409);
    return fact;
  });
  const profileRow = await currentMarketingProfile(tx, scope);
  if (!profileRow) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
  const profile = marketingProfile.parse(profileRow.data);
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const link = await officialTargetLink(
    tx,
    scope,
    profile,
    data(policyRow).allowedOrigins ?? [],
    brief.factKeys,
  );
  if (!link) throw new DomainError("LINK_NOT_ALLOWED", 409);
  const slot = Date.parse(brief.slotAt);
  if (!Number.isFinite(slot) || slot <= now.valueOf())
    throw new DomainError("SLOT_PASSED", 409);
  const rules = await resolveChannelRules(
    tx,
    scope,
    brief.channel,
    assignment.contentType,
    false,
  );
  const checked = await validateDraftMission(
    tx,
    scope,
    {
      title:
        `${rules.providerIdentifier ?? assignment.contentType}: ${brief.topic}`.slice(
          0,
          160,
        ),
      goal: `${brief.topic}. ${brief.angle}`.slice(0, 2000),
      audience: profile.audience.slice(0, 300),
      product: profile.productName,
      language: profile.contentLanguage,
      channels: [brief.channel],
      maxContents: 1,
      // The CTA stays the profile's approved one; the brief's cta only steers the text.
      targetAction: profile.primaryCtas[0],
      targetUrl: link.url,
      sourceIds: [...new Set(facts.map((fact) => data(fact).sourceId))],
      assetIds: [],
      contentType: assignment.contentType,
      campaignType: "product",
      profileVersion: profileRow.version,
      startAt: now.toISOString(),
      endAt: new Date(
        Math.min(slot + SLOT_WINDOW_MS, Date.parse(data(policyRow).endAt)),
      ).toISOString(),
    },
    facts.map((fact) => fact.id),
  );
  const ceiling = await missionCeiling(tx, scope, task);
  const mission = await create(tx, scope, "missions", {
    ...checked.parsed,
    status: "ready",
    plannedSlotAt: new Date(slot).toISOString(),
    factKeys: facts.map((fact) => data(fact).key),
    assignmentId: task.assignmentId,
    assignmentRunId: task.runId,
    briefKey: briefKey(brief),
    brief: {
      topic: brief.topic,
      angle: brief.angle,
      cta: brief.cta,
      notARepeatBecause: brief.notARepeatBecause,
    },
    agentTaskId: task.id,
    agentJobId: jobId,
    budgetRunKey: runBudgetKey(task.runId),
    chatCostCeilingMicros: ceiling.ceilingMicros,
    // Which budget set the ceiling, so a reused mission's refusal is named right.
    costCeilingBound: ceiling.monthBound ? "month" : "task",
    // A run with an image writes captions that fit media limits (Telegram 1,024).
    mediaPlanned: assignment.image === true,
    // The confirmed delivery travels with the draft (R73, I1): the publish
    // guard reads it, never the live assignment row.
    delivery: confirmedDelivery(assignment) ?? deliveryOf(assignment),
    ...extra,
  });
  return { missionId: mission.id, monthBound: ceiling.monthBound };
}

/**
 * Drafts one prepared mission, then puts an existing run image on the draft.
 * The attach is best effort: the paid draft counts even if it fails, and the
 * image reaches the draft with the next attach of the run.
 */
async function draft(
  scope: Scope,
  task: AgentTask,
  missionId: string,
  jobId: string,
) {
  const content = await generateMissionLive(scope, missionId, jobId);
  try {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      attachRunImage(tx, scope, task.runId),
    );
  } catch (error) {
    console.error("Orbit assignment image attach failed", errorCode(error));
  }
  return content;
}

/** A mission whose brief failed is closed, so nothing drafts it later. */
async function failMission(scope: Scope, missionId: string, code: string) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await entity(tx, scope, "missions", missionId);
    if (data(row).status !== "ready") return;
    await update(tx, scope, row, {
      ...data(row),
      status: "failed",
      failureCode: code,
    });
  });
}

/** The task's code for a failed brief; a mission ceiling hit names the budget that bound it. */
function briefFailure(error: unknown, monthBound: boolean) {
  const code = errorCode(error);
  if (code === "CHAT_PROPOSAL_COST_EXCEEDED")
    return monthBound ? ASSIGNMENT_BUDGET_EXHAUSTED : "AGENT_LIMIT";
  return code === "UNEXPECTED" ? "AGENT_FAILED" : code;
}

const PAUSED = "PROJECT_PAUSED";

/**
 * Whether the runner will requeue this task for the resume (I7b): it threw
 * `PROJECT_PAUSED` (no draft written, every failed brief refused by the pause)
 * and none of its calls was paid.
 */
async function requeuedByPause(
  scope: Scope,
  task: AgentTask,
  contentIds: string[],
  failed: Array<{ code: string }>,
) {
  if (contentIds.length || !failed.every((entry) => entry.code === PAUSED))
    return false;
  return scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => !(await taskReservations(tx, scope, task.id)).length,
  );
}

export const copywriterStep: StepHandler = async (scope, task) => {
  const contentIds: string[] = [];
  const failed: Array<{ briefKey: string; code: string }> = [];
  // Missions the project pause refused: failed or left ready once the task is known (N1).
  const pausedMissions: string[] = [];
  let exhausted = false;
  for (const brief of taskBriefs(task)) {
    const key = briefKey(brief);
    // The month is used up: the remaining briefs are not attempted.
    if (exhausted) {
      failed.push({ briefKey: key, code: ASSIGNMENT_BUDGET_EXHAUSTED });
      continue;
    }
    const jobId = `agent:${task.id}:copy:${key}`;
    let monthBound = false;
    let missionId: string | null = null;
    try {
      missionId = await scoped(
        scope.workspaceId,
        scope.projectId,
        async (tx) => {
          const existing = await missionOfJob(tx, scope, jobId);
          if (existing) {
            monthBound = data(existing).costCeilingBound === "month";
            return existing.id;
          }
          const created = await briefMission(tx, scope, task, brief, jobId);
          monthBound = created.monthBound;
          return created.missionId;
        },
      );
      const content = await draft(scope, task, missionId, jobId);
      contentIds.push(content.id);
    } catch (error) {
      const code = briefFailure(error, monthBound);
      failed.push({ briefKey: key, code });
      if (missionId && code === PAUSED) pausedMissions.push(missionId);
      else if (missionId) await failMission(scope, missionId, code);
      if (code === ASSIGNMENT_BUDGET_EXHAUSTED) exhausted = true;
    }
  }
  // The pause refused every brief before anything was paid: the runner puts the
  // task back in the queue for the resume (I7b), so its missions stay ready for
  // it. In any other case no task will draft them, so they close (R41/I2b).
  if (
    pausedMissions.length &&
    !(await requeuedByPause(scope, task, contentIds, failed))
  )
    for (const missionId of pausedMissions)
      await failMission(scope, missionId, PAUSED);
  if (!contentIds.length && failed.length)
    // Nothing written: the task fails; a used-up month pauses the assignment (R25).
    throw new DomainError(
      exhausted ? ASSIGNMENT_BUDGET_EXHAUSTED : failed[0]!.code,
    );
  return { contentIds, failed };
};

/**
 * Revision of one draft of the task's run (review `revise`): the same mission
 * path with `revisionOf` and the review's instruction, attributed to the
 * revising task (`agent:<taskId>:revise:<contentId>`). The old draft stays;
 * the caller decides what replaces what.
 */
export async function reviseAssignmentDraft(
  scope: Scope,
  task: AgentTask,
  input: { contentId: string; instruction: string },
) {
  const jobId = `agent:${task.id}:revise:${input.contentId}`;
  const missionId: string = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const existing = await missionOfJob(tx, scope, jobId);
      if (existing) return existing.id;
      const parent = await entity(tx, scope, "content", input.contentId);
      if (data(parent).assignmentRunId !== task.runId)
        throw new DomainError("DRAFT_NOT_IN_RUN", 409);
      const original = data(
        await entity(tx, scope, "missions", data(parent).missionId),
      );
      const created = await briefMission(
        tx,
        scope,
        task,
        {
          channel: original.channels[0],
          slotAt: original.plannedSlotAt,
          factKeys: original.factKeys,
          imageIdea: null,
          ...original.brief,
        },
        jobId,
        {
          revisionOf: {
            contentId: parent.id,
            version: parent.version,
            instruction: input.instruction,
          },
        },
      );
      return created.missionId;
    },
  );
  try {
    return await draft(scope, task, missionId, jobId);
  } catch (error) {
    await failMission(scope, missionId, briefFailure(error, false));
    throw error;
  }
}

/**
 * Saves an approved blog or newsletter draft to Drive (spec: these drafts are
 * never published). Approved means an owner review or an agent review of
 * exactly the current text. The Markdown of the content export goes to
 * `Orbit_Drafts/<Blog|Newsletter>`; the same text is saved once.
 */
export async function saveDraftToDrive(scope: Scope, contentId: string) {
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  const content = await inScope((tx) =>
    entity(tx, scope, "content", contentId),
  );
  const v = data(content);
  if (v.type !== "blog" && v.type !== "newsletter")
    throw new DomainError("DRAFT_NOT_EXPORTABLE", 409);
  const bodyHash = hash(v.body);
  // An agent review counts here without the publishing conditions: a draft on Drive is never published.
  const agentApproved =
    v.agentReview?.bodyHash === bodyHash &&
    Array.isArray(v.agentReview?.deterministicProblems) &&
    v.agentReview.deterministicProblems.length === 0;
  if (v.humanReviewedBodyHash !== bodyHash && !agentApproved)
    throw new DomainError("CONTENT_APPROVAL_REQUIRED", 409);
  if (v.driveDraft?.bodyHash === bodyHash) return content;
  // Text only: the attached image is neither loaded nor read.
  const bundle = await exportContentBundle(scope, contentId, {
    withAsset: false,
  });
  const article = bundle.files.find((file) => file.path === "article.md");
  const sources = bundle.article.sourceUrls.length
    ? `\n\n---\nSources:\n${bundle.article.sourceUrls.map((url) => `- ${url}`).join("\n")}\n`
    : "\n";
  const text = String(article?.content ?? v.body);
  // A body that opens with its own H1 keeps it; otherwise the title becomes the H1.
  const heading = /^\s*# /.test(text) ? "" : `# ${bundle.article.title}\n\n`;
  const markdown = `${heading}${text}${sources}`;
  const saved = await saveDraftDocument(scope, {
    contentId,
    bodyHash,
    category: v.type === "blog" ? "Blog" : "Newsletter",
    filename: `${bundle.article.slug}.md`,
    mime: "text/markdown",
    bytes: Buffer.from(markdown, "utf8"),
  });
  return inScope(async (tx) => {
    const current = await entity(tx, scope, "content", contentId);
    // The text changed meanwhile: the saved file stays, the record does not claim it.
    if (hash(data(current).body) !== bodyHash) return current;
    const result = await update(tx, scope, current, {
      ...data(current),
      driveDraft: {
        fileId: saved.id,
        folderId: saved.folderId,
        webViewLink: saved.webViewLink,
        bodyHash,
        savedAt: new Date().toISOString(),
      },
    });
    await audit(tx, scope, "content.draft_saved_to_drive", contentId, {
      fileId: saved.id,
      bodyHash,
    });
    return result;
  });
}
