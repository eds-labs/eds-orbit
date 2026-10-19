/**
 * What the MCP `search` and `fetch` tools share (Track M, WP-M3): which
 * projects the principal may read knowledge in, the self-describing result
 * ids (D-M3-6) and the citation URLs (D-M3-7).
 */
import { z } from "zod";
import { authDb } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import { can, PROJECT_READ } from "../../tenancy/permissions.ts";
import { effectiveRole, moduleScope } from "../../tenancy/module-roles.ts";
import { projectScope, type McpPrincipal } from "../principal.ts";
import { principalModules } from "../visibility.ts";

const KNOWLEDGE = "knowledge";
/** Projects one search covers at most (D-M3-5). */
export const SEARCH_MAX_PROJECTS = 5;
/** Longest title a result carries. */
const TITLE_MAX_CHARS = 160;

export const notFound = () => new DomainError("NOT_FOUND", 404);

/**
 * The member's knowledge scope in a project of the principal, read again on
 * every call: null when the knowledge module is not enabled, hidden from the
 * member or outside the grant's module restriction, or when the member's
 * role there cannot read. 404 NOT_FOUND (projectScope) when the project is
 * outside the principal or the membership is gone.
 */
export async function knowledgeScope(
  principal: McpPrincipal,
  projectId: string,
): Promise<Scope | null> {
  const scope = await projectScope(principal, projectId);
  if (!(await principalModules(principal, scope)).includes(KNOWLEDGE))
    return null;
  const role = effectiveRole(scope, KNOWLEDGE);
  if (role === "none" || !can({ role }, PROJECT_READ)) return null;
  return moduleScope(scope, KNOWLEDGE);
}

/**
 * The projects a search without `projectId` covers (D-M3-5): the principal's
 * projects whose knowledge the member may read, by name then id, at most
 * SEARCH_MAX_PROJECTS of them.
 */
export async function searchableProjects(
  principal: McpPrincipal,
): Promise<Scope[]> {
  const rows = await authDb.project.findMany({
    where: {
      workspaceId: principal.workspaceId,
      id: { in: [...principal.projectIds] },
    },
    select: { id: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const scopes: Scope[] = [];
  for (const row of rows) {
    // A project whose membership is gone since the principal was resolved
    // is left out, never reported.
    const scope = await knowledgeScope(principal, row.id).catch(
      (error: unknown) => {
        if (error instanceof DomainError && error.code === "NOT_FOUND")
          return null;
        throw error;
      },
    );
    if (scope) scopes.push(scope);
    if (scopes.length === SEARCH_MAX_PROJECTS) break;
  }
  return scopes;
}

export type ItemKind = "chunk" | "fact";
export type ItemRef = { projectId: string; kind: ItemKind; itemId: string };

/** A result id (D-M3-6): `p:<projectId>:chunk:<chunkId>` or `p:<projectId>:fact:<factId>`. */
export const itemId = (projectId: string, kind: ItemKind, id: string) =>
  `p:${projectId}:${kind}:${id}`;

const ITEM_ID = /^p:([^:]+):(chunk|fact):([^:]+)$/;
const uuid = z.uuid();

/** The parts of a result id, or null for anything that is not exactly one. */
export function parseItemId(value: string): ItemRef | null {
  const match = ITEM_ID.exec(value);
  if (!match) return null;
  const [, projectId, kind, id] = match;
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(id).success)
    return null;
  return { projectId: projectId!, kind: kind as ItemKind, itemId: id! };
}

/**
 * Longest canonical URL a result cites (D-M5-6); a longer one falls back to
 * the Orbit deep link, so URLs cannot push `search` or `fetch` over the
 * 64 KB output cap. Canonical URLs are serialized by `URL` (safeCitation),
 * so they are ASCII and JSON adds no escapes.
 */
export const MCP_URL_MAX_CHARS = 2048;

/** The project's knowledge library (passages) or facts page in Orbit. */
export function deepLink(projectId: string, kind: ItemKind): string {
  const origin = new URL(loadConfig().APP_ORIGIN).origin;
  return `${origin}/p/${projectId}/knowledge/${kind === "chunk" ? "library" : "facts"}`;
}

/**
 * A result's citation URL (D-M3-7): the source's safe canonical URL when it
 * has at most MCP_URL_MAX_CHARS characters, else the deep link. Never empty.
 */
export function itemUrl(
  projectId: string,
  kind: ItemKind,
  canonicalUrl: string | null,
): string {
  if (canonicalUrl && canonicalUrl.length <= MCP_URL_MAX_CHARS)
    return canonicalUrl;
  return deepLink(projectId, kind);
}

/** A title clipped to TITLE_MAX_CHARS characters (never inside a surrogate pair). */
const clipTitle = (title: string) =>
  Array.from(title).slice(0, TITLE_MAX_CHARS).join("");

/** A result title, clipped; a blank title becomes a fixed label. */
export const resultTitle = (title: string, kind: ItemKind) =>
  clipTitle(title.trim()) ||
  (kind === "chunk" ? "Knowledge passage" : "Verified fact");
