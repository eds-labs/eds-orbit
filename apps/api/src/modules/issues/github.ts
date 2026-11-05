import { randomUUID } from "node:crypto";
import { Prisma, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  getRepository,
  githubFetch,
  GithubSendError,
  installationToken,
  type GithubAppSecret,
  type GithubPermissions,
} from "../../platform/connections/github-app.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { audit, data, DomainError, update } from "../../shared.ts";
import { ISSUE_TYPE, issueDomainEvent, issueEvent, uuid, type IssueActor } from "./common.ts";
import { issuesActive, issuesGithubSwitchedOn, requireIssues, requireIssuesGithub } from "./gate.ts";
import {
  assertNoHits,
  githubExternalId,
  githubIssueText,
  issueOrbitUrl,
  parseGithubIssueUrl,
  REQUEST_MARKER,
} from "./github-body.ts";
import { allowedRepository, githubApp } from "./github-connection.ts";
import { loadIssue, shareableFields, type IssueRow } from "./issues.ts";
import { readIssuesSettings } from "./settings.ts";

// GitHub issues from Orbit issues (spec 2026-11-05 §5.2). A request is a
// project entity; the worker job creates the GitHub issue exactly once:
//
//   queued ──(checks pass, committed)──> sending ──POST──> done
//      │                                    │  definite refusal ──> failed
//      │ check fails ──> failed             │  unclear, not last ──> sending (rethrow; the
//      │                                    │      retry lists the App's issues by marker
//      │                                    │      before it posts again)
//      │                                    │  unclear, last attempt ──> outcome_unknown
//      │                                    │  check fails on retry ──> outcome_unknown
//   outcome_unknown ──reconcile (list only, never creates)──> done, or failed
//      (ISSUES_GITHUB_NOT_FOUND) when the complete listing has no marker and
//      the last POST was committed at least 2 minutes ago
//
// No GitHub call runs inside a database transaction. `sending` is committed
// before the POST, so a crash mid-POST leaves `sending` and the next attempt
// reconciles first. Records hold ids, codes and the repository name only:
// never the token, the key or the issue text.

/** The queue class of the GitHub job. */
export const ISSUES_GITHUB = "issues_github";
/** The entity kind of a create request. */
export const REQUEST_KIND = "issues_github_request";

export type GithubRequestStatus = "queued" | "sending" | "done" | "failed" | "outcome_unknown";

const PREVIEW_REQUEST_ID = "00000000-0000-0000-0000-000000000000";
/** Statuses an issue must have left before it may go to GitHub. */
const NOT_READY = ["new", "triage", "needs_info", "duplicate"];
const IN_FLIGHT = ["queued", "sending"];
/** Requests that block a new one for the same issue and repository. */
const UNSETTLED = [...IN_FLIGHT, "outcome_unknown"];
/** A reconcile settles "not found" only this long after the last POST was committed (replica lag). */
const NOT_FOUND_AFTER_MS = 2 * 60_000;
const CREATE_PERMISSIONS: GithubPermissions = { issues: "write", metadata: "read" };
export const READ_PERMISSIONS: GithubPermissions = { issues: "read", metadata: "read" };
const LIST_PAGES = 3;
const PAGE_SIZE = 100;
/** `since` reaches back this far, for clock skew between Orbit and GitHub. */
const SINCE_SKEW_MS = 5 * 60_000;
const SYSTEM: IssueActor = { kind: "system", id: null };

/** `owner/name` of an allow-list entry; dot names never reach a path. */
export function splitName(fullName: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(fullName);
  const parts = match ? [match[1]!, match[2]!] : [];
  if (parts.length !== 2 || parts.some((p) => p === "." || p === ".."))
    throw new DomainError("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED", 409);
  return parts as [string, string];
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The issue's GitHub ref in this repository, if any. */
async function linkedIn(tx: DbTx, scope: Scope, issueId: string, fullName: string) {
  const refs = await tx.issueExternalRef.findMany({
    where: { projectId: scope.projectId, issueId, system: "github" },
  });
  const prefix = `${fullName}#`.toLowerCase();
  return refs.find((r) => r.externalId.toLowerCase().startsWith(prefix)) ?? null;
}

function assertReady(issue: IssueRow) {
  if (NOT_READY.includes(issue.status)) throw new DomainError("ISSUES_NOT_CONFIRMED", 409);
  return shareableFields(issue);
}

/** Request checks 2–3 of spec §5.2 (the flag and permission are checked by the caller). */
async function checkRequest(tx: DbTx, scope: Scope, issueId: string, repositoryKey: string) {
  const issue = await loadIssue(tx, scope, issueId);
  const fields = assertReady(issue);
  const { settings } = await readIssuesSettings(tx, scope);
  const repository = allowedRepository(settings, repositoryKey);
  splitName(repository.fullName);
  if (await linkedIn(tx, scope, issue.id, repository.fullName))
    throw new DomainError("ISSUES_GITHUB_ALREADY_LINKED", 409);
  await githubApp(tx, scope);
  return { issue, fields, repository };
}

/** The exact title and body a request would send; writes nothing. */
export async function previewGithubIssue(
  tx: DbTx,
  scope: Scope,
  issueId: string,
  repositoryKey: string,
): Promise<{ title: string; body: string; repository: string; hits: Record<string, number> }> {
  requireIssuesGithub();
  const { issue, fields, repository } = await checkRequest(tx, scope, issueId, repositoryKey);
  const text = githubIssueText(fields, {
    requestId: PREVIEW_REQUEST_ID,
    orbitUrl: issueOrbitUrl(scope.projectId, issue.id),
  });
  return { title: text.title, body: text.body, repository: repository.fullName, hits: text.hits };
}

/**
 * A request in flight or with an unknown outcome may still create the
 * issue: it must finish or be reconciled first (never a blind re-create).
 */
export async function assertNoUnsettledRequest(tx: DbTx, scope: Scope, issueId: string, fullName: string) {
  const open = await tx.entity.findMany({
    where: { projectId: scope.projectId, kind: REQUEST_KIND, data: { path: ["issueId"], equals: issueId } },
  });
  if (open.some((r) => UNSETTLED.includes(data(r).status) && sameName(String(data(r).fullName), fullName)))
    throw new DomainError("ISSUES_GITHUB_REQUEST_STATE", 409);
}

/**
 * Queues the creation of a GitHub issue (spec §5.2 "Request"). The request
 * id is the entity id and the marker in the GitHub body.
 */
export async function requestGithubIssue(
  tx: DbTx,
  scope: Scope,
  issueId: string,
  repositoryKey: string,
  actor: IssueActor,
): Promise<{ requestId: string; status: "queued" }> {
  requireIssuesGithub();
  const id = uuid.parse(issueId);
  // One request at a time per issue: concurrent clicks queue up here.
  await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${id}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  const { issue, fields, repository } = await checkRequest(tx, scope, id, repositoryKey);
  await assertNoUnsettledRequest(tx, scope, issue.id, repository.fullName);

  const requestId = randomUUID();
  assertNoHits(githubIssueText(fields, { requestId, orbitUrl: issueOrbitUrl(scope.projectId, issue.id) }));
  const value = {
    issueId: issue.id,
    repositoryKey: repository.key,
    fullName: repository.fullName,
    requestId,
    status: "queued",
    attempts: 0,
    requestedAt: new Date().toISOString(),
    requestedBy: actor.id ?? actor.kind,
    issueVersion: issue.version,
  };
  await tx.entity.create({
    data: {
      id: requestId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: REQUEST_KIND,
      data: value as Prisma.InputJsonValue,
    },
  });
  await tx.entityVersion.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      entityId: requestId,
      version: 1,
      data: value as Prisma.InputJsonValue,
    },
  });
  // The history type is "github" (core migration check); `action` names the step.
  await issueEvent(tx, scope, issue.id, "github", actor, {}, { action: "requested", repository: repository.fullName, requestId });
  await audit(tx, scope, "issues.github.requested", requestId, {
    issueId: issue.id,
    repository: repository.fullName,
    actorKind: actor.kind,
  });
  await enqueue(tx, scope, ISSUES_GITHUB, requestId, `issues-github:${requestId}`, new Date(), { kind: "create" });
  return { requestId, status: "queued" };
}

/** The latest create requests of an issue, for its detail. */
export async function githubRequestsOf(tx: DbTx, scope: Scope, issueId: string) {
  const rows = await tx.entity.findMany({
    where: { projectId: scope.projectId, kind: REQUEST_KIND, data: { path: ["issueId"], equals: issueId } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map((row) => {
    const d = data(row);
    return {
      id: row.id,
      status: d.status as GithubRequestStatus,
      repository: String(d.fullName),
      code: (d.code as string | undefined) ?? null,
      externalId: (d.externalId as string | undefined) ?? null,
      requestedAt: String(d.requestedAt),
    };
  });
}

type RequestValue = Record<string, any>;
type Prepared = {
  app: GithubAppSecret;
  fullName: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
};

/**
 * Job step 1: the flag, the issue (confirmed, share-reviewed, unchanged
 * since the request), the allow-list and the grant, and the text again.
 * Throws a DomainError with the refusal's code.
 */
async function recheck(tx: DbTx, scope: Scope, value: RequestValue): Promise<Prepared> {
  if (!issuesGithubSwitchedOn()) throw new DomainError("ISSUES_GITHUB_DISABLED", 404);
  if (!(await issuesActive(tx, scope))) throw new DomainError("ISSUES_DISABLED", 404);
  const issue = await tx.issue.findFirst({ where: { projectId: scope.projectId, id: String(value.issueId) } });
  if (!issue) throw new DomainError("ISSUES_NOT_FOUND", 404);
  const fields = assertReady(issue);
  if (issue.version !== value.issueVersion) throw new DomainError("ISSUES_VERSION_CONFLICT", 409);
  const { settings } = await readIssuesSettings(tx, scope);
  const repository = allowedRepository(settings, String(value.repositoryKey));
  if (!sameName(repository.fullName, String(value.fullName)))
    throw new DomainError("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED", 409);
  const [owner, repo] = splitName(repository.fullName);
  if (await linkedIn(tx, scope, issue.id, repository.fullName))
    throw new DomainError("ISSUES_GITHUB_ALREADY_LINKED", 409);
  const { app } = await githubApp(tx, scope);
  const text = githubIssueText(fields, {
    requestId: String(value.requestId),
    orbitUrl: issueOrbitUrl(scope.projectId, issue.id),
  });
  assertNoHits(text);
  return { app, fullName: repository.fullName, owner, repo, title: text.title, body: text.body };
}

const loadRequest = (tx: DbTx, scope: Scope, id: string) =>
  tx.entity.findFirst({ where: { id, kind: REQUEST_KIND, projectId: scope.projectId } });

/** Moves an unfinished request to `failed` or `outcome_unknown` (content-free audit). */
async function settleIn(
  tx: DbTx,
  scope: Scope,
  id: string,
  status: "failed" | "outcome_unknown",
  code: string,
) {
  const row = await loadRequest(tx, scope, id);
  if (!row || !["queued", "sending"].includes(data(row).status)) return;
  const value = data(row);
  await update(tx, scope, row, { ...value, status, code });
  await audit(tx, scope, status === "failed" ? "issues.github.failed" : "issues.github.outcome_unknown", id, {
    issueId: value.issueId,
    repository: value.fullName,
    code,
  });
}

const settle = (scope: Scope, id: string, status: "failed" | "outcome_unknown", code: string) =>
  scoped(scope.workspaceId, scope.projectId, (tx) => settleIn(tx, scope, id, status, code));

/** The created issue's number from GitHub's answer, if it is this repository's issue. */
function createdIssue(result: unknown, fullName: string): { number: number; url: string } | null {
  const row = result as { number?: unknown; html_url?: unknown } | null;
  if (typeof row?.html_url !== "string" || typeof row.number !== "number") return null;
  try {
    const parsed = parseGithubIssueUrl(row.html_url);
    if (!sameName(parsed.fullName, fullName) || parsed.number !== row.number) return null;
    return { number: parsed.number, url: `https://github.com/${parsed.fullName}/issues/${parsed.number}` };
  } catch {
    return null;
  }
}

/**
 * Searches the App's issues in the repository since the request for its
 * marker: the issue, null when the complete listing has none, or
 * "incomplete" when three full pages did not settle it. Throws on any
 * GitHub failure.
 */
async function findByMarker(
  app: GithubAppSecret,
  token: string,
  owner: string,
  repo: string,
  value: RequestValue,
): Promise<{ number: number; url: string } | null | "incomplete"> {
  const marker = REQUEST_MARKER(String(value.requestId));
  const since = encodeURIComponent(new Date(Date.parse(String(value.requestedAt)) - SINCE_SKEW_MS).toISOString());
  const creator = encodeURIComponent(`${app.appSlug}[bot]`);
  for (let page = 1; page <= LIST_PAGES; page += 1) {
    const rows = await githubFetch<unknown>(
      `/repos/${owner}/${repo}/issues?creator=${creator}&state=all&since=${since}&per_page=${PAGE_SIZE}&page=${page}`,
      token,
    );
    if (!Array.isArray(rows)) throw new GithubSendError("GITHUB_REQUEST_FAILED", false);
    for (const row of rows as Array<{ body?: unknown; pull_request?: unknown }>) {
      if (row?.pull_request || typeof row?.body !== "string") continue;
      if (row.body.split(/\r?\n/)[0]!.trim() !== marker) continue;
      const found = createdIssue(row, `${owner}/${repo}`);
      if (found) return found;
    }
    if (rows.length < PAGE_SIZE) return null;
  }
  return "incomplete";
}

/**
 * Job step 5: the ref, the request `done`, history, audit and the domain
 * event, in one transaction. A request that already finished is left alone.
 */
async function linkRequest(
  scope: Scope,
  id: string,
  found: { number: number; url: string },
  actor: IssueActor,
): Promise<GithubRequestStatus> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await loadRequest(tx, scope, id);
    if (!row) return "failed";
    const value = data(row);
    if (!["sending", "outcome_unknown"].includes(value.status)) return value.status;
    const fullName = String(value.fullName);
    const externalId = githubExternalId(fullName, found.number);
    const existing = await tx.issueExternalRef.findFirst({
      where: { projectId: scope.projectId, system: "github", externalId },
    });
    if (existing && existing.issueId !== value.issueId) {
      await settleIn(tx, scope, id, "failed", "ISSUES_GITHUB_ALREADY_LINKED");
      return "failed";
    }
    if (!existing)
      await tx.issueExternalRef.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          issueId: String(value.issueId),
          system: "github",
          externalId,
          url: found.url,
          state: "open",
          syncedAt: new Date(),
          createdBy: String(value.requestedBy),
        },
      });
    await update(tx, scope, row, { ...value, status: "done", code: null, externalId });
    const issue = await tx.issue.findFirst({ where: { projectId: scope.projectId, id: String(value.issueId) } });
    await issueEvent(tx, scope, String(value.issueId), "github", actor, {}, {
      action: "linked",
      repository: fullName,
      externalId,
      requestId: id,
    });
    await audit(tx, scope, "issues.github.linked", id, { issueId: value.issueId, repository: fullName, externalId });
    await issueDomainEvent(tx, scope, "issues.github.linked", { type: ISSUE_TYPE, id: String(value.issueId) }, actor, {
      number: issue?.number ?? null,
      repository: fullName,
      externalId,
    });
    return "done";
  });
}

/** True unless GitHub definitely refused or never received the request. */
const sentOf = (error: unknown) => !(error instanceof GithubSendError) || error.sent;
/** Worth another attempt: a GitHub call that may have been received, or an unexpected error. */
const transient = (error: unknown) =>
  !(error instanceof DomainError) || (error instanceof GithubSendError && error.sent);
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : "GITHUB_REQUEST_FAILED");

/**
 * The worker job (spec §5.2 "Job", steps 1–6). `job` carries the worker's
 * attempt counter, which the worker has already raised for this run: the
 * run with `attempts >= maxAttempts` is the last one. Without it the run
 * counts as the last one, so an unclear outcome is never left `sending`.
 */
export async function runGithubCreate(
  scope: Scope,
  requestEntityId: string,
  job: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
): Promise<void> {
  const last = !(job.attempts < job.maxAttempts);
  try {
    await createOnce(scope, requestEntityId, last);
  } catch (error) {
    // An unexpected failure of the last run never leaves the request in flight.
    if (last)
      await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const row = await loadRequest(tx, scope, requestEntityId);
        const status = data(row).status;
        if (status === "sending") await settleIn(tx, scope, requestEntityId, "outcome_unknown", codeOf(error));
        else if (status === "queued") await settleIn(tx, scope, requestEntityId, "failed", codeOf(error));
      }).catch(() => undefined);
    throw error;
  }
}

async function createOnce(scope: Scope, requestEntityId: string, last: boolean): Promise<void> {
  // 1. Read and re-check in one transaction; a refusal is recorded there.
  const step1 = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await loadRequest(tx, scope, requestEntityId);
    if (!row || !IN_FLIGHT.includes(data(row).status)) return null;
    try {
      return { row: { id: row.id, version: row.version }, value: data(row), prepared: await recheck(tx, scope, data(row)) };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // A request that was already sending may have reached GitHub: it stays reconcilable.
      await settleIn(tx, scope, row.id, data(row).status === "sending" ? "outcome_unknown" : "failed", error.code);
      return null;
    }
  });
  if (!step1) return;
  const { value, prepared } = step1;
  const wasSending = value.status === "sending";
  const refused = (code: string) => settle(scope, requestEntityId, wasSending ? "outcome_unknown" : "failed", code);
  /** A failure before this run's POST: nothing new reached GitHub. */
  const beforePost = async (error: unknown) => {
    if (transient(error) && !last) throw error;
    await refused(codeOf(error));
  };

  // 2. Outside any transaction: still private, then a token for this one repository.
  let token: string;
  try {
    const repository = await getRepository(prepared.app, prepared.fullName);
    if (!sameName(repository.fullName, prepared.fullName) || repository.archived)
      return void (await refused("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED"));
    if (repository.private !== true) return void (await refused("ISSUES_GITHUB_REPOSITORY_PUBLIC"));
    token = await installationToken(prepared.app, { repositories: [prepared.repo], permissions: CREATE_PERMISSIONS });
  } catch (error) {
    return beforePost(error);
  }

  // 3. A request found `sending` may have been created: reconcile before any repeated write.
  if (wasSending) {
    let found: Awaited<ReturnType<typeof findByMarker>>;
    try {
      found = await findByMarker(prepared.app, token, prepared.owner, prepared.repo, value);
    } catch (error) {
      // Never post without a complete, successful listing.
      if (transient(error) && !last) throw error;
      return void (await settle(scope, requestEntityId, "outcome_unknown", codeOf(error)));
    }
    if (found === "incomplete")
      return void (await settle(scope, requestEntityId, "outcome_unknown", "ISSUES_GITHUB_RECONCILE_INCOMPLETE"));
    if (found) return void (await linkRequest(scope, requestEntityId, found, SYSTEM));
  }

  // Commit `sending` before the POST, after checking everything once more.
  const go = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await loadRequest(tx, scope, requestEntityId);
    if (!row || row.version !== step1.row.version) throw new DomainError("VERSION_CONFLICT", 409);
    const status = wasSending ? "outcome_unknown" : "failed";
    let again: Prepared;
    try {
      again = await recheck(tx, scope, data(row));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await settleIn(tx, scope, row.id, status, error.code);
      return false;
    }
    if (again.title !== prepared.title || again.body !== prepared.body || again.fullName !== prepared.fullName) {
      await settleIn(tx, scope, row.id, status, "ISSUES_VERSION_CONFLICT");
      return false;
    }
    await update(tx, scope, row, {
      ...data(row),
      status: "sending",
      attempts: Number(data(row).attempts ?? 0) + 1,
      sendingAt: new Date().toISOString(),
    });
    return true;
  });
  if (!go) return;

  // 4. The one write.
  let result: unknown;
  try {
    result = await githubFetch(`/repos/${prepared.owner}/${prepared.repo}/issues`, token, {
      method: "POST",
      body: JSON.stringify({ title: prepared.title, body: prepared.body }),
    });
  } catch (error) {
    // 6. A definite refusal created nothing; anything else may have.
    if (!sentOf(error)) return void (await settle(scope, requestEntityId, "failed", codeOf(error)));
    if (!last) throw error;
    return void (await settle(scope, requestEntityId, "outcome_unknown", codeOf(error)));
  }
  const created = createdIssue(result, prepared.fullName);
  if (!created) {
    // Accepted, but the answer names no issue of this repository.
    if (!last) throw new GithubSendError("GITHUB_REQUEST_FAILED", true);
    return void (await settle(scope, requestEntityId, "outcome_unknown", "GITHUB_REQUEST_FAILED"));
  }

  // 5. Link it.
  await linkRequest(scope, requestEntityId, created, SYSTEM);
}

/**
 * Looks for the GitHub issue of a request whose outcome is unknown and links
 * it when found. It only reads GitHub: it never creates an issue. A
 * definite "not found" (complete listing, last POST at least 2 minutes old)
 * settles it as `failed` ISSUES_GITHUB_NOT_FOUND, which allows a new request.
 */
export async function reconcileGithubRequest(
  scope: Scope,
  requestEntityId: string,
  actor: IssueActor,
): Promise<{ status: "done" | "outcome_unknown" | "failed" }> {
  const id = uuid.parse(requestEntityId);
  const step1 = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireIssues(tx, scope);
    requireIssuesGithub();
    const row = await loadRequest(tx, scope, id);
    if (!row) throw new DomainError("NOT_FOUND", 404);
    const value = data(row);
    if (value.status === "done") return null;
    if (value.status !== "outcome_unknown") throw new DomainError("ISSUES_GITHUB_REQUEST_STATE", 409);
    return { value, version: row.version, app: (await githubApp(tx, scope)).app };
  });
  if (!step1) return { status: "done" };
  const [owner, repo] = splitName(String(step1.value.fullName));
  const token = await installationToken(step1.app, { repositories: [repo], permissions: READ_PERMISSIONS });
  const found = await findByMarker(step1.app, token, owner, repo, step1.value);
  if (found === "incomplete") return { status: "outcome_unknown" };
  if (!found) {
    // A complete, successful listing without the marker settles the request
    // only once the last POST is old enough for GitHub to list it.
    const sentAt = Date.parse(String(step1.value.sendingAt ?? ""));
    if (!Number.isFinite(sentAt) || Date.now() - sentAt < NOT_FOUND_AFTER_MS) return { status: "outcome_unknown" };
    const settled = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await loadRequest(tx, scope, id);
      if (!row || row.version !== step1.version || data(row).status !== "outcome_unknown") return false;
      const value = data(row);
      await update(tx, scope, row, { ...value, status: "failed", code: "ISSUES_GITHUB_NOT_FOUND" });
      await audit(tx, scope, "issues.github.failed", id, {
        issueId: value.issueId,
        repository: value.fullName,
        code: "ISSUES_GITHUB_NOT_FOUND",
      });
      return true;
    });
    return { status: settled ? "failed" : "outcome_unknown" };
  }
  const status = await linkRequest(scope, id, found, actor);
  return { status: status === "done" ? "done" : "outcome_unknown" };
}

/**
 * Crash recovery (worker lease expired): after the last attempt a request
 * left `sending` becomes `outcome_unknown`, a `queued` one `failed`.
 */
export async function expireGithubRequest(tx: DbTx, scope: Scope, job: Record<string, any>) {
  if (Number(job.attempts) < Number(job.maxAttempts)) return;
  const row = await loadRequest(tx, scope, String(job.resourceId));
  if (!row) return;
  const status = data(row).status;
  if (status === "sending") await settleIn(tx, scope, row.id, "outcome_unknown", "JOB_OUTCOME_UNKNOWN");
  else if (status === "queued") await settleIn(tx, scope, row.id, "failed", "JOB_OUTCOME_UNKNOWN");
}
