import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  knowledgeDraft,
  type KnowledgeSnapshot,
} from "../../../../../packages/schemas/src/knowledge-workspace.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../shared.ts";
import {
  knowledgeOperationsSettings,
  lockKnowledge,
  recordKnowledgeIssue,
  resolveKnowledgeIssue,
} from "./operations.ts";
import {
  owner,
  previewDraft,
  startAnalysis,
  workspaceEnabled,
} from "./workspace.ts";

const WEEK = 7 * 86400000;
const TOPIC = "knowledge_github_refresh";

export async function setGithubRefresh(tx: DbTx, s: Scope, raw: unknown) {
  const i = z
    .object({
      draftId: z.uuid(),
      version: z.number().int().positive(),
      enabled: z.boolean(),
      confirmModelUse: z.literal(true).optional(),
    })
    .strict()
    .parse(raw);
  await lockKnowledge(tx, s);
  const row = await entity(tx, s, "knowledge_drafts", i.draftId);
  const d = data(row);
  if (row.version !== i.version) throw new DomainError("VERSION_CONFLICT", 409);
  if (d.input?.kind !== "github" || d.status === "replaced")
    throw new DomainError("KNOWLEDGE_GITHUB_DRAFT_REQUIRED", 409);
  if (i.enabled) {
    if (!(await knowledgeOperationsSettings(tx, s)).automation)
      throw new DomainError("KNOWLEDGE_AUTOMATION_DISABLED", 409);
    const draft = knowledgeDraft.parse(d.input);
    if (!draft.branch)
      throw new DomainError("KNOWLEDGE_GITHUB_BRANCH_REQUIRED", 409);
    if (
      i.confirmModelUse &&
      (!draft.modelUse || draft.rights?.modelUse === false)
    )
      throw new DomainError("MODEL_USE_FORBIDDEN", 409);
    const connection = await entity(
      tx,
      s,
      "knowledge_github_connections",
      draft.connectionId!,
    );
    if (data(connection).actorId !== s.userId)
      throw new DomainError("GITHUB_RECONNECT_REQUIRED", 409);
  }
  const next = {
    ...data(row).githubRefresh,
    enabled: i.enabled,
    autoAnalyze: i.enabled && i.confirmModelUse === true,
    ownerId: s.userId,
    approvedInputHash: hash(d.input),
    nextAt: i.enabled ? new Date(Date.now() + WEEK).toISOString() : null,
  };
  await update(tx, s, row, { ...d, githubRefresh: next });
  await audit(tx, s, "knowledge.github_refresh_settings", row.id, {
    enabled: next.enabled,
    autoAnalyze: next.autoAnalyze,
  });
  return {
    enabled: next.enabled,
    autoAnalyze: next.autoAnalyze,
    nextAt: next.nextAt,
  };
}

export async function githubRefreshScheduler(tx: DbTx, s: Scope, at: Date) {
  if (
    !workspaceEnabled() ||
    !(await knowledgeOperationsSettings(tx, s)).automation
  )
    return 0;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: s.projectId },
    select: { paused: true },
  });
  if (project.paused) return 0;
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      kind: "knowledge_drafts",
      data: { path: ["githubRefresh", "enabled"], equals: true },
    },
    take: 200,
  });
  let queued = 0;
  for (const row of rows) {
    const d = data(row);
    const refresh = d.githubRefresh;
    if (
      d.status === "replaced" ||
      d.activeRunId ||
      Date.parse(refresh.nextAt) > at.getTime()
    )
      continue;
    if (refresh.jobId) {
      const job = await tx.entity.findFirst({
        where: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          kind: "jobs",
          id: refresh.jobId,
        },
      });
      if (["queued", "running", "retry_scheduled"].includes(data(job).status))
        continue;
    }
    // Reserve the next slot in the same transaction as the outbox entry.
    const job = await enqueue(
      tx,
      s,
      TOPIC,
      row.id,
      `${TOPIC}:${row.id}:${refresh.nextAt}`,
      at,
      {
        approval: String(refresh.approvedInputHash),
        sponsorId: String(refresh.ownerId),
      },
    );
    await update(tx, s, row, {
      ...d,
      githubRefresh: {
        ...refresh,
        jobId: job.id,
        nextAt: new Date(at.getTime() + WEEK).toISOString(),
      },
    });
    queued++;
  }
  return queued;
}

type GithubRefreshAuthority = { approval: string; sponsorId: string };

export async function assertGithubRefresh(
  tx: DbTx,
  s: Scope,
  draft: { data: unknown },
  authority: GithubRefreshAuthority,
) {
  const d = data(draft);
  const refresh = d.githubRefresh;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: s.projectId },
    select: { paused: true },
  });
  if (
    project.paused ||
    !workspaceEnabled() ||
    !(await knowledgeOperationsSettings(tx, s)).automation ||
    refresh?.enabled !== true ||
    d.status === "replaced" ||
    refresh.ownerId !== authority.sponsorId ||
    authority.sponsorId !== s.userId ||
    refresh.approvedInputHash !== authority.approval
  )
    throw new DomainError("KNOWLEDGE_GITHUB_REFRESH_STOPPED", 409);
  if (hash(d.input) !== authority.approval)
    throw new DomainError("KNOWLEDGE_GITHUB_SCOPE_CHANGED", 409);
  const connection = await entity(
    tx,
    s,
    "knowledge_github_connections",
    d.input.connectionId,
  );
  if (data(connection).actorId !== s.userId)
    throw new DomainError("GITHUB_RECONNECT_REQUIRED", 409);
}

export async function runGithubRefresh(
  s: Scope,
  draftId: string,
  approval: string,
  sponsorId: string,
) {
  const authority = { approval, sponsorId };
  try {
    const actor = await actorScope(s.workspaceId, s.projectId, sponsorId);
    if (actor?.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
    await owner(actor);
    const preview = await previewDraft(actor, { draftId }, authority);
    const analyze = await scoped(s.workspaceId, s.projectId, async (tx) => {
      const row = await entity(tx, actor, "knowledge_drafts", draftId);
      await assertGithubRefresh(tx, actor, row, authority);
      const p = await entity(tx, actor, "knowledge_previews", preview.id);
      const snap = data(p).snapshot as KnowledgeSnapshot;
      const currentHash = hash(
        snap.files.map(({ path, hash }) => [path, hash]),
      );
      return (
        !snap.partial &&
        data(row).githubRefresh.autoAnalyze === true &&
        data(row).githubRefresh.lastSnapshotHash !== currentHash
      );
    });
    if (analyze)
      await startAnalysis(
        actor,
        { previewId: preview.id, confirmModelUse: true },
        authority,
      );
    await scoped(s.workspaceId, s.projectId, async (tx) => {
      await lockKnowledge(tx, actor);
      const row = await entity(tx, actor, "knowledge_drafts", draftId);
      await assertGithubRefresh(tx, actor, row, authority);
      const p = await entity(tx, actor, "knowledge_previews", preview.id);
      const snap = data(p).snapshot as KnowledgeSnapshot;
      const d = data(row);
      const refresh = d.githubRefresh;
      await update(tx, actor, row, {
        ...d,
        githubRefresh: {
          ...refresh,
          lastReadAt: new Date().toISOString(),
          previewId: preview.id,
          lastSnapshotHash: snap.partial
            ? refresh.lastSnapshotHash
            : hash(snap.files.map(({ path, hash }) => [path, hash])),
          errorCode: snap.partial ? "KNOWLEDGE_GITHUB_PARTIAL" : null,
        },
      });
      const at = new Date();
      if (snap.partial)
        await recordKnowledgeIssue(
          tx,
          actor,
          "github",
          draftId,
          "KNOWLEDGE_GITHUB_PARTIAL",
          at,
        );
      else await resolveKnowledgeIssue(tx, actor, "github", draftId, at);
    });
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "KNOWLEDGE_GITHUB_REFRESH_STOPPED"
    )
      return;
    const code =
      error instanceof DomainError
        ? error.code
        : "KNOWLEDGE_GITHUB_REFRESH_FAILED";
    await scoped(s.workspaceId, s.projectId, async (tx) => {
      await lockKnowledge(tx, s);
      const row = await entity(tx, s, "knowledge_drafts", draftId);
      const d = data(row);
      const refresh = d.githubRefresh;
      if (
        refresh?.enabled !== true ||
        refresh.approvedInputHash !== approval ||
        refresh.ownerId !== sponsorId
      )
        return;
      await update(tx, s, row, {
        ...d,
        githubRefresh: { ...refresh, errorCode: code },
      });
      await recordKnowledgeIssue(tx, s, "github", draftId, code, new Date());
    });
  }
}
