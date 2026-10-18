/**
 * The native MCP `search` tool (Track M, WP-M3; OpenAI contract
 * `search(query) -> { results: [{ id, title, url }] }`): the principal's
 * model-eligible knowledge, through the same knowledge search the assistant
 * uses, without a consumer module (D-M3-4).
 */
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { KnowledgeError } from "../../../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { requireSpendMandate } from "../../ai/spend-mandate.ts";
import { DomainError } from "../../shared.ts";
import { searchForModel, type KnowledgeHit } from "../../knowledge/mcp-read.ts";
import type { SearchBudget, SearchTrace } from "../../knowledge/search.ts";
import type { NativeTool, NativeToolContext } from "../native-tools.ts";
import {
  itemId,
  itemUrl,
  knowledgeScope,
  resultTitle,
  searchableProjects,
} from "./knowledge.ts";

/** Most results one search returns. */
export const SEARCH_MAX_RESULTS = 30;

const searchInput = z
  .object({
    query: z.string().trim().min(1).max(2000),
    projectId: z.uuid().optional(),
  })
  .strict();

const searchOutput = z
  .object({
    results: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            url: z.string().min(1),
          })
          .strict(),
      )
      .max(SEARCH_MAX_RESULTS),
  })
  .strict();

type SearchResult = z.infer<typeof searchOutput>["results"][number];

/**
 * The paid-search keys of one call in one project (D-M3-2): unique per call,
 * so a per-run limit never accumulates across calls; the project's daily and
 * monthly caps still apply. Null unless the project could start a paid query
 * embedding right now (an active spend mandate that approves paid tests, now
 * inside its window, and the project not paused): then the search is lexical
 * and spends nothing, and no `retrieval` run is opened for an attempt that
 * would fail before any spend (D-M3-3). The paid path re-checks all of it.
 */
async function budgetFor(
  scope: Scope,
  ctx: NativeToolContext,
): Promise<SearchBudget | null> {
  const open = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    let mandate;
    try {
      mandate = await requireSpendMandate(tx, scope);
    } catch (error) {
      // No active policy; a malformed one still fails the call.
      if (error instanceof DomainError && error.code === "POLICY_REQUIRED")
        return false;
      throw error;
    }
    const { startAt, endAt, approvedPaidTests } = mandate.limits;
    const now = Date.now();
    if (
      !approvedPaidTests ||
      now < Date.parse(startAt) ||
      now >= Date.parse(endAt)
    )
      return false;
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    return !project.paused;
  });
  if (!open) return null;
  // The request id ties the keys to the logs; the call id keeps them unique
  // per call.
  const runKey = `mcp:${ctx.grantId}:${ctx.requestId}:${ctx.callId}`;
  return {
    retrievalJobKey: `${runKey}:${scope.projectId}`,
    budgetRunKey: runKey,
  };
}

const toResult = (projectId: string, hit: KnowledgeHit): SearchResult =>
  hit.kind === "chunk"
    ? {
        id: itemId(projectId, "chunk", hit.chunkId),
        title: resultTitle(hit.title, "chunk"),
        url: itemUrl(projectId, "chunk", hit.canonicalUrl),
      }
    : {
        id: itemId(projectId, "fact", hit.factId),
        title: resultTitle(hit.key, "fact"),
        url: itemUrl(projectId, "fact", hit.canonicalUrl),
      };

/**
 * One project's results. A project whose knowledge cannot be searched right
 * now (a KnowledgeError, such as NO_ACTIVE_EMBEDDING_INDEX: the lexical
 * retrieval needs the active index too) contributes nothing; it never fails
 * the whole call. Only the error code is logged, never the query.
 */
async function searchProject(
  scope: Scope,
  query: string,
  ctx: NativeToolContext,
  trace: SearchTrace | undefined,
): Promise<SearchResult[]> {
  try {
    const { hits } = await searchForModel(scope, query, {
      budget: await budgetFor(scope, ctx),
      ...(trace ? { trace } : {}),
    });
    return hits.map((hit) => toResult(scope.projectId, hit));
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    ctx.log.warn(
      {
        code: "MCP_SEARCH_PROJECT_UNAVAILABLE",
        errorCode: error.code,
        requestId: ctx.requestId,
      },
      "mcp search skipped a project",
    );
    return [];
  }
}

/** Takes results from each project in turn, so one project cannot fill the list. */
function interleave(lists: SearchResult[][], max: number): SearchResult[] {
  const merged: SearchResult[] = [];
  for (let index = 0; merged.length < max; index++) {
    const round = lists.filter((list) => index < list.length);
    if (!round.length) break;
    for (const list of round) {
      if (merged.length === max) break;
      merged.push(list[index]!);
    }
  }
  return merged;
}

export const searchTool: NativeTool = {
  name: "search",
  description:
    "Search the Orbit knowledge this connection may read: verified facts and model-approved knowledge passages, in up to five projects or in the one named by projectId. Returns ids to pass to fetch, titles and citation URLs.",
  risk: "R0_read",
  inputSchema: searchInput,
  outputSchema: searchOutput,
  async run(principal, args, ctx) {
    const { query, projectId } = searchInput.parse(args);
    let scopes: Scope[];
    if (projectId) {
      // 404 outside the grant; a project whose knowledge the member may not
      // read is searched as empty.
      const scope = await knowledgeScope(principal, projectId);
      ctx.setAuditProject(projectId);
      scopes = scope ? [scope] : [];
    } else scopes = await searchableProjects(principal);

    // A single-project call is audited there, and a paid query embedding
    // joins its run. A call over several projects is project-less (one
    // McpGrantEvent); each paid embedding then opens its own `retrieval` run
    // in its project, reserved under the same per-call keys.
    let trace: SearchTrace | undefined;
    if (scopes.length === 1) {
      const runId = await ctx.startRun(scopes[0]!.projectId);
      if (runId) trace = { agentRunId: runId, taskClass: searchTool.name };
    }
    const lists: SearchResult[][] = [];
    for (const scope of scopes)
      lists.push(await searchProject(scope, query, ctx, trace));
    return { results: interleave(lists, SEARCH_MAX_RESULTS) };
  },
};
