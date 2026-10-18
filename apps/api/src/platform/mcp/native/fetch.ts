/**
 * The native MCP `fetch` tool (Track M, WP-M3; OpenAI contract
 * `fetch(id) -> { id, title, text, url, metadata }`): one search result by
 * its id. The project in the id is authorized again on every call (D-M3-6);
 * a malformed, unknown, ineligible or foreign id answers the same NOT_FOUND.
 */
import { z } from "zod";
import {
  fetchChunkForModel,
  fetchFactForModel,
} from "../../knowledge/mcp-read.ts";
import type { NativeTool } from "../native-tools.ts";
import {
  itemUrl,
  knowledgeScope,
  notFound,
  parseItemId,
  resultTitle,
} from "./knowledge.ts";

const fetchInput = z.object({ id: z.string().max(200) }).strict();

const fetchOutput = z
  .object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string().min(1),
    metadata: z
      .object({
        projectId: z.string(),
        kind: z.enum(["chunk", "fact"]),
        sourceId: z.string(),
        documentVersionId: z.string().optional(),
        fetchedAt: z.string().optional(),
        truncated: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/** A fact as text (D-M3-8): `key: value`, then its unit and currency. */
const factText = (fact: {
  key: string;
  value: string;
  unit?: string;
  currency?: string;
}) =>
  [`${fact.key}: ${fact.value}`, fact.unit, fact.currency]
    .filter(Boolean)
    .join(" ");

export const fetchTool: NativeTool = {
  name: "fetch",
  description:
    "Fetch one result of search by its id: the passage's document text (at most 48 KB) or the verified fact, with its citation URL.",
  risk: "R0_read",
  inputSchema: fetchInput,
  outputSchema: fetchOutput,
  async run(principal, args, ctx) {
    const { id } = fetchInput.parse(args);
    const ref = parseItemId(id);
    if (!ref) throw notFound();
    // Audited in the id's project only when it is one of the grant's.
    ctx.setAuditProject(ref.projectId);
    const scope = await knowledgeScope(principal, ref.projectId);
    if (!scope) throw notFound();
    if (ref.kind === "chunk") {
      const chunk = await fetchChunkForModel(scope, ref.itemId);
      return {
        id,
        title: resultTitle(chunk.title, "chunk"),
        text: chunk.text,
        url: itemUrl(ref.projectId, "chunk", chunk.canonicalUrl),
        metadata: {
          projectId: ref.projectId,
          kind: "chunk",
          sourceId: chunk.sourceId,
          documentVersionId: chunk.documentVersionId,
          fetchedAt: chunk.fetchedAt,
          truncated: chunk.truncated,
        },
      };
    }
    const fact = await fetchFactForModel(scope, ref.itemId);
    return {
      id,
      title: resultTitle(fact.key, "fact"),
      text: factText(fact),
      url: itemUrl(ref.projectId, "fact", fact.canonicalUrl),
      metadata: {
        projectId: ref.projectId,
        kind: "fact",
        sourceId: fact.sourceId,
      },
    };
  },
};
