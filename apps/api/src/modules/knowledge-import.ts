import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import { extractDocument, MIME } from "../../../../packages/knowledge/src/extract.ts";
import { ingest, setFact } from "../../../../packages/knowledge/src/index.ts";
import { create, data, entity, update } from "../shared.ts";
import { id, type Scope } from "../../../../packages/schemas/src/index.ts";

const sourceType = z.enum([
  "website", "gitbook", "url", "url_list", "file", "verified_facts", "historical",
]);
const document = z.object({
  externalId: z.string().min(1).max(300), title: z.string().min(1).max(300),
  text: z.string().max(1_000_000).optional(), base64: z.string().max(2_000_000).optional(),
  mimeType: z.enum([MIME.txt, MIME.md, MIME.html, MIME.pdf]), language: z.enum(["en", "de"]),
  canonicalUrl: z.url().optional(), sourceUpdatedAt: z.iso.datetime().optional(), selected: z.boolean().default(true),
}).strict();
const factValueType = z.preprocess((value) => {
  if (value === "string") return "text";
  if (value === "number") return "decimal";
  if (value === "boolean") return "status";
  return value;
}, z.enum(["text", "decimal", "date", "status", "url"]));
const fact = z.object({
  key: z.string().min(1).max(160), value: z.preprocess((value) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : value,
  z.string().min(1).max(1000)),
  valueType: factValueType, currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  unit: z.string().max(50).optional(), language: z.enum(["en", "de"]), market: z.string().max(100).optional(),
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime().optional(), publicUse: z.boolean(), modelUse: z.boolean(),
}).strict();
export const knowledgeImportInput = z.object({
  name: z.string().min(1).max(200), sourceType, authority: z.enum(["official", "website", "research", "generated"]),
  publicUse: z.boolean(), modelUse: z.boolean(), allowedOrigins: z.array(z.url()).max(20).default([]),
  allowedPaths: z.array(z.string().min(1).max(400)).max(20).default(["/"]), maxAgeHours: z.number().int().min(1).max(8760).default(168),
  documents: z.array(document).max(100).default([]), facts: z.array(fact).max(1000).default([]),
}).strict().superRefine((v, ctx) => {
  if (v.sourceType === "verified_facts" && !v.facts.length) ctx.addIssue({ code: "custom", message: "FACT_ROWS_REQUIRED", path: ["facts"] });
  if (v.sourceType !== "verified_facts" && !v.documents.length) ctx.addIssue({ code: "custom", message: "DOCUMENTS_REQUIRED", path: ["documents"] });
  if (v.sourceType === "historical" && v.authority !== "generated") ctx.addIssue({ code: "custom", message: "HISTORICAL_MUST_BE_GENERATED", path: ["authority"] });
});
export type KnowledgeImportInput = z.infer<typeof knowledgeImportInput>;
const controlledStatuses = new Set(["available", "beta", "planned", "discontinued"]);
/** Preserve bulk-import values when their source did not provide the units required for a structured fact. */
export function normalizeBulkFact<T extends { value: string; valueType: string; currency?: string; unit?: string }>(row: T): T {
  const mustRemainText =
    (row.valueType === "decimal" && !row.currency && !row.unit) ||
    (row.valueType === "status" && !controlledStatuses.has(row.value)) ||
    (row.valueType === "date" && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.value) || !Number.isFinite(Date.parse(row.value))));
  return mustRemainText ? { ...row, valueType: "text" } : row;
}

function parseCsv(csv: string) {
  const lines = csv.trim().split(/\r?\n/); if (lines.length < 2) throw new Error("MALFORMED_CSV");
  const header = lines.shift()!.split(",").map((x) => x.trim());
  if (!header.includes("key") || !header.includes("value")) throw new Error("MALFORMED_CSV");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, i) => [header[i]!, value.trim()])));
}
export function importPreview(raw: unknown) {
  const input = knowledgeImportInput.parse(raw);
  const seen = new Set<string>(); const errors: Array<{ item: string; code: string }> = [];
  const documents = input.documents.filter((d) => d.selected).map((d) => {
    const duplicate = seen.has(d.canonicalUrl ?? d.externalId); seen.add(d.canonicalUrl ?? d.externalId);
    if (duplicate) errors.push({ item: d.externalId, code: "DUPLICATE_DOCUMENT" });
    return { externalId: d.externalId, title: d.title, canonicalUrl: d.canonicalUrl ?? null, duplicate };
  });
  return { input, documents, factCount: input.facts.length, errors, ready: !errors.length };
}
export { parseCsv };

export async function commitKnowledgeImport(tx: DbTx, scope: Scope, raw: unknown) {
  const preview = importPreview(raw); if (!preview.ready) throw new Error("IMPORT_PREVIEW_INVALID");
  const i = preview.input;
  const job = await create(tx, scope, "knowledge_imports", { name: i.name, sourceType: i.sourceType, status: "running", total: i.documents.length + i.facts.length, completed: 0, failed: 0, failures: [], startedAt: new Date().toISOString() });
  const source = await create(tx, scope, "sources", {
    name: i.name, type: i.sourceType, status: "active", generation: 1, authority: i.sourceType === "historical" ? "generated" : i.authority,
    publicUse: i.publicUse, modelUse: i.sourceType === "historical" ? false : i.modelUse, maxAgeHours: i.maxAgeHours,
    allowedOrigins: i.allowedOrigins, allowedPaths: i.allowedPaths, importId: job.id, historical: i.sourceType === "historical",
  });
  let completed = 0; const failures: Array<{ item: string; code: string }> = [];
  for (const item of i.documents.filter((d) => d.selected)) try {
    const extracted = await extractDocument(item.base64 ? Buffer.from(item.base64, "base64") : Buffer.from(item.text ?? ""), item.mimeType);
    await ingest(tx, scope, { sourceId: source.id, externalId: item.externalId, title: item.title, text: extracted.text, mimeType: item.mimeType, language: item.language, canonicalUrl: item.canonicalUrl, sourceUpdatedAt: item.sourceUpdatedAt, expectedGeneration: 1 }); completed++;
  } catch (error) { failures.push({ item: item.externalId, code: error instanceof Error ? error.message : "IMPORT_FAILED" }); }
  for (const row of i.facts) try { await setFact(tx, scope, { ...normalizeBulkFact(row), sourceId: source.id, status: "verified" }); completed++; } catch (error) { failures.push({ item: row.key, code: error instanceof Error ? error.message : "FACT_IMPORT_FAILED" }); }
  return update(tx, scope, job, { ...data(job), sourceId: source.id, completed, failed: failures.length, failures, status: failures.length ? (completed ? "partial" : "failed") : "completed", completedAt: new Date().toISOString() });
}

export async function retryKnowledgeImport(tx: DbTx, scope: Scope, importId: string, raw: unknown) {
  await entity(tx, scope, "knowledge_imports", id.parse(importId));
  return commitKnowledgeImport(tx, scope, raw);
}
