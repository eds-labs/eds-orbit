import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  retrieve,
  validateEvidence,
} from "../../../../../packages/knowledge/src/index.ts";
import { retrieveHybrid } from "./retrieval.ts";
import { sharedSearch, validateShared, type SharedOrigin } from "./shares.ts";
import { data, DomainError } from "../shared.ts";
import type { ChatCard } from "../assistant/cards.ts";

/** Keys a paid search reserves under: its retrieval run and the budget run. */
export type SearchBudget = { retrievalJobKey: string; budgetRunKey: string };
/** The agent run a paid search joins instead of opening its own retrieval run. */
export type SearchTrace = { agentRunId: string; taskClass: string };

export const knowledgeSearchInput = z
  .object({
    query: z.string().trim().min(1).max(2000),
    factKeys: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  })
  .strict();

/** What a search returns to a model, checked before it leaves the server. */
export const knowledgeSearchResult = z
  .object({
    status: z.string(),
    retrieval: z
      .object({
        mode: z.enum(["hybrid", "lexical_degraded"]),
        indexProfile: z.string().min(1).max(160),
        indexGeneration: z.number().int().positive(),
        evidenceId: z.uuid(),
        // Results from shared organization libraries (ADR 0014).
        shared: z
          .array(
            z
              .object({
                shareId: z.uuid(),
                generation: z.number().int().positive(),
                libraryProjectId: z.uuid(),
                libraryName: z.string(),
                evidenceId: z.uuid(),
              })
              .strict(),
          )
          .max(3)
          .optional(),
      })
      .strict(),
    facts: z
      .array(z.object({ id: z.uuid(), sourceId: z.uuid() }).passthrough())
      .max(8),
    passages: z.array(z.object({ sourceId: z.uuid() }).passthrough()).max(6),
    gaps: z.array(z.unknown()).max(12),
  })
  .passthrough();

function clipped(value: unknown, max = 500) {
  return String(value ?? "").slice(0, max);
}

/**
 * The knowledge search of the assistant and the specialists (WP3.2): current
 * public, model-authorized Verified Facts and passages with their sources.
 * With `budget` it runs the paid hybrid retrieval under those keys;
 * without, the lexical retrieval only. `consumer` is the module searching
 * (WP3.5); without it only sources open to all modules are searched.
 * `trace` attributes a paid search to the caller's agent run.
 */
export async function knowledgeSearch(
  scope: Scope,
  raw: unknown,
  budget?: SearchBudget,
  consumer?: string,
  trace?: SearchTrace,
  // MCP reads only the project's own knowledge (ADR 0014), and reads it for
  // a model, not for publication: `internal` needs the model right only
  // (Mario 2026-10-23). Every module writing public text keeps `public`.
  options: { shared?: boolean; purpose?: "public" | "internal" } = {},
): Promise<{ result: unknown; cards: ChatCard[] }> {
  const input = knowledgeSearchInput.parse(raw);
  const language = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      return project.language;
    },
  );
  const request = {
    query: input.query,
    ...(input.factKeys?.length ? { factKeys: input.factKeys } : {}),
    language,
    purpose: options.purpose ?? ("public" as const),
    forModel: true,
    at: new Date(),
    topK: 6,
    ...(consumer ? { consumer } : {}),
  };
  const evidence = budget
    ? await retrieveHybrid(
        scope,
        request,
        budget.retrievalJobKey,
        budget.budgetRunKey,
        trace,
      )
    : await scoped(scope.workspaceId, scope.projectId, (tx) =>
        retrieve(tx, scope, request),
      );
  const own = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const value = data(evidence);
    if (
      value.purpose !== request.purpose ||
      value.forModel !== true ||
      !["ready", "insufficient_evidence"].includes(value.status)
    )
      throw new DomainError("CHAT_EVIDENCE_CHANGED");
    const validation = await validateEvidence(
      tx,
      scope,
      evidence.id,
      new Date(),
    );
    if (
      validation.reasons.some(
        (reason) =>
          reason !== "evidence_not_public_ready" &&
          reason !== "insufficient_evidence",
      )
    )
      throw new DomainError("CHAT_EVIDENCE_CHANGED");
    const facts = Array.isArray(value.facts) ? value.facts.slice(0, 8) : [];
    const items = Array.isArray(value.items) ? value.items.slice(0, 6) : [];
    const sourceIds = [
      ...new Set(
        [
          ...facts.map((f: any) => f.sourceId),
          ...items.map((i: any) => i.sourceId),
        ].filter(Boolean),
      ),
    ];
    const sources = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "sources",
        id: { in: sourceIds },
      },
    });
    const cards: ChatCard[] = [
      {
        kind: "status",
        label:
          value.mode === "hybrid"
            ? `Hybrid knowledge retrieval · index ${value.indexGeneration}`
            : `Knowledge retrieval: lexical_degraded · index ${value.indexGeneration}`,
        status: value.mode,
      },
      ...sources.map((source): ChatCard => ({
        kind: "source",
        label: clipped(data(source).name, 120),
        href: "/knowledge",
        status: "verified",
        resourceId: source.id,
        version: source.version,
      })),
    ];
    return {
      result: {
        status: value.status,
        retrieval: {
          mode: value.mode,
          indexProfile: value.indexProfile,
          indexGeneration: value.indexGeneration,
          evidenceId: evidence.id,
        },
        facts: facts.map((f: any) => ({
          id: f.id,
          version: f.version,
          key: clipped(f.key, 160),
          value: clipped(f.value, 500),
          sourceId: f.sourceId,
        })),
        passages: items.map((i: any) => ({
          chunkId: i.chunkId ?? i.id,
          sourceId: i.sourceId,
          title: clipped(i.title, 160),
          text: clipped(i.text, 700),
          url: clipped(i.canonicalUrl, 500),
        })),
        gaps: (value.gaps ?? []).slice(0, 12),
      },
      cards,
    };
  });
  // Shared organization libraries fill the remaining slots, own results first.
  const shared =
    options.shared === false
      ? []
      : await sharedSearch(scope, request, consumer ?? "assistant");
  if (!shared.length) return own;
  const result = own.result as {
    status: string;
    retrieval: Record<string, unknown>;
    facts: unknown[];
    passages: unknown[];
  };
  for (const set of shared) {
    const origin = {
      library: clipped(set.origin.libraryName, 120),
      shareId: set.origin.shareId,
    };
    for (const f of set.facts)
      if (result.facts.length < 8)
        result.facts.push({
          id: f.id,
          version: f.version,
          key: clipped(f.key, 160),
          value: clipped(f.value, 500),
          sourceId: f.sourceId,
          origin,
        });
    for (const i of set.items)
      if (result.passages.length < 6)
        result.passages.push({
          chunkId: i.chunkId ?? i.id,
          sourceId: i.sourceId,
          title: clipped(i.title, 160),
          text: clipped(i.text, 700),
          url: clipped(i.canonicalUrl, 500),
          origin,
        });
    for (const [id, name] of set.sources)
      own.cards.push({
        kind: "source",
        label: clipped(`${set.origin.libraryName} · ${name}`, 120),
        href: "/knowledge",
        status: "verified",
        resourceId: id,
      } as ChatCard);
  }
  if (result.facts.length || result.passages.length) result.status = "ready";
  result.retrieval.shared = shared.map((s) => s.origin);
  return own;
}

/**
 * Whether a search result may still be used: its own evidence and every
 * shared library it drew from (share active, same generation, library
 * evidence valid).
 */
export async function validateSearchResult(
  scope: Scope,
  result: { retrieval?: { evidenceId?: string; shared?: SharedOrigin[] } },
) {
  const evidenceId = result.retrieval?.evidenceId;
  if (!evidenceId) return false;
  const own = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    validateEvidence(tx, scope, evidenceId),
  );
  // Own evidence that found nothing contributed nothing to check.
  const nothingOwn = own.reasons.every(
    (r) => r === "insufficient_evidence" || r === "evidence_not_public_ready",
  );
  if (!own.valid && !(nothingOwn && result.retrieval?.shared?.length))
    return false;
  return validateShared(scope, result.retrieval?.shared ?? []);
}
