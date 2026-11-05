import { randomUUID } from "node:crypto";
import { Prisma, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { githubFetch, installationToken } from "../../platform/connections/github-app.ts";
import { audit, DomainError } from "../../shared.ts";
import { ISSUE_TYPE, issueDomainEvent, issueEvent, type IssueActor } from "./common.ts";
import { requireIssues, requireIssuesGithub } from "./gate.ts";
import { githubExternalId, parseGithubIssueUrl } from "./github-body.ts";
import { githubApp } from "./github-connection.ts";
import { READ_PERMISSIONS, splitName } from "./github.ts";
import { loadIssue } from "./issues.ts";
import { readIssuesSettings, type IssuesSettings } from "./settings.ts";

// Link an existing GitHub issue, refresh the linked state, unlink (spec
// 2026-11-05 §5.2). Every GitHub path is built from the allow-list's stored
// `fullName`; a URL only selects the entry and the issue number. GitHub is
// read with `issues: read` outside any database transaction. Refresh and
// unlink never touch the Orbit issue itself or GitHub.

/** A repeated refresh of an issue is refused for this long. */
export const REFRESH_MIN_MS = 60_000;

export type ExternalRefView = { id: string; system: string; externalId: string; url: string | null; state: string | null };
/**
 * A refreshed ref. `error` is the code of a failed read (the stored state was
 * kept); `stateReason` is GitHub's close reason from this read, not stored.
 */
export type RefreshedRefView = ExternalRefView & { error: string | null; stateReason: string | null };

type RefRow = Awaited<ReturnType<DbTx["issueExternalRef"]["findMany"]>>[number];
const view = (r: RefRow): ExternalRefView => ({ id: r.id, system: r.system, externalId: r.externalId, url: r.url, state: r.state });
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : "GITHUB_REQUEST_FAILED");

const allowListed = (settings: IssuesSettings, fullName: string) =>
  settings.github.repositories.find((r) => sameName(r.fullName, fullName)) ?? null;

type GithubIssue = { number?: unknown; state?: unknown; state_reason?: unknown; pull_request?: unknown };

/** One read of `/repos/{fullName}/issues/{n}` with a token for that repository only. */
async function readIssue(app: Awaited<ReturnType<typeof githubApp>>["app"], fullName: string, number: number, tokens: Map<string, string>) {
  const [, repo] = splitName(fullName);
  let token = tokens.get(fullName);
  if (!token) {
    token = await installationToken(app, { repositories: [repo], permissions: READ_PERMISSIONS });
    tokens.set(fullName, token);
  }
  const issue = await githubFetch<GithubIssue>(`/repos/${fullName}/issues/${number}`, token);
  if (!issue || issue.number !== number || (issue.state !== "open" && issue.state !== "closed"))
    throw new DomainError("GITHUB_REQUEST_FAILED", 409);
  return issue;
}

/**
 * The stored state is `open` or `closed`: the core migration's check
 * constraint allows nothing else and slice 1 adds no migration. The close
 * reason (`completed`, `not_planned`) is read but only reported by refresh.
 */
const stateOf = (issue: GithubIssue) => (issue.state === "open" ? "open" : "closed");
const reasonOf = (issue: GithubIssue) =>
  issue.state === "closed" && typeof issue.state_reason === "string" && /^[a-z_]{1,40}$/.test(issue.state_reason)
    ? issue.state_reason
    : null;

/** Links an existing issue of an allow-listed repository to an Orbit issue. */
export async function linkGithubIssue(
  scope: Scope,
  issueId: string,
  url: string,
  actor: IssueActor,
): Promise<ExternalRefView> {
  requireIssuesGithub();
  // Refused before any GitHub call, the token mint included.
  const parsed = parseGithubIssueUrl(url);
  const check = async (tx: DbTx) => {
    await requireIssues(tx, scope);
    const issue = await loadIssue(tx, scope, issueId);
    const repository = allowListed((await readIssuesSettings(tx, scope)).settings, parsed.fullName);
    if (!repository) throw new DomainError("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED", 409);
    splitName(repository.fullName);
    const externalId = githubExternalId(repository.fullName, parsed.number);
    const taken = await tx.issueExternalRef.findFirst({
      where: { projectId: scope.projectId, system: "github", externalId: { equals: externalId, mode: "insensitive" } },
    });
    if (taken) throw new DomainError("ISSUES_GITHUB_ALREADY_LINKED", 409);
    return { issue, fullName: repository.fullName, externalId };
  };

  const first = await scoped(scope.workspaceId, scope.projectId, async (tx) => ({
    ...(await check(tx)),
    app: (await githubApp(tx, scope)).app,
  }));
  const read = await readIssue(first.app, first.fullName, parsed.number, new Map());
  if (read.pull_request) throw new DomainError("ISSUES_GITHUB_URL_INVALID", 400);

  try {
    return await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const { issue, fullName, externalId } = await check(tx);
      const ref = await tx.issueExternalRef.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          issueId: issue.id,
          system: "github",
          externalId,
          url: `https://github.com/${fullName}/issues/${parsed.number}`,
          state: stateOf(read),
          syncedAt: new Date(),
          createdBy: actor.id ?? actor.kind,
        },
      });
      await issueEvent(tx, scope, issue.id, "github", actor, {}, { action: "linked", repository: fullName, externalId, via: "manual" });
      await audit(tx, scope, "issues.github.linked", ref.id, { issueId: issue.id, repository: fullName, externalId, via: "manual" });
      await issueDomainEvent(tx, scope, "issues.github.linked", { type: ISSUE_TYPE, id: issue.id }, actor, {
        number: issue.number,
        repository: fullName,
        externalId,
      });
      return view(ref);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new DomainError("ISSUES_GITHUB_ALREADY_LINKED", 409);
    throw error;
  }
}

/**
 * Reads the state of each github ref of the issue and stores it. A ref whose
 * repository left the allow-list is skipped, and a failed read keeps the
 * stored state: both are reported per ref (`error`), never as a failure of
 * the whole refresh.
 */
export async function refreshGithubRefs(
  scope: Scope,
  issueId: string,
  _actor: IssueActor,
): Promise<RefreshedRefView[]> {
  requireIssuesGithub();
  const first = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireIssues(tx, scope);
    const issue = await loadIssue(tx, scope, issueId);
    const refs = await tx.issueExternalRef.findMany({
      where: { projectId: scope.projectId, issueId: issue.id, system: "github" },
      orderBy: { createdAt: "asc" },
    });
    const cutoff = Date.now() - REFRESH_MIN_MS;
    if (refs.some((r) => r.syncedAt && r.syncedAt.getTime() > cutoff))
      throw new DomainError("ISSUES_GITHUB_REFRESH_TOO_SOON", 429);
    const { settings } = await readIssuesSettings(tx, scope);
    const targets = refs.map((ref) => {
      const at = ref.externalId.lastIndexOf("#");
      const number = Number(ref.externalId.slice(at + 1));
      const repository = at > 0 ? allowListed(settings, ref.externalId.slice(0, at)) : null;
      return { ref, number, fullName: repository?.fullName ?? null };
    });
    const readable = targets.some((t) => t.fullName && Number.isSafeInteger(t.number) && t.number > 0);
    return { issue, targets, app: readable ? (await githubApp(tx, scope)).app : null };
  });

  const tokens = new Map<string, string>();
  const results = new Map<string, { state: string; reason: string | null } | { error: string }>();
  for (const { ref, number, fullName } of first.targets) {
    if (!fullName || !first.app || !Number.isSafeInteger(number) || number < 1) {
      results.set(ref.id, { error: "ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED" });
      continue;
    }
    try {
      const read = await readIssue(first.app, fullName, number, tokens);
      results.set(ref.id, { state: stateOf(read), reason: reasonOf(read) });
    } catch (error) {
      results.set(ref.id, { error: codeOf(error) });
    }
  }

  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireIssues(tx, scope);
    const now = new Date();
    for (const [refId, result] of results)
      if ("state" in result)
        // A ref unlinked meanwhile is simply not updated.
        await tx.issueExternalRef.updateMany({
          where: { id: refId, projectId: scope.projectId, issueId: first.issue.id, system: "github" },
          data: { state: result.state, syncedAt: now },
        });
    const refs = await tx.issueExternalRef.findMany({
      where: { projectId: scope.projectId, issueId: first.issue.id, system: "github" },
      orderBy: { createdAt: "asc" },
    });
    await audit(tx, scope, "issues.github.refreshed", first.issue.id, {
      refs: refs.length,
      failed: [...results.values()].filter((r) => "error" in r).length,
    });
    return refs.map((r) => {
      const result = results.get(r.id);
      return {
        ...view(r),
        error: result && "error" in result ? result.error : null,
        stateReason: result && "state" in result ? result.reason : null,
      };
    });
  });
}

/** Removes one github ref of the issue; GitHub and other refs stay untouched. */
export async function unlinkGithubRef(
  tx: DbTx,
  scope: Scope,
  issueId: string,
  refId: string,
  actor: IssueActor,
): Promise<void> {
  requireIssuesGithub();
  const issue = await loadIssue(tx, scope, issueId);
  const ref = await tx.issueExternalRef.findFirst({
    where: { id: refId, projectId: scope.projectId, issueId: issue.id, system: "github" },
  });
  if (!ref) throw new DomainError("NOT_FOUND", 404);
  await tx.issueExternalRef.delete({ where: { projectId_id: { projectId: scope.projectId, id: ref.id } } });
  const repository = ref.externalId.slice(0, Math.max(0, ref.externalId.lastIndexOf("#")));
  await issueEvent(tx, scope, issue.id, "github", actor, {}, { action: "unlinked", repository, externalId: ref.externalId });
  await audit(tx, scope, "issues.github.unlinked", ref.id, { issueId: issue.id, repository, externalId: ref.externalId });
  await issueDomainEvent(tx, scope, "issues.github.unlinked", { type: ISSUE_TYPE, id: issue.id }, actor, {
    number: issue.number,
    repository,
    externalId: ref.externalId,
  });
}
