import { createHash } from "node:crypto";
import {
  CHUNK_VERSION,
  KnowledgeError,
  LIMITS,
  type ChunkInput,
} from "./types.js";
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function normalizeText(text: string) {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+$/gm, "")
    .trim();
}
export function tokenEstimate(text: string) {
  return Math.ceil(text.length / 3);
}
export function chunkText(input: string): ChunkInput[] {
  const text = normalizeText(input);
  if (!text || Buffer.byteLength(text) > LIMITS.maxBytes)
    throw new KnowledgeError("INVALID_DOCUMENT_SIZE");
  const blocks = text.split(/\n\s*\n/);
  const chunks: ChunkInput[] = [];
  let heading = "";
  let buffer = "";
  let blockStart = 1;
  function emit() {
    if (!buffer.trim()) return;
    if (chunks.length >= LIMITS.maxChunks)
      throw new KnowledgeError("TOO_MANY_CHUNKS");
    const value = (heading ? heading + "\n\n" : "") + buffer.trim();
    chunks.push({
      position: chunks.length,
      heading,
      anchor: "paragraph-" + blockStart,
      text: value,
      chunkHash: hash(CHUNK_VERSION + "\n" + value),
      tokenEstimate: tokenEstimate(value),
    });
    buffer = "";
  }
  blocks.forEach((block, index) => {
    const found = block.match(/^(#{1,6})\s+([^\n]+)/);
    if (found) {
      emit();
      heading = found[2]!.slice(0, 300);
      blockStart = index + 1;
    }
    if (buffer.length + block.length > 2400) {
      emit();
      blockStart = index + 1;
    }
    // Bound large unbroken paragraphs; tables keep the header on every fragment.
    if (block.length > 2700) {
      const lines = block.split("\n");
      const header = block.includes("|")
        ? lines.slice(0, 2).join("\n") + "\n"
        : "";
      let rest = block;
      if (header.length > 500)
        throw new KnowledgeError("TABLE_HEADER_TOO_LARGE");
      while (rest.length > 2400) {
        let cut = rest.lastIndexOf("\n", 2400);
        if (cut < 1200) cut = rest.lastIndexOf(" ", 2400);
        if (cut < 1200) cut = 2400;
        buffer = rest.slice(0, cut);
        emit();
        rest = header + rest.slice(cut).trim();
        if (header.length > 500)
          throw new KnowledgeError("TABLE_HEADER_TOO_LARGE");
      }
      buffer = rest;
    } else buffer += (buffer ? "\n\n" : "") + block;
  });
  emit();
  if (chunks.length > LIMITS.maxChunks)
    throw new KnowledgeError("TOO_MANY_CHUNKS");
  return chunks;
}
export function validateVector(vector: number[], dimensions = 1536) {
  if (
    vector.length !== dimensions ||
    vector.some((n) => !Number.isFinite(n)) ||
    !vector.some((n) => n !== 0)
  )
    throw new KnowledgeError("INVALID_EMBEDDING");
  return "[" + vector.join(",") + "]";
}
export function validAt(
  from: string | Date,
  until: string | Date | null | undefined,
  at: Date,
) {
  const start = new Date(from).getTime(),
    end = until ? new Date(until).getTime() : Infinity;
  return Number.isFinite(start) && start <= at.getTime() && at.getTime() < end;
}
export function overlap(
  a: { validFrom: string; validUntil?: string },
  b: { validFrom: string; validUntil?: string },
) {
  return (
    new Date(a.validFrom).getTime() <
      (b.validUntil ? new Date(b.validUntil).getTime() : Infinity) &&
    new Date(b.validFrom).getTime() <
      (a.validUntil ? new Date(a.validUntil).getTime() : Infinity)
  );
}
export function rrf<T extends { id: string }>(
  lexical: T[],
  semantic: T[],
  limit = 8,
): Array<T & { score: number; reasons: string[] }> {
  const merged = new Map<string, T & { score: number; reasons: string[] }>();
  for (const [branch, items] of [
    ["lexical", lexical],
    ["semantic", semantic],
  ] as const) {
    items.forEach((item, i) => {
      const prev = merged.get(item.id) ?? { ...item, score: 0, reasons: [] };
      prev.score += 1 / (60 + i + 1);
      prev.reasons.push(branch);
      merged.set(item.id, prev);
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
export function diverseContext<
  T extends {
    id: string;
    documentVersionId: string;
    text: string;
    chunkHash: string;
  },
>(items: T[], topK = LIMITS.topK, maxTokens = LIMITS.contextTokens) {
  const counts = new Map<string, number>(),
    seen = new Set<string>();
  let tokens = 0;
  return items
    .filter((item) => {
      const size = tokenEstimate(item.text);
      if (
        seen.has(item.chunkHash) ||
        (counts.get(item.documentVersionId) ?? 0) >= LIMITS.maxPerDocument ||
        tokens + size > maxTokens
      )
        return false;
      seen.add(item.chunkHash);
      counts.set(
        item.documentVersionId,
        (counts.get(item.documentVersionId) ?? 0) + 1,
      );
      tokens += size;
      return true;
    })
    .slice(0, topK);
}
